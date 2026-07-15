import crypto from 'node:crypto';
import fs from 'node:fs';
import { isIP } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import SqliteDatabase from 'better-sqlite3';
import { findAccountingWarnings, normalizeDatabaseRelations } from '../lib/accounting.js';
import {
    backupSQLite,
    getCanonicalPersistedFingerprint,
    initSQLite,
    loadFromSQLite,
    migrateJsonToSQLite,
    runMigrations,
    saveToSQLite
} from '../lib/db.js';
import { getPublicOrigin, isGoogleOAuthConfigured } from '../lib/google-oauth.js';
import { runLifecycleCatchUp } from '../lib/lifecycle.js';
import { invalidateRAGIndex } from '../lib/rag.js';
import type { AutomationProposal, Database } from '../src/types/billing.js';
import { createBackupService } from './services/backup.js';

const DEFAULT_ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export type RuntimeOptions = {
    rootDir?: string;
    env?: Record<string, string | undefined>;
    dataDir?: string;
    dbPath?: string;
    sqlitePath?: string;
    backupDir?: string;
    demoDbPath?: string;
    distDir?: string;
    migrationsDir?: string;
    /** Test-only injection for exercising stage/commit/rollback failure branches. */
    onlineBackup?: typeof backupSQLite;
};

export type MutationOptions = {
    reason?: string;
    backup?: boolean;
};

export type RuntimeReadiness = {
    status: 'starting' | 'ready' | 'blocked';
    reason?: string;
};

export type MutationResult<T> = {
    data: Database;
    value: T;
};

export class MutationPersistenceError extends Error {
    constructor(readonly cause: unknown) {
        super('Database mutation persistence failed');
        this.name = 'MutationPersistenceError';
    }
}

export class DomainValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'DomainValidationError';
    }
}

type QueueJob<T> = {
    execute: () => Promise<T>;
    resolve: (result: T) => void;
    reject: (error: unknown) => void;
};

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
    return Boolean(
        value
        && (typeof value === 'object' || typeof value === 'function')
        && typeof (value as { then?: unknown }).then === 'function'
    );
}

type TrustedRange =
    | { version: 4; network: number; mask: number }
    | { version: 6; network: bigint; mask: bigint };

