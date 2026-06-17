/**
 * lib/lifecycle.ts
 *
 * Billing Period Lifecycle Engine
 *
 * Responsibilities:
 *   1. getSystemMonth()        — current YYYY/MM in Asia/Taipei
 *   2. executeMonthClose()     — deterministic single-month close (no "ready" gate)
 *   3. advanceMonthOnce()      — advance DB by one month if needed
 *   4. runLifecycleCatchUp()   — catch up from stale month to current
 *   5. getLifecycleStatus()    — read-only status snapshot
 *
 * Design constraints:
 *   - Does NOT call writeDB() or backup; caller handles persistence.
 *   - Does NOT block on unpaid balances (they roll forward as priorBalance).
 *   - DOES block on ledger / history integrity failures.
 *   - Idempotent: calling twice with the same db in the same month is a no-op.
 *   - Maximum 24 catchup iterations (safety cap).
 */

import type {
    Database,
    LifecycleMetadata,
    LifecycleStatus,
} from '../src/types/billing.js';
import {
    calculateCurrentMonthBalances,
    appendLedgerEvent,
    ensureHistorySeals,
    getHistoryIntegrity,
    monthToCode,
    getLedgerSummary,
    MONTH_RE,
} from './accounting.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LIFECYCLE_TIMEZONE = 'Asia/Taipei';
const MAX_CATCHUP_ITERATIONS = 24;

// ---------------------------------------------------------------------------
// 1. getSystemMonth — current YYYY/MM in given timezone
// ---------------------------------------------------------------------------

export function getSystemMonth(timezone: string = LIFECYCLE_TIMEZONE): string {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
    });
    // en-CA gives ISO-like "YYYY-MM" format, e.g. "2026-07"
    const parts = formatter.formatToParts(now);
    const year = parts.find(p => p.type === 'year')?.value || '';
    const month = parts.find(p => p.type === 'month')?.value || '';
    return `${year}/${month}`;
}

// ---------------------------------------------------------------------------
// 2. ensureLifecycleMeta — initialises lifecycle field if missing
// ---------------------------------------------------------------------------

function ensureLifecycleMeta(db: Database): LifecycleMetadata {
    if (!db.lifecycle || typeof db.lifecycle !== 'object') {
        db.lifecycle = {
            timezone: LIFECYCLE_TIMEZONE,
            autoAdvanceEnabled: true,
            lastCheckedAt: null,
            lastAdvancedAt: null,
            lastAdvancedFrom: null,
            lastAdvancedTo: null,
        };
    }
    return db.lifecycle;
}

// ---------------------------------------------------------------------------
// 3. executeMonthClose — close current month, advance to next
//    (extracted from POST /api/settle, without the "ready" gate check)
// ---------------------------------------------------------------------------

export interface MonthCloseResult {
    closedMonth: string;
    nextMonth: string;
    memberCount: number;
    advancedAt: string;
}

export function executeMonthClose(db: Database): MonthCloseResult {
    const currentMonth = db.currentMonth;
    const [year, month] = currentMonth.split('/').map(Number);

    // Calculate balances and update members' priorBalance
    const balancesReport = calculateCurrentMonthBalances(db);
    db.members = db.members.map(m => {
        const balance = balancesReport.find(
            b => (b.memberId && b.memberId === m.id) || b.memberName === m.name
        );
        return {
            ...m,
            priorBalance: balance ? balance.endingBalance : m.priorBalance,
        };
    });

    // Seal history entry for this month
    const newHistoryEntry = {
        month: currentMonth,
        balances: balancesReport,
        payments: [...db.payments],
        tempCharges: [...db.tempCharges],
    };
    db.history.push(newHistoryEntry);

    const advancedAt = new Date().toISOString();
    ensureHistorySeals(db, { sealedAt: advancedAt, reason: 'month.auto-advanced' });

    // Advance to next month
    let nextYear = year;
    let nextMonth = month + 1;
    if (nextMonth > 12) {
        nextMonth = 1;
        nextYear += 1;
    }
    const nextMonthStr = `${nextYear}/${String(nextMonth).padStart(2, '0')}`;

    // Clear current-period transactions
    db.currentMonth = nextMonthStr;
    db.payments = [];
    db.tempCharges = [];

    // Ledger event
    appendLedgerEvent(db, {
        type: 'month.auto-advanced',
        summary: `自動封存 ${currentMonth} 並推進到 ${nextMonthStr}`,
        entityType: 'settlement',
        entityId: currentMonth,
        amount: balancesReport.reduce((sum, b) => sum + b.endingBalance, 0),
        month: nextMonthStr,
        payload: {
            settledMonth: currentMonth,
            nextMonth: nextMonthStr,
            balancesCount: balancesReport.length,
            trigger: 'auto-lifecycle',
        },
    });

    return {
        closedMonth: currentMonth,
        nextMonth: nextMonthStr,
        memberCount: balancesReport.length,
        advancedAt,
    };
}

