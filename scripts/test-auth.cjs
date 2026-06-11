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
} = require('../lib/auth.cjs');

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
    const child = spawn(process.execPath, ['server.cjs'], {
        cwd: root,
        env: {
            ...process.env,
            PORT: port,
            HOST: '127.0.0.1',
            DATA_DIR: dataDir,
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
        await fn(baseUrl);
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
        await withServer(fakeGoogle, async (baseUrl) => {
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
