import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import SqliteDatabase from 'better-sqlite3';
import { appendLedgerEvent, findAccountingWarnings, getSystemSnapshot } from '../../lib/accounting.js';
import {
    backupSQLite,
    getCanonicalPersistedFingerprint,
    loadFromSQLite,
    saveToSQLite
} from '../../lib/db.js';
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

function backupLabel(filename: string): string {
    return filename.match(/database_(\d{8}_\d{6})/)?.[1] || filename;
}

function removeSqliteFiles(sqlitePath: string): void {
    for (const suffix of ['', '-wal', '-shm']) {
        fs.rmSync(`${sqlitePath}${suffix}`, { force: true });
    }
}

function renameSqliteFiles(sourcePath: string, targetPath: string): void {
    for (const suffix of ['', '-wal', '-shm']) {
        const source = `${sourcePath}${suffix}`;
        if (fs.existsSync(source)) fs.renameSync(source, `${targetPath}${suffix}`);
    }
}

function verifySqlite(sqlitePath: string, expectedFingerprint?: string): Database {
    const sqlite = new SqliteDatabase(sqlitePath, { fileMustExist: true });
    try {
        if (sqlite.pragma('integrity_check', { simple: true }) !== 'ok') {
            throw new Error('SQLite integrity check failed');
        }
    } finally {
        sqlite.close();
    }
    const db = loadFromSQLite(sqlitePath);
    if (expectedFingerprint && getCanonicalPersistedFingerprint(db) !== expectedFingerprint) {
        throw new Error('SQLite fingerprint verification failed');
    }
    return db;
}

function assertDomainIntegrity(db: Database): void {
    const blockingWarnings = findAccountingWarnings(db)
        .filter(warning => warning.severity === 'high' || warning.severity === 'critical');
    if (blockingWarnings.length) {
        throw new Error(
            blockingWarnings.slice(0, 3).map(warning => `${warning.code}: ${warning.detail}`).join('; ')
        );
    }
}

