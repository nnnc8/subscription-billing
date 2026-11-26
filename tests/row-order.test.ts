import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { InStatement, Transaction } from '@libsql/client';
import { afterEach, describe, expect, it } from 'vitest';
import { normalizeDatabaseRelations } from '../lib/accounting.js';
import type { Database, HistoryEntry, Payment, TempCharge } from '../src/types/billing.js';
import {
    createRuntime,
    getCanonicalPersistedFingerprint,
    getCanonicalPersistedProjection,
    loadFromSQLite,
    runMigrations,
    saveToSQLite,
    writeDatabase,
    type Runtime
} from './test-database.js';

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function temporaryDirectory(): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'billing-row-order-'));
    directories.push(directory);
    return directory;
}

/** The fake fixtures/demo-database.json: members m_alpha, m_beta, m_gamma; s_alpha_video is subscriptions[0]. */
function fixture(): Database {
    return JSON.parse(fs.readFileSync('fixtures/demo-database.json', 'utf8')) as Database;
}

async function demoRuntime(): Promise<Runtime> {
    const runtime = createRuntime({ rootDir: path.resolve('.'), dataDir: temporaryDirectory(), env: { NODE_ENV: 'test', MIGRATE_FROM_JSON: '1' } });
    await runtime.ensureReady();
    return runtime;
}

/** Everything a restore brings back; the restore adds its own ledger event on top. */
function businessState(db: Database): Record<string, unknown> {
    const projection = getCanonicalPersistedProjection(db);
    delete projection.ledger;
    return projection;
}

function restoreEvent(filename: string) {
    return { type: 'backup.restored', summary: `還原備份 ${filename}`, entityType: 'backup', entityId: filename, payload: { filename } };
}

const ids = (rows: Array<{ id: string }>) => rows.map(row => row.id);

describe('restoring a backup after rows were deleted', () => {
    it('restores a backup taken before a middle member was deleted', async () => {
        const runtime = await demoRuntime();
        const before = (await runtime.readDB())!;
        expect(ids(before.members)).toEqual(['m_alpha', 'm_beta', 'm_gamma']);
        const filename = await runtime.backupDB();
        await runtime.mutateDB(db => {
            db.members = db.members.filter(member => member.id !== 'm_beta');
            db.subscriptions = db.subscriptions.filter(subscription => subscription.memberId !== 'm_beta');
            db.payments = db.payments.filter(payment => payment.memberId !== 'm_beta');
            db.tempCharges = db.tempCharges.filter(charge => charge.memberId !== 'm_beta');
        });
        expect(ids((await runtime.readDB())!.members)).toEqual(['m_alpha', 'm_gamma']);

        const restored = await runtime.restoreSQLiteFromBackup(filename, restoreEvent(filename));
        const persisted = (await runtime.readDB())!;
        expect(getCanonicalPersistedFingerprint(persisted)).toBe(getCanonicalPersistedFingerprint(restored));
        expect(businessState(persisted)).toEqual(businessState(before));
        expect(ids(persisted.members)).toEqual(['m_alpha', 'm_beta', 'm_gamma']);
        expect(ids(persisted.subscriptions)).toEqual(ids(before.subscriptions));
        expect(persisted.ledger.entries.at(-1)).toMatchObject({ type: 'backup.restored', entityId: filename });
        expect(runtime.getReadiness()).toEqual({ status: 'ready' });
    });

    it('restores a backup taken before subscriptions[0] was deleted', async () => {
        const runtime = await demoRuntime();
        const before = (await runtime.readDB())!;
        expect(before.subscriptions[0]?.id).toBe('s_alpha_video');
        const filename = await runtime.backupDB();
        await runtime.mutateDB(db => { db.subscriptions.splice(0, 1); });
        expect((await runtime.readDB())!.subscriptions[0]?.id).toBe('s_beta_video_1');

        const restored = await runtime.restoreSQLiteFromBackup(filename, restoreEvent(filename));
        const persisted = (await runtime.readDB())!;
        expect(getCanonicalPersistedFingerprint(persisted)).toBe(getCanonicalPersistedFingerprint(restored));
        expect(businessState(persisted)).toEqual(businessState(before));
        expect(ids(persisted.subscriptions)).toEqual(ids(before.subscriptions));
        expect(runtime.getReadiness()).toEqual({ status: 'ready' });
    });

    it('keeps the backup being restored when its safety snapshot reaches the retention limit', async () => {
        const runtime = await demoRuntime();
        const before = (await runtime.readDB())!;
        const filename = await runtime.backupDB();
        await runtime.mutateDB(db => {
            db.members.splice(1, 1);
            db.subscriptions = db.subscriptions.filter(subscription => subscription.memberId !== 'm_beta');
            db.payments = [];
        });
        const count = async () => Number((await runtime.client.execute('SELECT COUNT(*) AS count FROM backups')).rows[0]?.count);
        // Newer regular backups fill the retention limit, so the backup being restored is the oldest.
        for (let index = await count(); index < runtime.config.maxBackups; index += 1) {
            await runtime.client.execute({
                sql: 'INSERT INTO backups (id,created_at,reason,fingerprint,size,snapshot_json) SELECT ?,created_at,reason,fingerprint,size,snapshot_json FROM backups WHERE id=?',
                args: [`database_20990101_000000_${String(index).padStart(3, '0')}_aaaaaaaa.db`, filename]
            });
        }
        expect(await count()).toBe(runtime.config.maxBackups);

        await runtime.restoreSQLiteFromBackup(filename, restoreEvent(filename));
        const remaining = (await runtime.client.execute('SELECT id, reason FROM backups')).rows;
        expect(remaining.map(row => String(row.id))).toContain(filename);
        expect(remaining.filter(row => row.reason === 'restore.safety')).toHaveLength(1);
        expect(businessState((await runtime.readDB())!)).toEqual(businessState(before));
    });
});

