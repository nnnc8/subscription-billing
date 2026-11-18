import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createClient } from '@libsql/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getCanonicalPersistedFingerprint, loadFromConnection, loadFromSQLite, openDatabase, runMigrations, withWriteTransaction } from './test-database.js';
import { rowChanges, DELETE_CHUNK_SIZE } from '../lib/repositories/shared.js';
import { createRuntime } from './test-database.js';
import type { Runtime } from './test-database.js';
import type { AutomationProposal } from '../src/types/billing.js';

const directories: string[] = [];
const runtimes: Runtime[] = [];
afterEach(() => {
    for (const runtime of runtimes.splice(0)) runtime.close();
    for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
async function makeRuntime() {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'billing-atomicity-'));
    directories.push(dataDir);
    const runtime = createRuntime({ rootDir: path.resolve('.'), dataDir, env: { NODE_ENV: 'test', MIGRATE_FROM_JSON: '1' } });
    runtimes.push(runtime);
    await runtime.ensureReady();
    return runtime;
}
async function state(runtime: Runtime) {
    return { fingerprint: getCanonicalPersistedFingerprint((await runtime.readDB())!), backups: (await runtime.client.execute('SELECT * FROM backups ORDER BY id')).rows };
}
function pendingProposal(): AutomationProposal {
    return { id: 'atomic-proposal', kind: 'payment', sourceText: 'test', confidence: 1, reason: 'test', warnings: [], payload: { memberId: 'm_alpha', amount: 7 }, status: 'pending', createdAt: new Date().toISOString() };
}