export function createBackupService({
    backupDir,
    sqlitePath,
    maxBackups = 50,
    onlineBackup = backupSQLite
}: {
    backupDir: string;
    sqlitePath: string;
    maxBackups?: number;
    onlineBackup?: typeof backupSQLite;
}) {
    function safeBackupPath(filename: string): string {
        if (!/^database_\d{8}_\d{6}(?:(?:_\d{3})?_[a-f0-9]{8})?\.db$/.test(filename)) {
            throw httpError(400, '備份檔名格式不合法');
        }
        const resolved = path.resolve(backupDir, filename);
        if (!resolved.startsWith(`${path.resolve(backupDir)}${path.sep}`)) {
            throw httpError(400, '備份路徑不合法');
        }
        return resolved;
    }

    function validateBackupDatabase(backupPath: string): Database {
        try {
            const sqlite = new SqliteDatabase(backupPath, { readonly: true, fileMustExist: true });
            try {
                if (sqlite.pragma('integrity_check', { simple: true }) !== 'ok') {
                    throw new Error('SQLite integrity check failed');
                }
            } finally {
                sqlite.close();
            }
            const db = loadFromSQLite(backupPath);
            assertDomainIntegrity(db);
            return db;
        } catch {
            throw httpError(400, '備份檔案無效或已損毀');
        }
    }

    async function restoreSQLiteFromBackup(
        backupPath: string,
        restoreEvent: Partial<LedgerEvent> & { type: string }
    ): Promise<Database> {
        const stagePath = path.join(path.dirname(sqlitePath), `.restore-stage-${crypto.randomUUID()}.db`);
        const safetyPath = path.join(backupDir, `.restore-safety-${crypto.randomUUID()}.db`);
        let safetyVerified = false;
        let committed = false;
        removeSqliteFiles(stagePath);
        removeSqliteFiles(safetyPath);
        try {
            await onlineBackup(backupPath, stagePath);
            const stagedDb = verifySqlite(stagePath);
            assertDomainIntegrity(stagedDb);
            appendLedgerEvent(stagedDb, restoreEvent);
            saveToSQLite(stagePath, stagedDb);
            const expectedFingerprint = getCanonicalPersistedFingerprint(stagedDb);
            verifySqlite(stagePath, expectedFingerprint);

            await onlineBackup(sqlitePath, safetyPath);
            verifySqlite(safetyPath);
            safetyVerified = true;

            await onlineBackup(stagePath, sqlitePath);
            const restoredDb = verifySqlite(sqlitePath, expectedFingerprint);
            committed = true;
            removeSqliteFiles(safetyPath);
            return restoredDb;
        } catch (error) {
            if (safetyVerified) {
                try {
                    const safetyFingerprint = getCanonicalPersistedFingerprint(loadFromSQLite(safetyPath));
                    await onlineBackup(safetyPath, sqlitePath);
                    verifySqlite(sqlitePath, safetyFingerprint);
                    removeSqliteFiles(safetyPath);
                } catch (rollbackError) {
                    throw new Error(
                        `Restore failed and rollback failed: ${String(error)}; ${String(rollbackError)}`,
                        { cause: rollbackError }
                    );
                }
            }
            throw error;
        } finally {
            removeSqliteFiles(stagePath);
            if (committed) removeSqliteFiles(safetyPath);
        }
    }

    function moveBackupToTombstone(filename: string): string {
        const backupPath = safeBackupPath(filename);
        if (!fs.existsSync(backupPath)) throw httpError(404, '備份檔案不存在');
        const tombstoneFilename = `.backup-tombstone-${filename}-${crypto.randomUUID()}.db`;
        const tombstonePath = path.join(backupDir, tombstoneFilename);
        renameSqliteFiles(backupPath, tombstonePath);
        return tombstonePath;
    }

    function restoreBackupTombstone(tombstonePath: string, filename: string): void {
        renameSqliteFiles(tombstonePath, safeBackupPath(filename));
    }

    function removeBackupTombstone(tombstonePath: string): void {
        removeSqliteFiles(tombstonePath);
    }

    async function backupDB(): Promise<string | null> {
        try {
            const now = new Date();
            const timestamp = [
                now.getFullYear(),
                String(now.getMonth() + 1).padStart(2, '0'),
                String(now.getDate()).padStart(2, '0'),
                '_',
                String(now.getHours()).padStart(2, '0'),
                String(now.getMinutes()).padStart(2, '0'),
                String(now.getSeconds()).padStart(2, '0'),
                '_',
                String(now.getMilliseconds()).padStart(3, '0')
            ].join('');
            const backupPath = path.join(backupDir, `database_${timestamp}_${crypto.randomUUID().slice(0, 8)}.db`);
            await onlineBackup(sqlitePath, backupPath);

            const files = fs.readdirSync(backupDir)
                .filter(filename => filename.startsWith('database_') && filename.endsWith('.db'))
                .sort()
                .reverse();
            for (const filename of files.slice(maxBackups)) {
                fs.unlinkSync(path.join(backupDir, filename));
            }
            return backupPath;
        } catch (error) {
            console.error('Backup failed:', error);
            return null;
        }
    }

    function analyzeBackupFile(filename: string, currentSnapshot: Snapshot | null = null): Snapshot {
        const backupPath = safeBackupPath(filename);
        const stats = fs.statSync(backupPath);
        const base = {
            filename,
            label: backupLabel(filename),
            size: stats.size,
            mtime: stats.mtime.toISOString()
        };

        try {
            const snapshot = getSystemSnapshot(loadFromSQLite(backupPath)) as unknown as Snapshot;
            return {
                ...base,
                readable: true,
                snapshot,
                restoreImpact: compareSnapshots(currentSnapshot || {}, snapshot)
            };
        } catch (error) {
            return {
                ...base,
                readable: false,
                error: (error as Error).message || '備份內容無法讀取',
                restoreImpact: {
                    sameBusinessState: false,
                    changeCount: 0,
                    summary: '備份內容無法讀取',
                    changes: []
                }
            };
        }
    }

    function listBackupInventory(currentDb: Database): Snapshot {
        const current = getSystemSnapshot(currentDb) as unknown as Snapshot;
        const backups = fs.readdirSync(backupDir)
            .filter(filename => filename.startsWith('database_') && filename.endsWith('.db'))
            .sort()
            .reverse()
            .map(filename => analyzeBackupFile(filename, current));
        return { current, backups };
    }

    return {
        safeBackupPath,
        validateBackupDatabase,
        restoreSQLiteFromBackup,
        moveBackupToTombstone,
        restoreBackupTombstone,
        removeBackupTombstone,
        backupDB,
        analyzeBackupFile,
        listBackupInventory
    };
}
