import crypto from 'node:crypto';
import type { Response } from 'express';
import {
    appendLedgerEvent,
    findAccountingWarnings,
    getLedgerSummary,
    getSystemSnapshot,
    resolveMember
} from '../../lib/accounting.js';
import { getCanonicalPersistedFingerprint } from '../../lib/db.js';
import type { Database, LedgerEvent, Member } from '../../src/types/billing.js';
import { httpError } from '../middleware/error.js';
import {
    MutationPersistenceError,
    replacePersistedDatabase,
    type MutationOptions,
    type Runtime
} from '../runtime.js';

export type LedgerEventDraft = Partial<LedgerEvent> & { type: string };
export type MutationOutcome = {
    extra?: Record<string, unknown>;
    event?: LedgerEventDraft | null;
};

export function readDatabase(runtime: Runtime): Database {
    const db = runtime.readDB();
    if (!db) throw httpError(500, 'Database error');
    return db;
}

export function withAudit(db: Database): Database & { _audit: Record<string, unknown> } {
    return {
        ...db,
        _audit: {
            generatedAt: new Date().toISOString(),
            warnings: findAccountingWarnings(db),
            ledger: getLedgerSummary(db),
            snapshot: getSystemSnapshot(db)
        }
    };
}

export function sendDatabase(res: Response, db: Database, extra: Record<string, unknown> = {}): void {
    res.json({ success: true, ...extra, data: withAudit(db) });
}

export async function mutateAndSend(
    runtime: Runtime,
    res: Response,
    mutator: (db: Database) => MutationOutcome | void,
    options: MutationOptions = {}
): Promise<void> {
    try {
        const { data, value } = await runtime.mutateDB(db => {
            const outcome = mutator(db) || {};
            if (outcome.event) appendLedgerEvent(db, outcome.event);
            return outcome;
        }, options);
        sendDatabase(res, data, value.extra || {});
    } catch (error) {
        if (error instanceof MutationPersistenceError) {
            res.status(500).json({ error: '資料寫入失敗，已停止本次操作' });
            return;
        }
        throw error;
    }
}

export async function writeAndSend(
    runtime: Runtime,
    res: Response,
    db: Database,
    extra: Record<string, unknown> = {},
    event: LedgerEventDraft | null = null
): Promise<void> {
    try {
        const baseFingerprint = getCanonicalPersistedFingerprint(db);
        const { data } = await runtime.mutateDB(freshDb => {
            if (getCanonicalPersistedFingerprint(freshDb) !== baseFingerprint) {
                throw new Error('Stale database snapshot');
            }
            replacePersistedDatabase(freshDb, db);
            if (event) appendLedgerEvent(freshDb, event);
        }, { reason: 'legacy-route-write' });
        sendDatabase(res, data, extra);
    } catch (error) {
        if (error instanceof MutationPersistenceError || error instanceof Error) {
            res.status(500).json({ error: '資料寫入失敗，已停止本次操作' });
            return;
        }
        throw error;
    }
}

export function generateId(prefix: string): string {
    return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
}

export function parseMoney(value: unknown, field: string, { allowNegative = false } = {}): number {
    const amount = typeof value === 'number' ? value : Number.parseFloat(String(value));
    if (!Number.isFinite(amount)) throw httpError(400, `${field} 必須是有效數字`);
    if (!allowNegative && amount < 0) throw httpError(400, `${field} 不可為負數`);
    return amount;
}

export function assertMemberExists(
    db: Database,
    memberRef: { memberName?: string; memberId?: string }
): Member {
    const member = resolveMember(db, memberRef);
    if (!member) {
        throw httpError(400, `找不到成員：${memberRef.memberName || memberRef.memberId || JSON.stringify(memberRef)}`);
    }
    return member;
}

export function voidTransaction<
    T extends { status?: string; voidedAt?: string; voidedBy?: string; voidReason?: string }
>(record: T, reason = '使用者作廢'): T {
    const now = new Date().toISOString();
    return Object.assign(record, {
        status: 'voided',
        voidedAt: record.voidedAt || now,
        voidedBy: record.voidedBy || 'local-admin',
        voidReason: record.voidReason || reason
    });
}
