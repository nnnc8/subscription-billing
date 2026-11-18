import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Request } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SESSION_COOKIE_NAME, createSessionCookieValue } from '../lib/auth.js';
import { verifyRequestSession } from '../server/middleware/auth.js';
import { createRuntime, type Runtime } from './test-database.js';

const secret = 'legacy-cutoff-session-secret-with-enough-length-0123456789';
const email = 'owner@example.com';
const directories: string[] = [];
afterEach(() => {
    vi.restoreAllMocks();
    for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function dataDirectory(): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'billing-legacy-cutoff-'));
    directories.push(directory);
    return directory;
}

/** DATA_DIR/auth-state.json, where versions before the database store kept the cutoff. */
function writeLegacyState(dataDir: string, content: string): void {
    fs.writeFileSync(path.join(dataDir, 'auth-state.json'), content, 'utf8');
}

async function start(dataDir: string): Promise<Runtime> {
    const runtime = createRuntime({
        rootDir: path.resolve('.'), dataDir,
        env: { NODE_ENV: 'test', MIGRATE_FROM_JSON: '1', APP_SESSION_SECRET: secret, GOOGLE_CLIENT_ID: 'test-client', GOOGLE_CLIENT_SECRET: 'test-secret', GOOGLE_ALLOWED_EMAILS: email }
    });
    await runtime.ensureReady();
    return runtime;
}

const withSession = (issuedAt: number) => ({
    headers: { cookie: `${SESSION_COOKIE_NAME}=${createSessionCookieValue({ secret, user: { email }, now: issuedAt })}` }
}) as unknown as Request;

describe('upgrading from the auth-state.json cutoff', () => {
    it('imports the file cutoff during ensureReady and keeps the larger value', async () => {
        const dataDir = dataDirectory();
        const legacyCutoff = Date.now() - 60_000;
        writeLegacyState(dataDir, JSON.stringify({ sessionsRevokedBefore: legacyCutoff }));
        const upgraded = await start(dataDir);
        expect(await upgraded.sessionsRevokedBefore()).toBe(legacyCutoff);
        expect(await verifyRequestSession(upgraded, withSession(legacyCutoff - 1))).toEqual({ ok: false, reason: 'revoked' });
        expect(await verifyRequestSession(upgraded, withSession(legacyCutoff))).toMatchObject({ ok: true });

        // A later "sign out every device" stored in the database outlives the older file.
        await upgraded.revokeAllSessions(legacyCutoff + 1_000);
        upgraded.close();
        const restarted = await start(dataDir);
        expect(await restarted.sessionsRevokedBefore()).toBe(legacyCutoff + 1_000);
        restarted.close();

        // A file cutoff later than the database one wins.
        writeLegacyState(dataDir, JSON.stringify({ sessionsRevokedBefore: legacyCutoff + 5_000 }));
        expect(await (await start(dataDir)).sessionsRevokedBefore()).toBe(legacyCutoff + 5_000);
    });

    it('starts without the file, and reports and skips an unusable one', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const missing = await start(dataDirectory());
        expect(missing.getReadiness()).toEqual({ status: 'ready' });
        expect(await missing.sessionsRevokedBefore()).toBe(0);
        expect(warn).not.toHaveBeenCalled();

        const unusable = ['{not json', 'null', '[]', '{}', '{"sessionsRevokedBefore":"1700000000000"}', '{"sessionsRevokedBefore":1.5}', '{"sessionsRevokedBefore":-1}'];
        for (const content of unusable) {
            const dataDir = dataDirectory();
            writeLegacyState(dataDir, content);
            const runtime = await start(dataDir);
            expect(runtime.getReadiness()).toEqual({ status: 'ready' });
            expect(await runtime.sessionsRevokedBefore()).toBe(0);
        }
        const directoryInstead = dataDirectory();
        fs.mkdirSync(path.join(directoryInstead, 'auth-state.json'));
        expect((await start(directoryInstead)).getReadiness()).toEqual({ status: 'ready' });

        expect(warn).toHaveBeenCalledTimes(unusable.length + 1);
        for (const [message] of warn.mock.calls) expect(String(message)).toContain('auth-state.json');
    });
});