// ---------------------------------------------------------------------------
// 4. advanceMonthOnce — advance by one month (with integrity checks)
// ---------------------------------------------------------------------------

export interface AdvanceResult {
    advanced: boolean;
    from?: string;
    to?: string;
    blocked: boolean;
    blockedReason?: string;
    alreadyCurrent?: boolean;
}

export function advanceMonthOnce(db: Database, systemMonth: string): AdvanceResult {
    const meta = ensureLifecycleMeta(db);
    meta.lastCheckedAt = new Date().toISOString();

    const dbCode = monthToCode(db.currentMonth);
    const sysCode = monthToCode(systemMonth);

    // Safety: db month is not a valid YYYY/MM
    if (dbCode === null) {
        return { advanced: false, blocked: true, blockedReason: `db.currentMonth 格式錯誤：${db.currentMonth}` };
    }
    if (sysCode === null) {
        return { advanced: false, blocked: true, blockedReason: `systemMonth 格式錯誤：${systemMonth}` };
    }

    // Already at current or ahead — no-op
    if (dbCode >= sysCode) {
        return { advanced: false, blocked: false, alreadyCurrent: true };
    }

    // Check if target month is already in history (idempotency guard)
    const currentMonthInHistory = db.history.some(h => h.month === db.currentMonth);
    if (currentMonthInHistory) {
        return {
            advanced: false,
            blocked: true,
            blockedReason: `帳期 ${db.currentMonth} 已存在於歷史封存，疑似重複推進`,
        };
    }

    // Integrity checks (only these block auto-advance)
    const ledgerStatus = getLedgerSummary(db);
    if (!ledgerStatus.ok) {
        return {
            advanced: false,
            blocked: true,
            blockedReason: `Ledger 完整性失敗：${(ledgerStatus.problems || []).join(', ')}`,
        };
    }

    const historyIntegrity = getHistoryIntegrity(db);
    if (!historyIntegrity.ok) {
        const criticalProblems = historyIntegrity.problems
            .filter(p => p.severity === 'critical')
            .map(p => p.detail)
            .join('; ');
        return {
            advanced: false,
            blocked: true,
            blockedReason: `歷史封存完整性失敗：${criticalProblems}`,
        };
    }

    // Execute the close
    const fromMonth = db.currentMonth;
    const result = executeMonthClose(db);

    // Update lifecycle metadata
    meta.lastAdvancedAt = result.advancedAt;
    meta.lastAdvancedFrom = fromMonth;
    meta.lastAdvancedTo = result.nextMonth;

    return {
        advanced: true,
        from: fromMonth,
        to: result.nextMonth,
        blocked: false,
    };
}

// ---------------------------------------------------------------------------
// 5. runLifecycleCatchUp — advance until current or blocked
// ---------------------------------------------------------------------------

export function runLifecycleCatchUp(
    db: Database,
    timezone: string = LIFECYCLE_TIMEZONE
): AdvanceResult[] {
    const systemMonth = getSystemMonth(timezone);
    const results: AdvanceResult[] = [];

    for (let i = 0; i < MAX_CATCHUP_ITERATIONS; i++) {
        const result = advanceMonthOnce(db, systemMonth);
        results.push(result);

        // Stop if no advance happened (already current, blocked, or error)
        if (!result.advanced) break;
    }

    return results;
}

// ---------------------------------------------------------------------------
// 6. getLifecycleStatus — read-only status snapshot
// ---------------------------------------------------------------------------

export function getLifecycleStatus(db: Database, timezone: string = LIFECYCLE_TIMEZONE): LifecycleStatus {
    const meta = db.lifecycle;
    const systemMonth = getSystemMonth(timezone);
    const dbCode = monthToCode(db.currentMonth);
    const sysCode = monthToCode(systemMonth);

    let blockedReason: string | null = null;

    // Check what would block advance right now
    if (dbCode !== null && sysCode !== null && dbCode < sysCode) {
        // DB is behind — check if we're blocked
        const ledgerStatus = getLedgerSummary(db);
        if (!ledgerStatus.ok) {
            blockedReason = `Ledger 完整性失敗：${(ledgerStatus.problems || []).join(', ')}`;
        } else {
            const historyIntegrity = getHistoryIntegrity(db);
            if (!historyIntegrity.ok) {
                blockedReason = `歷史封存完整性失敗`;
            } else if (db.history.some(h => h.month === db.currentMonth)) {
                blockedReason = `帳期 ${db.currentMonth} 已存在於歷史封存`;
            }
        }
    }

    return {
        currentMonth: db.currentMonth,
        systemMonth,
        isCurrent: MONTH_RE.test(db.currentMonth) && MONTH_RE.test(systemMonth) && db.currentMonth === systemMonth,
        timezone,
        lastAdvancedAt: meta?.lastAdvancedAt ?? null,
        lastAdvancedFrom: meta?.lastAdvancedFrom ?? null,
        lastAdvancedTo: meta?.lastAdvancedTo ?? null,
        blockedReason,
    };
}