describe('row order after writeDatabase', () => {
    it('keeps the array order of a normal mutation', async () => {
        const runtime = await demoRuntime();
        const { data } = await runtime.mutateDB(db => {
            db.members.unshift({ id: 'm_front', name: 'Front Member', priorBalance: 0, customFee: null });
            db.platforms.reverse();
            db.subscriptions.reverse();
        });
        const persisted = (await runtime.readDB())!;
        expect(ids(persisted.members)).toEqual(['m_front', 'm_alpha', 'm_beta', 'm_gamma']);
        expect(ids(persisted.platforms)).toEqual(['p_team', 'p_music', 'p_video']);
        expect(ids(persisted.subscriptions)).toEqual(ids(fixture().subscriptions).reverse());
        expect(getCanonicalPersistedFingerprint(persisted)).toBe(getCanonicalPersistedFingerprint(data));
        expect(runtime.getReadiness()).toEqual({ status: 'ready' });
    });

    it('leaves every business table in the order of the saved data', async () => {
        const sqlitePath = path.join(temporaryDirectory(), 'database.db');
        await runMigrations(sqlitePath);
        const payment = (id: string): Payment => ({ id, memberId: 'm_alpha', memberName: 'Member Alpha', date: '2026-06-01', amount: 10, method: 'transfer', cycle: '202606' });
        const charge = (id: string): TempCharge => ({ id, memberId: 'm_beta', memberName: 'Member Beta', amount: 5, desc: id });
        const month = (value: string): HistoryEntry => ({ month: value, balances: [], payments: [], tempCharges: [] });
        const initial = fixture();
        initial.payments = ['pay_1', 'pay_2', 'pay_3'].map(payment);
        initial.tempCharges = ['chg_1', 'chg_2', 'chg_3'].map(charge);
        initial.history = ['2026/01', '2026/02', '2026/03'].map(month);
        await saveToSQLite(sqlitePath, initial);

        // Every table gets a row inserted before existing rows, and its first row moves to the end.
        const next = await loadFromSQLite(sqlitePath);
        const reshuffle = <T>(rows: T[], inserted: T): T[] => [rows[1]!, inserted, ...rows.slice(2), rows[0]!];
        next.platforms = reshuffle(next.platforms, { id: 'p_new', name: 'New Platform', price: 10, billingMode: 'fixed', totalCost: 0, archived: false });
        next.members = reshuffle(next.members, { id: 'm_new', name: 'New Member', priorBalance: 0, customFee: null });
        next.subscriptions = reshuffle(next.subscriptions, { id: 's_new', memberId: 'm_new', memberName: 'New Member', platformId: 'p_new', platformName: 'New Platform', startMonth: '2026/06', allowDuplicate: false });
        next.payments = reshuffle(next.payments, payment('pay_new'));
        next.tempCharges = reshuffle(next.tempCharges, charge('chg_new'));
        next.history = reshuffle(next.history, month('2026/04'));
        await saveToSQLite(sqlitePath, next);

        const persisted = await loadFromSQLite(sqlitePath);
        expect(ids(persisted.platforms)).toEqual(['p_music', 'p_new', 'p_team', 'p_video']);
        expect(ids(persisted.members)).toEqual(['m_beta', 'm_new', 'm_gamma', 'm_alpha']);
        expect(ids(persisted.subscriptions)).toEqual(['s_beta_video_1', 's_new', 's_beta_video_2', 's_beta_music', 's_gamma_team', 's_alpha_video']);
        expect(ids(persisted.payments)).toEqual(['pay_2', 'pay_new', 'pay_3', 'pay_1']);
        expect(ids(persisted.tempCharges)).toEqual(['chg_2', 'chg_new', 'chg_3', 'chg_1']);
        expect(persisted.history.map(entry => entry.month)).toEqual(['2026/02', '2026/04', '2026/03', '2026/01']);
        expect(getCanonicalPersistedFingerprint(persisted)).toBe(getCanonicalPersistedFingerprint(normalizeDatabaseRelations(next)));
    });

    it('writes only changed rows and rewrites a table only when its order changes', async () => {
        const previous = normalizeDatabaseRelations(fixture());
        const written = async (next: Database): Promise<string[]> => {
            const statements: InStatement[] = [];
            const tx = { batch: async (batch: InStatement[]) => { statements.push(...batch); return []; } } as unknown as Transaction;
            await writeDatabase(tx, previous, next);
            return statements.map(statement => {
                if (typeof statement === 'string') return statement;
                const [verb, , table] = statement.sql.split(' ');
                const args = Array.isArray(statement.args) ? statement.args : [];
                return `${verb} ${table} ${verb === 'DELETE' ? args.join(',') : String(args[0])}`;
            });
        };

        const edited = structuredClone(previous);
        edited.members[1]!.name = 'Renamed Beta';
        edited.members.push({ id: 'm_new', name: 'New Member', priorBalance: 0, customFee: null });
        edited.subscriptions.splice(0, 1);
        expect(await written(edited)).toEqual([
            'INSERT members m_beta',
            'INSERT members m_new',
            'DELETE subscriptions s_alpha_video'
        ]);

        const reordered = structuredClone(previous);
        reordered.members.reverse();
        expect(await written(reordered)).toEqual([
            'DELETE members m_alpha,m_beta,m_gamma',
            'INSERT members m_gamma',
            'INSERT members m_beta',
            'INSERT members m_alpha'
        ]);
    });
});
