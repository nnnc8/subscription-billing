const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { loadLocalEnv } = require('../lib/env');
const { isGoogleOAuthConfigured } = require('../lib/google-oauth');
const { loadFromSQLite } = require('../lib/db');

const {
    findAccountingWarnings,
    getClosePreview,
    getHistoryIntegrity,
    getLedgerSummary,
    getSystemSnapshot,
    normalizeDatabaseRelations
} = require('../lib/accounting');

const root = path.resolve(__dirname, '..');
loadLocalEnv({ cwd: root });

const host = process.env.HOST || '127.0.0.1';
const port = process.env.PORT || '3000';
const dataDir = path.resolve(process.env.DATA_DIR || root);
const dbPath = path.resolve(process.env.DB_PATH || path.join(dataDir, 'database.json'));
const sqlitePath = path.resolve(process.env.SQLITE_PATH || path.join(dataDir, 'database.db'));
const demoDbPath = path.join(root, 'fixtures', 'demo-database.json');
const checks = [];

function addCheck(status, label, detail) {
    checks.push({ status, label, detail });
}

function isCloudBinding() {
    return process.env.NODE_ENV === 'production' || host === '0.0.0.0' || host === '::';
}

function checkNodeVersion() {
    const [major] = process.versions.node.split('.').map(Number);
    if (major >= 20) {
        addCheck('pass', 'Node.js', process.version);
        return;
    }
    addCheck('fail', 'Node.js', `${process.version}; requires Node.js 20+`);
}

function checkDependencies() {
    const nodeModules = path.join(root, 'node_modules');
    if (fs.existsSync(nodeModules)) {
        addCheck('pass', 'Dependencies', 'node_modules exists');
    } else {
        addCheck('warn', 'Dependencies', 'node_modules missing; run npm install or pnpm install');
    }
}

function checkBuild() {
    const indexPath = path.join(root, 'dist', 'index.html');
    if (fs.existsSync(indexPath)) {
        addCheck('pass', 'Frontend build', 'dist/index.html exists');
    } else {
        addCheck('warn', 'Frontend build', 'dist is missing; run npm run build before npm run start');
    }
}

function checkDataDir() {
    try {
        fs.mkdirSync(dataDir, { recursive: true });
        const probe = path.join(dataDir, `.doctor-write-${process.pid}.tmp`);
        fs.writeFileSync(probe, 'ok', 'utf8');
        fs.unlinkSync(probe);
        addCheck('pass', 'Data directory', `${dataDir} is writable`);
    } catch (err) {
        addCheck('fail', 'Data directory', `${dataDir} is not writable: ${err.message}`);
    }
}

function readDatabase() {
    if (fs.existsSync(sqlitePath) && fs.statSync(sqlitePath).size > 0) {
        try {
            const db = loadFromSQLite(sqlitePath);
            addCheck('pass', 'Database readable', `SQLite database: ${db.currentMonth}; ${db.members.length} members`);
            return db;
        } catch (err) {
            addCheck('fail', 'Database readable', err.message || 'SQLite database cannot be parsed');
            return null;
        }
    }

    let sourcePath = dbPath;
    let sourceLabel = 'legacy database.json';
    if (!fs.existsSync(sourcePath)) {
        if (fs.existsSync(demoDbPath)) {
            addCheck('warn', 'Database', `SQLite database and database.json are missing; server will bootstrap from sanitized demo fixture`);
            sourcePath = demoDbPath;
            sourceLabel = 'demo fixture';
        } else {
            addCheck('fail', 'Database', `SQLite database is missing and no fallback files are available`);
            return null;
        }
    }

    try {
        const db = normalizeDatabaseRelations(JSON.parse(fs.readFileSync(sourcePath, 'utf8')));
        addCheck('warn', 'Database', `SQLite database is missing; reading legacy database.json instead`);
        addCheck('pass', 'Database readable', `${sourceLabel}: ${db.currentMonth}; ${db.members.length} members`);
        return db;
    } catch (err) {
        addCheck('fail', 'Database readable', err.message || `${sourcePath} cannot be parsed`);
        return null;
    }
}

