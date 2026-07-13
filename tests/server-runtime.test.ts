import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRuntime } from '../server/runtime.js';

const rootDir = path.resolve('.');
const fixturePath = path.join(rootDir, 'fixtures', 'demo-database.json');
const temporaryDirectories: string[] = [];

function makeDirectory(prefix: string): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    temporaryDirectories.push(directory);
    return directory;
}

function runtimeFor(dataDir: string) {
    return createRuntime({
        rootDir,
        env: { NODE_ENV: 'test', DATA_DIR: dataDir, MIGRATE_FROM_JSON: '1' }
    });
}

function expectNoLiveSqlite(dataDir: string): void {
    for (const suffix of ['', '-wal', '-shm']) {
        expect(fs.existsSync(path.join(dataDir, `database.db${suffix}`))).toBe(false);
    }
    expect(fs.readdirSync(dataDir).some(filename => filename.includes('.database.bootstrap-'))).toBe(false);
}

async function runServer(dataDir: string): Promise<number | null> {
    const child = spawn(process.execPath, [path.join(rootDir, 'node_modules/tsx/dist/cli.mjs'), 'server.ts'], {
        cwd: rootDir,
        env: {
            ...process.env,
            NODE_ENV: 'test',
            HOST: '127.0.0.1',
            PORT: '0',
            DATA_DIR: dataDir,
            DB_PATH: path.join(dataDir, 'database.json'),
            SQLITE_PATH: path.join(dataDir, 'database.db'),
            BACKUP_DIR: path.join(dataDir, 'backups'),
            MIGRATE_FROM_JSON: '1'
        },
        stdio: 'ignore'
    });
    return await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', resolve);
    });
}

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

describe('atomic SQLite bootstrap', () => {
    it('leaves no live database after malformed JSON process startup and succeeds on retry', async () => {
        const dataDir = makeDirectory('billing-bootstrap-malformed-');
        const jsonPath = path.join(dataDir, 'database.json');
        fs.writeFileSync(jsonPath, '{malformed', 'utf8');

        expect(await runServer(dataDir)).not.toBe(0);
        expectNoLiveSqlite(dataDir);

        fs.copyFileSync(fixturePath, jsonPath);
        const runtime = runtimeFor(dataDir);
        expect(() => runtime.initialize()).not.toThrow();
        expect(runtime.readDB()?.currentMonth).toBe('2026/06');
    });

    it('throws on a SQLite constraint failure and removes the staged database', () => {
        const dataDir = makeDirectory('billing-bootstrap-constraint-');
        const invalid = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as {
            members: Array<Record<string, unknown>>;
        };
        invalid.members[0]!.name = null;
        fs.writeFileSync(path.join(dataDir, 'database.json'), JSON.stringify(invalid), 'utf8');

        expect(() => runtimeFor(dataDir).initialize()).toThrow(/bootstrap migration failed/i);
        expectNoLiveSqlite(dataDir);
    });
});
