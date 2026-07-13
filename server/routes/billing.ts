import { Router } from 'express';
import { z } from 'zod';
import { appendLedgerEvent, findRecentDuplicateTransaction, isTransactionVoided } from '../../lib/accounting.js';
import type { Payment, TempCharge } from '../../src/types/billing.js';
import { nonEmptyIdSchema, parseInput } from '../middleware/validation.js';
import { MutationPersistenceError, type Runtime } from '../runtime.js';
import {
    assertMemberExists,
    generateId,
    parseMoney,
    sendDatabase,
    voidTransaction,
} from './shared.js';

const moneyInputSchema = z.union([z.number(), z.string().trim().min(1).max(100)]);
const memberReferenceSchema = {
    memberId: z.string().trim().min(1).max(200).optional(),
    memberName: z.string().trim().min(1).max(200).optional()
};
const paymentSchema = z.object({
    ...memberReferenceSchema,
    date: z.string().max(50).optional(),
    amount: moneyInputSchema,
    method: z.string().max(200).optional(),
    cycle: z.string().max(50).optional(),
    note: z.string().max(2_000).optional()
}).refine(value => Boolean(value.memberId || value.memberName));
const chargeSchema = z.object({
    ...memberReferenceSchema,
    date: z.string().max(50).optional(),
    amount: moneyInputSchema,
    desc: z.string().max(2_000).optional()
}).refine(value => Boolean(value.memberId || value.memberName));
const idParamsSchema = z.object({ id: nonEmptyIdSchema });
const voidBodySchema = z.object({ reason: z.string().max(500).optional() }).passthrough();

class DuplicateTransactionError extends Error {
    constructor(message: string, readonly duplicate: Record<string, unknown>) {
        super(message);
        this.name = 'DuplicateTransactionError';
    }
}

