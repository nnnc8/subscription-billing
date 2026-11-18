import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { InStatement, Transaction } from '@libsql/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getSystemSnapshot, normalizeDatabaseRelations } from '../lib/accounting.js';
import { createBackupService } from '../server/services/backup.js';
import type { Database } from '../src/types/billing.js';
import {
    createRuntime,
    getCanonicalPersistedFingerprint,
    getCanonicalPersistedProjection,
    loadFromSQLite,
    openDatabase,
    runMigrations,
    saveToSQLite,
    withWriteTransaction,
    type Runtime
} from './test-database.js';

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function temporaryDirectory(): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'billing-backup-inventory-'));
    directories.push(directory);
    return directory;
}

const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const SHA256_HEX = /^[a-f0-9]{64}$/;

function fixture(): Database {
    return JSON.parse(fs.readFileSync('fixtures/demo-database.json', 'utf8')) as Database;
}

function runtimeFor(dataDir: string): Runtime {
    return createRuntime({ rootDir: path.resolve('.'), dataDir, env: { NODE_ENV: 'test', MIGRATE_FROM_JSON: '1' } });
}

async function demoRuntime(): Promise<Runtime> {
    const runtime = runtimeFor(temporaryDirectory());
    await runtime.ensureReady();
    return runtime;
}

function businessState(db: Database): Record<string, unknown> {
    const projection = getCanonicalPersistedProjection(db);
    delete projection.ledger;
    return projection;
}

function restoreEvent(filename: string) {
    return { type: 'backup.restored', summary: `還原備份 ${filename}`, entityType: 'backup', entityId: filename, payload: { filename } };
}

/** The system snapshot the inventory showed for a backup, apart from when it was generated. */
function expectedSummary(json: string): Record<string, unknown> {
    return { ...getSystemSnapshot(normalizeDatabaseRelations(JSON.parse(json))), generatedAt: expect.any(String) };
}

type LegacyRow = { id: string; fingerprint: string; json: string };
const VALID = 'database_20261101_090000_000_aaaaaaaa.db';
const TAMPERED = 'database_20261101_080000_000_bbbbbbbb.db';
const GARBLED = 'database_20261101_070000_000_cccccccc.db';

/** Writes a legacy backup row the way insertBackup did before migration 003. */
async function insertLegacyRow(sqlitePath: string, row: LegacyRow): Promise<void> {
    const client = openDatabase(sqlitePath);
    await client.execute({
        sql: 'INSERT INTO backups (id,created_at,reason,fingerprint,size,snapshot_json) VALUES (?,?,?,?,?,?)',
        args: [row.id, '2026-11-01T01:00:00.000Z', 'manual', row.fingerprint, Buffer.byteLength(row.json, 'utf8'), row.json]
    });
}

/**
 * A database at schema 002 with fake business data and three legacy backups whose
 * fingerprint column holds the full canonical JSON: one valid, one whose snapshot no
 * longer matches its fingerprint, and one that is not JSON at all.
 */
async function legacyDatabase() {
    const dataDir = temporaryDirectory();
    const sqlitePath = path.join(dataDir, 'database.db');
    const schema002 = path.join(dataDir, 'migrations-002');
    fs.mkdirSync(schema002);
    for (const file of ['001_init.sql', '002_serverless.sql']) fs.copyFileSync(path.join('lib', 'migrations', file), path.join(schema002, file));
    await runMigrations(sqlitePath, schema002);
    await saveToSQLite(sqlitePath, fixture());
    const data = await loadFromSQLite(sqlitePath);
    const valid: LegacyRow = { id: VALID, fingerprint: getCanonicalPersistedFingerprint(data), json: JSON.stringify(data) };
    const tampered: LegacyRow = { id: TAMPERED, fingerprint: valid.fingerprint, json: JSON.stringify({ ...data, bankInfo: 'edited after the backup' }) };
    const garbled: LegacyRow = { id: GARBLED, fingerprint: 'invalid', json: 'not json' };
    for (const row of [valid, tampered, garbled]) await insertLegacyRow(sqlitePath, row);
    return { dataDir, sqlitePath, data, valid, tampered, garbled };
}

async function backupRows(runtime: Runtime) {
    const rows = (await runtime.client.execute('SELECT id, fingerprint, summary FROM backups ORDER BY id')).rows;
    return Object.fromEntries(rows.map(row => [String(row.id), { fingerprint: String(row.fingerprint), summary: row.summary }]));
}

