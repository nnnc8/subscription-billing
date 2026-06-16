const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { loadLocalEnv } = require('./lib/env.cjs');
const {
    OAUTH_STATE_COOKIE_NAME,
    OAUTH_STATE_MAX_AGE_SECONDS,
    SESSION_COOKIE_NAME,
    SESSION_MAX_AGE_SECONDS,
    createOAuthStateValue,
    createSessionCookieValue,
    verifySessionCookieValue
} = require('./lib/auth.cjs');
const {
    buildGoogleAuthUrl,
    exchangeGoogleCode,
    fetchGoogleUserinfo,
    getGoogleOAuthConfig,
    isAllowedGoogleUser,
    isGoogleOAuthConfigured
} = require('./lib/google-oauth.cjs');
const {
    appendLedgerEvent,
    calculateCurrentMonthBalances,
    ensureHistorySeals,
    findRecentDuplicateTransaction,
    findAccountingWarnings,
    getClosePreview,
    getLedgerSummary,
    getSystemSnapshot,
    isMemberRecord,
    isPlatformRecord,
    isTransactionVoided,
    normalizeDatabaseRelations,
    previousMonthString,
    resolveMember,
    isSubActiveInMonth,
    getPlatformPriceForMonth,
    isEntityBillableInMonth
} = require('./lib/accounting.cjs');
const { generateAIReminder } = require('./lib/ai-reminder.cjs');
const { handleAssistantChat } = require('./lib/ai-assistant.cjs');
const { invalidateRAGIndex, queryRAG } = require('./lib/rag.cjs');

loadLocalEnv({ cwd: __dirname });

const app = express();
app.set('trust proxy', true);
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = path.resolve(process.env.DATA_DIR || __dirname);
const DB_PATH = path.resolve(process.env.DB_PATH || path.join(DATA_DIR, 'database.json'));
const BACKUP_DIR = path.resolve(process.env.BACKUP_DIR || path.join(DATA_DIR, 'backups'));
const DEMO_DB_PATH = path.join(__dirname, 'fixtures', 'demo-database.json');
const MAX_BACKUPS = 50;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const COOKIE_SECURE = process.env.COOKIE_SECURE === undefined
    ? IS_PRODUCTION
    : ['1', 'true', 'yes'].includes(String(process.env.COOKIE_SECURE).toLowerCase());

function configuredAllowedOrigins() {
    return new Set(String(process.env.ALLOWED_ORIGINS || '')
        .split(',')
        .map(origin => origin.trim())
        .filter(Boolean));
}

function isAllowedOrigin(origin, requestHost = '') {
    if (!origin) return true;
    try {
        if (configuredAllowedOrigins().has(origin)) return true;
        const parsed = new URL(origin);
        if (requestHost && parsed.host === requestHost) return true;
        if (!IS_PRODUCTION) {
            const viteDevOrigins = new Set([
                'http://localhost:5173',
                'http://127.0.0.1:5173',
                'http://[::1]:5173'
            ]);
            return viteDevOrigins.has(origin);
        }
        return false;
    } catch (_) {
        return false;
    }
}

function applyCors(req, res, next) {
    const origin = req.headers.origin;
    if (origin) {
        if (!isAllowedOrigin(origin, req.headers.host)) {
            return res.status(403).json({ error: 'CORS origin blocked' });
        }
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] || 'Content-Type');
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
        res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
        return res.sendStatus(204);
    }
    return next();
}

function isAuthConfigured() {
    return Boolean(process.env.APP_SESSION_SECRET && isGoogleOAuthConfigured(process.env));
}

function isCloudBinding() {
    return IS_PRODUCTION || HOST === '0.0.0.0' || HOST === '::';
}

function parseCookies(req) {
    return String(req.headers.cookie || '')
        .split(';')
        .map(part => part.trim())
        .filter(Boolean)
        .reduce((cookies, part) => {
            const separator = part.indexOf('=');
            if (separator === -1) return cookies;
            const key = decodeURIComponent(part.slice(0, separator));
            const value = part.slice(separator + 1);
            cookies[key] = value;
            return cookies;
        }, {});
}

function buildCookie(name, value, { maxAge, httpOnly = true } = {}) {
    const pieces = [
        `${name}=${value}`,
        'Path=/',
        'SameSite=Lax',
        `Max-Age=${maxAge}`
    ];
    if (httpOnly) pieces.push('HttpOnly');
    if (COOKIE_SECURE) pieces.push('Secure');
    return pieces.join('; ');
}

function buildSessionCookie(value, { maxAge = SESSION_MAX_AGE_SECONDS } = {}) {
    return buildCookie(SESSION_COOKIE_NAME, value, { maxAge });
}

function buildOAuthStateCookie(value, { maxAge = OAUTH_STATE_MAX_AGE_SECONDS } = {}) {
    return buildCookie(OAUTH_STATE_COOKIE_NAME, value, { maxAge });
}

function clearSessionCookie() {
    return buildSessionCookie('', { maxAge: 0 });
}

function clearOAuthStateCookie() {
    return buildOAuthStateCookie('', { maxAge: 0 });
}

function verifyRequestSession(req) {
    const value = parseCookies(req)[SESSION_COOKIE_NAME];
    return verifySessionCookieValue(value, { secret: process.env.APP_SESSION_SECRET });
}

function externalOrigin(req) {
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    return `${proto}://${host}`;
}

function getGoogleRedirectUri(req, config) {
    return config.redirectUri || `${externalOrigin(req)}/api/auth/callback`;
}

function requireAuth(req, res, next) {
    if (!isAuthConfigured()) {
        return res.status(503).json({ error: 'Authentication is not configured' });
    }
    const session = verifyRequestSession(req);
    if (!session.ok) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    req.session = session.session;
    return next();
}

