import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
    chatCompletion,
    cosineSimilarity,
    createEmbedding,
    embedContent,
    generateContent
} from '../lib/ai.js';
import { generateAIReminder } from '../lib/ai-reminder.js';
import { handleAssistantChat } from '../lib/ai-assistant.js';
import { parseAndClassifyProposals } from '../lib/automation.js';
import { invalidateRAGIndex, queryRAG } from '../lib/rag.js';
import type { Database, Member } from '../src/types/billing.js';

const API_KEY = 'test-gemini-key-not-real';

function emptyDatabase(): Database {
    return {
        currentMonth: '2026/06',
        baseMonth: '2026/06',
        bankInfo: 'Test Bank',
        platforms: [],
        members: [],
        subscriptions: [],
        payments: [],
        tempCharges: [],
        history: [],
        reminderStyle: 'professional',
        ledger: { version: 1, entries: [], lastHash: '', updatedAt: '' }
    };
}

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' }
    });
}

function stubFetch(body: unknown, status = 200) {
    const fetchMock = vi.fn().mockImplementation(async () => jsonResponse(body, status));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}

beforeEach(() => {
    vi.stubEnv('GOOGLE_GEMINI_API_KEY', API_KEY);
    vi.stubEnv('AI_MODEL', 'models/gemini-contract');
    vi.stubEnv('AI_EMBEDDING_MODEL', 'models/gemini-embedding-contract');
    invalidateRAGIndex();
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    invalidateRAGIndex();
});

describe('Gemini AI Studio transport', () => {
    it('centralizes model, key, JSON request, and compatibility chat parsing', async () => {
        const fetchMock = stubFetch({
            candidates: [{ content: { parts: [{ text: 'transport reply' }] } }]
        });

        const raw = await generateContent<{ candidates: unknown[] }>(
            { contents: [{ role: 'user', parts: [{ text: 'raw request' }] }] },
            z.object({ candidates: z.array(z.unknown()) }),
            { model: 'models/gemini-contract' }
        );
        const text = await chatCompletion([
            { role: 'system', content: 'system' },
            { role: 'user', content: 'hello' }
        ], { temperature: 0.2, max_tokens: 300 });

        expect(raw.candidates).toHaveLength(1);
        expect(text).toBe('transport reply');
        expect(fetchMock).toHaveBeenCalledTimes(2);

        const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
        const requestUrl = new URL(url);
        const requestBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        expect(requestUrl.pathname).toContain('/models/gemini-contract:generateContent');
        expect(requestUrl.searchParams.get('key')).toBe(API_KEY);
        expect(requestBody).toMatchObject({
            systemInstruction: { parts: [{ text: 'system' }] },
            generationConfig: { temperature: 0.2, maxOutputTokens: 300 }
        });
    });

    it('keeps embedding and similarity compatibility exports', async () => {
        const fetchMock = stubFetch({ embedding: { values: [1, 0] } });

        await expect(embedContent('first')).resolves.toEqual([1, 0]);
        await expect(createEmbedding('second')).resolves.toEqual([1, 0]);
        expect(cosineSimilarity([1, 0], [1, 0])).toBe(1);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(String(fetchMock.mock.calls.at(0)?.[0])).toContain('/models/gemini-embedding-contract:embedContent');
    });

    it('redacts the API key from HTTP errors', async () => {
        stubFetch({ error: `denied ${API_KEY}` }, 403);

        const error = await generateContent({ contents: [] }, z.object({}).passthrough()).then(
            () => null,
            caught => caught as Error
        );

        expect(error).toBeInstanceOf(Error);
        expect(error?.message).toContain('403');
        expect(error?.message).not.toContain(API_KEY);
    });

    it('validates caller-provided response shapes and enforces timeout/cancellation', async () => {
        const schema = z.object({ ok: z.boolean() });
        stubFetch({ candidates: 'not-an-array' });
        await expect(generateContent({ contents: [] }, schema)).rejects.toThrow('invalid response shape');

        vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, init: RequestInit) => (
            new Promise<never>((_resolve, reject) => {
                const signal = init.signal as AbortSignal;
                signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
            })
        )));
        await expect(generateContent({ contents: [] }, schema, { timeoutMs: 10 })).rejects.toThrow('timed out');

        const controller = new AbortController();
        const request = generateContent({ contents: [] }, schema, { signal: controller.signal, timeoutMs: 1_000 });
        controller.abort();
        await expect(request).rejects.toThrow('cancelled');
    });
});

describe('AI callers use the shared transport', () => {
    const member: Member = {
        id: 'member-1',
        name: 'Member One',
        priorBalance: 0,
        customFee: null
    };

    it('generates a reminder and preserves the remote-failure fallback', async () => {
        const params = {
            member,
            summary: { outstanding: 100, monthlyFee: 100, tempCharges: 0, paid: 0 },
            activeSubsText: ['Test Service $100'],
            bankInfo: 'Test Bank',
            currentMonth: '2026/06',
            style: 'professional'
        };
        stubFetch({ candidates: [{ content: { parts: [{ text: 'AI reminder' }] } }] });
        await expect(generateAIReminder(params)).resolves.toMatchObject({ text: 'AI reminder', isAI: true });

        stubFetch({ error: 'temporary outage' }, 503);
        const fallback = await generateAIReminder(params);
        expect(fallback.isAI).toBe(false);
        expect(fallback.text).toContain(member.name);
        expect(fallback.error).toContain('503');
    });

    it('keeps automation tool parsing in the caller', async () => {
        const database = emptyDatabase();
        database.members = [member];
        const fetchMock = stubFetch({
            candidates: [{
                content: {
                    parts: [{
                        functionCall: {
                            name: 'record_billing_events',
                            args: {
                                events: [{
                                    kind: 'payment',
                                    memberName: member.name,
                                    amount: 100,
                                    confidence: 0.99,
                                    reason: 'matched'
                                }]
                            }
                        }
                    }]
                }
            }]
        });

        const result = await parseAndClassifyProposals('Member One paid 100', database, API_KEY, 'review');

        expect(result.pending).toHaveLength(1);
        const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        const requestBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        expect(requestBody).toHaveProperty('tools');
        expect(requestBody).toHaveProperty('toolConfig');
    });

    it('keeps assistant tool declarations and response parsing in the caller', async () => {
        const fetchMock = stubFetch({
            candidates: [{ content: { parts: [{ text: 'Assistant reply' }] }, finishReason: 'STOP' }]
        });

        const result = await handleAssistantChat(emptyDatabase(), '帳務狀況？');

        expect(result.reply).toBe('Assistant reply');
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        const requestBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        expect(requestBody).toHaveProperty('tools');

        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
        const fallback = await handleAssistantChat(emptyDatabase(), '帳務狀況？');
        expect(fallback.reply).toContain('發生錯誤');
    });

    it('uses shared embeddings for RAG and falls back to an empty result on failure', async () => {
        const database = emptyDatabase();
        database.members = [member];
        const fetchMock = stubFetch({ embedding: { values: [1, 0] } });

        const results = await queryRAG(database, 'Member One', 1);

        expect(results).toHaveLength(1);
        expect(results.at(0)?.score).toBe(1);
        expect(fetchMock).toHaveBeenCalledTimes(2);

        invalidateRAGIndex();
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
        await expect(queryRAG(database, 'Member One', 1)).resolves.toEqual([]);
    });
});
