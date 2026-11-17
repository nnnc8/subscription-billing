import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { getCanonicalPersistedFingerprint, loadFromSQLite, openDatabase, runMigrations, saveToSQLite } from '../lib/db.js';
import { migrateToTurso } from '../scripts/migrate-to-turso.js';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
async function prepare() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'billing-import-'));
    directories.push(directory);
    const sourcePath = path.join(directory, 'source.db');
    const targetUrl = process.env.TEST_LIBSQL_URL || pathToFileURL(path.join(directory, 'target.db')).href;
    await runMigrations(sourcePath);
    const fixture = JSON.parse(fs.readFileSync('fixtures/demo-database.json', 'utf8'));
    await saveToSQLite(sourcePath, fixture);
    return { sourcePath, targetUrl };
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
