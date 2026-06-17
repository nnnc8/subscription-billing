import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { initSQLite, loadFromSQLite, saveToSQLite, migrateJsonToSQLite } from './lib/db.js';
import { loadLocalEnv } from './lib/env.js';
import {
    OAUTH_STATE_COOKIE_NAME,
    OAUTH_STATE_MAX_AGE_SECONDS,
    SESSION_COOKIE_NAME,
    SESSION_MAX_AGE_SECONDS,
    createOAuthStateValue,
    createSessionCookieValue,
    verifySessionCookieValue,
} from './lib/auth.js';
import {
    buildGoogleAuthUrl,
    exchangeGoogleCode,
    fetchGoogleUserinfo,
    getGoogleOAuthConfig,
    isAllowedGoogleUser,
    isGoogleOAuthConfigured,
} from './lib/google-oauth.js';
import type { AssistantMessage } from './lib/ai-assistant.js';
import {
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
    monthToCode,
    normalizeDatabaseRelations,
    previousMonthString,
    resolveMember,
    isSubActiveInMonth,
    getPlatformPriceForMonth,
    isEntityBillableInMonth,
} from './lib/accounting.js';
import { generateAIReminder } from './lib/ai-reminder.js';
import { handleAssistantChat } from './lib/ai-assistant.js';
import { invalidateRAGIndex, queryRAG } from './lib/rag.js';
import { parseAndClassifyProposals, applyProposal } from './lib/automation.js';
import { runLifecycleCatchUp, getLifecycleStatus, getSystemMonth } from './lib/lifecycle.js';
import type { Database, LedgerEvent, Payment, TempCharge, Member, Platform, Subscription, AutomationProposal } from './src/types/billing.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadLocalEnv({ cwd: __dirname });

const app = express();
app.set('trust proxy', true);
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = path.resolve(process.env.DATA_DIR || __dirname);
const DB_PATH = path.resolve(process.env.DB_PATH || path.join(DATA_DIR, 'database.json'));
const SQLITE_PATH = path.resolve(process.env.SQLITE_PATH || path.join(DATA_DIR, 'database.db'));
const BACKUP_DIR = path.resolve(process.env.BACKUP_DIR || path.join(DATA_DIR, 'backups'));
const DEMO_DB_PATH = path.join(__dirname, 'fixtures', 'demo-database.json');
const MAX_BACKUPS = 50;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const COOKIE_SECURE = process.env.COOKIE_SECURE === undefined
    ? IS_PRODUCTION
    : ['1', 'true', 'yes'].includes(String(process.env.COOKIE_SECURE).toLowerCase());

function configuredAllowedOrigins(): Set<string> {
    return new Set(String(process.env.ALLOWED_ORIGINS || '')
        .split(',')
        .map(origin => origin.trim())
        .filter(Boolean));
}

function isAllowedOrigin(origin: string, requestHost = ''): boolean {
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
    } catch {
        return false;
    }
}

function applyCors(req: Request, res: Response, next: NextFunction): void {
    const origin = req.headers.origin as string | undefined;
    if (origin) {
        if (!isAllowedOrigin(origin, req.headers.host as string)) {
            res.status(403).json({ error: 'CORS origin blocked' });
            return;
        }
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Access-Control-Allow-Headers', (req.headers['access-control-request-headers'] as string) || 'Content-Type');
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
        res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
        res.sendStatus(204);
        return;
    }
    next();
}

function isAuthConfigured(): boolean {
    return Boolean(process.env.APP_SESSION_SECRET && isGoogleOAuthConfigured(process.env));
}

function isCloudBinding(): boolean {
    return IS_PRODUCTION || HOST === '0.0.0.0' || HOST === '::';
}

function parseCookies(req: Request): Record<string, string> {
    return String(req.headers.cookie || '')
        .split(';')
        .map(part => part.trim())
        .filter(Boolean)
        .reduce<Record<string, string>>((cookies, part) => {
            const separator = part.indexOf('=');
            if (separator === -1) return cookies;
            const key = decodeURIComponent(part.slice(0, separator));
            const value = part.slice(separator + 1);
            cookies[key] = value;
            return cookies;
        }, {});
}

function buildCookie(name: string, value: string, { maxAge, httpOnly = true }: { maxAge: number; httpOnly?: boolean }): string {
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

function buildSessionCookie(value: string, { maxAge = SESSION_MAX_AGE_SECONDS }: { maxAge?: number } = {}): string {
    return buildCookie(SESSION_COOKIE_NAME, value, { maxAge });
}

function buildOAuthStateCookie(value: string, { maxAge = OAUTH_STATE_MAX_AGE_SECONDS }: { maxAge?: number } = {}): string {
    return buildCookie(OAUTH_STATE_COOKIE_NAME, value, { maxAge });
}

function clearSessionCookie(): string {
    return buildSessionCookie('', { maxAge: 0 });
}

function clearOAuthStateCookie(): string {
    return buildOAuthStateCookie('', { maxAge: 0 });
}

function verifyRequestSession(req: Request): ReturnType<typeof verifySessionCookieValue> {
    const value = parseCookies(req)[SESSION_COOKIE_NAME];
    return verifySessionCookieValue(value, { secret: process.env.APP_SESSION_SECRET! });
}

function externalOrigin(req: Request): string {
    const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'http';
    const host = (req.headers['x-forwarded-host'] as string) || req.headers.host;
    return `${proto}://${host}`;
}

function getGoogleRedirectUri(req: Request, config: ReturnType<typeof getGoogleOAuthConfig>): string {
    return config.redirectUri || `${externalOrigin(req)}/api/auth/callback`;
}

declare global {
    /* eslint-disable-next-line @typescript-eslint/no-namespace */
    namespace Express {
        interface Request {
            session?: { v: number; iat: number; exp: number; user: { email: string; name?: string } | null };
        }
    }
}

function requireAuth(req: Request, res: Response, next: NextFunction): void {
    if (!isAuthConfigured()) {
        res.status(503).json({ error: 'Authentication is not configured' });
        return;
    }
    const session = verifyRequestSession(req);
    if (!session.ok) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
    }
    req.session = session.session;
    next();
}

function bootstrapDataFiles(): void {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    
    const dbExists = fs.existsSync(SQLITE_PATH) && fs.statSync(SQLITE_PATH).size > 0;
    
    // Initialize SQLite schema
    initSQLite(SQLITE_PATH);

    if (!dbExists) {
        if (fs.existsSync(DB_PATH)) {
            migrateJsonToSQLite(DB_PATH, SQLITE_PATH);
        } else if (fs.existsSync(DEMO_DB_PATH)) {
            migrateJsonToSQLite(DEMO_DB_PATH, SQLITE_PATH);
            // Sync fallback copy
            fs.copyFileSync(DEMO_DB_PATH, DB_PATH);
        }
    }
}

