import fs from 'node:fs';
import { isIP } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Transaction } from '@libsql/client';
import { findAccountingWarnings, normalizeDatabaseRelations } from '../lib/accounting.js';
import { openDatabase, loadFromConnection, runMigrations, withWriteTransaction, writeDatabase, verifyDatabase } from '../lib/db.js';
import { getPublicOrigin, isGoogleOAuthConfigured } from '../lib/google-oauth.js';
import { runLifecycleCatchUp, getSystemMonth } from '../lib/lifecycle.js';
import { invalidateRAGIndex } from '../lib/rag.js';
import type { Database } from '../src/types/billing.js';
import { createBackupService } from './services/backup.js';
import { createSessionRevocationStore } from './services/session-revocation.js';
import { createProposalStore } from './services/proposals.js';

const DEFAULT_ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export type RuntimeOptions = {
    rootDir?: string; env?: Record<string, string | undefined>; dataDir?: string;
    dbPath?: string; sqlitePath?: string; backupDir?: string; demoDbPath?: string;
    distDir?: string; migrationsDir?: string;
};
export type MutationOptions = { reason?: string; backup?: boolean; afterSave?: (tx: Transaction) => Promise<void> };
export type RuntimeReadiness = { status: 'starting' | 'ready' | 'blocked'; reason?: string };
export type MutationResult<T> = { data: Database; value: T };
export class MutationPersistenceError extends Error {
    constructor(readonly cause: unknown) { super('Database mutation persistence failed'); this.name = 'MutationPersistenceError'; }
}
export class DomainValidationError extends Error {
    constructor(message: string) { super(message); this.name = 'DomainValidationError'; }
}
function isPromiseLike(value: unknown): boolean {
    return Boolean(value && (typeof value === 'object' || typeof value === 'function') && typeof (value as { then?: unknown }).then === 'function');
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
    const databaseUrl = env.TURSO_DATABASE_URL || sqlitePath;
    // Construction stays side-effect free, including on read-only serverless filesystems.
    const client = openDatabase(databaseUrl, env.TURSO_AUTH_TOKEN);
    const isProduction = env.NODE_ENV === 'production';
    const config = {
        host: env.HOST || '127.0.0.1', port: Number(env.PORT || 3000), isProduction,
        cookieSecure: env.COOKIE_SECURE === undefined ? isProduction : ['1', 'true', 'yes'].includes(String(env.COOKIE_SECURE).toLowerCase()),
        maxBackups: 50
    };
    const paths = { rootDir, dataDir, dbPath, sqlitePath, backupDir, demoDbPath, distDir };
    const backup = createBackupService({ client, maxBackups: config.maxBackups });
    const sessionRevocation = createSessionRevocationStore(client);
    const proposals = createProposalStore(client);
    let readiness: RuntimeReadiness = { status: 'starting' };
    let readyPromise: Promise<void> | undefined;
    let queue: Promise<unknown> = Promise.resolve();
    function enqueueExclusive<T>(operation: () => Promise<T>): Promise<T> {
        const result = queue.then(operation);
        queue = result.catch(() => undefined);
        return result;
    }
    function markRuntimeFailure(error: unknown): void {
        readiness = { status: 'blocked', reason: error instanceof Error ? error.message : String(error) };
        readyPromise = undefined;
    }
    function assertDomainIntegrity(db: Database): void {
        const warnings = findAccountingWarnings(db).filter(w => w.severity === 'high' || w.severity === 'critical');
        if (warnings.length) throw new DomainValidationError(`Domain validation failed: ${warnings.slice(0, 3).map(w => `${w.code}: ${w.detail}`).join('; ')}`);
    }
    function isCloudBinding(): boolean { return config.isProduction || config.host === '0.0.0.0' || config.host === '::'; }
    function isAuthConfigured(): boolean {
        return Boolean(env.APP_SESSION_SECRET && isGoogleOAuthConfigured(env) && (!isCloudBinding() || getPublicOrigin(env) !== null));
    }
    async function executeMutation<T>(mutator: (freshDb: Database) => T, options: MutationOptions): Promise<MutationResult<T>> {
        let callbackFailed = false;
        try {
            const result = await withWriteTransaction(client, async tx => {
                const previous = await loadFromConnection(tx);
                const freshDb = structuredClone(previous);
                let value: T;
                try {
                    value = mutator(freshDb);
                    if (isPromiseLike(value)) throw new Error('Mutation callback must be synchronous');
                    normalizeDatabaseRelations(freshDb);
                    assertDomainIntegrity(freshDb);
                } catch (error) { callbackFailed = true; throw error; }
                try {
                    if (options.backup !== false) await backup.insertBackup(tx, previous, options.reason || 'mutation');
                    await writeDatabase(tx, previous, freshDb);
                    if (options.afterSave) await options.afterSave(tx);
                    await verifyDatabase(tx, freshDb);
                } catch (error) {
                    // Preserve route conflicts, including a lost proposal compare-and-swap.
                    if (error && typeof error === 'object' && 'status' in error) throw error;
                    throw new MutationPersistenceError(error);
                }
                return { data: freshDb, value };
            });
            invalidateRAGIndex();
            return result;
        } catch (error) {
            if (callbackFailed || (error && typeof error === 'object' && 'status' in error)) throw error;
            const failure = error instanceof MutationPersistenceError ? error : new MutationPersistenceError(error);
            markRuntimeFailure(failure);
            throw failure;
        }
    }
    function ensureReady(): Promise<void> {
        if (readyPromise) return readyPromise;
        readyPromise = (async () => {
            await runMigrations(client, migrationsDir);
            if (env.MIGRATE_FROM_JSON === '1') {
                await withWriteTransaction(client, async tx => {
                    const existing = await loadFromConnection(tx);
                    const businessCount = existing.members.length + existing.platforms.length + existing.payments.length + existing.ledger.entries.length + existing.history.length + existing.subscriptions.length + existing.tempCharges.length;
                    const hasMetadata = (await tx.execute('SELECT key FROM metadata LIMIT 1')).rows.length > 0;
                    if (businessCount || hasMetadata) return;
                    const source = fs.existsSync(dbPath) ? dbPath : demoDbPath;
                    try {
                        const next = normalizeDatabaseRelations(JSON.parse(fs.readFileSync(source, 'utf8')));
                        assertDomainIntegrity(next);
                        await writeDatabase(tx, existing, next);
                        await verifyDatabase(tx, next);
                    } catch (error) { throw new Error('SQLite bootstrap migration failed', { cause: error }); }
                });
            }
            const db = await loadFromConnection(client);
            assertDomainIntegrity(db);
            if (env.NODE_ENV !== 'test' && db.currentMonth < getSystemMonth()) await runStartupLifecycle();
            readiness = { status: 'ready' };
        })().catch(error => { readyPromise = undefined; markRuntimeFailure(error); throw error; });
        return readyPromise;
    }
    async function readDB(): Promise<Database | null> {
        try { return await loadFromConnection(client); }
        catch (error) { markRuntimeFailure(error); return null; }
    }
    function mutateDB<T>(mutator: (db: Database) => T, mutationOptions: MutationOptions = {}): Promise<MutationResult<T>> {
        return enqueueExclusive(async () => { await ensureReady(); return executeMutation(mutator, mutationOptions); });
    }
    async function runStartupLifecycle(): Promise<void> {
        if (env.NODE_ENV === 'test') return;
        await executeMutation(db => {
            const results = runLifecycleCatchUp(db);
            const blocked = results.find(result => result.blocked);
            if (blocked) throw new Error(`Lifecycle blocked startup: ${blocked.blockedReason || 'integrity check failed'}`);
        }, { reason: 'startup.lifecycle' });
    }
    return {
        env, config, paths, client, ensureReady, initialize: ensureReady, initializeAtomic: ensureReady,
        readDB, mutateDB, enqueueExclusive, getReadiness: () => ({ ...readiness }), runStartupLifecycle,
        isAuthConfigured, isCloudBinding, invalidateRAGIndex, close: () => client.close(),
        ...sessionRevocation, ...backup, ...proposals
    };
}
export type Runtime = ReturnType<typeof createRuntime>;