describe('libSQL persistence', () => {
    it('uses one read batch and writes no unchanged business rows', async () => {
        const runtime = await makeRuntime();
        const spy = vi.spyOn(runtime.client, 'batch');
        await runtime.readDB();
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy.mock.calls[0]?.[1]).toBe('read');
        spy.mockRestore();
        await runtime.client.executeMultiple("CREATE TRIGGER unchanged_member BEFORE UPDATE ON members BEGIN SELECT RAISE(ABORT,'unchanged row was written'); END;");
        await runtime.mutateDB(db => { db.bankInfo = 'changed metadata only'; });
        expect((await runtime.readDB())?.bankInfo).toBe('changed metadata only');
    });
    it('deletes more than 32766 rows with bounded parameter chunks', async () => {
        const runtime = await makeRuntime();
        const rows = Array.from({ length: 33000 }, (_, id) => ({ id: `extra_${id}`, name: `Extra ${id}`, priorBalance: 0, customFee: null }));
        await withWriteTransaction(runtime.client, async tx => {
            // Seed in bounded multi-row statements so the remote transaction stays short.
            const changes = [];
            for (let i = 0; i < rows.length; i += 100) {
                const chunk = rows.slice(i, i + 100);
                changes.push({ sql: `INSERT INTO members (id,name,priorBalance,customFee) VALUES ${chunk.map(() => '(?,?,?,?)').join(',')}`, args: chunk.flatMap(row => [row.id, row.name, row.priorBalance, row.customFee]) });
            }
            for (let i = 0; i < changes.length; i += 100) await tx.batch(changes.slice(i, i + 100));
        });
        const statements = rowChanges('members', 'id', rows, []);
        expect(statements).toHaveLength(Math.ceil(33000 / DELETE_CHUNK_SIZE));
        expect(statements.every(statement => typeof statement !== 'string' && Array.isArray(statement.args) && statement.args.length <= DELETE_CHUNK_SIZE)).toBe(true);
        await runtime.mutateDB(db => { db.members = db.members.filter(member => !member.id.startsWith('extra_')); }, { backup: false });
        expect((await runtime.readDB())?.members.some(member => member.id.startsWith('extra_'))).toBe(false);
    }, 30000);
    it('rolls back a mutation, snapshot, and afterSave when read-back fails', async () => {
        const runtime = await makeRuntime();
        const before = await state(runtime);
        await expect(runtime.mutateDB(db => { db.bankInfo = 'must roll back'; }, {
            afterSave: async tx => { await tx.execute("UPDATE metadata SET value='unexpected' WHERE key='bankInfo'"); }
        })).rejects.toThrow(/persistence failed/i);
        expect(await state(runtime)).toEqual(before);
    });
    it('rolls back the complete pending migration set on SQL failure and retries safely', async () => {
        const runtime = await makeRuntime();
        const before = await state(runtime);
        const directory = path.join(runtime.paths.dataDir, 'migrations');
        fs.mkdirSync(directory);
        fs.writeFileSync(path.join(directory, '003_probe.sql'), 'CREATE TABLE migration_probe (id TEXT PRIMARY KEY);');
        fs.writeFileSync(path.join(directory, '004_fail.sql'), 'INVALID SQL;');
        await expect(runMigrations(runtime.client, directory)).rejects.toThrow();
        expect(await state(runtime)).toEqual(before);
        expect((await runtime.client.execute("SELECT name FROM sqlite_master WHERE name='migration_probe'")).rows).toHaveLength(0);
        expect((await runtime.client.execute("SELECT version FROM schema_migrations WHERE version LIKE '00[34]%' ")).rows).toHaveLength(0);
        fs.writeFileSync(path.join(directory, '004_fail.sql'), 'CREATE TABLE migration_retry (id TEXT);');
        await Promise.all([runMigrations(runtime.client, directory), runMigrations(runtime.client, directory)]);
        expect((await runtime.client.execute("SELECT version FROM schema_migrations WHERE version='003_probe'")).rows).toHaveLength(1);
    });
    it('serializes independent runtime writers without losing either write', async () => {
        const runtime = await makeRuntime();
        const second = createRuntime({ rootDir: path.resolve('.'), dataDir: runtime.paths.dataDir, env: { NODE_ENV: 'test' } });
        runtimes.push(second);
        await second.ensureReady();
        await Promise.all([
            runtime.mutateDB(db => { db.bankInfo += 'A'; }),
            second.mutateDB(db => { db.bankInfo += 'B'; })
        ]);
        expect((await second.readDB())?.bankInfo).toMatch(/AB$|BA$/);
    });
    it('rolls back the losing proposal confirmation including its business rows and backup', async () => {
        const runtime = await makeRuntime();
        const second = createRuntime({ rootDir: path.resolve('.'), dataDir: runtime.paths.dataDir, env: { NODE_ENV: 'test' } });
        runtimes.push(second);
        await second.ensureReady();
        await runtime.storeProposals([pendingProposal()]);
        const firstCopy = (await runtime.getProposal('atomic-proposal'))!;
        const secondCopy = (await second.getProposal('atomic-proposal'))!;
        const confirm = (instance: Runtime, proposal: AutomationProposal, value: string) => instance.mutateDB(db => { db.bankInfo += value; }, {
            reason: 'test.confirm', afterSave: tx => instance.transitionProposal(tx, { ...proposal, status: 'applied' })
        });
        const beforeBackups = (await runtime.client.execute('SELECT id FROM backups')).rows.length;
        const results = await Promise.allSettled([confirm(runtime, firstCopy, 'WIN_A'), confirm(second, secondCopy, 'WIN_B')]);
        expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
        const rejected = results.find(result => result.status === 'rejected');
        expect(rejected?.status === 'rejected' && rejected.reason).toMatchObject({ status: 409 });
        const bankInfo = (await runtime.readDB())!.bankInfo;
        expect(Number(bankInfo.includes('WIN_A')) + Number(bankInfo.includes('WIN_B'))).toBe(1);
        expect((await runtime.client.execute('SELECT id FROM backups')).rows).toHaveLength(beforeBackups + 1);
        expect((await second.getProposal(firstCopy.id))?.status).toBe('applied');
        const after = await state(runtime);
        await expect(confirm(second, secondCopy, 'must rollback')).rejects.toMatchObject({ status: 409 });
        expect(await state(runtime)).toEqual(after);
    });
    it.skipIf(Boolean(process.env.TEST_LIBSQL_URL))('wraps COMMIT failures and discards all uncommitted changes', async () => {
        const runtime = await makeRuntime();
        await runtime.client.executeMultiple('PRAGMA foreign_keys=ON; CREATE TABLE parent_probe (id INTEGER PRIMARY KEY); CREATE TABLE child_probe (id INTEGER REFERENCES parent_probe(id) DEFERRABLE INITIALLY DEFERRED);');
        const before = await state(runtime);
        await expect(runtime.mutateDB(db => { db.bankInfo = 'commit must fail'; }, {
            afterSave: async tx => { await tx.execute('INSERT INTO child_probe VALUES (123)'); }
        })).rejects.toThrow(/persistence failed/);
        expect(await state(runtime)).toEqual(before);
        expect((await runtime.client.execute('SELECT * FROM child_probe')).rows).toHaveLength(0);
    });
});

