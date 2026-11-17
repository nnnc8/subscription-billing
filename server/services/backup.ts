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

const SHA256_HEX = /^[0-9a-f]{64}$/;
const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const UNREADABLE = '備份內容無法讀取';

/** Checks a stored snapshot the way restore does, and throws when restore must refuse it. */
function decodeSnapshot(json: string, fingerprint: string, size: number): Database {
    const db = normalizeDatabaseRelations(JSON.parse(json));
    const canonical = getCanonicalPersistedFingerprint(db);
    // fingerprint is the canonical JSON's sha256. A row older code wrote holds the JSON itself until backfilled.
    if (fingerprint !== sha256(canonical) && fingerprint !== canonical) throw new Error('Fingerprint mismatch');
    if (Buffer.byteLength(json, 'utf8') !== size) throw new Error('Size mismatch');
    const warnings = findAccountingWarnings(db).filter(w => w.severity === 'high' || w.severity === 'critical');
    if (warnings.length) throw new Error('Domain integrity failed');
    return db;
}

function decodeBackup(row: Row): Database {
    try { return decodeSnapshot(String(row.snapshot_json), String(row.fingerprint), Number(row.size)); }
    catch { throw httpError(400, '備份檔案無效或已損毀'); }
}

/** The summary column: the system snapshot of a backup restore accepts, otherwise JSON null. */
function summarizeSnapshot(json: string, fingerprint: string, size: number): string {
    try { return JSON.stringify(getSystemSnapshot(decodeSnapshot(json, fingerprint, size))); }
    catch { return 'null'; }
}

function parseSummary(value: unknown): Snapshot | null {
    if (typeof value !== 'string') return null;
    try {
        const summary: unknown = JSON.parse(value);
        return summary && typeof summary === 'object' && !Array.isArray(summary) ? summary as Snapshot : null;
    } catch { return null; }
}

/** Groups ids so each group's stored bytes stay under the limit; a larger row goes alone. */
function groupByBytes(rows: Row[], limit: number): string[][] {
    const groups: string[][] = [];
    let group: string[] = [];
    let bytes = 0;
    for (const row of rows) {
        if (group.length && (bytes + Number(row.bytes) > limit || group.length >= 100)) {
            groups.push(group);
            group = [];
            bytes = 0;
        }
        group.push(String(row.id));
        bytes += Number(row.bytes);
    }
    if (group.length) groups.push(group);
    return groups;
}

export function createBackupService({ client, maxBackups = 50, keepDailyBackups = 30, keepMonthlyBackups = 12, backfillBatchBytes = 2_000_000 }: {
    client: Client; maxBackups?: number; keepDailyBackups?: number; keepMonthlyBackups?: number;
    /** Stored bytes one backfill transaction may read; far below sqld's 10 MB response limit. */
    backfillBatchBytes?: number;
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
        const fingerprint = sha256(getCanonicalPersistedFingerprint(data));
        const size = Buffer.byteLength(json, 'utf8');
        await tx.execute({
            sql: 'INSERT INTO backups (id,created_at,reason,fingerprint,size,snapshot_json,summary) VALUES (?,?,?,?,?,?,?)',
            args: [id, now.toISOString(), reason, fingerprint, size, json, summarizeSnapshot(json, fingerprint, size)]
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
        assertBackupId(filename);
        const { rowsAffected } = await tx.execute({ sql: 'DELETE FROM backups WHERE id=?', args: [filename] });
        if (!rowsAffected) throw httpError(404, '備份檔案不存在');
    }
    /**
     * Gives rows written before migration 003, or by older code since, the sha256 fingerprint
     * and summary. Idempotent: each write transaction reads only rows still without a summary,
     * so concurrent cold starts never convert a row twice, and each reads a bounded number of bytes.
     */
    async function backfillBackupSummaries(): Promise<number> {
        const pending = (await client.execute(
            'SELECT id, length(CAST(fingerprint AS BLOB)) + length(CAST(snapshot_json AS BLOB)) AS bytes FROM backups WHERE summary IS NULL ORDER BY id'
        )).rows;
        let filled = 0;
        for (const ids of groupByBytes(pending, backfillBatchBytes)) {
            filled += await withWriteTransaction(client, async tx => {
                const rows = (await tx.execute({
                    sql: `SELECT id, fingerprint, size, snapshot_json FROM backups WHERE summary IS NULL AND id IN (${ids.map(() => '?').join(',')})`,
                    args: ids
                })).rows;
                if (rows.length) await tx.batch(rows.map(row => {
                    const stored = String(row.fingerprint);
                    // Hashing the stored value keeps a damaged row damaged: it still cannot match its snapshot.
                    const fingerprint = SHA256_HEX.test(stored) ? stored : sha256(stored);
                    return { sql: 'UPDATE backups SET fingerprint=?, summary=? WHERE id=?', args: [fingerprint, summarizeSnapshot(String(row.snapshot_json), fingerprint, Number(row.size)), String(row.id)] };
                }));
                return rows.length;
            });
        }
        return filled;
    }
    function describeRow(row: Row, snapshot: Snapshot | null, currentSnapshot: Snapshot): Snapshot {
        const filename = String(row.id);
        const base = { filename, label: backupLabel(filename), size: Number(row.size), mtime: String(row.created_at), reason: String(row.reason) };
        if (!snapshot) return { ...base, readable: false, error: UNREADABLE, restoreImpact: { sameBusinessState: false, changeCount: 0, summary: UNREADABLE, changes: [] } };
        return { ...base, readable: true, snapshot, restoreImpact: compareSnapshots(currentSnapshot, snapshot) };
    }
    async function analyzeBackupFile(filename: string, currentSnapshot: Snapshot = {}): Promise<Snapshot> {
        // A preview reads and verifies the full snapshot instead of trusting the stored summary.
        const row = await getBackup(filename);
        let snapshot: Snapshot | null = null;
        try { snapshot = getSystemSnapshot(decodeBackup(row)) as unknown as Snapshot; } catch { /* described as unreadable */ }
        return describeRow(row, snapshot, currentSnapshot);
    }
    async function listBackupInventory(currentDb: Database): Promise<Snapshot> {
        const current = getSystemSnapshot(currentDb) as unknown as Snapshot;
        // Only the stored summaries: every full snapshot together can exceed sqld's response limit.
        const rows = (await client.execute('SELECT id, created_at, reason, size, summary FROM backups ORDER BY id DESC')).rows;
        return { current, backups: rows.map(row => describeRow(row, parseSummary(row.summary), current)) };
    }
    return { insertBackup, backupDB, validateBackupDatabase, restoreSQLiteFromBackup, deleteBackup, backfillBackupSummaries, analyzeBackupFile, listBackupInventory };
}