export function createBillingRouter(runtime: Runtime): Router {
    const router = Router();

    router.post('/api/payment', async (req, res) => {
        const input = parseInput(paymentSchema, req.body, 'Missing required fields');
        const amount = parseMoney(input.amount, '付款金額');
        try {
            const { data } = await runtime.mutateDB(db => {
                const member = assertMemberExists(db, {
                    ...(input.memberId ? { memberId: input.memberId } : {}),
                    ...(input.memberName ? { memberName: input.memberName } : {})
                });
                const newPayment: Payment = {
                    id: generateId('pay'),
                    memberId: member.id,
                    memberName: member.name,
                    date: input.date || new Date().toISOString().split('T')[0]!,
                    amount,
                    method: input.method || '轉帳',
                    cycle: input.cycle || db.currentMonth.replace('/', ''),
                    note: input.note || '',
                    createdAt: new Date().toISOString()
                };

                const duplicate = findRecentDuplicateTransaction(db.payments, newPayment, { type: 'payment' });
                if (duplicate) {
                    const duplicatePayment = duplicate as Payment;
                    throw new DuplicateTransactionError('疑似重複付款：10 分鐘內已有相同收款紀錄', {
                        id: duplicatePayment.id,
                        memberName: duplicatePayment.memberName,
                        amount: duplicatePayment.amount,
                        date: duplicatePayment.date,
                        method: duplicatePayment.method,
                        note: duplicatePayment.note || '',
                        createdAt: duplicatePayment.createdAt || null
                    });
                }

                db.payments.push(newPayment);
                appendLedgerEvent(db, {
                    type: 'payment.created',
                    summary: `${member.name} 付款 ${newPayment.amount}`,
                    entityType: 'payment',
                    entityId: newPayment.id,
                    amount: newPayment.amount,
                    payload: { memberId: member.id, memberName: member.name, method: newPayment.method, date: newPayment.date }
                });
            }, { reason: 'payment.create' });
            sendDatabase(res, data);
        } catch (error) {
            if (error instanceof DuplicateTransactionError) {
                res.status(409).json({ error: error.message, duplicate: error.duplicate });
                return;
            }
            if (error instanceof MutationPersistenceError) {
                res.status(500).json({ error: '資料寫入失敗，已停止本次操作' });
                return;
            }
            throw error;
        }
    });

    router.delete('/api/payment/:id', async (req, res) => {
        const { id } = parseInput(idParamsSchema, req.params, '付款記錄 ID 不合法');
        const { reason } = parseInput(voidBodySchema, req.body ?? {}, '作廢原因格式不正確');
        try {
            const { data } = await runtime.mutateDB(db => {
                const payment = db.payments.find(item => item.id === id);
                if (!payment) { throw Object.assign(new Error('付款記錄不存在'), { status: 404 }); }
                if (isTransactionVoided(payment)) { throw Object.assign(new Error('付款記錄已作廢'), { status: 409 }); }

                voidTransaction(payment, reason);
                appendLedgerEvent(db, {
                    type: 'payment.voided',
                    summary: `作廢 ${payment.memberName} 付款 ${payment.amount}`,
                    entityType: 'payment',
                    entityId: id,
                    amount: payment.amount,
                    payload: { voided: payment }
                });
            });
            sendDatabase(res, data);
        } catch (error) {
            if (error instanceof MutationPersistenceError) {
                res.status(500).json({ error: '資料寫入失敗，已停止本次操作' });
                return;
            }
            throw error;
        }
    });

    router.post('/api/temp-charge', async (req, res) => {
        const input = parseInput(chargeSchema, req.body, 'Missing required fields');
        const amount = parseMoney(input.amount, '加帳金額');
        try {
            const { data } = await runtime.mutateDB(db => {
                const member = assertMemberExists(db, {
                    ...(input.memberId ? { memberId: input.memberId } : {}),
                    ...(input.memberName ? { memberName: input.memberName } : {})
                });
                const newCharge: TempCharge = {
                    id: generateId('chg'),
                    memberId: member.id,
                    memberName: member.name,
                    date: input.date || new Date().toISOString().split('T')[0]!,
                    amount,
                    desc: input.desc || '',
                    createdAt: new Date().toISOString()
                };

                const duplicate = findRecentDuplicateTransaction(db.tempCharges, newCharge, { type: 'charge' });
                if (duplicate) {
                    const duplicateCharge = duplicate as TempCharge;
                    throw new DuplicateTransactionError('疑似重複加帳：10 分鐘內已有相同臨時費用紀錄', {
                        id: duplicateCharge.id,
                        memberName: duplicateCharge.memberName,
                        amount: duplicateCharge.amount,
                        date: duplicateCharge.date,
                        desc: duplicateCharge.desc || '',
                        createdAt: duplicateCharge.createdAt || null
                    });
                }

                db.tempCharges.push(newCharge);
                appendLedgerEvent(db, {
                    type: 'charge.created',
                    summary: `${member.name} 加帳 ${newCharge.amount}`,
                    entityType: 'tempCharge',
                    entityId: newCharge.id,
                    amount: newCharge.amount,
                    payload: { memberId: member.id, memberName: member.name, desc: newCharge.desc, date: newCharge.date }
                });
            }, { reason: 'temp-charge.create' });
            sendDatabase(res, data);
        } catch (error) {
            if (error instanceof DuplicateTransactionError) {
                res.status(409).json({ error: error.message, duplicate: error.duplicate });
                return;
            }
            if (error instanceof MutationPersistenceError) {
                res.status(500).json({ error: '資料寫入失敗，已停止本次操作' });
                return;
            }
            throw error;
        }
    });

    router.delete('/api/temp-charge/:id', async (req, res) => {
        const { id } = parseInput(idParamsSchema, req.params, '臨時加帳 ID 不合法');
        const { reason } = parseInput(voidBodySchema, req.body ?? {}, '作廢原因格式不正確');
        try {
            const { data } = await runtime.mutateDB(db => {
                const charge = db.tempCharges.find(item => item.id === id);
                if (!charge) { throw Object.assign(new Error('臨時加帳記錄不存在'), { status: 404 }); }
                if (isTransactionVoided(charge)) { throw Object.assign(new Error('臨時加帳記錄已作廢'), { status: 409 }); }

                voidTransaction(charge, reason);
                appendLedgerEvent(db, {
                    type: 'charge.voided',
                    summary: `作廢 ${charge.memberName} 加帳 ${charge.amount}`,
                    entityType: 'tempCharge',
                    entityId: id,
                    amount: charge.amount,
                    payload: { voided: charge }
                });
            });
            sendDatabase(res, data);
        } catch (error) {
            if (error instanceof MutationPersistenceError) {
                res.status(500).json({ error: '資料寫入失敗，已停止本次操作' });
                return;
            }
            throw error;
        }
    });

    return router;
}
