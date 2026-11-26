import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRuntime } from './test-database.js';

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function runtimeFor() {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'billing-bootstrap-'));
    directories.push(dataDir);
    return createRuntime({ rootDir: path.resolve('.'), dataDir, env: { NODE_ENV: 'test', MIGRATE_FROM_JSON: '1' } });
}
describe('retryable serverless readiness', () => {
    it('constructs without creating a database or its directory', () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'billing-no-side-effect-'));
        directories.push(directory);
        const dataDir = path.join(directory, 'not-created');
        const runtime = createRuntime({ dataDir, env: { NODE_ENV: 'test' } });
        expect(fs.existsSync(dataDir)).toBe(false);
        runtime.close();
        expect(fs.existsSync(dataDir)).toBe(false);
    });
    it('shares one readiness promise and retries malformed JSON without business writes', async () => {
        const runtime = runtimeFor();
        fs.writeFileSync(runtime.paths.dbPath, '{bad-json');
        const first = runtime.ensureReady();
        expect(runtime.ensureReady()).toBe(first);
        await expect(first).rejects.toThrow(/bootstrap migration failed/);
        expect((await runtime.client.execute('SELECT * FROM members')).rows).toHaveLength(0);
        expect((await runtime.client.execute('SELECT * FROM backups')).rows).toHaveLength(0);
        fs.copyFileSync('fixtures/demo-database.json', runtime.paths.dbPath);
        await runtime.ensureReady();
        expect((await runtime.readDB())?.currentMonth).toBe('2026/06');
        expect(runtime.getReadiness().status).toBe('ready');
        runtime.close();
    });
    it('rolls back every row when bootstrap violates a constraint', async () => {
        const runtime = runtimeFor();
        const invalid = JSON.parse(fs.readFileSync('fixtures/demo-database.json', 'utf8'));
        invalid.members[0].name = null;
        fs.writeFileSync(runtime.paths.dbPath, JSON.stringify(invalid));
        await expect(runtime.ensureReady()).rejects.toThrow(/bootstrap migration failed/);
        expect((await runtime.client.execute('SELECT * FROM members')).rows).toHaveLength(0);
        runtime.close();
    });
});