function bootstrapDataFiles() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    if (!fs.existsSync(DB_PATH) && fs.existsSync(DEMO_DB_PATH)) {
        fs.copyFileSync(DEMO_DB_PATH, DB_PATH);
    }
}

if (isCloudBinding() && !isAuthConfigured()) {
    console.error('GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_ALLOWED_EMAILS, and APP_SESSION_SECRET are required when binding to a public host or running production.');
    process.exit(1);
}

bootstrapDataFiles();
app.use(applyCors);
app.use(express.json());

// Serve static frontend files in production
app.use(express.static(path.join(__dirname, 'dist')));

// Helper to read database
function readDB() {
    try {
        const data = fs.readFileSync(DB_PATH, 'utf8');
        return normalizeDatabaseRelations(JSON.parse(data));
    } catch (err) {
        console.error("Error reading database:", err);
        return null;
    }
}

function readDatabaseFile(filePath) {
    const data = fs.readFileSync(filePath, 'utf8');
    return normalizeDatabaseRelations(JSON.parse(data));
}

function describeDelta(label, before, after, formatter = value => value) {
    if (before === after) return null;
    return {
        label,
        before,
        after,
        text: `${label}: ${formatter(before)} -> ${formatter(after)}`
    };
}

function compareSnapshots(currentSnapshot, targetSnapshot) {
    if (!currentSnapshot || !targetSnapshot) {
        return {
            sameBusinessState: false,
            changeCount: 0,
            summary: '無法比較目前資料與備份內容',
            changes: []
        };
    }

    const money = value => `$${Number(value || 0).toLocaleString()}`;
    const plain = value => String(value ?? '—');
    const changes = [
        describeDelta('帳期', currentSnapshot.currentMonth, targetSnapshot.currentMonth, plain),
        describeDelta('本期待收', currentSnapshot.totals.receivable, targetSnapshot.totals.receivable, money),
        describeDelta('已入帳', currentSnapshot.totals.paid, targetSnapshot.totals.paid, money),
        describeDelta('成員數', currentSnapshot.counts.members, targetSnapshot.counts.members, plain),
        describeDelta('活躍設定數', currentSnapshot.counts.subscriptions, targetSnapshot.counts.subscriptions, plain),
        describeDelta('付款筆數', currentSnapshot.counts.payments, targetSnapshot.counts.payments, plain),
        describeDelta('臨時加帳筆數', currentSnapshot.counts.tempCharges, targetSnapshot.counts.tempCharges, plain),
        describeDelta('歷史月份數', currentSnapshot.counts.history, targetSnapshot.counts.history, plain),
        describeDelta('事件鏈筆數', currentSnapshot.counts.ledger, targetSnapshot.counts.ledger, plain)
    ].filter(Boolean);

    const sameBusinessState = currentSnapshot.fingerprint === targetSnapshot.fingerprint;
    return {
        sameBusinessState,
        changeCount: changes.length,
        summary: sameBusinessState
            ? '和目前帳務內容相同'
            : changes.slice(0, 3).map(change => change.text).join('；'),
        changes
    };
}

function backupLabel(filename) {
    const match = filename.match(/database_(\d{8}_\d{6})/);
    return match ? match[1] : filename;
}

function analyzeBackupFile(filename, currentSnapshot = null) {
    const backupPath = safeBackupPath(filename);
    const stats = fs.statSync(backupPath);
    const base = {
        filename,
        label: backupLabel(filename),
        size: stats.size,
        mtime: stats.mtime.toISOString()
    };

    try {
        const snapshot = getSystemSnapshot(readDatabaseFile(backupPath));
        return {
            ...base,
            readable: true,
            snapshot,
            restoreImpact: compareSnapshots(currentSnapshot, snapshot)
        };
    } catch (err) {
        return {
            ...base,
            readable: false,
            error: err.message || "備份內容無法讀取",
            restoreImpact: {
                sameBusinessState: false,
                changeCount: 0,
                summary: '備份內容無法讀取',
                changes: []
            }
        };
    }
}

function listBackupInventory(currentDb) {
    const currentSnapshot = getSystemSnapshot(currentDb);
    const backups = fs.readdirSync(BACKUP_DIR)
        .filter(f => f.startsWith('database_') && f.endsWith('.json'))
        .sort()
        .reverse()
        .map(f => analyzeBackupFile(f, currentSnapshot));
    return {
        current: currentSnapshot,
        backups
    };
}

function withAudit(db) {
    return {
        ...db,
        _audit: {
            generatedAt: new Date().toISOString(),
            warnings: findAccountingWarnings(db),
            ledger: getLedgerSummary(db),
            snapshot: getSystemSnapshot(db)
        }
    };
}

function sendDB(res, db, extra = {}) {
    return res.json({ success: true, ...extra, data: withAudit(db) });
}

function generateId(prefix) {
    return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
}

function parseMoney(value, field, { allowNegative = false } = {}) {
    const amount = typeof value === 'number' ? value : parseFloat(value);
    if (!Number.isFinite(amount)) {
        const err = new Error(`${field} 必須是有效數字`);
        err.status = 400;
        throw err;
    }
    if (!allowNegative && amount < 0) {
        const err = new Error(`${field} 不可為負數`);
        err.status = 400;
        throw err;
    }
    return amount;
}

function assertMemberExists(db, memberRef) {
    const member = resolveMember(db, typeof memberRef === 'object' ? memberRef : { memberName: memberRef });
    if (!member) {
        const err = new Error(`找不到成員：${memberRef.memberName || memberRef.memberId || memberRef}`);
        err.status = 400;
        throw err;
    }
    return member;
}