if (isCloudBinding() && !isAuthConfigured()) {
    console.error('GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_ALLOWED_EMAILS, and APP_SESSION_SECRET are required when binding to a public host or running production.');
    process.exit(1);
}

bootstrapDataFiles();

// ---------------------------------------------------------------------------
// Startup lifecycle catch-up
// (catches months missed while server was offline)
// ---------------------------------------------------------------------------
try {
    const startupDb = readDB();
    if (startupDb) {
        const startupResults = runLifecycleCatchUp(startupDb);
        if (startupResults.some(r => r.advanced)) {
            if (writeDB(startupDb)) {
                invalidateRAGIndex();
                console.log(`[lifecycle] startup catch-up: advanced ${startupResults.filter(r => r.advanced).length} month(s) to ${startupDb.currentMonth}`);
            }
        }
    }
} catch (err) {
    console.error('[lifecycle] startup catch-up error:', err);
}

app.use(applyCors);
app.use(express.json());

// ---------------------------------------------------------------------------
// In-memory Automation Inbox (session-scoped; applied events are in ledger)
// ---------------------------------------------------------------------------
const automationInbox: AutomationProposal[] = [];

app.use(express.static(path.join(__dirname, 'dist')));

function readDB(): Database | null {
    try {
        return loadFromSQLite(SQLITE_PATH);
    } catch (err) {
        console.error('Error reading database from SQLite:', err);
        return null;
    }
}

function readDatabaseFile(filePath: string): Database {
    const data = fs.readFileSync(filePath, 'utf8');
    return normalizeDatabaseRelations(JSON.parse(data));
}

interface Delta {
    label: string
    before: unknown
    after: unknown
    text: string
}

function describeDelta(label: string, before: unknown, after: unknown, formatter: (v: unknown) => string = v => String(v)): Delta | null {
    if (before === after) return null;
    return {
        label,
        before,
        after,
        text: `${label}: ${formatter(before)} -> ${formatter(after)}`
    };
}

function compareSnapshots(currentSnapshot: Record<string, unknown>, targetSnapshot: Record<string, unknown>): {
    sameBusinessState: boolean
    changeCount: number
    summary: string
    changes: (Delta | null)[]
} {
    if (!currentSnapshot || !targetSnapshot) {
        return {
            sameBusinessState: false,
            changeCount: 0,
            summary: '無法比較目前資料與備份內容',
            changes: []
        };
    }

    const money = (value: unknown) => `$${Number(value || 0).toLocaleString()}`;
    const plain = (value: unknown) => String(value ?? '—');
    const changes = [
        describeDelta('帳期', currentSnapshot.currentMonth, targetSnapshot.currentMonth, plain),
        describeDelta('本期待收', currentSnapshot.totals && (currentSnapshot.totals as Record<string, unknown>).receivable, targetSnapshot.totals && (targetSnapshot.totals as Record<string, unknown>).receivable, money),
        describeDelta('已入帳', currentSnapshot.totals && (currentSnapshot.totals as Record<string, unknown>).paid, targetSnapshot.totals && (targetSnapshot.totals as Record<string, unknown>).paid, money),
        describeDelta('成員數', currentSnapshot.counts && (currentSnapshot.counts as Record<string, unknown>).members, targetSnapshot.counts && (targetSnapshot.counts as Record<string, unknown>).members, plain),
        describeDelta('活躍設定數', currentSnapshot.counts && (currentSnapshot.counts as Record<string, unknown>).subscriptions, targetSnapshot.counts && (targetSnapshot.counts as Record<string, unknown>).subscriptions, plain),
        describeDelta('付款筆數', currentSnapshot.counts && (currentSnapshot.counts as Record<string, unknown>).payments, targetSnapshot.counts && (targetSnapshot.counts as Record<string, unknown>).payments, plain),
        describeDelta('臨時加帳筆數', currentSnapshot.counts && (currentSnapshot.counts as Record<string, unknown>).tempCharges, targetSnapshot.counts && (targetSnapshot.counts as Record<string, unknown>).tempCharges, plain),
        describeDelta('歷史月份數', currentSnapshot.counts && (currentSnapshot.counts as Record<string, unknown>).history, targetSnapshot.counts && (targetSnapshot.counts as Record<string, unknown>).history, plain),
        describeDelta('事件鏈筆數', currentSnapshot.counts && (currentSnapshot.counts as Record<string, unknown>).ledger, targetSnapshot.counts && (targetSnapshot.counts as Record<string, unknown>).ledger, plain)
    ].filter((c): c is Delta => c !== null);

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

function backupLabel(filename: string): string {
    const match = filename.match(/database_(\d{8}_\d{6})/);
    return match ? match[1] : filename;
}

function analyzeBackupFile(filename: string, currentSnapshot: Record<string, unknown> | null = null): Record<string, unknown> {
    const backupPath = safeBackupPath(filename);
    const stats = fs.statSync(backupPath);
    const base: Record<string, unknown> = {
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
            restoreImpact: compareSnapshots(currentSnapshot || {}, snapshot as unknown as Record<string, unknown>)
        };
    } catch (err) {
        return {
            ...base,
            readable: false,
            error: (err as Error).message || '備份內容無法讀取',
            restoreImpact: {
                sameBusinessState: false,
                changeCount: 0,
                summary: '備份內容無法讀取',
                changes: []
            }
        };
    }
}

function listBackupInventory(currentDb: Database): Record<string, unknown> {
    const currentSnapshot = getSystemSnapshot(currentDb);
    const backups = fs.readdirSync(BACKUP_DIR)
        .filter(f => f.startsWith('database_') && f.endsWith('.json'))
        .sort()
        .reverse()
        .map(f => analyzeBackupFile(f, currentSnapshot as unknown as Record<string, unknown>));
    return {
        current: currentSnapshot,
        backups
    };
}

