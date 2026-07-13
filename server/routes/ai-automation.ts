import { Router } from 'express';
import { z } from 'zod';
import {
    calculateCurrentMonthBalances,
    getPlatformPriceForMonth,
    isEntityBillableInMonth,
    isMemberRecord,
    isSubActiveInMonth
} from '../../lib/accounting.js';
import { handleAssistantChat, type AssistantMessage } from '../../lib/ai-assistant.js';
import { generateAIReminder } from '../../lib/ai-reminder.js';
import { applyProposal, parseAndClassifyProposals } from '../../lib/automation.js';
import { queryRAG } from '../../lib/rag.js';
import type { Subscription } from '../../src/types/billing.js';
import { httpError } from '../middleware/error.js';
import { emptyPayloadSchema, nonEmptyIdSchema, parseInput } from '../middleware/validation.js';
import { MutationPersistenceError, type Runtime } from '../runtime.js';
import { readDatabase, sendDatabase } from './shared.js';

const boundedTextSchema = z.string().trim().min(1).max(20_000);
const assistantMessageSchema = z.object({
    role: z.string().min(1).max(32),
    content: z.string().max(50_000).optional(),
    tool_calls: z.array(z.record(z.string(), z.unknown())).max(20).optional(),
    name: z.string().max(200).optional(),
    tool_call_id: z.string().max(200).optional()
}).passthrough();
const reminderSchema = z.object({
    memberId: nonEmptyIdSchema,
    style: z.string().max(100).optional()
});
const chatSchema = z.object({
    message: boundedTextSchema,
    history: z.array(assistantMessageSchema).max(100).optional().default([])
});
const ragSchema = z.object({
    query: boundedTextSchema,
    topK: z.number().int().min(1).max(20).optional().default(5)
});
const ingestSchema = z.object({
    text: boundedTextSchema,
    mode: z.enum(['auto', 'review']).optional().default('auto')
});
const proposalParamsSchema = z.object({ id: nonEmptyIdSchema });
const rejectSchema = z.object({ reason: z.string().max(2_000).optional() });

function getSubscriptionDisplayName(subscription: Subscription): string {
    const customName = (subscription as unknown as Record<string, unknown>).customName;
    return customName ? `${subscription.platformName} (${customName})` : subscription.platformName;
}

async function chat(runtime: Runtime, reqBody: unknown, isLegacy = false) {
    const { message, history } = parseInput(chatSchema, reqBody, '缺少 message 參數');
    const result = await handleAssistantChat(
        readDatabase(runtime),
        message,
        history as unknown as AssistantMessage[]
    );
    return { success: true, reply: result.reply, history: result.history, ...(isLegacy ? { isLegacy: true } : {}) };
}

