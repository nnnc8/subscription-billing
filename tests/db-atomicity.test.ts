import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import SqliteDatabase from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
    backupSQLite,
    getCanonicalPersistedFingerprint,
    initSQLite,
    loadFromSQLite,
    saveToSQLite
} from '../lib/db.js';
import { createRuntime } from '../server/runtime.js';
import type { Database } from '../src/types/billing.js';

const fixturePath = path.resolve('fixtures/demo-database.json');
const temporaryDirectories: string[] = [];

function fixtureDatabase(): Database {
    return JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as Database;
}

function makeLiveDatabase(): { directory: string; sqlitePath: string; backupDir: string } {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'billing-db-atomicity-'));
    temporaryDirectories.push(directory);
    const sqlitePath = path.join(directory, 'database.db');
    const backupDir = path.join(directory, 'backups');
    fs.mkdirSync(backupDir);
    initSQLite(sqlitePath);
    saveToSQLite(sqlitePath, fixtureDatabase());
    return { directory, sqlitePath, backupDir };
}

function makeRuntime(
    state: ReturnType<typeof makeLiveDatabase>,
    options: Parameters<typeof createRuntime>[0] = {}
) {
    return createRuntime({
        rootDir: path.resolve('.'),
        dataDir: state.directory,
        sqlitePath: state.sqlitePath,
        backupDir: state.backupDir,
        env: { NODE_ENV: 'test', MIGRATE_FROM_JSON: '0' },
        ...options
    });
}

function fingerprint(sqlitePath: string): string {
    return getCanonicalPersistedFingerprint(loadFromSQLite(sqlitePath));
}

function migrationDir(directory: string): string {
    const dir = path.join(directory, 'migrations');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, '002_ok.sql'), 'CREATE TABLE migration_probe (id TEXT PRIMARY KEY);', 'utf8');
    fs.writeFileSync(path.join(dir, '003_fail.sql'), 'THIS IS NOT SQL;', 'utf8');
    return dir;
}

function hiddenFiles(directory: string, prefix: string): string[] {
    return fs.readdirSync(directory).filter(filename => filename.startsWith(prefix));
}

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

describe('failure-atomic SQLite migration', () => {
    it('leaves live unchanged when migration N fails on the hidden stage', async () => {
        const state = makeLiveDatabase();
        const before = fingerprint(state.sqlitePath);
        const runtime = makeRuntime(state, { migrationsDir: migrationDir(state.directory) });

        await expect(runtime.initializeAtomic()).rejects.toThrow(/near|syntax|sql/i);
        expect(fingerprint(state.sqlitePath)).toBe(before);
        expect(hiddenFiles(state.directory, '.database-migration-')).toHaveLength(0);
        expect(hiddenFiles(state.backupDir, '.migration-safety-')).toHaveLength(0);
    });

    it('rolls live back after stage-to-live failure and removes safety after verification', async () => {
        const state = makeLiveDatabase();
        const before = fingerprint(state.sqlitePath);
        let calls = 0;
        const runtime = makeRuntime(state, {
            onlineBackup: async (sourcePath, destinationPath) => {
                calls += 1;
                if (calls === 3) throw new Error('forced stage-to-live failure');
                await backupSQLite(sourcePath, destinationPath);
            }
        });

        await expect(runtime.initializeAtomic()).rejects.toThrow('forced stage-to-live failure');
        expect(fingerprint(state.sqlitePath)).toBe(before);
        expect(hiddenFiles(state.backupDir, '.migration-safety-')).toHaveLength(0);
        expect(hiddenFiles(state.directory, '.database-migration-')).toHaveLength(0);
    });

    it('retains safety when rollback itself fails', async () => {
        const state = makeLiveDatabase();
        const before = fingerprint(state.sqlitePath);
        let calls = 0;
        const runtime = makeRuntime(state, {
            onlineBackup: async (sourcePath, destinationPath) => {
                calls += 1;
                if (calls === 3 || calls === 4) throw new Error(`forced backup failure ${calls}`);
                await backupSQLite(sourcePath, destinationPath);
            }
        });

        await expect(runtime.initializeAtomic()).rejects.toThrow(/rollback failed/i);
        expect(fingerprint(state.sqlitePath)).toBe(before);
        expect(hiddenFiles(state.backupDir, '.migration-safety-')).toHaveLength(1);
        expect(hiddenFiles(state.directory, '.database-migration-')).toHaveLength(0);
    });

    it('treats post-verify mismatch as failure and rolls back to the safety fingerprint', async () => {
        const state = makeLiveDatabase();
        const before = fingerprint(state.sqlitePath);
        let calls = 0;
        const runtime = makeRuntime(state, {
            onlineBackup: async (sourcePath, destinationPath) => {
                calls += 1;
                await backupSQLite(sourcePath, destinationPath);
                if (calls === 3) {
                    const sqlite = new SqliteDatabase(destinationPath);
                    try {
                        sqlite.prepare('DELETE FROM members WHERE id = ?').run('m_alpha');
                    } finally {
                        sqlite.close();
                    }
                }
            }
        });

        await expect(runtime.initializeAtomic()).rejects.toThrow(/post-migration|fingerprint/i);
        expect(fingerprint(state.sqlitePath)).toBe(before);
        expect(hiddenFiles(state.backupDir, '.migration-safety-')).toHaveLength(0);
    });
});

