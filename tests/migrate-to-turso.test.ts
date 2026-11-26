import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Request } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendLedgerEvent, ensureHistorySeals, findAccountingWarnings, normalizeDatabaseRelations } from '../lib/accounting.js';
import { SESSION_COOKIE_NAME, createSessionCookieValue } from '../lib/auth.js';
import { getCanonicalPersistedFingerprint, loadFromSQLite, openDatabase, runMigrations, saveToSQLite } from '../lib/db.js';
import { advanceMonthOnce } from '../lib/lifecycle.js';
import { migrateToTurso } from '../scripts/migrate-to-turso.js';
import { verifyRequestSession } from '../server/middleware/auth.js';
import type { Database, Member, Platform, Subscription } from '../src/types/billing.js';
import { createRuntime } from './test-database.js';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
function temporaryDirectory(): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'billing-import-'));
    directories.push(directory);
    return directory;
}
const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
async function prepare() {
    const directory = temporaryDirectory();
    const sourcePath = path.join(directory, 'source.db');
    const targetUrl = process.env.TEST_LIBSQL_URL || pathToFileURL(path.join(directory, 'target.db')).href;
    await runMigrations(sourcePath);
    const fixture = JSON.parse(fs.readFileSync('fixtures/demo-database.json', 'utf8'));
    await saveToSQLite(sourcePath, fixture);
    return { sourcePath, targetUrl };
}

/**
 * Fake records in the shape of the real ledger: 8 members (2 with a custom fee), 4 platforms,
 * 14 subscriptions (2 are one member's intentional extra seats), 2026/02 to 2026/10 closed
 * with 2026/10 sealed as legacy-sealed, 26 ledger events, and 2026/11 open.
 */
function realShapedLedger(): Database {
    const platforms: Platform[] = [
        { id: 'p_video', name: 'Video Plus', billingMode: 'fixed', price: 120, totalCost: 0 },
        { id: 'p_music', name: 'Music Family', billingMode: 'fixed', price: 60, totalCost: 0 },
        { id: 'p_cloud', name: 'Cloud Drive', billingMode: 'fixed', price: 30, totalCost: 0 },
        { id: 'p_team', name: 'Team Suite', billingMode: 'split', price: 0, totalCost: 400 }
    ];
    const members: Member[] = Array.from({ length: 8 }, (_, index) => ({
        id: `m_${index + 1}`, name: `Member ${index + 1}`, priorBalance: 0, customFee: index === 1 ? 150 : index === 4 ? 80 : null
    }));
    // [member, platform index, seat label]: member 6 holds two Video Plus seats on purpose.
    const plan: Array<[number, number, string?]> = [[1, 0], [1, 1], [2, 0], [2, 2], [3, 1], [3, 3], [4, 0], [4, 3], [5, 2], [5, 3], [6, 0, 'Seat A'], [6, 0, 'Seat B'], [7, 1], [8, 3]];
    const subscriptions: Subscription[] = plan.map(([member, platform, seat], index) => ({
        id: `s_${index + 1}`, memberId: `m_${member}`, memberName: `Member ${member}`,
        platformId: platforms[platform]!.id, platformName: platforms[platform]!.name, startMonth: '2026/02',
        ...(seat ? { seatLabel: seat, allowDuplicate: true } : {})
    }));
    const db = normalizeDatabaseRelations({
        currentMonth: '2026/02', baseMonth: '2026/02', bankInfo: 'Fake Bank (000) 0000-0000-0000', reminderStyle: 'minimal',
        platforms, members, subscriptions, payments: [], tempCharges: [], history: [],
        ledger: { version: 1, entries: [], lastHash: '', updatedAt: '' }
    });
    const pay = (month: string, member: number, slot: number) => {
        const [year, monthNumber] = month.split('/');
        const id = `pay_${year}${monthNumber}_${slot}`;
        const at = `${year}-${monthNumber}-15T1${slot}:00:00.000Z`;
        db.payments.push({ id, memberId: `m_${member}`, memberName: `Member ${member}`, date: `${year}-${monthNumber}-15`, amount: 100, method: 'transfer', cycle: `${year}${monthNumber}`, recordedAt: at });
        appendLedgerEvent(db, { at, type: 'payment.recorded', summary: `Fake payment ${id}`, entityType: 'payment', entityId: id, amount: 100, month, payload: { paymentId: id } });
    };
    // A month close stamps the clock time on its seal and ledger event, so pin it to each month.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
        for (let month = 2; month <= 10; month++) {
            const label = `2026/${String(month).padStart(2, '0')}`;
            if (month > 2) { pay(label, ((month - 3) % 8) + 1, 0); pay(label, ((month - 2) % 8) + 1, 1); }
            vi.setSystemTime(new Date(`${label.replace('/', '-')}-28T12:00:00.000Z`));
            expect(advanceMonthOnce(db, '2026/11')).toMatchObject({ advanced: true });
        }
        pay('2026/11', 3, 0);
        delete db.history.at(-1)!.seal;
        ensureHistorySeals(db);
    } finally { vi.useRealTimers(); }
    expect(db.history.map(entry => entry.month)).toEqual(['2026/02', '2026/03', '2026/04', '2026/05', '2026/06', '2026/07', '2026/08', '2026/09', '2026/10']);
    expect(db.history.at(-1)?.seal?.reason).toBe('legacy-sealed');
    expect(db.ledger.entries).toHaveLength(26);
    expect(findAccountingWarnings(db).filter(warning => warning.severity === 'high' || warning.severity === 'critical')).toEqual([]);
    return db;
}

