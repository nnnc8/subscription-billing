import { z } from 'zod';

const AI_STUDIO_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_GENERATION_MODEL = 'gemini-3.1-flash-lite';
const DEFAULT_EMBEDDING_MODEL = 'gemini-embedding-2';

export interface GeminiRequestOptions {
    model?: string
    apiKey?: string
    timeoutMs?: number
    signal?: AbortSignal
}

interface GoogleMessage {
    role: string
    content: string
    tool_calls?: Array<{ function: { name: string; arguments: string } }>
}

interface GoogleFormatResult {
    systemInstruction?: { parts: Array<{ text: string }> }
    contents: Array<Record<string, unknown>>
}

export const generateContentResponseSchema = z.object({
    candidates: z.array(z.object({
        content: z.object({
            parts: z.array(z.object({
                text: z.string().optional(),
                thoughtSignature: z.string().nullable().optional(),
                functionCall: z.object({
                    id: z.string().optional(),
                    name: z.string(),
                    args: z.record(z.string(), z.unknown())
                }).optional()
            }).passthrough()).optional()
        }).passthrough().optional(),
        finishReason: z.string().optional()
    }).passthrough()).optional()
}).passthrough();

export type GenerateContentResponse = z.infer<typeof generateContentResponseSchema>;

const embedContentResponseSchema = z.object({
    embedding: z.object({ values: z.array(z.number().finite()) }).optional()
}).passthrough();

type EmbedContentResponse = z.infer<typeof embedContentResponseSchema>;

type GeminiOperation = 'generateContent' | 'embedContent';

export function isAIConfigured(): boolean {
    return Boolean(process.env.GOOGLE_GEMINI_API_KEY?.trim());
}

function getApiKey(override?: string): string {
    const apiKey = (override ?? process.env.GOOGLE_GEMINI_API_KEY ?? '').trim();
    if (!apiKey) {
        throw new Error('GOOGLE_GEMINI_API_KEY is not configured');
    }
    return apiKey;
}

function normalizeModel(model: string | undefined, fallback: string): string {
    const selected = (model || fallback).trim();
    return selected.split('/').at(-1) || fallback;
}

function safeErrorDetail(value: unknown, apiKey: string): string {
    const detail = value instanceof Error ? value.message : String(value ?? '');
    return detail
        .replaceAll(apiKey, '[redacted]')
        .replaceAll(encodeURIComponent(apiKey), '[redacted]')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 200);
}

async function requestGemini<T>(
    operation: GeminiOperation,
    body: unknown,
    schema: z.ZodType<T>,
    options: GeminiRequestOptions,
    fallbackModel: string
): Promise<T> {
    const apiKey = getApiKey(options.apiKey);
    const model = normalizeModel(options.model, fallbackModel);
    const url = `${AI_STUDIO_BASE_URL}/${encodeURIComponent(model)}:${operation}?key=${encodeURIComponent(apiKey)}`;

    const controller = new AbortController();
    const timeoutMs = options.timeoutMs ?? 20_000;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const forwardAbort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', forwardAbort, { once: true });

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal
        });
        if (!response.ok) {
            const detail = safeErrorDetail(await response.text().catch(() => ''), apiKey);
            throw new Error(`Gemini ${operation} returned ${response.status}${detail ? `: ${detail}` : ''}`);
        }

        const payload: unknown = await response.json();
        try {
            return schema.parse(payload);
        } catch {
            throw new Error(`Gemini ${operation} returned invalid response shape`);
        }
    } catch (error) {
        if (controller.signal.aborted) {
            // Do not preserve AbortError causes: browser/runtime causes can contain request internals.
            if (options.signal?.aborted) {
                // eslint-disable-next-line preserve-caught-error
                throw new Error(`Gemini ${operation} request cancelled`);
            }
            // eslint-disable-next-line preserve-caught-error
            throw new Error(`Gemini ${operation} request timed out`);
        }
        const detail = safeErrorDetail(error, apiKey);
        // The original fetch error can retain the request URL, including the API key.
        // eslint-disable-next-line preserve-caught-error
        throw new Error(`Gemini ${operation} request failed${detail ? `: ${detail}` : ''}`);
    } finally {
        clearTimeout(timeout);
        options.signal?.removeEventListener('abort', forwardAbort);
    }
}

export function generateContent<T>(
    body: unknown,
    schema: z.ZodType<T>,
    options: GeminiRequestOptions = {}
): Promise<T> {
    return requestGemini<T>(
        'generateContent',
        body,
        schema,
        options,
        process.env.AI_MODEL || DEFAULT_GENERATION_MODEL
    );
}

export async function embedContent(text: string, options: GeminiRequestOptions = {}): Promise<number[]> {
    const data = await requestGemini<EmbedContentResponse>(
        'embedContent',
        { content: { parts: [{ text }] } },
        embedContentResponseSchema,
        options,
        process.env.AI_EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL
    );
    const values = data.embedding?.values;
    if (!Array.isArray(values) || values.length === 0 || !values.every(Number.isFinite)) {
        throw new Error('Gemini embedContent returned an invalid embedding');
    }
    return values;
}

function convertMessagesToGoogleFormat(messages: GoogleMessage[]): GoogleFormatResult {
    let systemInstruction: GoogleFormatResult['systemInstruction'];
    const contents: Array<Record<string, unknown>> = [];

    for (const message of messages) {
        if (message.role === 'system') {
            systemInstruction = { parts: [{ text: message.content }] };
        } else if (message.role === 'user') {
            contents.push({ role: 'user', parts: [{ text: message.content }] });
        } else if (message.role === 'tool') {
            contents.push({
                role: 'user',
                parts: [{ text: `【工具執行結果】：\n${message.content}` }]
            });
        } else if (message.role === 'assistant' || message.role === 'model') {
            let text = message.content || '';
            if (message.tool_calls?.length) {
                const calls = message.tool_calls
                    .map(call => `${call.function.name}(${call.function.arguments || ''})`)
                    .join(', ');
                text += `\n【系統工具呼叫】執行：${calls}`;
            }
            contents.push({ role: 'model', parts: [{ text: text.trim() }] });
        }
    }

    return systemInstruction ? { systemInstruction, contents } : { contents };
}

export async function chatCompletion(
    messages: GoogleMessage[],
    options: Record<string, unknown> = {}
): Promise<string> {
    const { systemInstruction, contents } = convertMessagesToGoogleFormat(messages);
    const body: Record<string, unknown> = {
        contents,
        generationConfig: {
            temperature: options.temperature ?? 0.7,
            maxOutputTokens: options.max_tokens ?? 2000
        }
    };
    if (systemInstruction) body.systemInstruction = systemInstruction;

    const data = await generateContent(body, generateContentResponseSchema);
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof text !== 'string') {
        throw new Error('Gemini generateContent returned no text candidate');
    }
    return text;
}

export function createEmbedding(text: string): Promise<number[]> {
    return embedContent(text);
}

export function cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let index = 0; index < a.length; index++) {
        const left = a[index] ?? 0;
        const right = b[index] ?? 0;
        dotProduct += left * right;
        normA += left * left;
        normB += right * right;
    }
    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}
