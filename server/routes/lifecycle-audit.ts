import { Router } from 'express';
import {
    appendLedgerEvent,
    calculateCurrentMonthBalances,
    ensureHistorySeals,
    findAccountingWarnings,
    getClosePreview,
    getLedgerSummary,
    isMemberRecord,
    monthToCode
} from '../../lib/accounting.js';
import { getLifecycleStatus, getSystemMonth } from '../../lib/lifecycle.js';
import { emptyPayloadSchema, parseInput } from '../middleware/validation.js';
import { MutationPersistenceError, type Runtime } from '../runtime.js';
import { readDatabase, sendDatabase } from './shared.js';

class SettlementConflictError extends Error {
    constructor(readonly payload: Record<string, unknown>) {
        super(String(payload.error || 'Settlement blocked'));
        this.name = 'SettlementConflictError';
    }
}

export function createLifecycleAuditRouter(runtime: Runtime): Router {
    const router = Router();

    router.post('/api/settle', async (req, res) => {
        parseInput(emptyPayloadSchema, req.body ?? {}, 'Invalid settle payload');
        const systemMonth = getSystemMonth();
        try {
            const { data } = await runtime.mutateDB(db => {
                const dbCode = monthToCode(db.currentMonth);
                const systemCode = monthToCode(systemMonth);
                if (dbCode !== null && systemCode !== null && dbCode >= systemCode) {
                    throw new SettlementConflictError({
                        error: `帳期已是最新（${db.currentMonth}），無需手動月結。帳期由系統依台北時間自動推進。`,
                        currentMonth: db.currentMonth,
                        systemMonth
                    });
                }

                const preview = getClosePreview(db);
                if (!preview.ready) {
                    throw new SettlementConflictError({ error: '月結預檢未通過，請先處理高風險項目', preview });
                }

                const currentMonth = db.currentMonth;
                const [year, month] = currentMonth.split('/').map(Number);
                const balances = calculateCurrentMonthBalances(db);
                db.members = db.members.map(member => {
                    const balance = balances.find(item => isMemberRecord(item, member));
                    return { ...member, priorBalance: balance ? balance.endingBalance : member.priorBalance };
                });
                db.history.push({
                    month: currentMonth,
                    balances,
                    payments: [...db.payments],
                    tempCharges: [...db.tempCharges]
                });
                ensureHistorySeals(db, { sealedAt: new Date().toISOString(), reason: 'month.settled' });

                const nextDate = new Date(Date.UTC(year!, month!, 1));
                const nextMonth = `${nextDate.getUTCFullYear()}/${String(nextDate.getUTCMonth() + 1).padStart(2, '0')}`;
                db.currentMonth = nextMonth;
                db.payments = [];
                db.tempCharges = [];
                appendLedgerEvent(db, {
                    type: 'month.settled',
                    summary: `完成 ${currentMonth} 月結，轉入 ${nextMonth}`,
                    entityType: 'settlement',
                    entityId: currentMonth,
                    amount: balances.reduce((sum, balance) => sum + balance.endingBalance, 0),
                    payload: { settledMonth: currentMonth, nextMonth, balancesCount: balances.length }
                });
            }, { reason: 'lifecycle.settle' });
            sendDatabase(res, data);
        } catch (error) {
            if (error instanceof SettlementConflictError) {
                res.status(409).json(error.payload);
                return;
            }
            if (error instanceof MutationPersistenceError) {
                res.status(500).json({ error: '資料寫入失敗，已停止本次操作' });
                return;
            }
            throw error;
        }
    });

    router.get('/api/close-preview', (_req, res) => {
        res.json({ success: true, preview: getClosePreview(readDatabase(runtime)) });
    });

    router.get('/api/audit', (_req, res) => {
        const db = readDatabase(runtime);
        res.json({
            success: true,
            generatedAt: new Date().toISOString(),
            warnings: findAccountingWarnings(db),
            ledger: getLedgerSummary(db)
        });
    });

    router.get('/api/lifecycle/status', (_req, res) => {
        res.json({ success: true, ...getLifecycleStatus(readDatabase(runtime)) });
    });

    router.get('/api/ledger', (_req, res) => {
        res.json({ success: true, ledger: getLedgerSummary(readDatabase(runtime)) });
    });

    return router;
}
