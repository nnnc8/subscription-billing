const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const {
    SESSION_COOKIE_NAME,
    createPasswordHash,
    createSessionCookieValue,
    verifyPassword,
    verifySessionCookieValue
} = require('../lib/auth.cjs');

const root = path.resolve(__dirname, '..');
const password = 'correct horse battery staple';
const wrongPassword = 'incorrect horse battery staple';
const sessionSecret = 'test-session-secret-with-enough-length-1234567890';

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
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

async function withServer(fn) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'subscription-billing-auth-'));
    fs.copyFileSync(path.join(root, 'fixtures', 'demo-database.json'), path.join(dataDir, 'database.json'));
    const passwordHash = createPasswordHash(password, { salt: 'test-auth-salt' });
    const port = String(3300 + Math.floor(Math.random() * 500));
    const child = spawn(process.execPath, ['server.cjs'], {
        cwd: root,
        env: {
            ...process.env,
            PORT: port,
            HOST: '127.0.0.1',
            DATA_DIR: dataDir,
            APP_PASSWORD_HASH: passwordHash,
            APP_SESSION_SECRET: sessionSecret,
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
        await fn(baseUrl);
    } finally {
        child.kill('SIGTERM');
        fs.rmSync(dataDir, { recursive: true, force: true });
    }

    if (child.exitCode !== null && child.exitCode !== 0) {
        throw new Error(stderr || `server exited with ${child.exitCode}`);
    }
}

async function main() {
    const hash = createPasswordHash(password, { salt: 'unit-test-salt' });
    assert.strictEqual(verifyPassword(password, hash), true);
    assert.strictEqual(verifyPassword(wrongPassword, hash), false);

    const cookie = createSessionCookieValue({ secret: sessionSecret, now: 1700000000000 });
    assert.strictEqual(verifySessionCookieValue(cookie, { secret: sessionSecret, now: 1700000000001 }).ok, true);
    assert.strictEqual(verifySessionCookieValue(`${cookie}x`, { secret: sessionSecret, now: 1700000000001 }).ok, false);
    assert.strictEqual(verifySessionCookieValue(cookie, { secret: sessionSecret, now: 1700000000000 + 8 * 24 * 60 * 60 * 1000 }).ok, false);

    await withServer(async (baseUrl) => {
        const unauthenticated = await fetch(`${baseUrl}/api/data`);
        assert.strictEqual(unauthenticated.status, 401);
        assert.deepStrictEqual(await unauthenticated.json(), { error: 'Unauthorized' });

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

        const badLogin = await fetch(`${baseUrl}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: wrongPassword })
        });
        assert.strictEqual(badLogin.status, 401);

        const login = await fetch(`${baseUrl}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password })
        });
        assert.strictEqual(login.status, 200);
        const setCookie = login.headers.get('set-cookie');
        assert(setCookie?.includes(`${SESSION_COOKIE_NAME}=`));
        assert(setCookie.includes('HttpOnly'));
        assert(setCookie.includes('SameSite=Lax'));
        assert(!setCookie.includes('Secure'), 'local test cookie should not force Secure');
        const sessionCookie = setCookie.split(';')[0];

        const authedData = await fetch(`${baseUrl}/api/data`, {
            headers: { Cookie: sessionCookie }
        });
        assert.strictEqual(authedData.status, 200);
        const authedPayload = await authedData.json();
        assert.strictEqual(authedPayload.currentMonth, '2026/06');

        const tampered = await fetch(`${baseUrl}/api/data`, {
            headers: { Cookie: `${SESSION_COOKIE_NAME}=tampered` }
        });
        assert.strictEqual(tampered.status, 401);

        const session = await fetch(`${baseUrl}/api/auth/session`, {
            headers: { Cookie: sessionCookie }
        });
        assert.strictEqual(session.status, 200);
        assert.deepStrictEqual(await session.json(), { authenticated: true });

        const logout = await fetch(`${baseUrl}/api/auth/logout`, {
            method: 'POST',
            headers: { Cookie: sessionCookie }
        });
        assert.strictEqual(logout.status, 200);
        assert(logout.headers.get('set-cookie')?.includes('Max-Age=0'));
    });

    console.log('Auth and API protection tests passed.');
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