describe.skipIf(!process.env.TEST_LIBSQL_URL)('independent remote clients', () => {
    it('uses the server write lock and reads both commits from a third connection', async () => {
        const runtime = await makeRuntime();
        const url = process.env.TEST_LIBSQL_URL!;
        const first = createClient({ url });
        let observeRequest = false;
        let requestStarted!: () => void;
        const requestSent = new Promise<void>(resolve => { requestStarted = resolve; });
        const second = createClient({ url, fetch: (...args: Parameters<typeof fetch>) => {
            const response = fetch(...args); // Real HTTP; observe dispatch without replacing any response.
            if (observeRequest) requestStarted();
            return response;
        } });
        let firstStarted!: () => void;
        const started = new Promise<void>(resolve => { firstStarted = resolve; });
        let unblock!: () => void;
        const gate = new Promise<void>(resolve => { unblock = resolve; });
        const jobs: Promise<unknown>[] = [];
        try {
            await second.execute('SELECT 1');
            const a = withWriteTransaction(first, async tx => {
                await tx.execute("UPDATE metadata SET value=value || 'REMOTE_A' WHERE key='bankInfo'");
                firstStarted();
                await gate;
            });
            jobs.push(a);
            await Promise.race([started, a.then(() => { throw new Error('First transaction ended before acquiring its write lock'); })]);
            observeRequest = true;
            const b = withWriteTransaction(second, async tx => { await tx.execute("UPDATE metadata SET value=value || 'REMOTE_B' WHERE key='bankInfo'"); });
            jobs.push(b);
            let secondFinished = false;
            void b.then(() => { secondFinished = true; }, () => { secondFinished = true; });
            await requestSent;
            await new Promise(resolve => setTimeout(resolve, 30));
            expect(secondFinished).toBe(false);
            // B sent a real HTTP request while A still held the write lock.
            unblock();
            await Promise.all([a, b]);
        } finally { unblock?.(); await Promise.allSettled(jobs); first.close(); second.close(); }
        const verifier = createClient({ url });
        try { expect((await loadFromConnection(verifier)).bankInfo).toMatch(/REMOTE_A.*REMOTE_B$/); }
        finally { verifier.close(); }
        expect((await runtime.readDB())?.bankInfo).toMatch(/REMOTE_A.*REMOTE_B$/);
    });
});

describe('transactional backups', () => {
    it('restores business state and records safety while keeping auth cutoff and proposals', async () => {
        const runtime = await makeRuntime();
        const original = (await runtime.readDB())!;
        const id = await runtime.backupDB();
        await runtime.mutateDB(db => { db.bankInfo = 'after snapshot'; });
        await runtime.storeProposals([pendingProposal()]);
        await runtime.revokeAllSessions(12345);
        const proposals = await runtime.listProposals();
        const restored = await runtime.restoreSQLiteFromBackup(id, { type: 'backup.restored', summary: 'test restore', entityType: 'backup' });
        expect(restored.bankInfo).toBe(original.bankInfo);
        expect(restored.ledger.entries.at(-1)?.type).toBe('backup.restored');
        expect(await runtime.sessionsRevokedBefore()).toBe(12345);
        expect(await runtime.listProposals()).toEqual(proposals);
        expect((await runtime.client.execute("SELECT reason FROM backups WHERE reason='restore.safety'")).rows).toHaveLength(1);
    });
    it('reads the latest cutoff and proposals across runtime restarts without a cache', async () => {
        const runtime = await makeRuntime();
        const second = createRuntime({ rootDir: path.resolve('.'), dataDir: runtime.paths.dataDir, env: { NODE_ENV: 'test' } });
        runtimes.push(second);
        await second.ensureReady();
        expect(await second.sessionsRevokedBefore()).toBe(0);
        await runtime.revokeAllSessions(555);
        expect(await second.sessionsRevokedBefore()).toBe(555);
        await runtime.revokeAllSessions(111);
        expect(await second.sessionsRevokedBefore()).toBe(555);
        await runtime.storeProposals([pendingProposal()]);
        runtime.close();
        expect((await second.getProposal('atomic-proposal'))?.status).toBe('pending');
        expect(await second.sessionsRevokedBefore()).toBe(555);
    });
    it('keeps business data and all backups after restore or delete fails', async () => {
        const runtime = await makeRuntime();
        const id = await runtime.backupDB();
        await runtime.mutateDB(db => { db.bankInfo = 'must survive restore'; });
        const before = await state(runtime);
        await runtime.client.executeMultiple("CREATE TRIGGER fail_metadata BEFORE UPDATE ON metadata BEGIN SELECT RAISE(ABORT,'forced write failure'); END;");
        await expect(runtime.restoreSQLiteFromBackup(id, { type: 'backup.restored', summary: 'test failure' })).rejects.toThrow(/forced write failure/);
        expect(await state(runtime)).toEqual(before);
        await runtime.client.execute('DROP TRIGGER fail_metadata');
        await expect(runtime.mutateDB(db => { db.bankInfo = 'rolled back'; }, { afterSave: async tx => { await runtime.deleteBackup(tx, id); throw new Error('after delete'); } })).rejects.toThrow();
        expect(await state(runtime)).toEqual(before);
    });
    it('rejects a damaged snapshot without saving a safety snapshot', async () => {
        const runtime = await makeRuntime();
        const id = await runtime.backupDB();
        await runtime.client.execute({ sql: "UPDATE backups SET snapshot_json='not json' WHERE id=?", args: [id] });
        const before = await state(runtime);
        await expect(runtime.restoreSQLiteFromBackup(id, { type: 'backup.restored' })).rejects.toMatchObject({ status: 400 });
        expect(await state(runtime)).toEqual(before);
    });
});

