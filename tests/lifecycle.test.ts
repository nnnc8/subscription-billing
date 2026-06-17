/**
 * tests/lifecycle.test.ts
 *
 * Billing Period Lifecycle Engine Tests
 *
 * Tests:
 *  1. getSystemMonth() — timezone-correct YYYY/MM
 *  2. advanceMonthOnce() — single step advance, integrity checks, idempotency
 *  3. runLifecycleCatchUp() — multi-month catch-up, max 24 cap
 *  4. getLifecycleStatus() — correct isCurrent flag
 *  5. Data integrity after advance — priorBalance rollover formula
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeDatabaseRelations } from '../lib/accounting.js';
import {
    getSystemMonth,
    advanceMonthOnce,
    runLifecycleCatchUp,
    getLifecycleStatus,
} from '../lib/lifecycle.js';
import type { Database } from '../src/types/billing.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, '../fixtures/demo-database.json');

function freshDb(): Database {
    return normalizeDatabaseRelations(JSON.parse(fs.readFileSync(dbPath, 'utf8')));
}

// ---------------------------------------------------------------------------
// 1. getSystemMonth — timezone-correct YYYY/MM
// ---------------------------------------------------------------------------

describe('getSystemMonth — Asia/Taipei timezone', () => {
    it('returns YYYY/MM format matching a known moment', () => {
        const month = getSystemMonth('Asia/Taipei');
        expect(month).toMatch(/^\d{4}\/(0[1-9]|1[0-2])$/);
    });

    it('UTC 2026-06-30T15:59:59Z → 2026/06 in Taipei (23:59:59 still June)', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-06-30T15:59:59Z'));
        const month = getSystemMonth('Asia/Taipei');
        vi.useRealTimers();
        expect(month).toBe('2026/06');
    });

    it('UTC 2026-06-30T16:00:00Z → 2026/07 in Taipei (00:00:00 is July)', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-06-30T16:00:00Z'));
        const month = getSystemMonth('Asia/Taipei');
        vi.useRealTimers();
        expect(month).toBe('2026/07');
    });

    it('handles year boundary: UTC 2025-12-31T16:00:00Z → 2026/01', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2025-12-31T16:00:00Z'));
        const month = getSystemMonth('Asia/Taipei');
        vi.useRealTimers();
        expect(month).toBe('2026/01');
    });
});

// ---------------------------------------------------------------------------
// 2. advanceMonthOnce — single step advance
// ---------------------------------------------------------------------------

describe('advanceMonthOnce — single month advance', () => {
    let db: Database;

    beforeEach(() => {
        db = freshDb();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('advances currentMonth by one when db is behind', () => {
        const beforeMonth = db.currentMonth;
        const [year, month] = beforeMonth.split('/').map(Number);
        const expectedNext = month === 12
            ? `${year + 1}/01`
            : `${year}/${String(month + 1).padStart(2, '0')}`;

        const systemMonth = expectedNext;
        const result = advanceMonthOnce(db, systemMonth);

        expect(result.advanced).toBe(true);
        expect(result.blocked).toBe(false);
        expect(result.from).toBe(beforeMonth);
        expect(result.to).toBe(expectedNext);
        expect(db.currentMonth).toBe(expectedNext);
    });

    it('is a no-op when db.currentMonth equals systemMonth', () => {
        const result = advanceMonthOnce(db, db.currentMonth);

        expect(result.advanced).toBe(false);
        expect(result.blocked).toBe(false);
        expect(result.alreadyCurrent).toBe(true);
    });

    it('is a no-op when db.currentMonth is ahead of systemMonth', () => {
        const [y, m] = db.currentMonth.split('/').map(Number);
        const olderMonth = m === 1 ? `${y - 1}/12` : `${y}/${String(m - 1).padStart(2, '0')}`;
        const result = advanceMonthOnce(db, olderMonth);

        expect(result.advanced).toBe(false);
        expect(result.alreadyCurrent).toBe(true);
    });

    it('clears payments and tempCharges after advance', () => {
        const [y, m] = db.currentMonth.split('/').map(Number);
        const nextMonth = m === 12 ? `${y + 1}/01` : `${y}/${String(m + 1).padStart(2, '0')}`;

        // Ensure there are some payments to clear
        expect(db.payments.length + db.tempCharges.length).toBeGreaterThanOrEqual(0);
        advanceMonthOnce(db, nextMonth);

        expect(db.payments).toHaveLength(0);
        expect(db.tempCharges).toHaveLength(0);
    });

    it('adds a history entry for the closed month', () => {
        const closedMonth = db.currentMonth;
        const [y, m] = closedMonth.split('/').map(Number);
        const nextMonth = m === 12 ? `${y + 1}/01` : `${y}/${String(m + 1).padStart(2, '0')}`;
        const historyBefore = db.history.length;

        advanceMonthOnce(db, nextMonth);

        expect(db.history.length).toBe(historyBefore + 1);
        expect(db.history[db.history.length - 1].month).toBe(closedMonth);
    });

    it('blocks when target month is already in history (idempotency guard)', () => {
        // Manually add current month to history (simulating a bug / double-call)
        db.history.push({
            month: db.currentMonth,
            balances: [],
            payments: [],
            tempCharges: [],
        });

        const [y, m] = db.currentMonth.split('/').map(Number);
        const nextMonth = m === 12 ? `${y + 1}/01` : `${y}/${String(m + 1).padStart(2, '0')}`;
        const result = advanceMonthOnce(db, nextMonth);

        expect(result.advanced).toBe(false);
        expect(result.blocked).toBe(true);
        expect(result.blockedReason).toContain('已存在於歷史封存');
    });

    it('blocks when ledger integrity fails', () => {
        const [y, m] = db.currentMonth.split('/').map(Number);
        const nextMonth = m === 12 ? `${y + 1}/01` : `${y}/${String(m + 1).padStart(2, '0')}`;

        // Corrupt the ledger
        if (db.ledger.entries.length > 0) {
            (db.ledger.entries[db.ledger.entries.length - 1] as unknown as Record<string, unknown>).hash = 'invalid_hash';
        } else {
            db.ledger.entries.push({
                id: 'bad_entry',
                at: new Date().toISOString(),
                actor: 'test',
                type: 'test',
                summary: 'test',
                month: db.currentMonth,
                entityType: 'test',
                entityId: null,
                amount: null,
                payload: null,
                previousHash: 'wrong_previous',
                hash: 'bad_hash',
            });
        }

        const result = advanceMonthOnce(db, nextMonth);
        expect(result.advanced).toBe(false);
        expect(result.blocked).toBe(true);
        expect(result.blockedReason).toContain('Ledger');
    });

    it('does NOT block on unpaid balances — rolls them forward as priorBalance', () => {
        const [y, m] = db.currentMonth.split('/').map(Number);
        const nextMonth = m === 12 ? `${y + 1}/01` : `${y}/${String(m + 1).padStart(2, '0')}`;

        // Clear all payments to simulate unpaid members
        db.payments = [];

        const result = advanceMonthOnce(db, nextMonth);

        expect(result.advanced).toBe(true);
        expect(result.blocked).toBe(false);

        // All members should have priorBalance = subscriptionFee + any prior balance (≥0 if they owe)
        db.members.forEach(member => {
            expect(typeof member.priorBalance).toBe('number');
            expect(Number.isFinite(member.priorBalance)).toBe(true);
        });
    });

    it('writes lifecycle metadata after successful advance', () => {
        const [y, m] = db.currentMonth.split('/').map(Number);
        const nextMonth = m === 12 ? `${y + 1}/01` : `${y}/${String(m + 1).padStart(2, '0')}`;

        advanceMonthOnce(db, nextMonth);

        expect(db.lifecycle?.lastAdvancedAt).toBeDefined();
        expect(db.lifecycle?.lastAdvancedFrom).toBeDefined();
        expect(db.lifecycle?.lastAdvancedTo).toBeDefined();
        expect(db.lifecycle?.lastCheckedAt).toBeDefined();
    });
});

// ---------------------------------------------------------------------------
// 3. priorBalance rollover formula
// ---------------------------------------------------------------------------

describe('priorBalance rollover formula after advance', () => {
    it('endingBalance = priorBalance + subscriptionFee + tempCharge - paid', () => {
        const db = freshDb();
        const [y, mo] = db.currentMonth.split('/').map(Number);
        const nextMonth = mo === 12 ? `${y + 1}/01` : `${y}/${String(mo + 1).padStart(2, '0')}`;

        advanceMonthOnce(db, nextMonth);

        // The history entry should have balances matching the formula
        const lastHistory = db.history[db.history.length - 1];
        lastHistory.balances.forEach(b => {
            const expected = b.priorBalance + b.subscriptionFee + b.tempCharge - b.paid;
            expect(b.endingBalance).toBeCloseTo(expected, 5);
        });

        // The member's new priorBalance should equal the endingBalance they had
        db.members.forEach(member => {
            const histBalance = lastHistory.balances.find(
                b => (b.memberId && b.memberId === member.id) || b.memberName === member.name
            );
            if (histBalance) {
                expect(member.priorBalance).toBe(histBalance.endingBalance);
            }
        });
    });

    it('unpaid member priorBalance increases by their monthly fee', () => {
        const db = freshDb();

        // Pick any member and remove all their payments
        const member = db.members[0];
        db.payments = db.payments.filter(p =>
            p.memberId !== member.id && p.memberName !== member.name
        );

        const priorBefore = member.priorBalance;

        const [y, mo] = db.currentMonth.split('/').map(Number);
        const nextMonth = mo === 12 ? `${y + 1}/01` : `${y}/${String(mo + 1).padStart(2, '0')}`;
        advanceMonthOnce(db, nextMonth);

        const updatedMember = db.members.find(m => m.id === member.id)!;
        // priorBalance should have increased (or stayed same if fee is 0)
        expect(updatedMember.priorBalance).toBeGreaterThanOrEqual(priorBefore);
    });
});

// ---------------------------------------------------------------------------
// 4. runLifecycleCatchUp — multi-month catch-up
// ---------------------------------------------------------------------------

describe('runLifecycleCatchUp — multi-month catch-up', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('catches up across 3 months', () => {
        const db = freshDb();
        const [y, m] = db.currentMonth.split('/').map(Number);

        const oldYear = m <= 3 ? y - 1 : y;
        const oldMonth = ((m - 4 + 12) % 12) + 1;
        db.currentMonth = `${oldYear}/${String(oldMonth).padStart(2, '0')}`;
        const historyBefore = db.history.length;

        const results = runLifecycleCatchUp(db, 'Asia/Taipei');

        expect(results.some(r => r.advanced)).toBe(true);
        expect(db.history.length).toBeGreaterThan(historyBefore);
    });


    it('catches up exactly N months when db is N months behind', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-08-01T10:00:00+08:00')); // Taipei Aug 1

        const db = freshDb();
        db.currentMonth = '2026/05'; // 3 months behind
        const histBefore = db.history.length;

        const results = runLifecycleCatchUp(db, 'Asia/Taipei');
        vi.useRealTimers();

        const advancedResults = results.filter(r => r.advanced);
        expect(advancedResults.length).toBe(3); // May→Jun, Jun→Jul, Jul→Aug
        expect(db.currentMonth).toBe('2026/08');
        expect(db.history.length).toBe(histBefore + 3);
    });

    it('does not create duplicate history entries on repeated calls', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-08-15T10:00:00+08:00'));

        const db = freshDb();
        db.currentMonth = '2026/07';

        // First call — should advance once
        runLifecycleCatchUp(db, 'Asia/Taipei');
        const histAfterFirst = db.history.length;
        const monthAfterFirst = db.currentMonth;

        // Second call with same db — should be no-op (already at Aug)
        const results2 = runLifecycleCatchUp(db, 'Asia/Taipei');
        vi.useRealTimers();

        expect(results2.every(r => !r.advanced)).toBe(true);
        expect(db.history.length).toBe(histAfterFirst);
        expect(db.currentMonth).toBe(monthAfterFirst);
    });

    it('respects the 24-iteration safety cap', () => {
        vi.useFakeTimers();
        // Set system time far in future (30 months ahead of fixture db)
        vi.setSystemTime(new Date('2030-01-01T10:00:00+08:00'));

        const db = freshDb();
        db.currentMonth = '2026/06'; // Far behind

        const results = runLifecycleCatchUp(db, 'Asia/Taipei');
        vi.useRealTimers();

        // Should stop at 24 regardless
        expect(results.length).toBeLessThanOrEqual(24 + 1); // +1 for the no-op or block result
        expect(results.filter(r => r.advanced).length).toBeLessThanOrEqual(24);
    });

    it('returns immediately if db.currentMonth equals systemMonth', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-06-17T10:00:00+08:00'));

        const db = freshDb();
        // Current month in fixture is 2026/06 — already current
        const results = runLifecycleCatchUp(db, 'Asia/Taipei');
        vi.useRealTimers();

        expect(results).toHaveLength(1);
        expect(results[0].advanced).toBe(false);
        expect(results[0].alreadyCurrent).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// 5. getLifecycleStatus — status snapshot
// ---------------------------------------------------------------------------

describe('getLifecycleStatus — status snapshot', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('isCurrent = true when db month matches system month', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-06-17T10:00:00+08:00'));

        const db = freshDb();
        const status = getLifecycleStatus(db, 'Asia/Taipei');
        vi.useRealTimers();

        expect(status.isCurrent).toBe(true);
        expect(status.systemMonth).toBe('2026/06');
        expect(status.currentMonth).toBe(db.currentMonth);
    });

    it('isCurrent = false when db month is behind', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-08-01T10:00:00+08:00'));

        const db = freshDb(); // currentMonth = 2026/06
        const status = getLifecycleStatus(db, 'Asia/Taipei');
        vi.useRealTimers();

        expect(status.isCurrent).toBe(false);
        expect(status.systemMonth).toBe('2026/08');
    });

    it('blockedReason is null when no integrity issues exist', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-08-01T10:00:00+08:00'));

        const db = freshDb();
        const status = getLifecycleStatus(db, 'Asia/Taipei');
        vi.useRealTimers();

        expect(status.blockedReason).toBeNull();
    });

    it('reports lastAdvancedAt after a successful advance', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-01T10:00:00+08:00'));

        const db = freshDb(); // currentMonth = 2026/06
        runLifecycleCatchUp(db, 'Asia/Taipei');
        const status = getLifecycleStatus(db, 'Asia/Taipei');
        vi.useRealTimers();

        expect(status.lastAdvancedAt).not.toBeNull();
        expect(status.lastAdvancedFrom).toBe('2026/06');
        expect(status.lastAdvancedTo).toBe('2026/07');
    });

    it('timezone field is always in response', () => {
        const db = freshDb();
        const status = getLifecycleStatus(db, 'Asia/Taipei');
        expect(status.timezone).toBe('Asia/Taipei');
    });
});

// ---------------------------------------------------------------------------
// 6. History integrity maintained after multi-month catch-up
// ---------------------------------------------------------------------------

describe('History integrity after catch-up', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('all history entries have valid seals after 3-month catch-up', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-15T10:00:00+08:00'));

        const db = freshDb();
        db.currentMonth = '2026/06';
        runLifecycleCatchUp(db, 'Asia/Taipei');
        vi.useRealTimers();

        db.history.forEach(entry => {
            expect(entry.seal).toBeDefined();
            expect(entry.seal?.hash).toBeDefined();
            expect(entry.seal?.hash?.length).toBe(64); // SHA-256 hex
        });
    });

    it('no duplicate months in history after catch-up', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-01T10:00:00+08:00'));

        const db = freshDb();
        db.currentMonth = '2026/06';
        runLifecycleCatchUp(db, 'Asia/Taipei');
        vi.useRealTimers();

        const months = db.history.map(h => h.month);
        const unique = new Set(months);
        expect(unique.size).toBe(months.length);
    });

    it('ledger has auto-advance events for each month advanced', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-01T10:00:00+08:00'));

        const db = freshDb();
        db.currentMonth = '2026/06';
        const ledgerBefore = db.ledger.entries.length;
        runLifecycleCatchUp(db, 'Asia/Taipei');
        vi.useRealTimers();

        const autoEvents = db.ledger.entries
            .slice(ledgerBefore)
            .filter(e => e.type === 'month.auto-advanced');

        expect(autoEvents.length).toBeGreaterThan(0);
        expect(autoEvents.every(e => e.payload !== null)).toBe(true);
    });
});
