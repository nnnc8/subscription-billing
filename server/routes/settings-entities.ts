import { Router } from 'express';
import { z } from 'zod';
import {
    isMemberRecord,
    isPlatformRecord,
    MONTH_RE,
    previousMonthString
} from '../../lib/accounting.js';
import type { Database, Member, Platform, Subscription } from '../../src/types/billing.js';
import { httpError } from '../middleware/error.js';
import { nonEmptyIdSchema, parseInput } from '../middleware/validation.js';
import type { Runtime } from '../runtime.js';
import {
    generateId,
    mutateAndSend,
    parseMoney,
} from './shared.js';

const moneyInputSchema = z.union([z.number(), z.string().max(100)]);
const platformDraftSchema = z.object({
    id: z.string().max(200).optional(),
    name: z.string().trim().min(1).max(200),
    billingMode: z.enum(['fixed', 'split']).optional(),
    price: moneyInputSchema.optional(),
    totalCost: moneyInputSchema.optional()
}).passthrough();
const memberDraftSchema = z.object({
    id: z.string().max(200).optional(),
    name: z.string().trim().min(1).max(200),
    priorBalance: moneyInputSchema.nullish(),
    customFee: moneyInputSchema.nullish()
}).passthrough();
const subscriptionSchema = z.object({
    id: z.string().trim().min(1).max(500),
    memberId: z.string().max(200).optional(),
    platformId: z.string().max(200).optional(),
    memberName: z.string().trim().min(1).max(200),
    platformName: z.string().trim().min(1).max(200),
    startMonth: z.string().regex(MONTH_RE),
    exitMonth: z.union([z.literal(''), z.string().regex(MONTH_RE)]).optional(),
    seatLabel: z.string().max(200).optional(),
    allowDuplicate: z.boolean().optional()
}).passthrough();
const updatePlatformsSchema = z.object({ platforms: z.array(platformDraftSchema).max(10_000) });
const updateMembersSchema = z.object({ members: z.array(memberDraftSchema).max(10_000) });
const updateSubscriptionsSchema = z.object({ subscriptions: z.array(subscriptionSchema).max(50_000) });
const updateBankSchema = z.object({
    bankInfo: z.string().max(20_000).optional(),
    reminderStyle: z.string().max(100).optional()
});
const configBundleSchema = z.object({
    platforms: z.array(platformDraftSchema).max(10_000),
    members: z.array(memberDraftSchema).max(10_000),
    bankInfo: z.string().max(20_000).optional(),
    reminderStyle: z.string().max(100).optional()
});
const createMemberSchema = z.object({
    name: z.string().trim().min(1).max(200),
    priorBalance: moneyInputSchema.nullish(),
    customFee: moneyInputSchema.nullish()
});
const createPlatformSchema = z.object({
    name: z.string().trim().min(1).max(200),
    price: moneyInputSchema.optional(),
    billingMode: z.enum(['fixed', 'split']).optional(),
    totalCost: moneyInputSchema.optional()
});
const idParamsSchema = z.object({ id: nonEmptyIdSchema });

function normalizePlatformDraft(platform: Record<string, unknown>): Record<string, unknown> {
    const billingMode = platform.billingMode === 'split' ? 'split' : 'fixed';
    return {
        ...platform,
        billingMode,
        price: billingMode === 'split' ? 0 : parseMoney(platform.price ?? 0, '固定單人月費'),
        totalCost: billingMode === 'split' ? parseMoney(platform.totalCost ?? 0, '平台總月費') : 0
    };
}

function normalizeMemberDraft(member: Record<string, unknown>): Record<string, unknown> {
    return {
        ...member,
        priorBalance: member.priorBalance === '' || member.priorBalance == null
            ? 0
            : parseMoney(member.priorBalance, '期初餘額', { allowNegative: true }),
        customFee: member.customFee === '' || member.customFee == null
            ? null
            : parseMoney(member.customFee, '自訂月費')
    };
}

function summarizeSettingsBundle(
    currentDb: Database,
    nextPlatforms: Record<string, unknown>[],
    nextMembers: Record<string, unknown>[],
    nextBankInfo: string,
    nextReminderStyle: string
) {
    const currentPlatforms = new Map(currentDb.platforms.map(platform => [platform.id || platform.name, platform]));
    const currentMembers = new Map(currentDb.members.map(member => [member.id || member.name, member]));
    let changedPlatforms = 0;
    let changedPlatformValues = 0;
    for (const platform of nextPlatforms) {
        const current = currentPlatforms.get(String(platform.id || platform.name));
        const differences = current
            ? [
                current.price !== platform.price,
                (current.billingMode || 'fixed') !== platform.billingMode,
                (current.totalCost || 0) !== platform.totalCost
            ].filter(Boolean).length
            : 1;
        if (differences) {
            changedPlatforms += 1;
            changedPlatformValues += differences;
        }
    }

    let changedMembers = 0;
    let changedMemberValues = 0;
    for (const member of nextMembers) {
        const current = currentMembers.get(String(member.id || member.name));
        const differences = current
            ? [
                current.priorBalance !== member.priorBalance,
                (current.customFee ?? null) !== (member.customFee ?? null)
            ].filter(Boolean).length
            : 1;
        if (differences) {
            changedMembers += 1;
            changedMemberValues += differences;
        }
    }

    const bankInfoChanged = (currentDb.bankInfo || '') !== nextBankInfo;
    const reminderStyleChanged = (currentDb.reminderStyle || 'friendly') !== nextReminderStyle;
    return {
        changedPlatforms,
        changedPlatformValues,
        changedMembers,
        changedMemberValues,
        bankInfoChanged,
        reminderStyleChanged,
        totalChanges: changedPlatformValues + changedMemberValues + Number(bankInfoChanged) + Number(reminderStyleChanged)
    };
}

