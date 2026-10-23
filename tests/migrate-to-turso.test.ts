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