function checkAccounting(db) {
    if (!db) return;

    const warnings = findAccountingWarnings(db);
    const criticalCount = warnings.filter(warning => warning.severity === 'critical').length;
    const ledger = getLedgerSummary(db);
    const history = getHistoryIntegrity(db);
    const closePreview = getClosePreview(db);
    const snapshot = getSystemSnapshot(db);

    if (criticalCount === 0 && ledger.ok && history.ok && closePreview.ready) {
        addCheck('pass', 'Accounting', `${snapshot.health.label}; receivable $${snapshot.totals.receivable}`);
    } else {
        addCheck('fail', 'Accounting', `critical=${criticalCount}, ledger=${ledger.ok}, history=${history.ok}, closeReady=${closePreview.ready}`);
    }
}

function checkAuthEnv() {
    const hasGoogleClientId = Boolean(process.env.GOOGLE_CLIENT_ID);
    const hasGoogleClientSecret = Boolean(process.env.GOOGLE_CLIENT_SECRET);
    const hasAllowedEmails = Boolean(process.env.GOOGLE_ALLOWED_EMAILS);
    const hasSessionSecret = Boolean(process.env.APP_SESSION_SECRET);
    const secretLongEnough = !process.env.APP_SESSION_SECRET || process.env.APP_SESSION_SECRET.length >= 32;

    if (isGoogleOAuthConfigured(process.env) && hasSessionSecret && secretLongEnough) {
        addCheck('pass', 'Auth env', 'Google OAuth vars and APP_SESSION_SECRET are set');
        return;
    }

    const detailParts = [];
    if (!hasGoogleClientId) detailParts.push('GOOGLE_CLIENT_ID missing');
    if (!hasGoogleClientSecret) detailParts.push('GOOGLE_CLIENT_SECRET missing');
    if (!hasAllowedEmails) detailParts.push('GOOGLE_ALLOWED_EMAILS missing');
    if (!hasSessionSecret) detailParts.push('APP_SESSION_SECRET missing');
    if (!secretLongEnough) detailParts.push('APP_SESSION_SECRET should be at least 32 characters');

    addCheck(isCloudBinding() ? 'fail' : 'warn', 'Auth env', detailParts.join('; '));
}

function checkHostBinding() {
    if (host === '127.0.0.1' || host === 'localhost') {
        addCheck('pass', 'Host binding', `${host}; local-only`);
        return;
    }
    if (host === '0.0.0.0' || host === '::') {
        addCheck(isCloudBinding() ? 'pass' : 'warn', 'Host binding', `${host}; public binding must have Google auth envs before use`);
        return;
    }
    addCheck('warn', 'Host binding', `${host}; verify this is intentional`);
}

function checkTrackedSensitiveFiles() {
    let tracked;
    try {
        tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
            .split('\n')
            .filter(Boolean);
    } catch (_) {
        addCheck('warn', 'Git privacy', 'not a Git checkout; skipped tracked-file check');
        return;
    }

    const forbidden = tracked.filter(file => (
        file === 'database.json'
        || file === 'session_handoff.md'
        || file === 'migrate.py'
        || /^backups\/.*\.json$/.test(file)
        || file === 'database_test_backup.json'
    ));

    if (forbidden.length === 0) {
        addCheck('pass', 'Git privacy', 'no tracked live database, handoff, backups, or legacy migration');
    } else {
        addCheck('fail', 'Git privacy', `tracked sensitive files: ${forbidden.join(', ')}`);
    }
}

async function checkLocalService() {
    if (typeof fetch !== 'function') {
        addCheck('warn', 'Local service', 'fetch unavailable; skipped localhost check');
        return;
    }

    const serviceHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1000);
    try {
        const res = await fetch(`http://${serviceHost}:${port}/api/health`, { signal: controller.signal });
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        const payload = await res.json();
        addCheck('pass', 'Local service', `${serviceHost}:${port} responds; authConfigured=${payload.authConfigured}`);
    } catch (_) {
        addCheck('warn', 'Local service', `not running now; start with npm run start`);
    } finally {
        clearTimeout(timeout);
    }
}

function printResults() {
    const icon = {
        pass: 'PASS',
        warn: 'WARN',
        fail: 'FAIL'
    };
    checks.forEach(check => {
        console.log(`${icon[check.status]} ${check.label}: ${check.detail}`);
    });
}

async function main() {
    checkNodeVersion();
    checkDependencies();
    checkBuild();
    checkDataDir();
    checkAuthEnv();
    checkHostBinding();
    checkTrackedSensitiveFiles();
    const db = readDatabase();
    checkAccounting(db);
    await checkLocalService();
    printResults();

    const failures = checks.filter(check => check.status === 'fail');
    if (failures.length > 0) {
        process.exit(1);
    }
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