function safeBackupPath(filename) {
    if (!/^database_\d{8}_\d{6}(?:(?:_\d{3})?_[a-f0-9]{8})?\.json$/.test(filename)) {
        const err = new Error("備份檔名格式不合法");
        err.status = 400;
        throw err;
    }
    const resolved = path.resolve(BACKUP_DIR, filename);
    if (!resolved.startsWith(path.resolve(BACKUP_DIR) + path.sep)) {
        const err = new Error("備份路徑不合法");
        err.status = 400;
        throw err;
    }
    return resolved;
}

// Helper to create a timestamped backup before writing
function backupDB() {
    try {
        const now = new Date();
        const ts = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}${String(now.getSeconds()).padStart(2,'0')}_${String(now.getMilliseconds()).padStart(3,'0')}`;
        const suffix = crypto.randomUUID().slice(0, 8);
        const backupPath = path.join(BACKUP_DIR, `database_${ts}_${suffix}.json`);
        fs.copyFileSync(DB_PATH, backupPath);

        // Clean up old backups
        const files = fs.readdirSync(BACKUP_DIR)
            .filter(f => f.startsWith('database_') && f.endsWith('.json'))
            .sort()
            .reverse();
        if (files.length > MAX_BACKUPS) {
            files.slice(MAX_BACKUPS).forEach(f => {
                fs.unlinkSync(path.join(BACKUP_DIR, f));
            });
        }
        return backupPath;
    } catch (err) {
        console.error("Backup failed:", err);
        return null;
    }
}

// Helper to write database (auto-backup before writing)
function writeDB(data) {
    try {
        normalizeDatabaseRelations(data);
        backupDB();
        const tmpPath = `${DB_PATH}.${process.pid}.${Date.now()}.tmp`;
        fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
        fs.renameSync(tmpPath, DB_PATH);
        return true;
    } catch (err) {
        console.error("Error writing database:", err);
        return false;
    }
}

function writeAndSend(res, db, extra = {}, event = null) {
    if (event) {
        appendLedgerEvent(db, event);
    }
    if (!writeDB(db)) {
        return res.status(500).json({ error: "資料寫入失敗，已停止本次操作" });
    }
    invalidateRAGIndex();
    return sendDB(res, db, extra);
}

function handleRequestError(res, err) {
    return res.status(err.status || 500).json({ error: err.message || "Server error" });
}

function normalizePlatformDraft(platform) {
    const billingMode = platform?.billingMode === 'split' ? 'split' : 'fixed';
    return {
        ...platform,
        billingMode,
        price: billingMode === 'split' ? 0 : parseMoney(platform?.price ?? 0, "固定單人月費"),
        totalCost: billingMode === 'split' ? parseMoney(platform?.totalCost ?? 0, "平台總月費") : 0
    };
}

function normalizeMemberDraft(member) {
    return {
        ...member,
        priorBalance: member?.priorBalance === "" || member?.priorBalance === undefined || member?.priorBalance === null
            ? 0
            : parseMoney(member.priorBalance, "期初餘額", { allowNegative: true }),
        customFee: member?.customFee === "" || member?.customFee === undefined || member?.customFee === null
            ? null
            : parseMoney(member.customFee, "自訂月費")
    };
}

function summarizeSettingsBundle(currentDb, nextPlatforms, nextMembers, nextBankInfo, nextReminderStyle) {
    const currentPlatforms = new Map((currentDb.platforms || []).map(platform => [platform.id || platform.name, platform]));
    const currentMembers = new Map((currentDb.members || []).map(member => [member.id || member.name, member]));

    let changedPlatforms = 0;
    let changedPlatformValues = 0;
    nextPlatforms.forEach(platform => {
        const current = currentPlatforms.get(platform.id || platform.name);
        if (!current) {
            changedPlatforms += 1;
            changedPlatformValues += 1;
            return;
        }
        const platformDiffs = [
            current.price !== platform.price,
            (current.billingMode || 'fixed') !== platform.billingMode,
            (current.totalCost || 0) !== platform.totalCost
        ].filter(Boolean).length;
        if (platformDiffs > 0) {
            changedPlatforms += 1;
            changedPlatformValues += platformDiffs;
        }
    });

    let changedMembers = 0;
    let changedMemberValues = 0;
    nextMembers.forEach(member => {
        const current = currentMembers.get(member.id || member.name);
        if (!current) {
            changedMembers += 1;
            changedMemberValues += 1;
            return;
        }
        const memberDiffs = [
            current.priorBalance !== member.priorBalance,
            (current.customFee ?? null) !== (member.customFee ?? null)
        ].filter(Boolean).length;
        if (memberDiffs > 0) {
            changedMembers += 1;
            changedMemberValues += memberDiffs;
        }
    });

    const bankInfoChanged = (currentDb.bankInfo || "") !== nextBankInfo;
    const reminderStyleChanged = (currentDb.reminderStyle || "friendly") !== nextReminderStyle;
    return {
        changedPlatforms,
        changedPlatformValues,
        changedMembers,
        changedMemberValues,
        bankInfoChanged,
        reminderStyleChanged,
        totalChanges: changedPlatformValues + changedMemberValues + (bankInfoChanged ? 1 : 0) + (reminderStyleChanged ? 1 : 0)
    };
}

function voidTransaction(record, reason = '使用者作廢') {
    const now = new Date().toISOString();
    record.status = 'voided';
    record.voidedAt = record.voidedAt || now;
    record.voidedBy = record.voidedBy || 'local-admin';
    record.voidReason = record.voidReason || reason;
    return record;
}

// ----------------------------------------------------
// Public Health / Auth Endpoints
// ----------------------------------------------------

app.get('/api/health', (req, res) => {
    res.json({
        ok: true,
        authConfigured: isAuthConfigured(),
        dataWritable: fs.existsSync(DATA_DIR) && fs.statSync(DATA_DIR).isDirectory(),
        host: HOST,
        port: Number(PORT)
    });
});

app.get('/api/auth/session', (req, res) => {
    if (!isAuthConfigured()) {
        return res.json({ authenticated: false, authConfigured: false });
    }
    const session = verifyRequestSession(req);
    return res.json({
        authenticated: session.ok,
        ...(session.ok && session.session.user ? { user: session.session.user } : {})
    });
});

app.get('/api/auth/login', (req, res) => {
    if (!isAuthConfigured()) {
        return res.status(503).json({ error: 'Authentication is not configured' });
    }

    const config = getGoogleOAuthConfig();
    const state = createOAuthStateValue();
    const redirectUri = getGoogleRedirectUri(req, config);
    const authUrl = buildGoogleAuthUrl({ config, redirectUri, state });
    res.setHeader('Set-Cookie', buildOAuthStateCookie(state));
    return res.redirect(authUrl);
});

app.get('/api/auth/callback', async (req, res) => {
    if (!isAuthConfigured()) {
        return res.status(503).json({ error: 'Authentication is not configured' });
    }

    const { code, state } = req.query;
    const cookies = parseCookies(req);
    if (
        typeof code !== 'string' ||
        typeof state !== 'string' ||
        !cookies[OAUTH_STATE_COOKIE_NAME] ||
        cookies[OAUTH_STATE_COOKIE_NAME] !== state
    ) {
        res.setHeader('Set-Cookie', clearOAuthStateCookie());
        return res.status(400).json({ error: 'Invalid OAuth state' });
    }

    const config = getGoogleOAuthConfig();
    const redirectUri = getGoogleRedirectUri(req, config);
    try {
        const token = await exchangeGoogleCode({ config, code, redirectUri });
        const profile = await fetchGoogleUserinfo({ config, accessToken: token.access_token });
        if (!isAllowedGoogleUser(profile, config.allowedEmails)) {
            res.setHeader('Set-Cookie', clearOAuthStateCookie());
            return res.status(403).json({ error: 'Google account is not allowed' });
        }

        const user = {
            email: profile.email.toLowerCase(),
            name: profile.name || profile.email
        };
        const cookieValue = createSessionCookieValue({ secret: process.env.APP_SESSION_SECRET, user });
        res.setHeader('Set-Cookie', [
            buildSessionCookie(cookieValue),
            clearOAuthStateCookie()
        ]);
        return res.redirect('/');
    } catch (err) {
        console.error('Google OAuth callback failed:', err.message || err);
        res.setHeader('Set-Cookie', clearOAuthStateCookie());
        return res.status(err.status || 500).json({ error: 'Google login failed' });
    }
});

app.post('/api/auth/logout', (req, res) => {
    res.setHeader('Set-Cookie', clearSessionCookie());
    return res.json({ authenticated: false });
});

app.use('/api', requireAuth);

// ----------------------------------------------------
// API Endpoints
// ----------------------------------------------------

// 1. Get all data
app.get('/api/data', (req, res) => {
    const db = readDB();
    if (!db) {
        return res.status(500).json({ error: "Failed to read database" });
    }
    res.json(withAudit(db));
});

// 2. Add payment
app.post('/api/payment', (req, res) => {
    const db = readDB();
    if (!db) return res.status(500).json({ error: "Database error" });

    try {
        const { memberId, memberName, date, amount, method, cycle, note } = req.body;
        if ((!memberId && !memberName) || amount === undefined) {
            return res.status(400).json({ error: "Missing required fields" });
        }
        const member = assertMemberExists(db, { memberId, memberName });
        const createdAt = new Date().toISOString();

        const newPayment = {
            id: generateId('pay'),
            memberId: member.id,
            memberName: member.name,
            date: date || new Date().toISOString().split('T')[0],
            amount: parseMoney(amount, "付款金額"),
            method: method || "轉帳",
            cycle: cycle || db.currentMonth.replace('/', ''),
            note: note || "",
            createdAt
        };

        const duplicatePayment = findRecentDuplicateTransaction(db.payments, newPayment, { type: 'payment' });
        if (duplicatePayment) {
            return res.status(409).json({
                error: '疑似重複付款：10 分鐘內已有相同收款紀錄',
                duplicate: {
                    id: duplicatePayment.id,
                    memberName: duplicatePayment.memberName,
                    amount: duplicatePayment.amount,
                    date: duplicatePayment.date,
                    method: duplicatePayment.method,
                    note: duplicatePayment.note || '',
                    createdAt: duplicatePayment.createdAt || null
                }
            });
        }

        db.payments.push(newPayment);
        return writeAndSend(res, db, {}, {
            type: 'payment.created',
            summary: `${member.name} 付款 ${newPayment.amount}`,
            entityType: 'payment',
            entityId: newPayment.id,
            amount: newPayment.amount,
            payload: { memberId: member.id, memberName: member.name, method: newPayment.method, date: newPayment.date }
        });
    } catch (err) {
        return handleRequestError(res, err);
    }
});

// 3. Void payment
app.delete('/api/payment/:id', (req, res) => {
    const db = readDB();
    if (!db) return res.status(500).json({ error: "Database error" });

    const id = req.params.id;
    const payment = db.payments.find(p => p.id === id);
    if (!payment) return res.status(404).json({ error: "付款記錄不存在" });
    if (isTransactionVoided(payment)) return res.status(409).json({ error: "付款記錄已作廢" });

    voidTransaction(payment, req.body?.reason);
    return writeAndSend(res, db, {}, {
        type: 'payment.voided',
        summary: `作廢 ${payment.memberName} 付款 ${payment.amount}`,
        entityType: 'payment',
        entityId: id,
        amount: payment.amount,
        payload: { voided: payment }
    });
});

// 4. Add temporary charge
app.post('/api/temp-charge', (req, res) => {
    const db = readDB();
    if (!db) return res.status(500).json({ error: "Database error" });

    try {
        const { memberId, memberName, date, amount, desc } = req.body;
        if ((!memberId && !memberName) || amount === undefined) {
            return res.status(400).json({ error: "Missing required fields" });
        }
        const member = assertMemberExists(db, { memberId, memberName });
        const createdAt = new Date().toISOString();

        const newCharge = {
            id: generateId('chg'),
            memberId: member.id,
            memberName: member.name,
            date: date || new Date().toISOString().split('T')[0],
            amount: parseMoney(amount, "加帳金額"),
            desc: desc || "",
            createdAt
        };

        const duplicateCharge = findRecentDuplicateTransaction(db.tempCharges, newCharge, { type: 'charge' });
        if (duplicateCharge) {
            return res.status(409).json({
                error: '疑似重複加帳：10 分鐘內已有相同臨時費用紀錄',
                duplicate: {
                    id: duplicateCharge.id,
                    memberName: duplicateCharge.memberName,
                    amount: duplicateCharge.amount,
                    date: duplicateCharge.date,
                    desc: duplicateCharge.desc || '',
                    createdAt: duplicateCharge.createdAt || null
                }
            });
        }

        db.tempCharges.push(newCharge);
        return writeAndSend(res, db, {}, {
            type: 'charge.created',
            summary: `${member.name} 加帳 ${newCharge.amount}`,
            entityType: 'tempCharge',
            entityId: newCharge.id,
            amount: newCharge.amount,
            payload: { memberId: member.id, memberName: member.name, desc: newCharge.desc, date: newCharge.date }
        });
    } catch (err) {
        return handleRequestError(res, err);
    }
});

// 5. Void temporary charge
app.delete('/api/temp-charge/:id', (req, res) => {
    const db = readDB();
    if (!db) return res.status(500).json({ error: "Database error" });

    const id = req.params.id;
    const charge = db.tempCharges.find(c => c.id === id);
    if (!charge) return res.status(404).json({ error: "臨時加帳記錄不存在" });
    if (isTransactionVoided(charge)) return res.status(409).json({ error: "臨時加帳記錄已作廢" });

    voidTransaction(charge, req.body?.reason);
    return writeAndSend(res, db, {}, {
        type: 'charge.voided',
        summary: `作廢 ${charge.memberName} 加帳 ${charge.amount}`,
        entityType: 'tempCharge',
        entityId: id,
        amount: charge.amount,
        payload: { voided: charge }
    });
});

// 6. Update platform prices
app.post('/api/update-prices', (req, res) => {
    const db = readDB();
    if (!db) return res.status(500).json({ error: "Database error" });

    const { platforms } = req.body;
    if (!Array.isArray(platforms)) {
        return res.status(400).json({ error: "Invalid platforms data" });
    }

    try {
        db.platforms = platforms.map(normalizePlatformDraft);
    } catch (err) {
        return handleRequestError(res, err);
    }
    return writeAndSend(res, db, {}, {
        type: 'platforms.updated',
        summary: `更新 ${db.platforms.length} 個平台價格設定`,
        entityType: 'platform',
        payload: { count: db.platforms.length }
    });
});

// 7. Update members config (custom fees, prior balance)
app.post('/api/update-members', (req, res) => {
    const db = readDB();
    if (!db) return res.status(500).json({ error: "Database error" });

    const { members } = req.body;
    if (!Array.isArray(members)) {
        return res.status(400).json({ error: "Invalid members data" });
    }

    try {
        db.members = members.map(normalizeMemberDraft);
    } catch (err) {
        return handleRequestError(res, err);
    }
    return writeAndSend(res, db, {}, {
        type: 'members.updated',
        summary: `更新 ${db.members.length} 位成員設定`,
        entityType: 'member',
        payload: { count: db.members.length }
    });
});

// 8. Update active subscriptions list
app.post('/api/update-subscriptions', (req, res) => {
    const db = readDB();
    if (!db) return res.status(500).json({ error: "Database error" });

    const { subscriptions } = req.body;
    if (!Array.isArray(subscriptions)) {
        return res.status(400).json({ error: "Invalid subscriptions data" });
    }

    db.subscriptions = subscriptions;
    return writeAndSend(res, db, {}, {
        type: 'subscriptions.updated',
        summary: `更新 ${subscriptions.length} 筆訂閱指派`,
        entityType: 'subscription',
        payload: { count: subscriptions.length }
    });
});

// 9. Update bank info and general settings
app.post('/api/update-bank', (req, res) => {
    const db = readDB();
    if (!db) return res.status(500).json({ error: "Database error" });

    const { bankInfo, reminderStyle } = req.body;
    db.bankInfo = bankInfo || "";
    db.reminderStyle = reminderStyle || "friendly";
    return writeAndSend(res, db, {}, {
        type: 'settings.updated',
        summary: '更新匯款資訊與對帳單樣式',
        entityType: 'settings',
        payload: { reminderStyle: db.reminderStyle, bankInfoChanged: true }
    });
});

// 9aa. Atomically update all configuration drafts in a single write
app.post('/api/update-config-bundle', (req, res) => {
    const db = readDB();
    if (!db) return res.status(500).json({ error: "Database error" });

    try {
        const { platforms, members, bankInfo, reminderStyle } = req.body;
        if (!Array.isArray(platforms) || !Array.isArray(members)) {
            return res.status(400).json({ error: "設定草稿格式不正確" });
        }

        const normalizedPlatforms = platforms.map(normalizePlatformDraft);
        const normalizedMembers = members.map(normalizeMemberDraft);
        const nextBankInfo = typeof bankInfo === 'string' ? bankInfo : "";
        const nextReminderStyle = reminderStyle || "friendly";
        const summary = summarizeSettingsBundle(db, normalizedPlatforms, normalizedMembers, nextBankInfo, nextReminderStyle);

        if (summary.totalChanges === 0) {
            return sendDB(res, db, { message: '沒有設定異動，已重新同步畫面。' });
        }

        db.platforms = normalizedPlatforms;
        db.members = normalizedMembers;
        db.bankInfo = nextBankInfo;
        db.reminderStyle = nextReminderStyle;

        const summaryParts = [];
        if (summary.changedPlatforms > 0) summaryParts.push(`${summary.changedPlatforms} 個平台`);
        if (summary.changedMembers > 0) summaryParts.push(`${summary.changedMembers} 位成員`);
        if (summary.bankInfoChanged) summaryParts.push('匯款資訊');
        if (summary.reminderStyleChanged) summaryParts.push('催帳語氣');
        const eventSummary = `一次性更新設定：${summaryParts.join('、')}`;

        return writeAndSend(res, db, {
            message: '設定已一次寫入資料庫，並留下單筆事件。'
        }, {
            type: 'settings.bundle.updated',
            summary: eventSummary,
            entityType: 'settings',
            payload: summary
        });
    } catch (err) {
        return handleRequestError(res, err);
    }
});

// 9a. Add new member
app.post('/api/member', (req, res) => {
    const db = readDB();
    if (!db) return res.status(500).json({ error: "Database error" });
    
    try {
        const { name, priorBalance, customFee } = req.body;
        if (!name) return res.status(400).json({ error: "姓名不可為空" });
        
        if (db.members.some(m => m.name === name)) {
            return res.status(400).json({ error: "該成員已存在" });
        }
        
        const newMember = {
            id: generateId('m'),
            name,
            priorBalance: priorBalance === "" || priorBalance === undefined || priorBalance === null ? 0 : parseMoney(priorBalance, "期初餘額", { allowNegative: true }),
            customFee: customFee === "" || customFee === undefined || customFee === null ? null : parseMoney(customFee, "自訂月費")
        };
        
        db.members.push(newMember);
        return writeAndSend(res, db, {}, {
            type: 'member.created',
            summary: `新增成員 ${newMember.name}`,
            entityType: 'member',
            entityId: newMember.id,
            payload: { memberId: newMember.id, memberName: newMember.name }
        });
    } catch (err) {
        return handleRequestError(res, err);
    }
});

// 9b. Archive member without deleting accounting evidence
app.delete('/api/member/:id', (req, res) => {
    const db = readDB();
    if (!db) return res.status(500).json({ error: "Database error" });
    
    const id = req.params.id;
    const member = db.members.find(m => m.id === id);
    if (!member) return res.status(404).json({ error: "成員不存在" });
    if (member.status === 'archived' || member.archivedAt) {
        return res.status(409).json({ error: "成員已停用" });
    }

    const archivedAt = new Date().toISOString();
    const archivedMonth = db.currentMonth;
    const stopMonth = previousMonthString(db.currentMonth) || db.currentMonth;
    member.status = 'archived';
    member.archivedAt = archivedAt;
    member.archivedBy = 'local-admin';
    member.archivedMonth = archivedMonth;
    member.archiveReason = '使用者停用';

    let closedSubscriptions = 0;
    db.subscriptions.forEach(subscription => {
        if (!isMemberRecord(subscription, member)) return;
        if (!subscription.exitMonth || subscription.exitMonth >= db.currentMonth) {
            subscription.exitMonth = stopMonth;
            subscription.archivedWithMemberAt = archivedAt;
            closedSubscriptions += 1;
        }
    });

    return writeAndSend(res, db, {}, {
        type: 'member.archived',
        summary: `停用成員 ${member.name}`,
        entityType: 'member',
        entityId: member.id,
        payload: { memberId: member.id, memberName: member.name, archivedMonth, closedSubscriptions }
    });
});

// 9c. Add new subscription platform
app.post('/api/platform', (req, res) => {
    const db = readDB();
    if (!db) return res.status(500).json({ error: "Database error" });
    
    try {
        const { name, price, billingMode, totalCost } = req.body;
        if (!name) return res.status(400).json({ error: "平台名稱不可為空" });
        
        if (db.platforms.some(p => p.name === name)) {
            return res.status(400).json({ error: "該平台已存在" });
        }
        
        const mode = billingMode || "fixed";
        const newPlatform = {
            id: generateId('p'),
            name,
            price: mode === "split" ? 0 : parseMoney(price || 0, "固定單人月費"),
            billingMode: mode,
            totalCost: mode === "split" ? parseMoney(totalCost || 0, "平台總月費") : 0
        };
        
        db.platforms.push(newPlatform);
        return writeAndSend(res, db, {}, {
            type: 'platform.created',
            summary: `新增平台 ${newPlatform.name}`,
            entityType: 'platform',
            entityId: newPlatform.id,
            payload: { platformId: newPlatform.id, platformName: newPlatform.name, billingMode: newPlatform.billingMode }
        });
    } catch (err) {
        return handleRequestError(res, err);
    }
});

// 9d. Archive subscription platform without deleting accounting evidence
app.delete('/api/platform/:id', (req, res) => {
    const db = readDB();
    if (!db) return res.status(500).json({ error: "Database error" });
    
    const id = req.params.id;
    const platform = db.platforms.find(p => p.id === id);
    if (!platform) return res.status(404).json({ error: "平台不存在" });
    if (platform.status === 'archived' || platform.archivedAt) {
        return res.status(409).json({ error: "平台已停用" });
    }

    const archivedAt = new Date().toISOString();
    const archivedMonth = db.currentMonth;
    const stopMonth = previousMonthString(db.currentMonth) || db.currentMonth;
    platform.status = 'archived';
    platform.archivedAt = archivedAt;
    platform.archivedBy = 'local-admin';
    platform.archivedMonth = archivedMonth;
    platform.archiveReason = '使用者停用';

    let closedSubscriptions = 0;
    db.subscriptions.forEach(subscription => {
        if (!isPlatformRecord(subscription, platform)) return;
        if (!subscription.exitMonth || subscription.exitMonth >= db.currentMonth) {
            subscription.exitMonth = stopMonth;
            subscription.archivedWithPlatformAt = archivedAt;
            closedSubscriptions += 1;
        }
    });

    return writeAndSend(res, db, {}, {
        type: 'platform.archived',
        summary: `停用平台 ${platform.name}`,
        entityType: 'platform',
        entityId: platform.id,
        payload: { platformId: platform.id, platformName: platform.name, archivedMonth, closedSubscriptions }
    });
});

// 10. Perform Monthly Settlement (結帳 / Rollover)
app.post('/api/settle', (req, res) => {
    const db = readDB();
    if (!db) return res.status(500).json({ error: "Database error" });

    const preview = getClosePreview(db);
    if (!preview.ready) {
        return res.status(409).json({
            error: "月結預檢未通過，請先處理高風險項目",
            preview
        });
    }

    const currentMonth = db.currentMonth; // YYYY/MM (e.g. "2026/05")
    
    // Parse current year/month
    const [year, month] = currentMonth.split('/').map(Number);

    const balancesReport = calculateCurrentMonthBalances(db);
    const updatedMembers = db.members.map(m => {
        const balance = balancesReport.find(b => isMemberRecord(b, m));
        return {
            ...m,
            priorBalance: balance ? balance.endingBalance : m.priorBalance
        };
    });

    // C. Archive current month data to history
    const newHistoryEntry = {
        month: currentMonth,
        balances: balancesReport,
        payments: [...db.payments],
        tempCharges: [...db.tempCharges]
    };
    db.history.push(newHistoryEntry);
    ensureHistorySeals(db, { sealedAt: new Date().toISOString(), reason: 'month.settled' });

    // D. Update current month to next month
    let nextYear = year;
    let nextMonth = month + 1;
    if (nextMonth > 12) {
        nextMonth = 1;
        nextYear += 1;
    }
    const nextMonthStr = `${nextYear}/${String(nextMonth).padStart(2, '0')}`;

    db.currentMonth = nextMonthStr;
    db.members = updatedMembers;
    db.payments = [];
    db.tempCharges = [];

    return writeAndSend(res, db, {}, {
        type: 'month.settled',
        summary: `完成 ${currentMonth} 月結，轉入 ${nextMonthStr}`,
        entityType: 'settlement',
        entityId: currentMonth,
        amount: balancesReport.reduce((sum, b) => sum + b.endingBalance, 0),
        payload: { settledMonth: currentMonth, nextMonth: nextMonthStr, balancesCount: balancesReport.length }
    });
});

// 10a. Close readiness preview
app.get('/api/close-preview', (req, res) => {
    const db = readDB();
    if (!db) return res.status(500).json({ error: "Database error" });
    res.json({
        success: true,
        preview: getClosePreview(db)
    });
});

// ----------------------------------------------------
// Backup / Restore API Endpoints
// ----------------------------------------------------

// 10b. List all available backups
app.get('/api/backups', (req, res) => {
    try {
        const db = readDB();
        if (!db) return res.status(500).json({ error: "Database error" });
        res.json({ success: true, ...listBackupInventory(db) });
    } catch (err) {
        res.status(500).json({ error: "無法讀取備份目錄" });
    }
});

app.get('/api/backups/:filename/preview', (req, res) => {
    try {
        const db = readDB();
        if (!db) return res.status(500).json({ error: "Database error" });
        const preview = analyzeBackupFile(req.params.filename, getSystemSnapshot(db));
        res.json({ success: true, backup: preview });
    } catch (err) {
        return handleRequestError(res, err);
    }
});

// 10c. Restore a specific backup
app.post('/api/backups/restore', (req, res) => {
    const { filename } = req.body;
    if (!filename) return res.status(400).json({ error: "請指定備份檔案名稱" });

    try {
        const backupPath = safeBackupPath(filename);
        if (!fs.existsSync(backupPath)) {
            return res.status(404).json({ error: "備份檔案不存在" });
        }

        // Backup current db before restoring (just in case)
        backupDB();
        fs.copyFileSync(backupPath, DB_PATH);
        const db = readDB();
        return writeAndSend(res, db, { message: `已還原至 ${filename}` }, {
            type: 'backup.restored',
            summary: `還原備份 ${filename}`,
            entityType: 'backup',
            entityId: filename,
            payload: { filename }
        });
    } catch (err) {
        return handleRequestError(res, err);
    }
});

// 10d. Create a manual backup
app.post('/api/backups/create', (req, res) => {
    const db = readDB();
    if (!db) return res.status(500).json({ error: "Database error" });

    const backupPath = backupDB();
    if (!backupPath) {
        return res.status(500).json({ error: "備份建立失敗" });
    }

    const filename = path.basename(backupPath);
    return writeAndSend(res, db, { filename, message: `備份已建立: ${filename}` }, {
        type: 'backup.created',
        summary: `建立手動備份 ${filename}`,
        entityType: 'backup',
        entityId: filename,
        payload: { filename }
    });
});

// 10e. Delete a backup file
app.delete('/api/backups/:filename', (req, res) => {
    const filename = req.params.filename;
    try {
        const backupPath = safeBackupPath(filename);
        if (!fs.existsSync(backupPath)) {
            return res.status(404).json({ error: "備份檔案不存在" });
        }
        fs.unlinkSync(backupPath);
        const db = readDB();
        if (!db) return res.status(500).json({ error: "Database error" });
        return writeAndSend(res, db, {}, {
            type: 'backup.deleted',
            summary: `刪除備份 ${filename}`,
            entityType: 'backup',
            entityId: filename,
            payload: { filename }
        });
    } catch (err) {
        return handleRequestError(res, err);
    }
});

// 10f. Accounting audit warnings
app.get('/api/audit', (req, res) => {
    const db = readDB();
    if (!db) return res.status(500).json({ error: "Database error" });
    res.json({
        success: true,
        generatedAt: new Date().toISOString(),
        warnings: findAccountingWarnings(db),
        ledger: getLedgerSummary(db)
    });
});

// 10g. Tamper-evident accounting event chain
app.get('/api/ledger', (req, res) => {
    const db = readDB();
    if (!db) return res.status(500).json({ error: "Database error" });
    res.json({
        success: true,
        ledger: getLedgerSummary(db)
    });
});

// Helper to get displayName in server
function getSubscriptionDisplayName(sub) {
    if (sub.customName) {
        return `${sub.platformName} (${sub.customName})`;
    }
    return sub.platformName;
}

// 11. AI Routes
app.post('/api/ai/generate-reminder', async (req, res) => {
    const { memberId, style } = req.body;
    if (!memberId) {
        return res.status(400).json({ error: '缺少 memberId 參數' });
    }

    const db = readDB();
    if (!db) {
        return res.status(500).json({ error: '無法讀取資料庫' });
    }

    try {
        const member = db.members.find(m => m.id === memberId);
        if (!member) {
            return res.status(404).json({ error: '找不到成員' });
        }

        const balances = calculateCurrentMonthBalances(db);
        const balance = balances.find(b => isMemberRecord(b, member));
        if (!balance) {
            return res.status(400).json({ error: '找不到該成員的當月帳務摘要' });
        }

        // Map balance properties to summary format expected by generateOpenAIReminder
        const summary = {
            outstanding: balance.endingBalance,
            monthlyFee: balance.subscriptionFee,
            tempCharges: balance.tempCharge,
            paid: balance.paid
        };

        // Generate activeSubsText similar to the client helper
        const memberSubs = db.subscriptions.filter(s => {
            return (s.memberId && s.memberId === member.id) || s.memberName === member.name;
        });
        const activeSubsText = [];
        
        if (isEntityBillableInMonth(member, db.currentMonth) && member.customFee !== null && member.customFee !== "") {
            activeSubsText.push(`  • 自訂費用小計: $${member.customFee}`);
        } else {
            memberSubs.forEach(sub => {
                const isSubActive = isSubActiveInMonth(sub, db.currentMonth);
                const platform = db.platforms.find(p => (sub.platformId && p.id === sub.platformId) || p.name === sub.platformName);
                const isPlatformBillable = platform ? isEntityBillableInMonth(platform, db.currentMonth) : false;
                const isMemberBillable = isEntityBillableInMonth(member, db.currentMonth);

                if (isSubActive && isPlatformBillable && isMemberBillable) {
                    const price = platform ? getPlatformPriceForMonth(db, platform, db.currentMonth) : 0;
                    activeSubsText.push(`  • ${getSubscriptionDisplayName(sub)}: $${price}`);
                }
            });
        }

        if (activeSubsText.length === 0) {
            activeSubsText.push("  • 本期無訂閱項目");
        }

        const result = await generateAIReminder({
            member,
            summary,
            activeSubsText,
            bankInfo: db.bankInfo || '',
            currentMonth: db.currentMonth || '',
            style: style || 'friendly'
        });

        res.json({
            success: true,
            text: result.text,
            isAI: result.isAI,
            error: result.error
        });
    } catch (err) {
        console.error('Error generating reminder route:', err);
        res.status(500).json({ error: err.message || '生成催帳訊息失敗' });
    }
});

app.post('/api/ai/chat', async (req, res) => {
    const { message, history } = req.body;
    if (!message) {
        return res.status(400).json({ error: '缺少 message 參數' });
    }

    const db = readDB();
    if (!db) {
        return res.status(500).json({ error: '無法讀取資料庫' });
    }

    try {
        const result = await handleAssistantChat(db, message, history || []);
        res.json({
            success: true,
            reply: result.reply,
            history: result.history
        });
    } catch (err) {
        console.error('Error in chat route:', err);
        res.status(500).json({ error: err.message || 'AI 助理對話失敗' });
    }
});

app.post('/api/ai/rag-search', async (req, res) => {
    const { query, topK } = req.body;
    if (!query) {
        return res.status(400).json({ error: '缺少 query 參數' });
    }

    const db = readDB();
    if (!db) {
        return res.status(500).json({ error: '無法讀取資料庫' });
    }

    try {
        const results = await queryRAG(db, query, topK || 5);
        res.json({
            success: true,
            results: results
        });
    } catch (err) {
        console.error('Error in RAG search route:', err);
        res.status(500).json({ error: err.message || 'RAG 搜索失敗' });
    }
});

app.post('/api/ai/chat-legacy', async (req, res) => {
    const { message, history } = req.body;
    if (!message) {
        return res.status(400).json({ error: '缺少 message 參數' });
    }

    const db = readDB();
    if (!db) {
        return res.status(500).json({ error: '無法讀取資料庫' });
    }

    try {
        const result = await handleAssistantChat(db, message, history || []);
        res.json({
            success: true,
            reply: result.reply,
            history: result.history,
            isLegacy: true
        });
    } catch (err) {
        console.error('Error in legacy chat route:', err);
        res.status(500).json({ error: err.message || 'AI 助理對話失敗' });
    }
});

// Redirect all other queries to React SPA index.html in production
app.get(/.*/, (req, res) => {
    res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

app.listen(PORT, HOST, () => {
    console.log(`Server is running on http://${HOST}:${PORT}`);
    console.log(`Data directory: ${DATA_DIR}`);
    if (HOST !== '0.0.0.0') return;

    const os = require('os');
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
            if (net.family === 'IPv4' && !net.internal) {
                console.log(`手機或平板請連線同一個 Wi-Fi 並瀏覽：http://${net.address}:${PORT}`);
            }
        }
    }
});