function parseIPv4(value: string): number | null {
    if (isIP(value) !== 4) return null;
    const parts = value.split('.').map(Number);
    if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return null;
    return (((parts[0]! << 24) >>> 0) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

function parseIPv6(value: string): bigint | null {
    if (isIP(value) !== 6) return null;
    const normalized = value.toLowerCase();
    if (normalized.includes('::') && normalized.indexOf('::') !== normalized.lastIndexOf('::')) return null;
    const [leftText, rightText] = normalized.split('::');
    const parseGroups = (text: string | undefined): string[] => text ? text.split(':').filter(Boolean) : [];
    const left = parseGroups(leftText);
    const right = parseGroups(rightText);
    const missing = 8 - left.length - right.length;
    if (!normalized.includes('::') && missing !== 0) return null;
    if (missing < 0) return null;
    const groups = [...left, ...Array.from({ length: missing }, () => '0'), ...right];
    if (groups.length !== 8 || groups.some(group => !/^[0-9a-f]{1,4}$/.test(group))) return null;
    return groups.reduce((result, group) => (result << 16n) | BigInt(`0x${group}`), 0n);
}

function parseTrustedRanges(value: string | undefined): TrustedRange[] | null {
    const entries = String(value || '').split(',').map(item => item.trim()).filter(Boolean);
    if (entries.length === 0) return null;
    const ranges: TrustedRange[] = [];
    for (const entry of entries) {
        const [address, prefixText] = entry.split('/');
        const version = isIP(address || '');
        const prefix = prefixText === undefined ? (version === 4 ? 32 : 128) : Number(prefixText);
        if (!Number.isInteger(prefix) || prefix < 0 || (version === 4 && prefix > 32) || (version === 6 && prefix > 128)) return null;
        if (version === 4) {
            const parsed = parseIPv4(address || '');
            if (parsed === null) return null;
            const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
            ranges.push({ version: 4, network: (parsed & mask) >>> 0, mask });
            continue;
        }
        if (version === 6) {
            const parsed = parseIPv6(address || '');
            if (parsed === null) return null;
            const mask = prefix === 0 ? 0n : ((1n << 128n) - 1n) ^ ((1n << BigInt(128 - prefix)) - 1n);
            ranges.push({ version: 6, network: parsed & mask, mask });
            continue;
        }
        return null;
    }
    return ranges;
}

export function createTrustProxy(value: string | undefined): false | ((ip: string) => boolean) {
    const ranges = parseTrustedRanges(value);
    if (!ranges) return false;
    return (ip: string) => {
        const parsed = parseIPv4(ip);
        if (parsed !== null && ranges.some(range => range.version === 4 && ((parsed & range.mask) >>> 0) === range.network)) return true;
        const parsedIPv6 = parseIPv6(ip);
        return parsedIPv6 !== null && ranges.some(range => range.version === 6 && (parsedIPv6 & range.mask) === range.network);
    };
}

export function replacePersistedDatabase(target: Database, source: Database): void {
    Object.assign(target, {
        currentMonth: source.currentMonth,
        baseMonth: source.baseMonth,
        bankInfo: source.bankInfo,
        platforms: source.platforms,
        members: source.members,
        subscriptions: source.subscriptions,
        payments: source.payments,
        tempCharges: source.tempCharges,
        history: source.history,
        reminderStyle: source.reminderStyle,
        ledger: source.ledger
    });
    if (source.lifecycle === undefined) delete target.lifecycle;
    else target.lifecycle = source.lifecycle;
}

function removeSqliteFiles(sqlitePath: string): void {
    for (const suffix of ['', '-wal', '-shm']) {
        fs.rmSync(`${sqlitePath}${suffix}`, { force: true });
    }
}

function verifySqlite(sqlitePath: string): void {
    const sqlite = new SqliteDatabase(sqlitePath, { fileMustExist: true });
    try {
        sqlite.pragma('wal_checkpoint(TRUNCATE)');
        if (sqlite.pragma('integrity_check', { simple: true }) !== 'ok') {
            throw new Error('SQLite integrity check failed');
        }
    } finally {
        sqlite.close();
    }
    loadFromSQLite(sqlitePath);
}

function readTombstoneOriginalName(filename: string): string | null {
    const prefix = '.backup-tombstone-';
    if (!filename.startsWith(prefix) || !filename.endsWith('.db')) return null;
    const encoded = filename.slice(prefix.length, -3);
    const separator = encoded.lastIndexOf('-');
    if (separator <= 0) return null;
    return encoded.slice(0, separator);
}

export function createRuntime(options: RuntimeOptions = {}) {
    const rootDir = path.resolve(options.rootDir || DEFAULT_ROOT_DIR);
    const env = options.env || process.env;
    const dataDir = path.resolve(options.dataDir || env.DATA_DIR || rootDir);
    const dbPath = path.resolve(options.dbPath || env.DB_PATH || path.join(dataDir, 'database.json'));
    const sqlitePath = path.resolve(options.sqlitePath || env.SQLITE_PATH || path.join(dataDir, 'database.db'));
    const backupDir = path.resolve(options.backupDir || env.BACKUP_DIR || path.join(dataDir, 'backups'));
    const demoDbPath = path.resolve(options.demoDbPath || path.join(rootDir, 'fixtures', 'demo-database.json'));
    const distDir = path.resolve(options.distDir || path.join(rootDir, 'dist'));
    const migrationsDir = path.resolve(options.migrationsDir || path.join(rootDir, 'lib', 'migrations'));
    const onlineBackup = options.onlineBackup || backupSQLite;
    const isProduction = env.NODE_ENV === 'production';
    const config = {
        host: env.HOST || '127.0.0.1',
        port: Number(env.PORT || 3000),
        isProduction,
        cookieSecure: env.COOKIE_SECURE === undefined
            ? isProduction
            : ['1', 'true', 'yes'].includes(String(env.COOKIE_SECURE).toLowerCase()),
        maxBackups: 50
    };
    const paths = { rootDir, dataDir, dbPath, sqlitePath, backupDir, demoDbPath, distDir };
    const automationInbox: AutomationProposal[] = [];
    const backup = createBackupService({
        backupDir,
        sqlitePath,
        maxBackups: config.maxBackups,
        onlineBackup
    });
    const mutationQueue: Array<QueueJob<unknown>> = [];
    let mutationWorkerRunning = false;
    let readiness: RuntimeReadiness = { status: 'starting' };

    function markRuntimeFailure(error: unknown): void {
        readiness = {
            status: 'blocked',
            reason: error instanceof Error ? error.message : String(error)
        };
    }

    function domainIntegrityFailure(db: Database): string | null {
        const blockingWarnings = findAccountingWarnings(db)
            .filter(warning => warning.severity === 'high' || warning.severity === 'critical');
        return blockingWarnings.length
            ? blockingWarnings.slice(0, 3).map(warning => `${warning.code}: ${warning.detail}`).join('; ')
            : null;
    }

    function isAuthConfigured(): boolean {
        return Boolean(
            env.APP_SESSION_SECRET
            && isGoogleOAuthConfigured(env)
            && (!isCloudBinding() || getPublicOrigin(env) !== null)
        );
    }

    function isCloudBinding(): boolean {
        return config.isProduction || config.host === '0.0.0.0' || config.host === '::';
    }

    function initializeFromJsonAtomically(sourcePath: string): void {
        const stagedPath = path.join(dataDir, `.database.bootstrap-${crypto.randomUUID()}.db`);
        removeSqliteFiles(stagedPath);
        try {
            initSQLite(stagedPath);
            if (!migrateJsonToSQLite(sourcePath, stagedPath)) {
                throw new Error(`SQLite bootstrap migration failed: ${sourcePath}`);
            }
            verifySqlite(stagedPath);
            removeSqliteFiles(sqlitePath);
            fs.renameSync(stagedPath, sqlitePath);
            removeSqliteFiles(stagedPath);
        } catch (error) {
            removeSqliteFiles(stagedPath);
            removeSqliteFiles(sqlitePath);
            throw error;
        }
    }

    function resolveTombstones(db: Database): void {
        for (const filename of fs.readdirSync(backupDir)) {
            const originalFilename = readTombstoneOriginalName(filename);
            if (!originalFilename) continue;

            const tombstonePath = path.join(backupDir, filename);
            const hasMatchingLedger = db.ledger.entries.some(entry => {
                if (entry.type !== 'backup.deleted') return false;
                const payload = entry.payload as Record<string, unknown> | undefined;
                return payload?.tombstone === filename && payload.filename === originalFilename;
            });
            if (hasMatchingLedger) {
                removeSqliteFiles(tombstonePath);
                continue;
            }

            const originalPath = path.join(backupDir, originalFilename);
            if (fs.existsSync(originalPath)) {
                throw new Error(`Unmatched backup tombstone requires review: ${filename}`);
            }
            fs.renameSync(tombstonePath, originalPath);
        }
    }

    async function migrateExistingSQLiteAtomically(): Promise<void> {
        const stagePath = path.join(dataDir, `.database-migration-${crypto.randomUUID()}.db`);
        const safetyPath = path.join(backupDir, `.migration-safety-${crypto.randomUUID()}.db`);
        let safetyVerified = false;
        let committed = false;

        removeSqliteFiles(stagePath);
        removeSqliteFiles(safetyPath);
        try {
            await onlineBackup(sqlitePath, stagePath);
            runMigrations(stagePath, migrationsDir);
            verifySqlite(stagePath);
            const stagedDb = loadFromSQLite(stagePath);
            const integrityFailure = domainIntegrityFailure(stagedDb);
            if (integrityFailure) {
                throw new Error(`Staged migration domain validation failed: ${integrityFailure}`);
            }
            const expectedFingerprint = getCanonicalPersistedFingerprint(stagedDb);

            await onlineBackup(sqlitePath, safetyPath);
            verifySqlite(safetyPath);
            safetyVerified = true;

            await onlineBackup(stagePath, sqlitePath);
            verifySqlite(sqlitePath);
            const committedDb = loadFromSQLite(sqlitePath);
            if (getCanonicalPersistedFingerprint(committedDb) !== expectedFingerprint) {
                throw new Error('Post-migration live verification mismatch');
            }
            committed = true;
        } catch (error) {
            if (safetyVerified) {
                try {
                    const safetyFingerprint = getCanonicalPersistedFingerprint(loadFromSQLite(safetyPath));
                    await onlineBackup(safetyPath, sqlitePath);
                    verifySqlite(sqlitePath);
                    if (getCanonicalPersistedFingerprint(loadFromSQLite(sqlitePath)) !== safetyFingerprint) {
                        throw new Error('Migration rollback fingerprint mismatch', { cause: error });
                    }
                    removeSqliteFiles(safetyPath);
                } catch (rollbackError) {
                    throw new Error(
                        `SQLite migration failed and rollback failed: ${String(error)}; ${String(rollbackError)}`,
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

    async function initializeAtomic(): Promise<void> {
        try {
            fs.mkdirSync(dataDir, { recursive: true });
            fs.mkdirSync(backupDir, { recursive: true });
            const liveExists = fs.existsSync(sqlitePath) && fs.statSync(sqlitePath).size > 0;

            if (!liveExists && env.MIGRATE_FROM_JSON === '1') {
                const sourcePath = fs.existsSync(dbPath) ? dbPath : demoDbPath;
                if (!fs.existsSync(sourcePath)) {
                    removeSqliteFiles(sqlitePath);
                    throw new Error(`SQLite bootstrap source not found: ${sourcePath}`);
                }
                initializeFromJsonAtomically(sourcePath);
            } else if (liveExists) {
                await migrateExistingSQLiteAtomically();
            } else {
                initSQLite(sqlitePath);
            }

            const db = readDB();
            if (!db) throw new Error('Database read failed during initialization');
            resolveTombstones(db);
            const integrityFailure = domainIntegrityFailure(db);
            if (integrityFailure) {
                throw new Error(`Domain integrity blocked startup: ${integrityFailure}`);
            }
            readiness = { status: 'ready' };
        } catch (error) {
            markRuntimeFailure(error);
            throw error;
        }
    }

    function initialize(): void {
        try {
            fs.mkdirSync(dataDir, { recursive: true });
            fs.mkdirSync(backupDir, { recursive: true });
            const liveExists = fs.existsSync(sqlitePath) && fs.statSync(sqlitePath).size > 0;

            if (!liveExists && env.MIGRATE_FROM_JSON === '1') {
                const sourcePath = fs.existsSync(dbPath) ? dbPath : demoDbPath;
                if (!fs.existsSync(sourcePath)) {
                    removeSqliteFiles(sqlitePath);
                    throw new Error(`SQLite bootstrap source not found: ${sourcePath}`);
                }
                initializeFromJsonAtomically(sourcePath);
            } else {
                initSQLite(sqlitePath);
            }

            const db = readDB();
            if (!db) throw new Error('Database read failed during initialization');
            const integrityFailure = domainIntegrityFailure(db);
            if (integrityFailure) {
                throw new Error(`Domain integrity blocked startup: ${integrityFailure}`);
            }
            readiness = { status: 'ready' };
        } catch (error) {
            markRuntimeFailure(error);
            throw error;
        }
    }

    function readDB(): Database | null {
        try {
            const db = loadFromSQLite(sqlitePath);
            return db;
        } catch (error) {
            markRuntimeFailure(error);
            console.error('Error reading database from SQLite:', error);
            return null;
        }
    }

    async function executeMutation<T>(mutator: (freshDb: Database) => T, options: MutationOptions): Promise<MutationResult<T>> {
        const freshDb = readDB();
        if (!freshDb) throw new Error('Database error');

        const value = mutator(freshDb);
        if (isPromiseLike(value)) {
            throw new Error('Mutation callback must be synchronous');
        }

        normalizeDatabaseRelations(freshDb);
        const integrityFailure = domainIntegrityFailure(freshDb);
        if (integrityFailure) {
            throw new DomainValidationError(`Domain validation failed: ${integrityFailure}`);
        }
        try {
            if (options.backup !== false && !await backup.backupDB()) {
                throw new Error('Database backup failed');
            }
            saveToSQLite(sqlitePath, freshDb);
        } catch (error) {
            markRuntimeFailure(error);
            throw new MutationPersistenceError(error);
        }
        invalidateRAGIndex();
        return { data: freshDb, value };
    }

    function enqueueExclusive<T>(operation: () => Promise<T>): Promise<T> {
        return new Promise((resolve, reject) => {
            mutationQueue.push({
                execute: operation,
                resolve: resolve as (result: unknown) => void,
                reject
            });
            void drainMutationQueue();
        });
    }

    async function drainMutationQueue(): Promise<void> {
        if (mutationWorkerRunning) return;
        mutationWorkerRunning = true;
        try {
            while (mutationQueue.length > 0) {
                const job = mutationQueue.shift()!;
                try {
                    job.resolve(await job.execute());
                } catch (error) {
                    job.reject(error);
                }
            }
        } finally {
            mutationWorkerRunning = false;
            if (mutationQueue.length > 0) void drainMutationQueue();
        }
    }

    function mutateDB<T>(mutator: (freshDb: Database) => T, options: MutationOptions = {}): Promise<MutationResult<T>> {
        return enqueueExclusive(() => executeMutation(mutator, options));
    }

    async function runStartupLifecycle(): Promise<void> {
        if (env.NODE_ENV === 'test') return;
        try {
            const { data, value: results } = await mutateDB(db => {
                const lifecycleResults = runLifecycleCatchUp(db);
                const blocked = lifecycleResults.find(result => result.blocked);
                if (blocked) throw new Error(`Lifecycle blocked startup: ${blocked.blockedReason || 'integrity check failed'}`);
                return lifecycleResults;
            }, { reason: 'startup.lifecycle' });
            console.log(`[lifecycle] startup catch-up: advanced ${results.filter(result => result.advanced).length} month(s) to ${data.currentMonth}`);
        } catch (error) {
            markRuntimeFailure(error);
            throw error;
        }
    }

    return {
        env,
        config,
        paths,
        automationInbox,
        initialize,
        readDB,
        initializeAtomic,
        mutateDB,
        enqueueExclusive,
        getReadiness: () => ({ ...readiness }),
        runStartupLifecycle,
        isAuthConfigured,
        isCloudBinding,
        invalidateRAGIndex,
        ...backup
    };
}

export type Runtime = ReturnType<typeof createRuntime>;
