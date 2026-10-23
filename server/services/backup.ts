import crypto from 'node:crypto';
import type { Client, Transaction, Row } from '@libsql/client';
import { appendLedgerEvent, findAccountingWarnings, getSystemSnapshot, normalizeDatabaseRelations } from '../../lib/accounting.js';
import { getCanonicalPersistedFingerprint, loadFromConnection, withWriteTransaction, writeDatabase, verifyDatabase } from '../../lib/db.js';
import type { Database, LedgerEvent } from '../../src/types/billing.js';
import { httpError } from '../middleware/error.js';

type Snapshot = Record<string, unknown>;

interface Delta {
    label: string;
    before: unknown;
    after: unknown;
    text: string;
}

function describeDelta(
    label: string,
    before: unknown,
    after: unknown,
    formatter: (value: unknown) => string = value => String(value)
): Delta | null {
    if (before === after) return null;
    return { label, before, after, text: `${label}: ${formatter(before)} -> ${formatter(after)}` };
}

export function compareSnapshots(currentSnapshot: Snapshot, targetSnapshot: Snapshot): {
    sameBusinessState: boolean;
    changeCount: number;
    summary: string;
    changes: Delta[];
} {
    if (!currentSnapshot || !targetSnapshot) {
        return { sameBusinessState: false, changeCount: 0, summary: '無法比較目前資料與備份內容', changes: [] };
    }

    const money = (value: unknown) => `$${Number(value || 0).toLocaleString()}`;
    const plain = (value: unknown) => String(value ?? '—');
    const currentTotals = currentSnapshot.totals as Snapshot | undefined;
    const targetTotals = targetSnapshot.totals as Snapshot | undefined;
    const currentCounts = currentSnapshot.counts as Snapshot | undefined;
    const targetCounts = targetSnapshot.counts as Snapshot | undefined;
    const changes = [
        describeDelta('帳期', currentSnapshot.currentMonth, targetSnapshot.currentMonth, plain),
        describeDelta('本期待收', currentTotals?.receivable, targetTotals?.receivable, money),
        describeDelta('已入帳', currentTotals?.paid, targetTotals?.paid, money),
        describeDelta('成員數', currentCounts?.members, targetCounts?.members, plain),
        describeDelta('活躍設定數', currentCounts?.subscriptions, targetCounts?.subscriptions, plain),
        describeDelta('付款筆數', currentCounts?.payments, targetCounts?.payments, plain),
        describeDelta('臨時加帳筆數', currentCounts?.tempCharges, targetCounts?.tempCharges, plain),
        describeDelta('歷史月份數', currentCounts?.history, targetCounts?.history, plain),
        describeDelta('事件鏈筆數', currentCounts?.ledger, targetCounts?.ledger, plain)
    ].filter((change): change is Delta => change !== null);

    const sameBusinessState = currentSnapshot.fingerprint === targetSnapshot.fingerprint;
    return {
        sameBusinessState,
        changeCount: changes.length,
        summary: sameBusinessState ? '和目前帳務內容相同' : changes.slice(0, 3).map(change => change.text).join('；'),
        changes
    };
}

const REGULAR_BACKUP_RE = /^database_(\d{8})_\d{6}(?:(?:_\d{3})?_[a-f0-9]{8})?\.db$/;

export type BackupRetentionPolicy = {
    keepRecent: number;
    keepDaily: number;
    keepMonthly: number;
};

/**
 * Keeps the newest `keepRecent` backups plus the newest backup of each of the latest
 * `keepDaily` days and `keepMonthly` months, so a burst of writes cannot rotate away
 * every snapshot older than an hour. Returns the regular backups that may be deleted.
 */
export function selectBackupsToPrune(filenames: string[], policy: BackupRetentionPolicy): string[] {
    const newestFirst = filenames.filter(filename => REGULAR_BACKUP_RE.test(filename)).sort().reverse();
    const keep = new Set(newestFirst.slice(0, policy.keepRecent));
    const keepNewestPerPeriod = (periodOf: (day: string) => string, limit: number): void => {
        const periods = new Set<string>();
        for (const filename of newestFirst) {
            const period = periodOf(REGULAR_BACKUP_RE.exec(filename)![1]!);
            if (periods.has(period)) continue;
            if (periods.size >= limit) break;
            periods.add(period);
            keep.add(filename);
        }
    };
    keepNewestPerPeriod(day => day, policy.keepDaily);
    keepNewestPerPeriod(day => day.slice(0, 6), policy.keepMonthly);
    return newestFirst.filter(filename => !keep.has(filename));
}

function backupLabel(filename: string): string {
    return filename.match(/database_(\d{8}_\d{6})/)?.[1] || filename;
}

export function assertBackupId(filename: string): void {
    if (!REGULAR_BACKUP_RE.test(filename)) throw httpError(400, '備份檔名格式不合法');
}

function decodeBackup(row: Row): Database {
    try {
        const db = normalizeDatabaseRelations(JSON.parse(String(row.snapshot_json)));
        if (getCanonicalPersistedFingerprint(db) !== row.fingerprint) throw new Error('Fingerprint mismatch');
        if (Buffer.byteLength(String(row.snapshot_json), 'utf8') !== Number(row.size)) throw new Error('Size mismatch');
        const warnings = findAccountingWarnings(db).filter(w => w.severity === 'high' || w.severity === 'critical');
        if (warnings.length) throw new Error('Domain integrity failed');
        return db;
    } catch { throw httpError(400, '備份檔案無效或已損毀'); }
}