/** The eight metadata rows main's better-sqlite3 saveToSQLite wrote on every save. */
function mainEraMetadata(data: Database): Record<string, string> {
    return {
        currentMonth: data.currentMonth || '', baseMonth: data.baseMonth || '',
        bankInfo: data.bankInfo || '', reminderStyle: data.reminderStyle || '',
        ledgerLastHash: data.ledger?.lastHash || '', ledgerUpdatedAt: data.ledger?.updatedAt || '',
        ledgerVersion: String(data.ledger?.version || 1), lifecycle: data.lifecycle ? JSON.stringify(data.lifecycle) : ''
    };
}

/**
 * A source as main's better-sqlite3 version left it: schema 001 only, so no auth_state,
 * backups or automation_proposals table, and every metadata row, defaults included.
 */
async function mainEraSource(data: Database, metadata: (saved: Database) => Record<string, string> = mainEraMetadata) {
    const directory = temporaryDirectory();
    const schema001 = path.join(directory, 'migrations-001');
    fs.mkdirSync(schema001);
    fs.copyFileSync(path.join('lib', 'migrations', '001_init.sql'), path.join(schema001, '001_init.sql'));
    const sourcePath = path.join(directory, 'source.db');
    await runMigrations(sourcePath, schema001);
    await saveToSQLite(sourcePath, data);
    const rows = metadata(await loadFromSQLite(sourcePath));
    const client = openDatabase(sourcePath);
    try {
        await client.batch(['DELETE FROM metadata', ...Object.entries(rows).map(([key, value]) => ({ sql: 'INSERT INTO metadata (key, value) VALUES (?, ?)', args: [key, value] }))], 'write');
        const tables = (await client.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")).rows.map(row => String(row.name));
        expect(tables).not.toContain('auth_state');
        expect((await client.execute('SELECT version FROM schema_migrations')).rows.map(row => String(row.version))).toEqual(['001_init']);
    } finally { client.close(); }
    return { sourcePath, targetUrl: process.env.TEST_LIBSQL_URL || pathToFileURL(path.join(directory, 'target.db')).href };
}

/** The metadata table exactly as stored, in key order. */
async function metadataRows(url: string): Promise<Array<{ key: string; value: unknown }>> {
    const client = openDatabase(url);
    try { return (await client.execute('SELECT key, value FROM metadata ORDER BY key')).rows.map(row => ({ key: String(row.key), value: row.value })); }
    finally { client.close(); }
}

it('migrates business data, refuses overwrite, and preserves a safety backup with --force', async () => {
    const options = await prepare();
    const result = await migrateToTurso(options);
    expect(result.imported).toBe(true);
    expect(result.fingerprintSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(getCanonicalPersistedFingerprint(await loadFromSQLite(options.targetUrl))).toBe(getCanonicalPersistedFingerprint(await loadFromSQLite(options.sourcePath)));
    await expect(migrateToTurso(options)).rejects.toThrow(/Target contains business data/);
    const changed = await loadFromSQLite(options.sourcePath);
    changed.bankInfo = 'replacement';
    await saveToSQLite(options.sourcePath, changed);
    await migrateToTurso({ ...options, force: true });
    expect((await loadFromSQLite(options.targetUrl)).bankInfo).toBe('replacement');
    const client = openDatabase(options.targetUrl);
    try { expect((await client.execute("SELECT reason FROM backups WHERE reason='migration.safety'")).rows).toHaveLength(1); }
    finally { client.close(); }
});
it('rewrites target tables whose rows are in another order with --force', async () => {
    const options = await prepare();
    await migrateToTurso(options);
    // A source with the same rows in another order, written into a fresh file in array order.
    const reordered = JSON.parse(fs.readFileSync('fixtures/demo-database.json', 'utf8'));
    reordered.members.reverse();
    reordered.platforms.reverse();
    reordered.subscriptions.reverse();
    const sourcePath = path.join(path.dirname(options.sourcePath), 'reordered.db');
    await runMigrations(sourcePath);
    await saveToSQLite(sourcePath, reordered);
    expect((await migrateToTurso({ ...options, sourcePath, force: true })).imported).toBe(true);
    const target = await loadFromSQLite(options.targetUrl);
    expect(target.members.map(member => member.id)).toEqual(['m_gamma', 'm_beta', 'm_alpha']);
    expect(target.platforms.map(platform => platform.id)).toEqual(['p_team', 'p_music', 'p_video']);
    expect(target.subscriptions.map(subscription => subscription.id)).toEqual(['s_gamma_team', 's_beta_music', 's_beta_video_2', 's_beta_video_1', 's_alpha_video']);
    expect(getCanonicalPersistedFingerprint(target)).toBe(getCanonicalPersistedFingerprint(await loadFromSQLite(sourcePath)));
});
it('dry-runs without creating or changing a target and rejects using the source as target', async () => {
    const options = await prepare();
    const localTarget = path.join(path.dirname(options.sourcePath), 'dry-run-target.db');
    expect((await migrateToTurso({ ...options, targetUrl: pathToFileURL(localTarget).href, dryRun: true })).imported).toBe(false);
    expect(fs.existsSync(localTarget)).toBe(false);
    await expect(migrateToTurso({ ...options, targetUrl: pathToFileURL(options.sourcePath).href })).rejects.toThrow(/must be different/);
});
it('rolls back data and the safety snapshot if target writing fails', async () => {
    const options = await prepare();
    await migrateToTurso(options);
    const before = getCanonicalPersistedFingerprint(await loadFromSQLite(options.targetUrl));
    const changed = await loadFromSQLite(options.sourcePath);
    changed.bankInfo = 'must rollback';
    await saveToSQLite(options.sourcePath, changed);
    const client = openDatabase(options.targetUrl);
    try {
        await client.executeMultiple("CREATE TRIGGER fail_import BEFORE UPDATE ON metadata BEGIN SELECT RAISE(ABORT,'forced import failure'); END;");
        await expect(migrateToTurso({ ...options, force: true })).rejects.toThrow(/forced import failure/);
        expect(getCanonicalPersistedFingerprint(await loadFromSQLite(options.targetUrl))).toBe(before);
        expect((await client.execute('SELECT * FROM backups')).rows).toHaveLength(0);
    } finally { client.close(); }
});
describe('metadata rows', () => {
    const keys = ['bankInfo', 'baseMonth', 'currentMonth', 'ledgerLastHash', 'ledgerUpdatedAt', 'ledgerVersion', 'lifecycle', 'reminderStyle'];
    it('copies all eight metadata rows of a main-era source, ledgerVersion=1 included', async () => {
        const options = await mainEraSource(realShapedLedger());
        const source = await metadataRows(options.sourcePath);
        expect(source.map(row => row.key)).toEqual(keys);
        expect(source).toEqual(expect.arrayContaining([
            { key: 'ledgerVersion', value: '1' }, { key: 'reminderStyle', value: 'minimal' },
            { key: 'baseMonth', value: '2026/02' }, { key: 'currentMonth', value: '2026/11' }
        ]));
        const result = await migrateToTurso(options);
        expect(await metadataRows(options.targetUrl)).toEqual(source);
        // Copying the rows leaves the canonical fingerprint of the data as it was.
        const fingerprint = getCanonicalPersistedFingerprint(await loadFromSQLite(options.sourcePath));
        expect(result.fingerprintSha256).toBe(sha256(fingerprint));
        expect(getCanonicalPersistedFingerprint(await loadFromSQLite(options.targetUrl))).toBe(fingerprint);
    });
    it('copies metadata rows whose values all equal the code defaults', async () => {
        const data = JSON.parse(fs.readFileSync('fixtures/demo-database.json', 'utf8')) as Database;
        Object.assign(data, { currentMonth: '2026/05', baseMonth: '2026/05', bankInfo: '', reminderStyle: 'friendly', payments: [], tempCharges: [], history: [], ledger: { version: 1, entries: [], lastHash: '', updatedAt: '' } });
        const defaults = { currentMonth: '2026/05', baseMonth: '2026/05', bankInfo: '', reminderStyle: 'friendly', ledgerLastHash: '', ledgerUpdatedAt: '', ledgerVersion: '1', lifecycle: '' };
        const options = await mainEraSource(data, () => defaults);
        const source = await metadataRows(options.sourcePath);
        expect(source).toHaveLength(8);
        await migrateToTurso(options);
        expect(await metadataRows(options.targetUrl)).toEqual(source);
    });
    it('leaves exactly the source metadata rows in a target replaced with --force', async () => {
        const options = await mainEraSource(realShapedLedger());
        await migrateToTurso(options);
        const client = openDatabase(options.targetUrl);
        try { await client.execute("INSERT INTO metadata (key, value) VALUES ('unknownKey', 'written by another tool')"); }
        finally { client.close(); }
        await migrateToTurso({ ...options, force: true });
        expect(await metadataRows(options.targetUrl)).toEqual(await metadataRows(options.sourcePath));
    });
    it('reports committed metadata rows that differ from the source rows', async () => {
        const options = await mainEraSource(realShapedLedger());
        await runMigrations(options.targetUrl);
        const client = openDatabase(options.targetUrl);
        try {
            // '1.0' still loads as ledger version 1, so only the raw row comparison can notice it.
            await client.executeMultiple("CREATE TRIGGER rewrite_ledger_version AFTER INSERT ON metadata WHEN NEW.key='ledgerVersion' BEGIN UPDATE metadata SET value='1.0' WHERE key='ledgerVersion'; END;");
        } finally { client.close(); }
        await expect(migrateToTurso(options)).rejects.toThrow(/Committed target metadata mismatch/);
    });
});
describe('lifecycle catch-up before the import', () => {
    afterEach(() => { vi.useRealTimers(); });
    const highRisk = (data: Database) => findAccountingWarnings(data).filter(warning => warning.severity === 'high' || warning.severity === 'critical');
    /** Mid-month in Asia/Taipei, so runLifecycleCatchUp closes every month before `month`. */
    function clockAt(month: string): void {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(`${month.replace('/', '-')}-15T04:00:00.000Z`));
    }
    /** A source holding `data`, and a target file that a refused import must never create. */
    async function sourceFile(data: Database) {
        const directory = temporaryDirectory();
        const sourcePath = path.join(directory, 'source.db');
        await runMigrations(sourcePath);
        await saveToSQLite(sourcePath, data);
        return { sourcePath, targetUrl: pathToFileURL(path.join(directory, 'target.db')).href };
    }
    async function expectRefused(options: { sourcePath: string; targetUrl: string }, reason: RegExp): Promise<void> {
        await expect(migrateToTurso({ ...options, dryRun: true })).rejects.toThrow(reason);
        await expect(migrateToTurso(options)).rejects.toThrow(reason);
        expect(fs.existsSync(fileURLToPath(options.targetUrl))).toBe(false);
    }

    it('refuses a source whose open month is already sealed, and still imports the fixture a month later', async () => {
        const sealed = normalizeDatabaseRelations(JSON.parse(fs.readFileSync('fixtures/demo-database.json', 'utf8')) as Database);
        // Close 2026/06 and reopen it, as if the month had been closed twice.
        clockAt('2026/06');
        expect(advanceMonthOnce(sealed, '2026/07')).toMatchObject({ advanced: true, to: '2026/07' });
        vi.useRealTimers();
        sealed.currentMonth = '2026/06';
        // The existing domain check lets it through: being sealed already is only a medium warning.
        expect(highRisk(sealed)).toEqual([]);
        expect(findAccountingWarnings(sealed).map(warning => warning.code)).toContain('current_month_already_in_history');
        const refused = await sourceFile(sealed);
        const clean = await prepare();

        clockAt('2026/07');
        await expectRefused(refused, /2026\/06.*已存在於歷史封存/);
        expect((await migrateToTurso(clean)).imported).toBe(true);
        // The import writes the source as it is, not the copy the check closed.
        const source = await loadFromSQLite(clean.sourcePath);
        const target = await loadFromSQLite(clean.targetUrl);
        expect(getCanonicalPersistedFingerprint(target)).toBe(getCanonicalPersistedFingerprint(source));
        expect(target.currentMonth).toBe('2026/06');
        expect(target.history).toEqual([]);
    });

    it('refuses subscriptions that overlap only from next month, and still imports the real-shaped ledger unchanged', async () => {
        const ledger = realShapedLedger();
        const refused = await sourceFile(ledger);
        // Written straight into the source: Member 1 gets a second Video Plus seat from 2026/12.
        const client = openDatabase(refused.sourcePath);
        try {
            await client.execute({
                sql: 'INSERT INTO subscriptions (id, memberId, platformId, memberName, platformName, startMonth, exitMonth, seatLabel, allowDuplicate) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 0)',
                args: ['s_15', 'm_1', 'p_video', 'Member 1', 'Video Plus', '2026/12']
            });
        } finally { client.close(); }
        expect(highRisk(await loadFromSQLite(refused.sourcePath))).toEqual([]);
        const clean = await mainEraSource(ledger);

        clockAt('2026/12');
        await expectRefused(refused, /2026\/12.*duplicate_active_subscription/);
        const result = await migrateToTurso(clean);
        expect(result.imported).toBe(true);
        const source = await loadFromSQLite(clean.sourcePath);
        const target = await loadFromSQLite(clean.targetUrl);
        expect(getCanonicalPersistedFingerprint(target)).toBe(getCanonicalPersistedFingerprint(source));
        expect(result.fingerprintSha256).toBe(sha256(getCanonicalPersistedFingerprint(source)));
        expect(target.currentMonth).toBe('2026/11');
        expect(target.history).toHaveLength(9);
        expect(target.ledger.entries).toHaveLength(26);
        expect(target.subscriptions.filter(subscription => subscription.allowDuplicate && subscription.seatLabel).map(subscription => subscription.id)).toEqual(['s_11', 's_12']);
    });
});
describe('session cutoff', () => {
    const secret = 'migration-session-secret-with-enough-length-0123456789';
    const email = 'owner@example.com';
    /** The app as it starts on the migrated target. */
    async function appOn(targetUrl: string) {
        const runtime = createRuntime({
            rootDir: path.resolve('.'), dataDir: temporaryDirectory(),
            env: { NODE_ENV: 'test', TURSO_DATABASE_URL: targetUrl, APP_SESSION_SECRET: secret, GOOGLE_CLIENT_ID: 'test-client', GOOGLE_CLIENT_SECRET: 'test-secret', GOOGLE_ALLOWED_EMAILS: email }
        });
        await runtime.ensureReady();
        return runtime;
    }
    const withSession = (issuedAt: number) => ({
        headers: { cookie: `${SESSION_COOKIE_NAME}=${createSessionCookieValue({ secret, user: { email }, now: issuedAt })}` }
    }) as unknown as Request;
    it('signs out sessions issued before the import, in its transaction, and never lowers a later cutoff', async () => {
        const options = await mainEraSource(realShapedLedger());
        const startedAt = Date.now();
        await migrateToTurso(options);
        const runtime = await appOn(options.targetUrl);
        const cutoff = await runtime.sessionsRevokedBefore();
        expect(cutoff).toBeGreaterThanOrEqual(startedAt);
        expect(cutoff).toBeLessThanOrEqual(Date.now());
        expect(await verifyRequestSession(runtime, withSession(startedAt - 1))).toEqual({ ok: false, reason: 'revoked' });
        expect(await verifyRequestSession(runtime, withSession(cutoff))).toMatchObject({ ok: true });

        // A --force import keeps a later "sign out every device" made on the target.
        await runtime.revokeAllSessions(cutoff + 3_600_000);
        await migrateToTurso({ ...options, force: true });
        expect(await runtime.sessionsRevokedBefore()).toBe(cutoff + 3_600_000);

        // A failed import also rolls back its cutoff.
        await runtime.client.execute("UPDATE auth_state SET value='1' WHERE key='sessionsRevokedBefore'");
        const changed = await loadFromSQLite(options.sourcePath);
        changed.bankInfo = 'must roll back';
        await saveToSQLite(options.sourcePath, changed);
        // Fails the read-back check at the end of the import transaction.
        await runtime.client.executeMultiple("CREATE TRIGGER corrupt_import AFTER UPDATE ON metadata WHEN NEW.key='bankInfo' BEGIN UPDATE metadata SET value='changed by a trigger' WHERE key='bankInfo'; END;");
        await expect(migrateToTurso({ ...options, force: true })).rejects.toThrow(/read-back mismatch/);
        expect(await runtime.sessionsRevokedBefore()).toBe(1);
    });
});