export function createAiAutomationRouter(runtime: Runtime): Router {
    const router = Router();

    router.post('/api/ai/generate-reminder', async (req, res) => {
        const { memberId, style } = parseInput(reminderSchema, req.body, '缺少 memberId 參數');
        const db = readDatabase(runtime);
        const member = db.members.find(item => item.id === memberId);
        if (!member) { res.status(404).json({ error: '找不到成員' }); return; }
        const balance = calculateCurrentMonthBalances(db).find(item => isMemberRecord(item, member));
        if (!balance) {
            res.status(400).json({ error: '找不到該成員的當月帳務摘要' });
            return;
        }

        const activeSubscriptions: string[] = [];
        const memberSubscriptions = db.subscriptions.filter(subscription =>
            (subscription.memberId && subscription.memberId === member.id)
            || subscription.memberName === member.name
        );
        if (isEntityBillableInMonth(member, db.currentMonth) && member.customFee != null) {
            activeSubscriptions.push(`  • 自訂費用小計: $${member.customFee}`);
        } else {
            for (const subscription of memberSubscriptions) {
                const platform = db.platforms.find(item =>
                    (subscription.platformId && item.id === subscription.platformId)
                    || item.name === subscription.platformName
                );
                if (
                    isSubActiveInMonth(subscription, db.currentMonth)
                    && Boolean(platform && isEntityBillableInMonth(platform, db.currentMonth))
                    && isEntityBillableInMonth(member, db.currentMonth)
                ) {
                    const price = platform
                        ? getPlatformPriceForMonth(db, { platformId: platform.id, platformName: platform.name }, db.currentMonth)
                        : 0;
                    activeSubscriptions.push(`  • ${getSubscriptionDisplayName(subscription)}: $${price}`);
                }
            }
        }
        if (!activeSubscriptions.length) activeSubscriptions.push('  • 本期無訂閱項目');

        const result = await generateAIReminder({
            member,
            summary: {
                outstanding: balance.endingBalance,
                monthlyFee: balance.subscriptionFee,
                tempCharges: balance.tempCharge,
                paid: balance.paid
            },
            activeSubsText: activeSubscriptions,
            bankInfo: db.bankInfo || '',
            currentMonth: db.currentMonth || '',
            style: style || 'friendly'
        });
        res.json({ success: true, text: result.text, isAI: result.isAI, error: result.error });
    });

    router.post('/api/ai/chat', async (req, res) => {
        res.json(await chat(runtime, req.body));
    });

    router.post('/api/ai/rag-search', async (req, res) => {
        const { query, topK } = parseInput(ragSchema, req.body, '缺少 query 參數');
        res.json({ success: true, results: await queryRAG(readDatabase(runtime), query, topK) });
    });

    router.post('/api/automation/ingest', async (req, res) => {
        const { text, mode } = parseInput(ingestSchema, req.body, '缺少輸入文字');
        const db = readDatabase(runtime);
        const result = await parseAndClassifyProposals(
            text,
            db,
            runtime.env.GOOGLE_GEMINI_API_KEY || '',
            mode
        );
        let responseResult = result;
        if (result.applied.length) {
            const proposals = result.applied.map(proposal => ({ ...proposal }));
            try {
                    const { value: applied } = await runtime.mutateDB(freshDb => {
                    const persisted: typeof proposals = [];
                    for (const proposal of proposals) {
                        const applyResult = applyProposal(proposal, freshDb);
                        if (!applyResult.ok) {
                            throw httpError(409, `AI proposal ${proposal.id} 在套用前已失效：${applyResult.error || '重新驗證失敗'}`);
                        }
                        persisted.push({
                            ...proposal,
                            status: 'applied',
                            appliedAt: new Date().toISOString(),
                            ...(applyResult.ledgerEventId ? { ledgerEventId: applyResult.ledgerEventId } : {})
                        });
                    }
                    return persisted;
                }, { reason: 'automation.ingest.apply' });
                responseResult = { ...result, applied };
                runtime.automationInbox.push(...applied, ...result.pending, ...result.rejected);
                res.json({ success: true, ...responseResult });
                return;
            } catch (error) {
                if (error instanceof MutationPersistenceError) {
                    res.status(500).json({ error: 'AI 解析成功但資料寫入失敗' });
                    return;
                }
                throw error;
            }
        }
        runtime.automationInbox.push(...result.applied, ...result.pending, ...result.rejected);
        res.json({ success: true, ...responseResult });
    });

    router.get('/api/automation/inbox', (_req, res) => {
        res.json({ success: true, proposals: runtime.automationInbox });
    });

    router.post('/api/automation/confirm/:id', async (req, res) => {
        const { id } = parseInput(proposalParamsSchema, req.params, 'Proposal ID 不合法');
        parseInput(emptyPayloadSchema, req.body ?? {}, 'Invalid confirmation payload');
        const proposal = runtime.automationInbox.find(item => item.id === id);
        if (!proposal) { res.status(404).json({ error: '找不到該 proposal' }); return; }
        if (proposal.status !== 'pending') {
            res.status(409).json({ error: `Proposal 狀態為 ${proposal.status}，無法再確認` });
            return;
        }

        try {
            const { data, value: appliedProposal } = await runtime.mutateDB(db => {
                const latest = runtime.automationInbox.find(item => item.id === id);
                if (!latest || latest.status !== 'pending') {
                    throw httpError(409, 'Proposal 已變更，請重新整理後再試');
                }
                const result = applyProposal(latest, db);
                if (!result.ok) {
                    throw httpError(409, result.error || '套用時重新驗證失敗');
                }
                return {
                    ...latest,
                    status: 'applied' as const,
                    appliedAt: new Date().toISOString(),
                    ...(result.ledgerEventId ? { ledgerEventId: result.ledgerEventId } : {})
                };
            }, { reason: 'automation.confirm.apply' });
            const index = runtime.automationInbox.findIndex(item => item.id === id);
            if (index >= 0) runtime.automationInbox[index] = appliedProposal;
            sendDatabase(res, data, { proposal: appliedProposal });
        } catch (error) {
            if (error instanceof MutationPersistenceError) {
                res.status(500).json({ error: '資料寫入失敗' });
                return;
            }
            throw error;
        }
    });

    router.post('/api/automation/reject/:id', (req, res) => {
        const { id } = parseInput(proposalParamsSchema, req.params, 'Proposal ID 不合法');
        const { reason } = parseInput(rejectSchema, req.body ?? {}, '拒絕原因格式不正確');
        const proposal = runtime.automationInbox.find(item => item.id === id);
        if (!proposal) { res.status(404).json({ error: '找不到該 proposal' }); return; }
        if (proposal.status !== 'pending') {
            res.status(409).json({ error: `Proposal 狀態為 ${proposal.status}，無法拒絕` });
            return;
        }
        Object.assign(proposal, {
            status: 'rejected',
            rejectedAt: new Date().toISOString(),
            rejectedBy: 'manual',
            rejectReason: reason || '使用者手動拒絕'
        });
        res.json({ success: true, proposal });
    });

    router.post('/api/ai/chat-legacy', async (req, res) => {
        res.json(await chat(runtime, req.body, true));
    });

    return router;
}