describe.skipIf(Boolean(process.env.TEST_LIBSQL_URL))('file driver connection behavior', () => {
    it('queues path aliases through the entire transaction and keeps other leases alive', async () => {
        const runtime = await makeRuntime();
        const other = openDatabase(pathToFileURL(path.join(runtime.paths.dataDir, '..', path.basename(runtime.paths.dataDir), 'database.db')).href);
        const tx = await runtime.client.transaction('write');
        let readFinished = false;
        const queuedRead = loadFromSQLite(other).then(db => { readFinished = true; return db; });
        try {
            await tx.execute("UPDATE metadata SET value='committed' WHERE key='bankInfo'");
            await Promise.resolve();
            expect(readFinished).toBe(false);
            await tx.commit();
        } finally { tx.close(); }
        expect((await queuedRead).bankInfo).toBe('committed');
        runtime.close();
        await other.execute("UPDATE metadata SET value='after close' WHERE key='bankInfo'");
        expect((await loadFromSQLite(other)).bankInfo).toBe('after close');
        other.close();
    });
    it('replaces the connection after an external BUSY and proves the next write independently', async () => {
        const runtime = await makeRuntime();
        const independent = createClient({ url: pathToFileURL(runtime.paths.sqlitePath).href, concurrency: 1, timeout: 0 });
        try {
            const blocker = await independent.transaction('write');
            try { await expect(runtime.client.execute("UPDATE metadata SET value='busy' WHERE key='bankInfo'")).rejects.toThrow(/SQLITE_BUSY/); }
            finally { await blocker.rollback(); blocker.close(); }
            await runtime.mutateDB(db => { db.bankInfo = 'really committed'; });
        } finally { independent.close(); }
        const verifier = createClient({ url: pathToFileURL(runtime.paths.sqlitePath).href, concurrency: 1 });
        try { expect((await verifier.execute("SELECT value FROM metadata WHERE key='bankInfo'")).rows[0]?.value).toBe('really committed'); }
        finally { verifier.close(); }
    });
    it('replaces a connection after a failed BEGIN without replaying the mutator', async () => {
        const runtime = await makeRuntime();
        const independent = createClient({ url: pathToFileURL(runtime.paths.sqlitePath).href, concurrency: 1, timeout: 0 });
        let calls = 0;
        try {
            const blocker = await independent.transaction('write');
            await expect(runtime.mutateDB(() => { calls++; })).rejects.toThrow(/persistence failed/);
            expect(calls).toBe(0);
            await blocker.rollback();
            blocker.close();
            await runtime.mutateDB(db => { calls++; db.bankInfo = 'after begin failure'; });
            expect(calls).toBe(1);
        } finally { independent.close(); }
        expect((await runtime.readDB())?.bankInfo).toBe('after begin failure');
    });
});