export function createBackupService({ client, maxBackups = 50, keepDailyBackups = 30, keepMonthlyBackups = 12 }: {
    client: Client; maxBackups?: number; keepDailyBackups?: number; keepMonthlyBackups?: number;
}) {
    async function insertBackup(tx: Transaction, data: Database, reason: string, keepIds: string[] = []): Promise<string> {
        const now = new Date();
        const parts = new Intl.DateTimeFormat('en-GB', {
            timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
        }).formatToParts(now);
        const part = (name: Intl.DateTimeFormatPartTypes) => parts.find(p => p.type === name)!.value;
        const timestamp = `${part('year')}${part('month')}${part('day')}_${part('hour')}${part('minute')}${part('second')}_${String(now.getMilliseconds()).padStart(3, '0')}`;
        const id = `database_${timestamp}_${crypto.randomUUID().slice(0, 8)}.db`;
        const json = JSON.stringify(data);
        await tx.execute({
            sql: 'INSERT INTO backups (id,created_at,reason,fingerprint,size,snapshot_json) VALUES (?,?,?,?,?,?)',
            args: [id, now.toISOString(), reason, getCanonicalPersistedFingerprint(data), Buffer.byteLength(json, 'utf8'), json]
        });
        const ids = (await tx.execute('SELECT id FROM backups')).rows.map(row => String(row.id));
        for (const removed of selectBackupsToPrune(ids, { keepRecent: maxBackups, keepDaily: keepDailyBackups, keepMonthly: keepMonthlyBackups })) {
            if (keepIds.includes(removed)) continue;
            await tx.execute({ sql: 'DELETE FROM backups WHERE id=?', args: [removed] });
        }
        return id;
    }
    async function backupDB(reason = 'manual', recordEvent = false): Promise<string> {
        return withWriteTransaction(client, async tx => {
            const previous = await loadFromConnection(tx);
            const id = await insertBackup(tx, previous, reason);
            if (recordEvent) {
                const next = structuredClone(previous);
                appendLedgerEvent(next, { type: 'backup.created', summary: `建立手動備份 ${id}`, entityType: 'backup', entityId: id, payload: { filename: id } });
                await writeDatabase(tx, previous, next);
                await verifyDatabase(tx, next);
            }
            return id;
        });
    }
    async function getBackup(filename: string, db: Client | Transaction = client): Promise<Row> {
        assertBackupId(filename);
        const row = (await db.execute({ sql: 'SELECT * FROM backups WHERE id=?', args: [filename] })).rows[0];
        if (!row) throw httpError(404, '備份檔案不存在');
        return row;
    }
    async function validateBackupDatabase(filename: string): Promise<Database> {
        return decodeBackup(await getBackup(filename));
    }
    async function restoreSQLiteFromBackup(filename: string, event: Partial<LedgerEvent> & { type: string }): Promise<Database> {
        return withWriteTransaction(client, async tx => {
            const target = decodeBackup(await getBackup(filename, tx));
            const previous = await loadFromConnection(tx);
            // The backup being restored must survive the safety snapshot's pruning.
            await insertBackup(tx, previous, 'restore.safety', [filename]);
            appendLedgerEvent(target, event);
            await writeDatabase(tx, previous, target);
            await verifyDatabase(tx, target);
            return target;
        });
    }
    async function deleteBackup(tx: Transaction, filename: string): Promise<void> {
        await getBackup(filename, tx);
        await tx.execute({ sql: 'DELETE FROM backups WHERE id=?', args: [filename] });
    }
    function analyzeRow(row: Row, currentSnapshot: Snapshot): Snapshot {
        const filename = String(row.id);
        const base = { filename, label: backupLabel(filename), size: Number(row.size), mtime: String(row.created_at), reason: String(row.reason) };
        try {
            const snapshot = getSystemSnapshot(decodeBackup(row)) as unknown as Snapshot;
            return { ...base, readable: true, snapshot, restoreImpact: compareSnapshots(currentSnapshot, snapshot) };
        } catch {
            return { ...base, readable: false, error: '備份內容無法讀取', restoreImpact: { sameBusinessState: false, changeCount: 0, summary: '備份內容無法讀取', changes: [] } };
        }
    }
    async function analyzeBackupFile(filename: string, currentSnapshot: Snapshot = {}): Promise<Snapshot> {
        return analyzeRow(await getBackup(filename), currentSnapshot);
    }
    async function listBackupInventory(currentDb: Database): Promise<Snapshot> {
        const current = getSystemSnapshot(currentDb) as unknown as Snapshot;
        const rows = (await client.execute('SELECT * FROM backups ORDER BY id DESC')).rows;
        return { current, backups: rows.map(row => analyzeRow(row, current)) };
    }
    return { insertBackup, backupDB, validateBackupDatabase, restoreSQLiteFromBackup, deleteBackup, analyzeBackupFile, listBackupInventory };
}