describe('failure-atomic restore', () => {
    it('validates and writes the restore ledger on stage before committing live', async () => {
        const state = makeLiveDatabase();
        const runtime = makeRuntime(state);
        const backupPath = await runtime.backupDB();
        expect(backupPath).toBeTruthy();

        await runtime.mutateDB(db => {
            db.bankInfo = 'changed after backup';
        });
        const restored = await runtime.restoreSQLiteFromBackup(backupPath!, {
            type: 'backup.restored',
            summary: 'test restore',
            entityType: 'backup',
            entityId: path.basename(backupPath!),
            payload: { filename: path.basename(backupPath!) }
        });

        expect(restored.bankInfo).toBe(fixtureDatabase().bankInfo);
        expect(restored.ledger.entries.at(-1)?.type).toBe('backup.restored');
        expect(hiddenFiles(state.backupDir, '.restore-safety-')).toHaveLength(0);
        expect(hiddenFiles(state.directory, '.restore-stage-')).toHaveLength(0);
    });

    it('serializes restore ahead of a concurrent mutation without losing the later write', async () => {
        const state = makeLiveDatabase();
        const backupPath = path.join(state.backupDir, 'database_20260715_000000_000_abcdef12.db');
        await backupSQLite(state.sqlitePath, backupPath);

        let releaseRestore!: () => void;
        let signalRestoreStarted!: () => void;
        const restoreStarted = new Promise<void>(resolve => {
            signalRestoreStarted = resolve;
        });
        const restoreGate = new Promise<void>(resolve => {
            releaseRestore = resolve;
        });
        let backupCalls = 0;
        const runtime = makeRuntime(state, {
            onlineBackup: async (sourcePath, destinationPath) => {
                backupCalls += 1;
                if (backupCalls === 1) {
                    signalRestoreStarted();
                    await restoreGate;
                }
                await backupSQLite(sourcePath, destinationPath);
            }
        });

        const restore = runtime.enqueueExclusive(() => runtime.restoreSQLiteFromBackup(backupPath, {
            type: 'backup.restored',
            summary: 'concurrent restore test',
            entityType: 'backup',
            entityId: path.basename(backupPath),
            payload: { filename: path.basename(backupPath) }
        }));
        await restoreStarted;
        const mutation = runtime.mutateDB(db => {
            db.bankInfo = 'mutation after restore';
        }, { backup: false });
        releaseRestore();
        await Promise.all([restore, mutation]);

        const finalDb = runtime.readDB()!;
        expect(finalDb.bankInfo).toBe('mutation after restore');
        expect(finalDb.ledger.entries.at(-1)?.type).toBe('backup.restored');
        expect(finalDb.ledger.entries.some(entry => entry.type === 'backup.restored')).toBe(true);
    });
});