export function createSettingsEntitiesRouter(runtime: Runtime): Router {
    const router = Router();

    router.post('/api/update-prices', async (req, res) => {
        const { platforms } = parseInput(updatePlatformsSchema, req.body, 'Invalid platforms data');
        const nextPlatforms = platforms.map(normalizePlatformDraft) as unknown as Platform[];
        await mutateAndSend(runtime, res, db => {
            db.platforms = nextPlatforms;
            return {
                event: {
                    type: 'platforms.updated',
                    summary: `更新 ${db.platforms.length} 個平台價格設定`,
                    entityType: 'platform',
                    payload: { count: db.platforms.length }
                }
            };
        }, { reason: 'settings.update-prices' });
    });

    router.post('/api/update-members', async (req, res) => {
        const { members } = parseInput(updateMembersSchema, req.body, 'Invalid members data');
        const nextMembers = members.map(normalizeMemberDraft) as unknown as Member[];
        await mutateAndSend(runtime, res, db => {
            db.members = nextMembers;
            return {
                event: {
                    type: 'members.updated',
                    summary: `更新 ${db.members.length} 位成員設定`,
                    entityType: 'member',
                    payload: { count: db.members.length }
                }
            };
        }, { reason: 'settings.update-members' });
    });

    router.post('/api/update-subscriptions', async (req, res) => {
        const { subscriptions } = parseInput(updateSubscriptionsSchema, req.body, 'Invalid subscriptions data');
        const nextSubscriptions = subscriptions as unknown as Subscription[];
        await mutateAndSend(runtime, res, db => {
            db.subscriptions = nextSubscriptions;
            return {
                event: {
                    type: 'subscriptions.updated',
                    summary: `更新 ${nextSubscriptions.length} 筆訂閱指派`,
                    entityType: 'subscription',
                    payload: { count: nextSubscriptions.length }
                }
            };
        }, { reason: 'settings.update-subscriptions' });
    });

    router.post('/api/update-bank', async (req, res) => {
        const input = parseInput(updateBankSchema, req.body, 'Invalid settings data');
        await mutateAndSend(runtime, res, db => {
            db.bankInfo = input.bankInfo || '';
            db.reminderStyle = input.reminderStyle || 'friendly';
            return {
                event: {
                    type: 'settings.updated',
                    summary: '更新匯款資訊與對帳單樣式',
                    entityType: 'settings',
                    payload: { reminderStyle: db.reminderStyle, bankInfoChanged: true }
                }
            };
        }, { reason: 'settings.update-bank' });
    });

    router.post('/api/update-config-bundle', async (req, res) => {
        const input = parseInput(configBundleSchema, req.body, '設定草稿格式不正確');
        const platforms = input.platforms.map(normalizePlatformDraft);
        const members = input.members.map(normalizeMemberDraft);
        const bankInfo = input.bankInfo || '';
        const reminderStyle = input.reminderStyle || 'friendly';
        await mutateAndSend(runtime, res, db => {
            const summary = summarizeSettingsBundle(db, platforms, members, bankInfo, reminderStyle);
            if (!summary.totalChanges) {
                return { extra: { message: '沒有設定異動，已重新同步畫面。' } };
            }

            db.platforms = platforms as unknown as Platform[];
            db.members = members as unknown as Member[];
            db.bankInfo = bankInfo;
            db.reminderStyle = reminderStyle;
            const parts = [
                summary.changedPlatforms ? `${summary.changedPlatforms} 個平台` : '',
                summary.changedMembers ? `${summary.changedMembers} 位成員` : '',
                summary.bankInfoChanged ? '匯款資訊' : '',
                summary.reminderStyleChanged ? '催帳語氣' : ''
            ].filter(Boolean);

            return {
                extra: { message: '設定已一次寫入資料庫，並留下單筆事件。' },
                event: {
                    type: 'settings.bundle.updated',
                    summary: `一次性更新設定：${parts.join('、')}`,
                    entityType: 'settings',
                    payload: summary
                }
            };
        }, { reason: 'settings.update-config-bundle' });
    });

    router.post('/api/member', async (req, res) => {
        const input = parseInput(createMemberSchema, req.body, '姓名不可為空');
        const priorBalance = input.priorBalance === '' || input.priorBalance == null
            ? 0
            : parseMoney(input.priorBalance, '期初餘額', { allowNegative: true });
        const customFee = input.customFee === '' || input.customFee == null
            ? null
            : parseMoney(input.customFee, '自訂月費');
        await mutateAndSend(runtime, res, db => {
            if (db.members.some(member => member.name === input.name)) {
                throw httpError(400, '該成員已存在');
            }
            const member: Member = {
                id: generateId('m'),
                name: input.name,
                priorBalance,
                customFee
            };
            db.members.push(member);
            return {
                event: {
                    type: 'member.created',
                    summary: `新增成員 ${member.name}`,
                    entityType: 'member',
                    entityId: member.id,
                    payload: { memberId: member.id, memberName: member.name }
                }
            };
        }, { reason: 'member.create' });
    });

    router.delete('/api/member/:id', async (req, res) => {
        const { id } = parseInput(idParamsSchema, req.params, '成員 ID 不合法');
        await mutateAndSend(runtime, res, db => {
            const member = db.members.find(item => item.id === id);
            if (!member) throw httpError(404, '成員不存在');
            if (member.status === 'archived' || member.archivedAt) throw httpError(409, '成員已停用');

            const archivedAt = new Date().toISOString();
            const archivedMonth = db.currentMonth;
            const stopMonth = previousMonthString(db.currentMonth) || db.currentMonth;
            Object.assign(member, {
                status: 'archived',
                archivedAt,
                archivedBy: 'local-admin',
                archivedMonth,
                archiveReason: '使用者停用'
            });
            let closedSubscriptions = 0;
            for (const subscription of db.subscriptions) {
                if (!isMemberRecord(subscription, member)) continue;
                if (!subscription.exitMonth || subscription.exitMonth >= db.currentMonth) {
                    subscription.exitMonth = stopMonth;
                    Object.assign(subscription, { archivedWithMemberAt: archivedAt });
                    closedSubscriptions += 1;
                }
            }
            return {
                event: {
                    type: 'member.archived',
                    summary: `停用成員 ${member.name}`,
                    entityType: 'member',
                    entityId: member.id,
                    payload: { memberId: member.id, memberName: member.name, archivedMonth, closedSubscriptions }
                }
            };
        }, { reason: 'member.archive' });
    });

    router.post('/api/platform', async (req, res) => {
        const input = parseInput(createPlatformSchema, req.body, '平台名稱不可為空');
        const billingMode = input.billingMode || 'fixed';
        const price = billingMode === 'split' ? 0 : parseMoney(input.price || 0, '固定單人月費');
        const totalCost = billingMode === 'split' ? parseMoney(input.totalCost || 0, '平台總月費') : 0;
        await mutateAndSend(runtime, res, db => {
            if (db.platforms.some(platform => platform.name === input.name)) {
                throw httpError(400, '該平台已存在');
            }
            const platform: Platform = {
                id: generateId('p'),
                name: input.name,
                price,
                billingMode,
                totalCost
            };
            db.platforms.push(platform);
            return {
                event: {
                    type: 'platform.created',
                    summary: `新增平台 ${platform.name}`,
                    entityType: 'platform',
                    entityId: platform.id,
                    payload: { platformId: platform.id, platformName: platform.name, billingMode: platform.billingMode }
                }
            };
        }, { reason: 'platform.create' });
    });

    router.delete('/api/platform/:id', async (req, res) => {
        const { id } = parseInput(idParamsSchema, req.params, '平台 ID 不合法');
        await mutateAndSend(runtime, res, db => {
            const platform = db.platforms.find(item => item.id === id);
            if (!platform) throw httpError(404, '平台不存在');
            if (platform.status === 'archived' || platform.archivedAt) throw httpError(409, '平台已停用');

            const archivedAt = new Date().toISOString();
            const archivedMonth = db.currentMonth;
            const stopMonth = previousMonthString(db.currentMonth) || db.currentMonth;
            Object.assign(platform, {
                status: 'archived',
                archivedAt,
                archivedBy: 'local-admin',
                archivedMonth,
                archiveReason: '使用者停用'
            });
            let closedSubscriptions = 0;
            for (const subscription of db.subscriptions) {
                if (!isPlatformRecord(subscription, platform)) continue;
                if (!subscription.exitMonth || subscription.exitMonth >= db.currentMonth) {
                    subscription.exitMonth = stopMonth;
                    Object.assign(subscription, { archivedWithPlatformAt: archivedAt });
                    closedSubscriptions += 1;
                }
            }
            return {
                event: {
                    type: 'platform.archived',
                    summary: `停用平台 ${platform.name}`,
                    entityType: 'platform',
                    entityId: platform.id,
                    payload: { platformId: platform.id, platformName: platform.name, archivedMonth, closedSubscriptions }
                }
            };
        }, { reason: 'platform.archive' });
    });

    return router;
}
