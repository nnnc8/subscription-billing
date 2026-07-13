const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const {
    OAUTH_STATE_COOKIE_NAME,
    SESSION_COOKIE_NAME,
    createSessionCookieValue,
    verifySessionCookieValue
} = require('../lib/auth');

const root = path.resolve(__dirname, '..');
const sessionSecret = 'test-session-secret-with-enough-length-1234567890';
const allowedEmail = 'owner@example.com';
const blockedEmail = 'intruder@example.com';

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function parseForm(body) {
    return Object.fromEntries(new URLSearchParams(body));
}

function createFakeGoogleServer() {
    const state = {
        lastTokenRequest: null,
        nextProfile: {
            sub: 'google-user-1',
            email: allowedEmail,
            email_verified: true,
            name: 'Owner User'
        }
    };

    const server = http.createServer((req, res) => {
        if (req.url.startsWith('/oauth2/v2/auth')) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(Object.fromEntries(new URL(req.url, 'http://fake-google').searchParams)));
            return;
        }

        if (req.url === '/token' && req.method === 'POST') {
            let body = '';
            req.on('data', chunk => {
                body += chunk.toString();
            });
            req.on('end', () => {
                state.lastTokenRequest = parseForm(body);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    access_token: 'fake-access-token',
                    expires_in: 3600,
                    token_type: 'Bearer'
                }));
            });
            return;
        }

        if (req.url === '/userinfo') {
            if (req.headers.authorization !== 'Bearer fake-access-token') {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'bad token' }));
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(state.nextProfile));
            return;
        }

        res.writeHead(404);
        res.end();
    });

    return new Promise(resolve => {
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            resolve({
                state,
                baseUrl: `http://127.0.0.1:${port}`,
                close: () => new Promise(done => server.close(done))
            });
        });
    });
}

async function waitForHealth(baseUrl, child) {
    const started = Date.now();
    let lastError = null;
    while (Date.now() - started < 5000) {
        if (child.exitCode !== null) {
            throw new Error(`server exited early with code ${child.exitCode}`);
        }
        try {
            const res = await fetch(`${baseUrl}/api/health`);
            if (res.ok) return;
            lastError = new Error(`health returned ${res.status}`);
        } catch (err) {
            lastError = err;
        }
        await sleep(100);
    }
    throw lastError || new Error('server did not become healthy');
}

async function withServer(fakeGoogle, fn) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'subscription-billing-auth-'));
    fs.copyFileSync(path.join(root, 'fixtures', 'demo-database.json'), path.join(dataDir, 'database.json'));
    const port = String(3300 + Math.floor(Math.random() * 500));
    const child = spawn(process.execPath, [path.resolve(root, 'node_modules/tsx/dist/cli.mjs'), 'server.ts'], {
        cwd: root,
        env: {
            ...process.env,
            PORT: port,
            HOST: '127.0.0.1',
            DATA_DIR: dataDir,
            MIGRATE_FROM_JSON: '1',
            APP_SESSION_SECRET: sessionSecret,
            GOOGLE_CLIENT_ID: 'fake-client-id',
            GOOGLE_CLIENT_SECRET: 'fake-client-secret',
            GOOGLE_ALLOWED_EMAILS: allowedEmail,
            GOOGLE_REDIRECT_URI: `http://127.0.0.1:${port}/api/auth/callback`,
            GOOGLE_OAUTH_AUTH_URL: `${fakeGoogle.baseUrl}/oauth2/v2/auth`,
            GOOGLE_OAUTH_TOKEN_URL: `${fakeGoogle.baseUrl}/token`,
            GOOGLE_OAUTH_USERINFO_URL: `${fakeGoogle.baseUrl}/userinfo`,
            NODE_ENV: 'test'
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });

    let stderr = '';
    child.stderr.on('data', chunk => {
        stderr += chunk.toString();
    });

    const baseUrl = `http://127.0.0.1:${port}`;
    try {
        await waitForHealth(baseUrl, child);
        await fn(baseUrl, { dataDir });
    } finally {
        child.kill('SIGTERM');
        fs.rmSync(dataDir, { recursive: true, force: true });
    }

    if (child.exitCode !== null && child.exitCode !== 0) {
        throw new Error(stderr || `server exited with ${child.exitCode}`);
    }
}