describe('backup inventory', () => {
    it('stores the sha256 of the canonical JSON and a summary for new backups', async () => {
        const runtime = await demoRuntime();
        const filename = await runtime.backupDB();
        const row = (await runtime.client.execute({ sql: 'SELECT fingerprint, size, snapshot_json, summary FROM backups WHERE id=?', args: [filename] })).rows[0]!;
        const json = String(row.snapshot_json);
        expect(row.fingerprint).toBe(sha256(getCanonicalPersistedFingerprint(normalizeDatabaseRelations(JSON.parse(json)))));
        expect(row.size).toBe(Buffer.byteLength(json, 'utf8'));
        expect(JSON.parse(String(row.summary))).toEqual(expectedSummary(json));
    });

    it('lists backups from stored summaries without reading snapshot_json', async () => {
        const runtime = await demoRuntime();
        const manual = await runtime.backupDB();
        await runtime.mutateDB(db => { db.bankInfo = 'changed after the manual backup'; }, { reason: 'test.mutation' });
        // A snapshot of a state restore would refuse, as a restore safety snapshot can be.
        const risky = await withWriteTransaction(runtime.client, async tx => runtime.insertBackup(tx, { ...fixture(), currentMonth: 'not-a-month' }, 'restore.safety'));
        const current = (await runtime.readDB())!;

        const execute = vi.spyOn(runtime.client, 'execute');
        const inventory = await runtime.listBackupInventory(current);
        const statements = execute.mock.calls.map(call => { const statement = call[0] as InStatement; return typeof statement === 'string' ? statement : statement.sql; });
        const results = await Promise.all(execute.mock.results.map(result => result.value as ReturnType<Runtime['client']['execute']>));
        execute.mockRestore();
        expect(statements).toEqual(['SELECT id, created_at, reason, size, summary FROM backups ORDER BY id DESC']);
        expect(results.map(result => result.columns)).toEqual([['id', 'created_at', 'reason', 'size', 'summary']]);
        expect(JSON.stringify(inventory)).not.toContain('snapshot_json');

        expect(inventory.current).toMatchObject({ fingerprint: expect.stringMatching(SHA256_HEX), currentMonth: '2026/06' });
        const backups = inventory.backups as Array<Record<string, unknown>>;
        const byName = Object.fromEntries(backups.map(backup => [String(backup.filename), backup]));
        expect(backups).toHaveLength(3);
        expect(byName[risky]).toMatchObject({ readable: false, reason: 'restore.safety', error: '備份內容無法讀取', restoreImpact: { summary: '備份內容無法讀取' } });
        const readable = backups.filter(backup => backup.readable);
        expect(readable).toHaveLength(2);
        for (const backup of readable) {
            expect(backup).toMatchObject({
                label: expect.stringMatching(/^\d{8}_\d{6}$/), mtime: expect.any(String), size: expect.any(Number),
                snapshot: { currentMonth: '2026/06', fingerprint: expect.stringMatching(SHA256_HEX), health: { label: expect.any(String), status: expect.any(String) } },
                restoreImpact: { sameBusinessState: false, summary: expect.any(String) }
            });
        }
        // The preview still reads and verifies the full snapshot, and agrees with the stored summary.
        const preview = await runtime.analyzeBackupFile(manual, inventory.current as Record<string, unknown>);
        expect(preview).toEqual({ ...byName[manual], snapshot: { ...(byName[manual]!.snapshot as object), generatedAt: expect.any(String) } });
    });

    it('deletes a backup without reading its snapshot', async () => {
        const runtime = await demoRuntime();
        const filename = await runtime.backupDB();
        const statements: string[] = [];
        await withWriteTransaction(runtime.client, async tx => {
            const recording = {
                execute: (statement: InStatement) => {
                    statements.push(typeof statement === 'string' ? statement : statement.sql);
                    return tx.execute(statement);
                }
            } as unknown as Transaction;
            await runtime.deleteBackup(recording, filename);
        });
        expect(statements).toEqual(['DELETE FROM backups WHERE id=?']);
        expect((await runtime.client.execute('SELECT id FROM backups')).rows).toHaveLength(0);
        await expect(withWriteTransaction(runtime.client, tx => runtime.deleteBackup(tx, filename))).rejects.toMatchObject({ status: 404 });
    });

    it('backfills legacy backups with the sha256 fingerprint and a summary, and they still restore', async () => {
        const legacy = await legacyDatabase();
        const runtime = runtimeFor(legacy.dataDir);
        await runtime.ensureReady();
        expect(runtime.getReadiness()).toEqual({ status: 'ready' });

        const rows = await backupRows(runtime);
        expect(rows[VALID]?.fingerprint).toBe(sha256(legacy.valid.fingerprint));
        expect(JSON.parse(String(rows[VALID]?.summary))).toEqual(expectedSummary(legacy.valid.json));
        // Damaged rows keep a fingerprint that cannot match, and list as unreadable.
        expect(rows[TAMPERED]).toEqual({ fingerprint: sha256(legacy.tampered.fingerprint), summary: 'null' });
        expect(rows[GARBLED]).toEqual({ fingerprint: sha256('invalid'), summary: 'null' });
        const inventory = await runtime.listBackupInventory((await runtime.readDB())!);
        expect((inventory.backups as Array<Record<string, unknown>>).map(backup => [backup.filename, backup.readable])).toEqual([
            [VALID, true], [TAMPERED, false], [GARBLED, false]
        ]);

        await runtime.mutateDB(db => { db.bankInfo = 'changed after the legacy backup'; db.members.splice(1, 1); db.subscriptions = db.subscriptions.filter(item => item.memberId !== 'm_beta'); db.payments = []; });
        await runtime.restoreSQLiteFromBackup(VALID, restoreEvent(VALID));
        expect(businessState((await runtime.readDB())!)).toEqual(businessState(legacy.data));

        // Restore verifies the stored sha256.
        await expect(runtime.restoreSQLiteFromBackup(TAMPERED, restoreEvent(TAMPERED))).rejects.toMatchObject({ status: 400 });
        await expect(runtime.restoreSQLiteFromBackup(GARBLED, restoreEvent(GARBLED))).rejects.toMatchObject({ status: 400 });
        await runtime.client.execute({ sql: 'UPDATE backups SET fingerprint=? WHERE id=?', args: [sha256('another canonical JSON'), VALID] });
        await expect(runtime.restoreSQLiteFromBackup(VALID, restoreEvent(VALID))).rejects.toMatchObject({ status: 400 });
    });

    it('backfills once when two cold starts race, and a later run changes nothing', async () => {
        const legacy = await legacyDatabase();
        const first = runtimeFor(legacy.dataDir);
        const second = runtimeFor(legacy.dataDir);
        await Promise.all([first.ensureReady(), second.ensureReady()]);
        const rows = await backupRows(first);
        expect(rows[VALID]?.fingerprint).toBe(sha256(legacy.valid.fingerprint));
        expect(rows[GARBLED]?.fingerprint).toBe(sha256('invalid'));
        const before = (await first.client.execute('SELECT * FROM backups ORDER BY id')).rows;
        expect(await second.backfillBackupSummaries()).toBe(0);
        expect((await first.client.execute('SELECT * FROM backups ORDER BY id')).rows).toEqual(before);
    });

    it('restores a legacy row written after startup and fills it on the next run', async () => {
        const runtime = await demoRuntime();
        const data = (await runtime.readDB())!;
        const late: LegacyRow = { id: VALID, fingerprint: getCanonicalPersistedFingerprint(data), json: JSON.stringify(data) };
        await insertLegacyRow(runtime.paths.sqlitePath, late);
        await runtime.mutateDB(db => { db.bankInfo = 'changed after the late legacy row'; });
        await runtime.restoreSQLiteFromBackup(VALID, restoreEvent(VALID));
        expect(businessState((await runtime.readDB())!)).toEqual(businessState(data));

        expect(await runtime.backfillBackupSummaries()).toBe(1);
        const row = (await backupRows(runtime))[VALID];
        expect(row?.fingerprint).toBe(sha256(late.fingerprint));
        expect(JSON.parse(String(row?.summary))).toEqual(expectedSummary(late.json));
    });

    it('backfills in write transactions that each read a bounded number of bytes', async () => {
        const legacy = await legacyDatabase();
        const client = openDatabase(legacy.sqlitePath);
        await runMigrations(client);
        const service = createBackupService({ client, backfillBatchBytes: 1 });
        const transaction = vi.spyOn(client, 'transaction');
        expect(await service.backfillBackupSummaries()).toBe(3);
        expect(transaction).toHaveBeenCalledTimes(3);
        transaction.mockRestore();
        const rows = (await client.execute('SELECT fingerprint, summary FROM backups')).rows;
        expect(rows.every(row => SHA256_HEX.test(String(row.fingerprint)) && row.summary !== null)).toBe(true);
    });
});
