import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const functionDir = path.resolve('.vercel/output/functions/api/index.func');
assert(fs.existsSync(path.join(functionDir, 'api/index.js')), 'Run pnpm build:vercel:offline first');

// Assemble the function as a deployment does: the built files plus every filePathMap
// entry (symlinks kept as symlinks), outside the repository so that nothing resolves
// through the project's own node_modules and no native libsql build is present.
function assembleFunction(target) {
    fs.cpSync(functionDir, target, { recursive: true, verbatimSymlinks: true });
    const { filePathMap = {} } = JSON.parse(fs.readFileSync(path.join(functionDir, '.vc-config.json'), 'utf8'));
    for (const [destination, source] of Object.entries(filePathMap)) {
        const output = path.join(target, destination);
        fs.mkdirSync(path.dirname(output), { recursive: true });
        if (fs.lstatSync(source).isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(source), output);
        else fs.cpSync(source, output, { recursive: true, verbatimSymlinks: true });
    }
}

// Process isolation releases the module-level runtime before the parent deletes its files.
if (process.argv[2] !== '--worker') {
    const url = process.env.TEST_LIBSQL_URL;
    assert(url, 'Set TEST_LIBSQL_URL to a disposable turso dev database, for example http://127.0.0.1:8080');
    const { resetTestDatabase } = await import('./test-database.ts');
    await resetTestDatabase(url);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'billing-vercel-function-'));
    let status = 1;
    try {
        assembleFunction(path.join(directory, 'function'));
        fs.mkdirSync(path.join(directory, 'data'));
        // The worker runs on plain Node, without the tsx loader this parent needs.
        const env = { ...process.env };
        delete env.NODE_OPTIONS;
        const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--worker', directory], { stdio: 'inherit', timeout: 120000, env });
        if (result.error) throw result.error;
        status = result.status || (result.signal ? 1 : 0);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
    process.exit(status);
}
const directory = process.argv[3];
assert(directory && fs.statSync(directory).isDirectory());
const bundleDir = path.join(directory, 'function');
const dataDir = path.join(directory, 'data');
let oauth;
let server;
const environment = { ...process.env };
async function listen(instance) {
    await new Promise((resolve, reject) => {
        instance.once('error', reject);
        instance.listen(0, '127.0.0.1', resolve);
    });
    return `http://127.0.0.1:${instance.address().port}`;
}
async function close(instance) {
    if (!instance?.listening) return;
    instance.closeAllConnections();
    await new Promise((resolve, reject) => instance.close(error => error ? reject(error) : resolve()));
}
try {
    fs.copyFileSync('fixtures/demo-database.json', path.join(dataDir, 'database.json'));
    oauth = http.createServer((req, res) => {
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/token') { req.resume(); res.end(JSON.stringify({ access_token: 'fake-access', token_type: 'Bearer' })); }
        else if (req.url === '/userinfo') {
            assert.equal(req.headers.authorization, 'Bearer fake-access');
            res.end(JSON.stringify({ sub: 'smoke-owner', email: 'smoke@example.com', email_verified: true, name: 'Smoke Owner' }));
        } else { res.statusCode = 404; res.end('{}'); }
    });
    const googleUrl = await listen(oauth);
    Object.assign(process.env, {
        NODE_ENV: 'test', COOKIE_SECURE: 'true', PUBLIC_ORIGIN: 'https://billing.example',
        DATA_DIR: dataDir, MIGRATE_FROM_JSON: '1',
        TURSO_DATABASE_URL: process.env.TEST_LIBSQL_URL, TURSO_AUTH_TOKEN: '',
        APP_SESSION_SECRET: 'fake-vercel-smoke-session-secret-01234567890123456789',
        GOOGLE_CLIENT_ID: 'fake-client', GOOGLE_CLIENT_SECRET: 'fake-client-secret',
        GOOGLE_ALLOWED_EMAILS: 'smoke@example.com', GOOGLE_GEMINI_API_KEY: '',
        GOOGLE_OAUTH_AUTH_URL: `${googleUrl}/auth`, GOOGLE_OAUTH_TOKEN_URL: `${googleUrl}/token`, GOOGLE_OAUTH_USERINFO_URL: `${googleUrl}/userinfo`,
        GOOGLE_REDIRECT_URI: 'https://billing.example/api/auth/callback'
    });
    // Import the assembled @vercel/node output with ordinary Node. This checks .js → .ts ESM
    // resolution, the traced dependencies, and that the migrations ship with the function.
    const module = await import(pathToFileURL(path.join(bundleDir, 'api/index.js')).href);
    const handler = module.default?.default || module.default;
    assert.equal(typeof handler, 'function');
    server = http.createServer(handler);
    const base = await listen(server);
    const anonymous = await fetch(`${base}/api/data`);
    assert.equal(anonymous.status, 401);
    const login = await fetch(`${base}/api/auth/login`, { redirect: 'manual' });
    assert.equal(login.status, 302);
    const redirect = new URL(login.headers.get('location'));
    assert.equal(redirect.searchParams.get('redirect_uri'), 'https://billing.example/api/auth/callback');
    const state = login.headers.getSetCookie().find(cookie => cookie.startsWith('sb_oauth_state=')).split(';')[0];
    const callback = await fetch(`${base}/api/auth/callback?code=fake&state=${redirect.searchParams.get('state')}`, { redirect: 'manual', headers: { Cookie: state } });
    assert.equal(callback.status, 302);
    const cookieHeader = callback.headers.getSetCookie().find(cookie => cookie.startsWith('sb_session='));
    assert(cookieHeader.includes('HttpOnly') && cookieHeader.includes('Secure') && cookieHeader.includes('SameSite=Lax'));
    const cookie = cookieHeader.split(';')[0];
    const request = (endpoint, body) => fetch(`${base}${endpoint}`, {
        ...(body !== undefined ? { method: 'POST', body: JSON.stringify(body) } : {}),
        headers: { Cookie: cookie, 'Content-Type': 'application/json' }
    });
    const data = await request('/api/data');
    assert.equal(data.status, 200);
    assert((await data.json()).members.some(member => member.id === 'm_alpha'));
    const payment = await request('/api/payment', { memberId: 'm_alpha', amount: 17, note: 'vercel-built-smoke' });
    assert.equal(payment.status, 200);
    assert((await payment.json()).data.payments.some(item => item.note === 'vercel-built-smoke'));
    const created = await request('/api/backups/create', {});
    assert.equal(created.status, 200);
    const { filename } = await created.json();
    const inventory = await request('/api/backups');
    assert.equal(inventory.status, 200);
    assert((await inventory.json()).backups.some(backup => backup.filename === filename && backup.readable));
    console.log('Assembled Vercel function passed on remote libSQL: fake OAuth, secure cookie, /api/data, payment, database backups.');
} finally {
    await close(server);
    await close(oauth);
    for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key];
    Object.assign(process.env, environment);
}