function withAudit(db: Database): Database & { _audit: Record<string, unknown> } {
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

function sendDB(res: Response, db: Database, extra: Record<string, unknown> = {}): void {
    res.json({ success: true, ...extra, data: withAudit(db) });
}

function generateId(prefix: string): string {
    return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
}

function parseMoney(value: unknown, field: string, { allowNegative = false }: { allowNegative?: boolean } = {}): number {
    const amount = typeof value === 'number' ? value : parseFloat(String(value));
    if (!Number.isFinite(amount)) {
        const err = new Error(`${field} 必須是有效數字`) as Error & { status: number };
        err.status = 400;
        throw err;
    }
    if (!allowNegative && amount < 0) {
        const err = new Error(`${field} 不可為負數`) as Error & { status: number };
        err.status = 400;
        throw err;
    }
    return amount;
}

function assertMemberExists(db: Database, memberRef: { memberName?: string; memberId?: string }): Member {
    const member = resolveMember(db, memberRef);
    if (!member) {
        const err = new Error(`找不到成員：${memberRef.memberName || memberRef.memberId || JSON.stringify(memberRef)}`) as Error & { status: number };
        err.status = 400;
        throw err;
    }
    return member;
}

function safeBackupPath(filename: string): string {
    if (!/^database_\d{8}_\d{6}(?:(?:_\d{3})?_[a-f0-9]{8})?\.json$/.test(filename)) {
        const err = new Error('備份檔名格式不合法') as Error & { status: number };
        err.status = 400;
        throw err;
    }
    const resolved = path.resolve(BACKUP_DIR, filename);
    if (!resolved.startsWith(path.resolve(BACKUP_DIR) + path.sep)) {
        const err = new Error('備份路徑不合法') as Error & { status: number };
        err.status = 400;
        throw err;
    }
    return resolved;
}

function backupDB(): string | null {
    try {
        const now = new Date();
        const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}_${String(now.getMilliseconds()).padStart(3, '0')}`;
        const suffix = crypto.randomUUID().slice(0, 8);
        const backupPath = path.join(BACKUP_DIR, `database_${ts}_${suffix}.json`);
        fs.copyFileSync(DB_PATH, backupPath);

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
        console.error('Backup failed:', err);
        return null;
    }
}

function writeDB(data: Database): boolean {
    try {
        normalizeDatabaseRelations(data);
        backupDB();
        
        // Save to SQLite database
        saveToSQLite(SQLITE_PATH, data);
        
        // Sync to JSON file for compatibility with other scripts/tests
        const tmpPath = `${DB_PATH}.${process.pid}.${Date.now()}.tmp`;
        fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
        fs.renameSync(tmpPath, DB_PATH);
        return true;
    } catch (err) {
        console.error('Error writing database to SQLite/JSON:', err);
        return false;
    }
}

function writeAndSend(res: Response, db: Database, extra: Record<string, unknown> = {}, event: Partial<LedgerEvent> & { type: string } | null = null): void {
    if (event) {
        appendLedgerEvent(db, event);
    }
    if (!writeDB(db)) {
        res.status(500).json({ error: '資料寫入失敗，已停止本次操作' });
        return;
    }
    invalidateRAGIndex();
    sendDB(res, db, extra);
}

function handleRequestError(res: Response, err: Error & { status?: number }): void {
    res.status(err.status || 500).json({ error: err.message || 'Server error' });
}

function normalizePlatformDraft(platform: Record<string, unknown>): Record<string, unknown> {
    const billingMode = platform?.billingMode === 'split' ? 'split' : 'fixed';
    return {
        ...platform,
        billingMode,
        price: billingMode === 'split' ? 0 : parseMoney(platform?.price ?? 0, '固定單人月費'),
        totalCost: billingMode === 'split' ? parseMoney(platform?.totalCost ?? 0, '平台總月費') : 0
    };
}

function normalizeMemberDraft(member: Record<string, unknown>): Record<string, unknown> {
    return {
        ...member,
        priorBalance: member?.priorBalance === '' || member?.priorBalance === undefined || member?.priorBalance === null
            ? 0
            : parseMoney(member.priorBalance, '期初餘額', { allowNegative: true }),
        customFee: member?.customFee === '' || member?.customFee === undefined || member?.customFee === null
            ? null
            : parseMoney(member.customFee, '自訂月費')
    };
}

function summarizeSettingsBundle(
    currentDb: Database,
    nextPlatforms: Record<string, unknown>[],
    nextMembers: Record<string, unknown>[],
    nextBankInfo: string,
    nextReminderStyle: string
): { changedPlatforms: number; changedPlatformValues: number; changedMembers: number; changedMemberValues: number; bankInfoChanged: boolean; reminderStyleChanged: boolean; totalChanges: number } {
    const currentPlatforms = new Map((currentDb.platforms || []).map(platform => [platform.id || platform.name, platform]));
    const currentMembers = new Map((currentDb.members || []).map(member => [member.id || member.name, member]));

    let changedPlatforms = 0;
    let changedPlatformValues = 0;
    nextPlatforms.forEach(platform => {
        const current = currentPlatforms.get((platform.id || platform.name) as string);
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
        const current = currentMembers.get((member.id || member.name) as string);
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

    const bankInfoChanged = (currentDb.bankInfo || '') !== nextBankInfo;
    const reminderStyleChanged = (currentDb.reminderStyle || 'friendly') !== nextReminderStyle;
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

function voidTransaction<T extends { status?: string; voidedAt?: string; voidedBy?: string; voidReason?: string }>(record: T, reason = '使用者作廢'): T {
    const now = new Date().toISOString();
    record.status = 'voided' as T['status'];
    record.voidedAt = record.voidedAt || now;
    record.voidedBy = record.voidedBy || 'local-admin';
    record.voidReason = record.voidReason || reason;
    return record;
}

// ----------------------------------------------------
// Public Health / Auth Endpoints
// ----------------------------------------------------

app.get('/api/health', (req: Request, res: Response) => {
    res.json({
        ok: true,
        authConfigured: isAuthConfigured(),
        dataWritable: fs.existsSync(DATA_DIR) && fs.statSync(DATA_DIR).isDirectory(),
        host: HOST,
        port: Number(PORT)
    });
});

app.get('/api/auth/session', (req: Request, res: Response) => {
    if (!isAuthConfigured()) {
        res.json({ authenticated: false, authConfigured: false });
        return;
    }
    const session = verifyRequestSession(req);
    res.json({
        authenticated: session.ok,
        ...(session.ok && session.session?.user ? { user: session.session.user } : {})
    });
});

app.get('/api/auth/login', (req: Request, res: Response) => {
    if (!isAuthConfigured()) {
        res.status(503).json({ error: 'Authentication is not configured' });
        return;
    }

    const config = getGoogleOAuthConfig();
    const state = createOAuthStateValue();
    const redirectUri = getGoogleRedirectUri(req, config);
    const authUrl = buildGoogleAuthUrl({ config, redirectUri, state });
    res.setHeader('Set-Cookie', buildOAuthStateCookie(state));
    res.redirect(authUrl);
});

app.get('/api/auth/callback', async (req: Request, res: Response) => {
    if (!isAuthConfigured()) {
        res.status(503).json({ error: 'Authentication is not configured' });
        return;
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
        res.status(400).json({ error: 'Invalid OAuth state' });
        return;
    }

    const config = getGoogleOAuthConfig();
    const redirectUri = getGoogleRedirectUri(req, config);
    try {
        const token = await exchangeGoogleCode({ config, code, redirectUri });
        const profile = await fetchGoogleUserinfo({ config, accessToken: token.access_token as string });
        if (!isAllowedGoogleUser(profile, config.allowedEmails)) {
            res.setHeader('Set-Cookie', clearOAuthStateCookie());
            res.status(403).json({ error: 'Google account is not allowed' });
            return;
        }

        const user = {
            email: (profile.email as string).toLowerCase(),
            name: (profile.name as string) || (profile.email as string)
        };
        const cookieValue = createSessionCookieValue({ secret: process.env.APP_SESSION_SECRET!, user });
        res.setHeader('Set-Cookie', [
            buildSessionCookie(cookieValue),
            clearOAuthStateCookie()
        ]);
        res.redirect('/');
    } catch (err) {
        console.error('Google OAuth callback failed:', (err as Error).message || err);
        res.setHeader('Set-Cookie', clearOAuthStateCookie());
        res.status((err as Error & { status?: number }).status || 500).json({ error: 'Google login failed' });
    }
});

app.post('/api/auth/logout', (req: Request, res: Response) => {
    res.setHeader('Set-Cookie', clearSessionCookie());
    res.json({ authenticated: false });
});

app.use('/api', requireAuth);

// ----------------------------------------------------
// API Endpoints
// ----------------------------------------------------

app.get('/api/data', (req: Request, res: Response) => {
    let db = readDB();
    if (!db) {
        res.status(500).json({ error: 'Failed to read database' });
        return;
    }

    // Per-request lifecycle check — advances month if Taipei date has changed
    try {
        const lcResults = runLifecycleCatchUp(db);
        if (lcResults.some(r => r.advanced)) {
            const persisted = writeDB(db);
            if (!persisted) {
                // Write failed: discard in-memory mutations, re-read persisted state
                // so the client always sees what's actually on disk.
                console.error('[lifecycle] /api/data writeDB failed — re-reading persisted state');
                const freshDb = readDB();
                if (!freshDb) {
                    res.status(500).json({ error: 'Database write failed and re-read also failed' });
                    return;
                }
                db = freshDb;
            } else {
                invalidateRAGIndex();
            }
        }
    } catch (err) {
        // Non-fatal: log and continue — don't fail /api/data over lifecycle
        console.error('[lifecycle] /api/data catch-up error:', err);
    }

    res.json(withAudit(db));
});

app.post('/api/payment', (req: Request, res: Response) => {
    const db = readDB();
    if (!db) { res.status(500).json({ error: 'Database error' }); return; }

    try {
        const { memberId, memberName, date, amount, method, cycle, note } = req.body as Record<string, unknown>;
        if ((!memberId && !memberName) || amount === undefined) {
            res.status(400).json({ error: 'Missing required fields' });
            return;
        }
        const member = assertMemberExists(db, { memberId: memberId as string, memberName: memberName as string });
        const createdAt = new Date().toISOString();

        const newPayment: Payment = {
            id: generateId('pay'),
            memberId: member.id,
            memberName: member.name,
            date: (date as string) || new Date().toISOString().split('T')[0],
            amount: parseMoney(amount, '付款金額'),
            method: (method as string) || '轉帳',
            cycle: (cycle as string) || db.currentMonth.replace('/', ''),
            note: (note as string) || '',
            createdAt,
        } as Payment;

        const duplicatePayment = findRecentDuplicateTransaction(db.payments, newPayment, { type: 'payment' });
        if (duplicatePayment) {
            res.status(409).json({
                error: '疑似重複付款：10 分鐘內已有相同收款紀錄',
                duplicate: {
                    id: duplicatePayment.id,
                    memberName: duplicatePayment.memberName,
                    amount: duplicatePayment.amount,
                    date: duplicatePayment.date,
                    method: (duplicatePayment as unknown as Record<string, string>).method,
                    note: (duplicatePayment as unknown as Record<string, string>).note || '',
                    createdAt: (duplicatePayment as unknown as Record<string, string>).createdAt || null
                }
            });
            return;
        }

        db.payments.push(newPayment);
        writeAndSend(res, db, {}, {
            type: 'payment.created',
            summary: `${member.name} 付款 ${newPayment.amount}`,
            entityType: 'payment',
            entityId: newPayment.id,
            amount: newPayment.amount,
            payload: { memberId: member.id, memberName: member.name, method: newPayment.method, date: newPayment.date }
        } as Partial<LedgerEvent> & { type: string });
    } catch (err) {
        handleRequestError(res, err as Error & { status?: number });
    }
});

app.delete('/api/payment/:id', (req: Request, res: Response) => {
    const db = readDB();
    if (!db) { res.status(500).json({ error: 'Database error' }); return; }

    const id = req.params.id;
    const payment = db.payments.find(p => p.id === id);
    if (!payment) { res.status(404).json({ error: '付款記錄不存在' }); return; }
    if (isTransactionVoided(payment)) { res.status(409).json({ error: '付款記錄已作廢' }); return; }

    voidTransaction(payment, (req.body as Record<string, string>)?.reason);
    writeAndSend(res, db, {}, {
        type: 'payment.voided',
        summary: `作廢 ${payment.memberName} 付款 ${payment.amount}`,
        entityType: 'payment',
        entityId: id,
        amount: payment.amount,
        payload: { voided: payment }
    } as Partial<LedgerEvent> & { type: string });
});

app.post('/api/temp-charge', (req: Request, res: Response) => {
    const db = readDB();
    if (!db) { res.status(500).json({ error: 'Database error' }); return; }

    try {
        const { memberId, memberName, date, amount, desc } = req.body as Record<string, unknown>;
        if ((!memberId && !memberName) || amount === undefined) {
            res.status(400).json({ error: 'Missing required fields' });
            return;
        }
        const member = assertMemberExists(db, { memberId: memberId as string, memberName: memberName as string });
        const createdAt = new Date().toISOString();

        const newCharge = {
            id: generateId('chg'),
            memberId: member.id,
            memberName: member.name,
            date: (date as string) || new Date().toISOString().split('T')[0],
            amount: parseMoney(amount, '加帳金額'),
            desc: (desc as string) || '',
            createdAt,
        } as TempCharge;

        const duplicateCharge = findRecentDuplicateTransaction(db.tempCharges, newCharge, { type: 'charge' });
        if (duplicateCharge) {
            res.status(409).json({
                error: '疑似重複加帳：10 分鐘內已有相同臨時費用紀錄',
                duplicate: {
                    id: duplicateCharge.id,
                    memberName: duplicateCharge.memberName,
                    amount: duplicateCharge.amount,
                    date: duplicateCharge.date,
                    desc: (duplicateCharge as unknown as Record<string, string>).desc || '',
                    createdAt: (duplicateCharge as unknown as Record<string, string>).createdAt || null
                }
            });
            return;
        }

        db.tempCharges.push(newCharge);
        writeAndSend(res, db, {}, {
            type: 'charge.created',
            summary: `${member.name} 加帳 ${newCharge.amount}`,
            entityType: 'tempCharge',
            entityId: newCharge.id,
            amount: newCharge.amount,
            payload: { memberId: member.id, memberName: member.name, desc: newCharge.desc, date: newCharge.date }
        } as Partial<LedgerEvent> & { type: string });
    } catch (err) {
        handleRequestError(res, err as Error & { status?: number });
    }
});

app.delete('/api/temp-charge/:id', (req: Request, res: Response) => {
    const db = readDB();
    if (!db) { res.status(500).json({ error: 'Database error' }); return; }

    const id = req.params.id;
    const charge = db.tempCharges.find(c => c.id === id);
    if (!charge) { res.status(404).json({ error: '臨時加帳記錄不存在' }); return; }
    if (isTransactionVoided(charge)) { res.status(409).json({ error: '臨時加帳記錄已作廢' }); return; }

    voidTransaction(charge, (req.body as Record<string, string>)?.reason);
    writeAndSend(res, db, {}, {
        type: 'charge.voided',
        summary: `作廢 ${charge.memberName} 加帳 ${charge.amount}`,
        entityType: 'tempCharge',
        entityId: id,
        amount: charge.amount,
        payload: { voided: charge }
    } as Partial<LedgerEvent> & { type: string });
});

app.post('/api/update-prices', (req: Request, res: Response) => {
    const db = readDB();
    if (!db) { res.status(500).json({ error: 'Database error' }); return; }

    const { platforms } = req.body as { platforms: Record<string, unknown>[] };
    if (!Array.isArray(platforms)) {
        res.status(400).json({ error: 'Invalid platforms data' });
        return;
    }

    try {
        db.platforms = platforms.map(normalizePlatformDraft) as unknown as Platform[];
    } catch (err) {
        handleRequestError(res, err as Error & { status?: number });
        return;
    }
    writeAndSend(res, db, {}, {
        type: 'platforms.updated',
        summary: `更新 ${db.platforms.length} 個平台價格設定`,
        entityType: 'platform',
        payload: { count: db.platforms.length }
    } as Partial<LedgerEvent> & { type: string });
});

app.post('/api/update-members', (req: Request, res: Response) => {
    const db = readDB();
    if (!db) { res.status(500).json({ error: 'Database error' }); return; }

    const { members } = req.body as { members: Record<string, unknown>[] };
    if (!Array.isArray(members)) {
        res.status(400).json({ error: 'Invalid members data' });
        return;
    }

    try {
        db.members = members.map(normalizeMemberDraft) as unknown as Member[];
    } catch (err) {
        handleRequestError(res, err as Error & { status?: number });
        return;
    }
    writeAndSend(res, db, {}, {
        type: 'members.updated',
        summary: `更新 ${db.members.length} 位成員設定`,
        entityType: 'member',
        payload: { count: db.members.length }
    } as Partial<LedgerEvent> & { type: string });
});

app.post('/api/update-subscriptions', (req: Request, res: Response) => {
    const db = readDB();
    if (!db) { res.status(500).json({ error: 'Database error' }); return; }

    const { subscriptions } = req.body as { subscriptions: Subscription[] };
    if (!Array.isArray(subscriptions)) {
        res.status(400).json({ error: 'Invalid subscriptions data' });
        return;
    }

    db.subscriptions = subscriptions;
    writeAndSend(res, db, {}, {
        type: 'subscriptions.updated',
        summary: `更新 ${subscriptions.length} 筆訂閱指派`,
        entityType: 'subscription',
        payload: { count: subscriptions.length }
    } as Partial<LedgerEvent> & { type: string });
});

app.post('/api/update-bank', (req: Request, res: Response) => {
    const db = readDB();
    if (!db) { res.status(500).json({ error: 'Database error' }); return; }

    const { bankInfo, reminderStyle } = req.body as { bankInfo: string; reminderStyle: string };
    db.bankInfo = bankInfo || '';
    db.reminderStyle = reminderStyle || 'friendly';
    writeAndSend(res, db, {}, {
        type: 'settings.updated',
        summary: '更新匯款資訊與對帳單樣式',
        entityType: 'settings',
        payload: { reminderStyle: db.reminderStyle, bankInfoChanged: true }
    } as Partial<LedgerEvent> & { type: string });
});

app.post('/api/update-config-bundle', (req: Request, res: Response) => {
    const db = readDB();
    if (!db) { res.status(500).json({ error: 'Database error' }); return; }

    try {
        const { platforms, members, bankInfo, reminderStyle } = req.body as Record<string, unknown>;
        if (!Array.isArray(platforms) || !Array.isArray(members)) {
            res.status(400).json({ error: '設定草稿格式不正確' });
            return;
        }

        const normalizedPlatforms = platforms.map(p => normalizePlatformDraft(p as Record<string, unknown>));
        const normalizedMembers = members.map(m => normalizeMemberDraft(m as Record<string, unknown>));
        const nextBankInfo = typeof bankInfo === 'string' ? bankInfo : '';
        const nextReminderStyle = (reminderStyle as string) || 'friendly';
        const summary = summarizeSettingsBundle(db, normalizedPlatforms, normalizedMembers, nextBankInfo, nextReminderStyle);

        if (summary.totalChanges === 0) {
            sendDB(res, db, { message: '沒有設定異動，已重新同步畫面。' });
            return;
        }

        db.platforms = normalizedPlatforms as unknown as Platform[];
        db.members = normalizedMembers as unknown as Member[];
        db.bankInfo = nextBankInfo;
        db.reminderStyle = nextReminderStyle;

        const summaryParts: string[] = [];
        if (summary.changedPlatforms > 0) summaryParts.push(`${summary.changedPlatforms} 個平台`);
        if (summary.changedMembers > 0) summaryParts.push(`${summary.changedMembers} 位成員`);
        if (summary.bankInfoChanged) summaryParts.push('匯款資訊');
        if (summary.reminderStyleChanged) summaryParts.push('催帳語氣');
        const eventSummary = `一次性更新設定：${summaryParts.join('、')}`;

        writeAndSend(res, db, {
            message: '設定已一次寫入資料庫，並留下單筆事件。'
        }, {
            type: 'settings.bundle.updated',
            summary: eventSummary,
            entityType: 'settings',
            payload: summary
        } as Partial<LedgerEvent> & { type: string });
    } catch (err) {
        handleRequestError(res, err as Error & { status?: number });
    }
});

app.post('/api/member', (req: Request, res: Response) => {
    const db = readDB();
    if (!db) { res.status(500).json({ error: 'Database error' }); return; }

    try {
        const { name, priorBalance, customFee } = req.body as Record<string, unknown>;
        if (!name) { res.status(400).json({ error: '姓名不可為空' }); return; }

        if (db.members.some(m => m.name === name)) {
            res.status(400).json({ error: '該成員已存在' });
            return;
        }

        const newMember: Member = {
            id: generateId('m'),
            name: name as string,
            priorBalance: priorBalance === '' || priorBalance === undefined || priorBalance === null ? 0 : parseMoney(priorBalance, '期初餘額', { allowNegative: true }),
            customFee: customFee === '' || customFee === undefined || customFee === null ? null : parseMoney(customFee, '自訂月費')
        } as Member;

        db.members.push(newMember);
        writeAndSend(res, db, {}, {
            type: 'member.created',
            summary: `新增成員 ${newMember.name}`,
            entityType: 'member',
            entityId: newMember.id,
            payload: { memberId: newMember.id, memberName: newMember.name }
        } as Partial<LedgerEvent> & { type: string });
    } catch (err) {
        handleRequestError(res, err as Error & { status?: number });
    }
});

app.delete('/api/member/:id', (req: Request, res: Response) => {
    const db = readDB();
    if (!db) { res.status(500).json({ error: 'Database error' }); return; }

    const id = req.params.id;
    const member = db.members.find(m => m.id === id);
    if (!member) { res.status(404).json({ error: '成員不存在' }); return; }
    if (member.status === 'archived' || member.archivedAt) {
        res.status(409).json({ error: '成員已停用' });
        return;
    }

    const archivedAt = new Date().toISOString();
    const archivedMonth = db.currentMonth;
    const stopMonth = previousMonthString(db.currentMonth) || db.currentMonth;
    member.status = 'archived';
    member.archivedAt = archivedAt;
    (member as unknown as Record<string, unknown>).archivedBy = 'local-admin';
    member.archivedMonth = archivedMonth;
    (member as unknown as Record<string, unknown>).archiveReason = '使用者停用';

    let closedSubscriptions = 0;
    db.subscriptions.forEach(subscription => {
        if (!isMemberRecord(subscription, member)) return;
        if (!subscription.exitMonth || subscription.exitMonth >= db.currentMonth) {
            subscription.exitMonth = stopMonth;
            (subscription as unknown as Record<string, unknown>).archivedWithMemberAt = archivedAt;
            closedSubscriptions += 1;
        }
    });

    writeAndSend(res, db, {}, {
        type: 'member.archived',
        summary: `停用成員 ${member.name}`,
        entityType: 'member',
        entityId: member.id,
        payload: { memberId: member.id, memberName: member.name, archivedMonth, closedSubscriptions }
    } as Partial<LedgerEvent> & { type: string });
});

app.post('/api/platform', (req: Request, res: Response) => {
    const db = readDB();
    if (!db) { res.status(500).json({ error: 'Database error' }); return; }

    try {
        const { name, price, billingMode, totalCost } = req.body as Record<string, unknown>;
        if (!name) { res.status(400).json({ error: '平台名稱不可為空' }); return; }

        if (db.platforms.some(p => p.name === name)) {
            res.status(400).json({ error: '該平台已存在' });
            return;
        }

        const mode = (billingMode as string) || 'fixed';
        const newPlatform: Platform = {
            id: generateId('p'),
            name: name as string,
            price: mode === 'split' ? 0 : parseMoney(price || 0, '固定單人月費'),
            billingMode: mode as 'fixed' | 'split',
            totalCost: mode === 'split' ? parseMoney(totalCost || 0, '平台總月費') : 0
        } as Platform;

        db.platforms.push(newPlatform);
        writeAndSend(res, db, {}, {
            type: 'platform.created',
            summary: `新增平台 ${newPlatform.name}`,
            entityType: 'platform',
            entityId: newPlatform.id,
            payload: { platformId: newPlatform.id, platformName: newPlatform.name, billingMode: newPlatform.billingMode }
        } as Partial<LedgerEvent> & { type: string });
    } catch (err) {
        handleRequestError(res, err as Error & { status?: number });
    }
});

app.delete('/api/platform/:id', (req: Request, res: Response) => {
    const db = readDB();
    if (!db) { res.status(500).json({ error: 'Database error' }); return; }

    const id = req.params.id;
    const platform = db.platforms.find(p => p.id === id);
    if (!platform) { res.status(404).json({ error: '平台不存在' }); return; }
    if (platform.status === 'archived' || platform.archivedAt) {
        res.status(409).json({ error: '平台已停用' });
        return;
    }

    const archivedAt = new Date().toISOString();
    const archivedMonth = db.currentMonth;
    const stopMonth = previousMonthString(db.currentMonth) || db.currentMonth;
    platform.status = 'archived';
    platform.archivedAt = archivedAt;
    (platform as unknown as Record<string, unknown>).archivedBy = 'local-admin';
    platform.archivedMonth = archivedMonth;
    (platform as unknown as Record<string, unknown>).archiveReason = '使用者停用';

    let closedSubscriptions = 0;
    db.subscriptions.forEach(subscription => {
        if (!isPlatformRecord(subscription, platform)) return;
        if (!subscription.exitMonth || subscription.exitMonth >= db.currentMonth) {
            subscription.exitMonth = stopMonth;
            (subscription as unknown as Record<string, unknown>).archivedWithPlatformAt = archivedAt;
            closedSubscriptions += 1;
        }
    });

    writeAndSend(res, db, {}, {
        type: 'platform.archived',
        summary: `停用平台 ${platform.name}`,
        entityType: 'platform',
        entityId: platform.id,
        payload: { platformId: platform.id, platformName: platform.name, archivedMonth, closedSubscriptions }
    } as Partial<LedgerEvent> & { type: string });
});

app.post('/api/settle', (req: Request, res: Response) => {
    const db = readDB();
    if (!db) { res.status(500).json({ error: 'Database error' }); return; }

    // Guard: manual settle must not push billing period past the real system month.
    // Only a catch-up settle (db.currentMonth < systemMonth) is allowed.
    const systemMonth = getSystemMonth();
    const dbCode = monthToCode(db.currentMonth);
    const sysCode = monthToCode(systemMonth);
    if (dbCode !== null && sysCode !== null && dbCode >= sysCode) {
        res.status(409).json({
            error: `帳期已是最新（${db.currentMonth}），無需手動月結。帳期由系統依台北時間自動推進。`,
            currentMonth: db.currentMonth,
            systemMonth,
        });
        return;
    }

    const preview = getClosePreview(db);
    if (!preview.ready) {
        res.status(409).json({
            error: '月結預檢未通過，請先處理高風險項目',
            preview
        });
        return;
    }

    const currentMonth = db.currentMonth;
    const [year, month] = currentMonth.split('/').map(Number);

    const balancesReport = calculateCurrentMonthBalances(db);
    const updatedMembers = db.members.map(m => {
        const balance = balancesReport.find(b => isMemberRecord(b, m));
        return {
            ...m,
            priorBalance: balance ? balance.endingBalance : m.priorBalance
        };
    });

    const newHistoryEntry = {
        month: currentMonth,
        balances: balancesReport,
        payments: [...db.payments],
        tempCharges: [...db.tempCharges]
    };
    db.history.push(newHistoryEntry);
    ensureHistorySeals(db, { sealedAt: new Date().toISOString(), reason: 'month.settled' });

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

    writeAndSend(res, db, {}, {
        type: 'month.settled',
        summary: `完成 ${currentMonth} 月結，轉入 ${nextMonthStr}`,
        entityType: 'settlement',
        entityId: currentMonth,
        amount: balancesReport.reduce((sum, b) => sum + b.endingBalance, 0),
        payload: { settledMonth: currentMonth, nextMonth: nextMonthStr, balancesCount: balancesReport.length }
    } as Partial<LedgerEvent> & { type: string });
});

app.get('/api/close-preview', (req: Request, res: Response) => {
    const db = readDB();
    if (!db) { res.status(500).json({ error: 'Database error' }); return; }
    res.json({
        success: true,
        preview: getClosePreview(db)
    });
});

app.get('/api/backups', (req: Request, res: Response) => {
    try {
        const db = readDB();
        if (!db) { res.status(500).json({ error: 'Database error' }); return; }
        res.json({ success: true, ...listBackupInventory(db) });
    } catch (err) {
        res.status(500).json({ error: '無法讀取備份目錄' });
    }
});

app.get('/api/backups/:filename/preview', (req: Request, res: Response) => {
    try {
        const db = readDB();
        if (!db) { res.status(500).json({ error: 'Database error' }); return; }
        const preview = analyzeBackupFile(req.params.filename as string, getSystemSnapshot(db) as unknown as Record<string, unknown>);
        res.json({ success: true, backup: preview });
    } catch (err) {
        handleRequestError(res, err as Error & { status?: number });
    }
});

app.post('/api/backups/restore', (req: Request, res: Response) => {
    const { filename } = req.body as { filename: string };
    if (!filename) { res.status(400).json({ error: '請指定備份檔案名稱' }); return; }

    try {
        const backupPath = safeBackupPath(filename);
        if (!fs.existsSync(backupPath)) {
            res.status(404).json({ error: '備份檔案不存在' });
            return;
        }

        backupDB();
        fs.copyFileSync(backupPath, DB_PATH);
        const db = readDB();
        writeAndSend(res, db!, { message: `已還原至 ${filename}` }, {
            type: 'backup.restored',
            summary: `還原備份 ${filename}`,
            entityType: 'backup',
            entityId: filename,
            payload: { filename }
        } as Partial<LedgerEvent> & { type: string });
    } catch (err) {
        handleRequestError(res, err as Error & { status?: number });
    }
});

app.post('/api/backups/create', (req: Request, res: Response) => {
    const db = readDB();
    if (!db) { res.status(500).json({ error: 'Database error' }); return; }

    const backupPath = backupDB();
    if (!backupPath) {
        res.status(500).json({ error: '備份建立失敗' });
        return;
    }

    const filename = path.basename(backupPath);
    writeAndSend(res, db, { filename, message: `備份已建立: ${filename}` }, {
        type: 'backup.created',
        summary: `建立手動備份 ${filename}`,
        entityType: 'backup',
        entityId: filename,
        payload: { filename }
    } as Partial<LedgerEvent> & { type: string });
});

app.delete('/api/backups/:filename', (req: Request, res: Response) => {
    const filename = req.params.filename as string;
    try {
        const backupPath = safeBackupPath(filename);
        if (!fs.existsSync(backupPath)) {
            res.status(404).json({ error: '備份檔案不存在' });
            return;
        }
        fs.unlinkSync(backupPath);
        const db = readDB();
        if (!db) { res.status(500).json({ error: 'Database error' }); return; }
        writeAndSend(res, db, {}, {
            type: 'backup.deleted',
            summary: `刪除備份 ${filename}`,
            entityType: 'backup',
            entityId: filename,
            payload: { filename }
        } as Partial<LedgerEvent> & { type: string });
    } catch (err) {
        handleRequestError(res, err as Error & { status?: number });
    }
});

app.get('/api/audit', (req: Request, res: Response) => {
    const db = readDB();
    if (!db) { res.status(500).json({ error: 'Database error' }); return; }
    res.json({
        success: true,
        generatedAt: new Date().toISOString(),
        warnings: findAccountingWarnings(db),
        ledger: getLedgerSummary(db)
    });
});


app.get('/api/lifecycle/status', (req: Request, res: Response) => {
    const db = readDB();
    if (!db) { res.status(500).json({ error: 'Database error' }); return; }
    const status = getLifecycleStatus(db);
    res.json({ success: true, ...status });
});

app.get('/api/ledger', (req: Request, res: Response) => {
    const db = readDB();
    if (!db) { res.status(500).json({ error: 'Database error' }); return; }
    res.json({
        success: true,
        ledger: getLedgerSummary(db)
    });
});

function getSubscriptionDisplayName(sub: Subscription): string {
    if ((sub as unknown as Record<string, unknown>).customName) {
        return `${sub.platformName} (${(sub as unknown as Record<string, unknown>).customName})`;
    }
    return sub.platformName;
}

// AI Routes
app.post('/api/ai/generate-reminder', async (req: Request, res: Response) => {
    const { memberId, style } = req.body as { memberId: string; style: string };
    if (!memberId) {
        res.status(400).json({ error: '缺少 memberId 參數' });
        return;
    }

    const db = readDB();
    if (!db) {
        res.status(500).json({ error: '無法讀取資料庫' });
        return;
    }

    try {
        const member = db.members.find(m => m.id === memberId);
        if (!member) {
            res.status(404).json({ error: '找不到成員' });
            return;
        }

        const balances = calculateCurrentMonthBalances(db);
        const balance = balances.find(b => isMemberRecord(b, member));
        if (!balance) {
            res.status(400).json({ error: '找不到該成員的當月帳務摘要' });
            return;
        }

        const summary = {
            outstanding: balance.endingBalance,
            monthlyFee: balance.subscriptionFee,
            tempCharges: balance.tempCharge,
            paid: balance.paid
        };

        const memberSubs = db.subscriptions.filter(s => {
            return (s.memberId && s.memberId === member.id) || s.memberName === member.name;
        });
        const activeSubsText: string[] = [];

        if (isEntityBillableInMonth(member, db.currentMonth) && member.customFee != null) {
            activeSubsText.push(`  • 自訂費用小計: $${member.customFee}`);
        } else {
            memberSubs.forEach(sub => {
                const isSubActive = isSubActiveInMonth(sub, db.currentMonth);
                const platform = db.platforms.find(p => (sub.platformId && p.id === sub.platformId) || p.name === sub.platformName);
                const isPlatformBillable = platform ? isEntityBillableInMonth(platform, db.currentMonth) : false;
                const isMemberBillable = isEntityBillableInMonth(member, db.currentMonth);

                if (isSubActive && isPlatformBillable && isMemberBillable) {
                    const price = platform ? getPlatformPriceForMonth(db, { platformId: platform.id, platformName: platform.name }, db.currentMonth) : 0;
                    activeSubsText.push(`  • ${getSubscriptionDisplayName(sub)}: $${price}`);
                }
            });
        }

        if (activeSubsText.length === 0) {
            activeSubsText.push('  • 本期無訂閱項目');
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
        res.status(500).json({ error: (err as Error).message || '生成催帳訊息失敗' });
    }
});

app.post('/api/ai/chat', async (req: Request, res: Response) => {
    const { message, history } = req.body as { message: string; history: Record<string, unknown>[] };
    if (!message) {
        res.status(400).json({ error: '缺少 message 參數' });
        return;
    }

    const db = readDB();
    if (!db) {
        res.status(500).json({ error: '無法讀取資料庫' });
        return;
    }

    try {
        const result = await handleAssistantChat(db, message, (history || []) as unknown as AssistantMessage[]);
        res.json({
            success: true,
            reply: result.reply,
            history: result.history
        });
    } catch (err) {
        console.error('Error in chat route:', err);
        res.status(500).json({ error: (err as Error).message || 'AI 助理對話失敗' });
    }
});

app.post('/api/ai/rag-search', async (req: Request, res: Response) => {
    const { query, topK } = req.body as { query: string; topK: number };
    if (!query) {
        res.status(400).json({ error: '缺少 query 參數' });
        return;
    }

    const db = readDB();
    if (!db) {
        res.status(500).json({ error: '無法讀取資料庫' });
        return;
    }

    try {
        const results = await queryRAG(db, query, topK || 5);
        res.json({
            success: true,
            results: results
        });
    } catch (err) {
        console.error('Error in RAG search route:', err);
        res.status(500).json({ error: (err as Error).message || 'RAG 搜索失敗' });
    }
});

// ---------------------------------------------------------------------------
// Automation Routes (GenAI Demo)
// ---------------------------------------------------------------------------

/**
 * POST /api/automation/ingest
 * Body: { text: string, mode?: "auto" | "review" }
 * Returns: { applied, pending, rejected, parseErrors }
 *
 * AI parses the natural language text into structured proposals.
 * Only proposals with confidence >= 0.9 + passing deterministic checks
 * are auto-applied. All others go to pending (never silently dropped).
 */
app.post('/api/automation/ingest', async (req: Request, res: Response) => {
    const { text, mode } = req.body as { text?: string; mode?: string };
    if (!text || typeof text !== 'string' || !text.trim()) {
        res.status(400).json({ error: '缺少輸入文字' });
        return;
    }

    const db = readDB();
    if (!db) {
        res.status(500).json({ error: 'Database error' });
        return;
    }

    const apiKey = process.env.GOOGLE_GEMINI_API_KEY || '';
    try {
        const ingestMode = (mode === 'review' ? 'review' : 'auto') as 'auto' | 'review';
        const result = await parseAndClassifyProposals(text.trim(), db, apiKey, ingestMode);

        // If anything was auto-applied, persist to DB
        if (result.applied.length > 0) {
            if (!writeDB(db)) {
                res.status(500).json({ error: 'AI 解析成功但資料寫入失敗' });
                return;
            }
            invalidateRAGIndex();
        }

        // Store all proposals in the session inbox
        automationInbox.push(...result.applied, ...result.pending, ...result.rejected);

        res.json({
            success: true,
            applied: result.applied,
            pending: result.pending,
            rejected: result.rejected,
            parseErrors: result.parseErrors,
        });
    } catch (err) {
        console.error('[Automation] ingest error:', err);
        res.status(500).json({ error: (err as Error).message || 'AI 解析失敗' });
    }
});

/**
 * GET /api/automation/inbox
 * Returns all proposals stored in the session inbox.
 */
app.get('/api/automation/inbox', (req: Request, res: Response) => {
    res.json({ success: true, proposals: automationInbox });
});

/**
 * POST /api/automation/confirm/:id
 * Manually confirms a pending proposal → applies it to DB.
 */
app.post('/api/automation/confirm/:id', (req: Request, res: Response) => {
    const proposalId = req.params.id;
    const proposal = automationInbox.find(p => p.id === proposalId);

    if (!proposal) {
        res.status(404).json({ error: '找不到該 proposal' });
        return;
    }
    if (proposal.status !== 'pending') {
        res.status(409).json({ error: `Proposal 狀態為 ${proposal.status}，無法再確認` });
        return;
    }

    const db = readDB();
    if (!db) {
        res.status(500).json({ error: 'Database error' });
        return;
    }

    const applyResult = applyProposal(proposal, db);
    if (!applyResult.ok) {
        res.status(400).json({ error: applyResult.error || '套用失敗' });
        return;
    }

    proposal.status = 'applied';
    proposal.appliedAt = new Date().toISOString();
    proposal.ledgerEventId = applyResult.ledgerEventId;

    if (!writeDB(db)) {
        // Revert in-memory status on write failure
        proposal.status = 'pending';
        proposal.appliedAt = undefined;
        proposal.ledgerEventId = undefined;
        res.status(500).json({ error: '資料寫入失敗' });
        return;
    }
    invalidateRAGIndex();

    sendDB(res, db, { proposal });
});

/**
 * POST /api/automation/reject/:id
 * Manually rejects a pending proposal.
 */
app.post('/api/automation/reject/:id', (req: Request, res: Response) => {
    const proposalId = req.params.id;
    const proposal = automationInbox.find(p => p.id === proposalId);

    if (!proposal) {
        res.status(404).json({ error: '找不到該 proposal' });
        return;
    }
    if (proposal.status !== 'pending') {
        res.status(409).json({ error: `Proposal 狀態為 ${proposal.status}，無法拒絕` });
        return;
    }

    const { reason } = req.body as { reason?: string };
    proposal.status = 'rejected';
    proposal.rejectedAt = new Date().toISOString();
    proposal.rejectedBy = 'manual';
    proposal.rejectReason = reason || '使用者手動拒絕';

    res.json({ success: true, proposal });
});

app.post('/api/ai/chat-legacy', async (req: Request, res: Response) => {
    const { message, history } = req.body as { message: string; history: Record<string, unknown>[] };
    if (!message) {
        res.status(400).json({ error: '缺少 message 參數' });
        return;
    }

    const db = readDB();
    if (!db) {
        res.status(500).json({ error: '無法讀取資料庫' });
        return;
    }

    try {
        const result = await handleAssistantChat(db, message, (history || []) as unknown as AssistantMessage[]);
        res.json({
            success: true,
            reply: result.reply,
            history: result.history,
            isLegacy: true
        });
    } catch (err) {
        console.error('Error in legacy chat route:', err);
        res.status(500).json({ error: (err as Error).message || 'AI 助理對話失敗' });
    }
});

app.get(/.*/, (req: Request, res: Response) => {
    res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

app.listen(Number(PORT), HOST, () => {
    console.log(`Server is running on http://${HOST}:${PORT}`);
    console.log(`Data directory: ${DATA_DIR}`);
    if (HOST !== '0.0.0.0') return;

    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
        const net = nets[name];
        if (!net) continue;
        for (const addr of net) {
            if (addr.family === 'IPv4' && !addr.internal) {
                console.log(`手機或平板請連線同一個 Wi-Fi 並瀏覽：http://${addr.address}:${PORT}`);
            }
        }
    }
});