function cookieValue(setCookie, name) {
    const cookie = setCookie.find(item => item.startsWith(`${name}=`));
    assert(cookie, `${name} cookie missing`);
    return cookie.split(';')[0].split('=').slice(1).join('=');
}

async function main() {
    const cookie = createSessionCookieValue({
        secret: sessionSecret,
        user: { email: allowedEmail, name: 'Owner User' },
        now: 1700000000000
    });
    const validSession = verifySessionCookieValue(cookie, { secret: sessionSecret, now: 1700000000001 });
    assert.strictEqual(validSession.ok, true);
    assert.deepStrictEqual(validSession.session.user, { email: allowedEmail, name: 'Owner User' });
    assert.strictEqual(verifySessionCookieValue(`${cookie}x`, { secret: sessionSecret, now: 1700000000001 }).ok, false);
    assert.strictEqual(verifySessionCookieValue(cookie, { secret: sessionSecret, now: 1700000000000 + 8 * 24 * 60 * 60 * 1000 }).ok, false);

    const fakeGoogle = await createFakeGoogleServer();
    try {
        await withServer(fakeGoogle, async (baseUrl, { dataDir }) => {
            const unauthenticated = await fetch(`${baseUrl}/api/data`);
            assert.strictEqual(unauthenticated.status, 401);
            assert.deepStrictEqual(await unauthenticated.json(), { error: 'Unauthorized' });

            const unauthenticatedExport = await fetch(`${baseUrl}/api/export-json`);
            assert.strictEqual(unauthenticatedExport.status, 401);
            assert.deepStrictEqual(await unauthenticatedExport.json(), { error: 'Unauthorized' });

            for (const [method, endpoint] of [
                ['POST', '/api/payment'],
                ['POST', '/api/backups/restore'],
                ['POST', '/api/update-config-bundle'],
                ['POST', '/api/settle']
            ]) {
                const res = await fetch(`${baseUrl}${endpoint}`, {
                    method,
                    headers: { 'Content-Type': 'application/json' },
                    body: '{}'
                });
                assert.strictEqual(res.status, 401, `${method} ${endpoint} should require auth`);
            }

            const login = await fetch(`${baseUrl}/api/auth/login`, { redirect: 'manual' });
            assert.strictEqual(login.status, 302);
            const authLocation = new URL(login.headers.get('location'));
            assert.strictEqual(authLocation.origin, fakeGoogle.baseUrl);
            assert.strictEqual(authLocation.searchParams.get('client_id'), 'fake-client-id');
            assert.strictEqual(authLocation.searchParams.get('response_type'), 'code');
            assert.strictEqual(authLocation.searchParams.get('scope'), 'openid email profile');
            assert.strictEqual(authLocation.searchParams.get('redirect_uri'), `${baseUrl}/api/auth/callback`);
            assert.strictEqual(authLocation.searchParams.get('login_hint'), allowedEmail);
            assert.strictEqual(authLocation.searchParams.get('prompt'), null);
            assert(authLocation.searchParams.get('state'));
            const stateCookie = cookieValue(login.headers.getSetCookie(), OAUTH_STATE_COOKIE_NAME);
            assert.strictEqual(stateCookie, authLocation.searchParams.get('state'));

            const wrongState = await fetch(`${baseUrl}/api/auth/callback?code=ok&state=bad`, {
                redirect: 'manual',
                headers: { Cookie: `${OAUTH_STATE_COOKIE_NAME}=${stateCookie}` }
            });
            assert.strictEqual(wrongState.status, 400);

            fakeGoogle.state.nextProfile = {
                sub: 'google-user-2',
                email: blockedEmail,
                email_verified: true,
                name: 'Blocked User'
            };
            const blocked = await fetch(`${baseUrl}/api/auth/callback?code=blocked-code&state=${stateCookie}`, {
                redirect: 'manual',
                headers: { Cookie: `${OAUTH_STATE_COOKIE_NAME}=${stateCookie}` }
            });
            assert.strictEqual(blocked.status, 403);

            const secondLogin = await fetch(`${baseUrl}/api/auth/login`, { redirect: 'manual' });
            const secondState = cookieValue(secondLogin.headers.getSetCookie(), OAUTH_STATE_COOKIE_NAME);
            fakeGoogle.state.nextProfile = {
                sub: 'google-user-1',
                email: allowedEmail,
                email_verified: true,
                name: 'Owner User'
            };
            const callback = await fetch(`${baseUrl}/api/auth/callback?code=good-code&state=${secondState}`, {
                redirect: 'manual',
                headers: { Cookie: `${OAUTH_STATE_COOKIE_NAME}=${secondState}` }
            });
            assert.strictEqual(callback.status, 302);
            assert.strictEqual(callback.headers.get('location'), '/');
            assert.strictEqual(fakeGoogle.state.lastTokenRequest.client_id, 'fake-client-id');
            assert.strictEqual(fakeGoogle.state.lastTokenRequest.client_secret, 'fake-client-secret');
            assert.strictEqual(fakeGoogle.state.lastTokenRequest.code, 'good-code');
            assert.strictEqual(fakeGoogle.state.lastTokenRequest.redirect_uri, `${baseUrl}/api/auth/callback`);
            const callbackCookies = callback.headers.getSetCookie();
            const sessionCookie = `${SESSION_COOKIE_NAME}=${cookieValue(callbackCookies, SESSION_COOKIE_NAME)}`;
            assert(callbackCookies.some(item => item.includes('HttpOnly')));
            assert(callbackCookies.some(item => item.includes('SameSite=Lax')));
            assert(!callbackCookies.some(item => item.includes('Secure')), 'local test cookie should not force Secure');

            const successfulWrite = await fetch(`${baseUrl}/api/payment`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Cookie: sessionCookie
                },
                body: JSON.stringify({
                    memberId: 'm_alpha',
                    date: '2026-06-11',
                    amount: 321,
                    method: 'test',
                    cycle: '202606',
                    note: 'critical-write-success'
                })
            });
            assert.strictEqual(successfulWrite.status, 200);
            const successfulPayload = await successfulWrite.json();
            assert(successfulPayload.data.payments.some(payment => payment.note === 'critical-write-success'));

            const backupDir = path.join(dataDir, 'backups');
            fs.rmSync(backupDir, { recursive: true, force: true });
            fs.writeFileSync(backupDir, 'force backup failure');

            const failedWrite = await fetch(`${baseUrl}/api/payment`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Cookie: sessionCookie
                },
                body: JSON.stringify({
                    memberId: 'm_alpha',
                    date: '2026-06-12',
                    amount: 654,
                    method: 'test',
                    cycle: '202606',
                    note: 'must-not-persist'
                })
            });
            assert.strictEqual(failedWrite.status, 500);
            const failedWritePayload = await failedWrite.json();
            assert.strictEqual(failedWritePayload.error, '資料寫入失敗，已停止本次操作');
            assert(!JSON.stringify(failedWritePayload).includes(dataDir));

            fs.rmSync(backupDir, { force: true });
            fs.mkdirSync(backupDir);

            const dataAfterFailedWrite = await fetch(`${baseUrl}/api/data`, {
                headers: { Cookie: sessionCookie }
            });
            assert.strictEqual(dataAfterFailedWrite.status, 200);
            const dataAfterFailedWritePayload = await dataAfterFailedWrite.json();
            assert(dataAfterFailedWritePayload.payments.some(payment => payment.note === 'critical-write-success'));
            assert(!dataAfterFailedWritePayload.payments.some(payment => payment.note === 'must-not-persist'));

            const invalidBackupName = 'database_20260711_202500_000_deadbeef.db';
            fs.writeFileSync(path.join(backupDir, invalidBackupName), 'not a sqlite database');
            const liveDbPath = path.join(dataDir, 'database.db');
            const liveDbBeforeInvalidRestore = fs.readFileSync(liveDbPath);

            const invalidRestore = await fetch(`${baseUrl}/api/backups/restore`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Cookie: sessionCookie
                },
                body: JSON.stringify({ filename: invalidBackupName })
            });
            assert.strictEqual(invalidRestore.status, 400);
            assert.deepStrictEqual(await invalidRestore.json(), { error: '備份檔案無效或已損毀' });
            assert.deepStrictEqual(fs.readFileSync(liveDbPath), liveDbBeforeInvalidRestore);

            const createBackup = await fetch(`${baseUrl}/api/backups/create`, {
                method: 'POST',
                headers: { Cookie: sessionCookie }
            });
            assert.strictEqual(createBackup.status, 200);
            const { filename: validBackupName } = await createBackup.json();

            const writeAfterBackup = await fetch(`${baseUrl}/api/payment`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Cookie: sessionCookie
                },
                body: JSON.stringify({
                    memberId: 'm_alpha',
                    date: '2026-06-13',
                    amount: 987,
                    method: 'test',
                    cycle: '202606',
                    note: 'remove-by-restore'
                })
            });
            assert.strictEqual(writeAfterBackup.status, 200);

            for (const entry of fs.readdirSync(backupDir)) {
                if (entry !== validBackupName) {
                    fs.rmSync(path.join(backupDir, entry), { recursive: true, force: true });
                }
            }
            for (let i = 0; i < 49; i += 1) {
                const dummyName = `database_20990101_000000_${String(i).padStart(3, '0')}_aaaaaaaa.db`;
                fs.copyFileSync(path.join(backupDir, validBackupName), path.join(backupDir, dummyName));
            }
            assert.strictEqual(
                fs.readdirSync(backupDir).filter(name => name.startsWith('database_') && name.endsWith('.db')).length,
                50
            );

            const boundaryRestore = await fetch(`${baseUrl}/api/backups/restore`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Cookie: sessionCookie
                },
                body: JSON.stringify({ filename: validBackupName })
            });
            assert.strictEqual(boundaryRestore.status, 200);
            const boundaryRestorePayload = await boundaryRestore.json();
            assert(boundaryRestorePayload.data.payments.some(payment => payment.note === 'critical-write-success'));
            assert(!boundaryRestorePayload.data.payments.some(payment => payment.note === 'remove-by-restore'));
            assert(fs.existsSync(path.join(backupDir, validBackupName)));
            assert(!fs.readdirSync(backupDir).some(name => name.startsWith('.restore-safety-')));

            const authedData = await fetch(`${baseUrl}/api/data`, {
                headers: { Cookie: sessionCookie }
            });
            assert.strictEqual(authedData.status, 200);
            const authedPayload = await authedData.json();
            assert.strictEqual(authedPayload.currentMonth, '2026/06');

            const session = await fetch(`${baseUrl}/api/auth/session`, {
                headers: { Cookie: sessionCookie }
            });
            assert.strictEqual(session.status, 200);
            assert.deepStrictEqual(await session.json(), {
                authenticated: true,
                user: { email: allowedEmail, name: 'Owner User' }
            });

            const logout = await fetch(`${baseUrl}/api/auth/logout`, {
                method: 'POST',
                headers: { Cookie: sessionCookie }
            });
            assert.strictEqual(logout.status, 200);
            assert(logout.headers.get('set-cookie')?.includes('Max-Age=0'));
        });
    } finally {
        await fakeGoogle.close();
    }

    console.log('Google auth and API protection tests passed.');
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
