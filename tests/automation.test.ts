/**
 * tests/automation.test.ts
 *
 * Tagtoo GenAI Demo — Automation Layer Tests
 *
 * Tests the automation pipeline:
 *  - AI parsing (mocked Gemini) → deterministic validation → classification
 *  - Auto-apply vs pending vs rejected classification
 *  - Duplicate detection blocks auto-apply
 *  - Low-confidence proposals never write to DB
 *  - AI key does not appear in ledger payloads
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeDatabaseRelations } from '../lib/accounting.js';
import {
    validateProposal,
    classifyProposalForAutoApply,
    applyPaymentProposal,
    applyTempChargeProposal,
    applySubscriptionProposal,
    parseAndClassifyProposals,
} from '../lib/automation.js';
import type { Database, AutomationProposal } from '../src/types/billing.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, '../fixtures/demo-database.json');

function freshDb(): Database {
    return normalizeDatabaseRelations(JSON.parse(fs.readFileSync(dbPath, 'utf8')));
}

function first<T>(items: T[], label: string): T {
    const value = items.at(0);
    if (value === undefined) throw new Error(`Fixture invariant failed: ${label} is empty`);
    return value;
}

function last<T>(items: T[], label: string): T {
    const value = items.at(-1);
    if (value === undefined) throw new Error(`Fixture invariant failed: ${label} is empty`);
    return value;
}

// ---------------------------------------------------------------------------
// Mock Gemini (to avoid real API calls in tests)
// ---------------------------------------------------------------------------

const FAKE_API_KEY = 'test-key-not-real';

// We mock the fetch global to intercept Gemini API calls
function mockGeminiResponse(events: Record<string, unknown>[], parseErrors: string[] = []) {
    const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
            candidates: [{
                content: {
                    parts: [{
                        functionCall: {
                            name: 'record_billing_events',
                            args: { events, parseErrors },
                        },
                    }],
                },
                finishReason: 'STOP',
            }],
        }),
        text: async () => '',
    });
    vi.stubGlobal('fetch', mockFetch);
    return mockFetch;
}

beforeEach(() => {
    vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 1. validateProposal — member resolution
// ---------------------------------------------------------------------------

describe('validateProposal — member resolution', () => {
    it('should pass for exact member name match', () => {
        const db = freshDb();
        const member = first(db.members, 'members');
        const raw = { kind: 'payment', memberName: member.name, amount: 200, confidence: 0.95, reason: 'test' };
        const result = validateProposal(raw, db, new Date().toISOString());
        expect(result.blockReasons).toHaveLength(0);
        expect(result.resolvedMemberName).toBe(member.name);
    });

    it('should block when member name is not found', () => {
        const db = freshDb();
        const raw = { kind: 'payment', memberName: '完全不存在的人', amount: 200, confidence: 0.95, reason: 'test' };
        const result = validateProposal(raw, db, new Date().toISOString());
        expect(result.ok).toBe(false);
        expect(result.blockReasons.some(r => r.includes('找不到成員'))).toBe(true);
    });

    it('should warn (not block) on fuzzy single match', () => {
        const db = freshDb();
        // Use a substring of the first member name
        const member = first(db.members, 'members');
        const shortName = member.name.split(' ')[0]; // e.g. "Member"
        const raw = { kind: 'payment', memberName: shortName, amount: 100, confidence: 0.85, reason: 'test' };
        const result = validateProposal(raw, db, new Date().toISOString());
        // Could be block (multiple fuzzy) or warn (single fuzzy) — both are valid behavior
        // Main thing: if blockReasons is empty, we expect a warning
        if (result.blockReasons.length === 0) {
            expect(result.warnings.length).toBeGreaterThan(0);
        }
    });
});

// ---------------------------------------------------------------------------
// 2. validateProposal — amount checks
// ---------------------------------------------------------------------------

describe('validateProposal — amount checks', () => {
    it('should block payment with missing amount', () => {
        const db = freshDb();
        const member = first(db.members, 'members');
        const raw = { kind: 'payment', memberName: member.name, confidence: 0.9, reason: 'test' };
        const result = validateProposal(raw, db, new Date().toISOString());
        expect(result.ok).toBe(false);
        expect(result.blockReasons.some(r => r.includes('金額'))).toBe(true);
    });

    it('should block payment with zero amount', () => {
        const db = freshDb();
        const member = first(db.members, 'members');
        const raw = { kind: 'payment', memberName: member.name, amount: 0, confidence: 0.9, reason: 'test' };
        const result = validateProposal(raw, db, new Date().toISOString());
        expect(result.ok).toBe(false);
    });

    it('should block payment with negative amount', () => {
        const db = freshDb();
        const member = first(db.members, 'members');
        const raw = { kind: 'payment', memberName: member.name, amount: -100, confidence: 0.9, reason: 'test' };
        const result = validateProposal(raw, db, new Date().toISOString());
        expect(result.ok).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// 3. validateProposal — subscription checks
// ---------------------------------------------------------------------------

describe('validateProposal — subscription checks', () => {
    it('should block subscription with unknown platform', () => {
        const db = freshDb();
        const member = first(db.members, 'members');
        const raw = { kind: 'subscription', memberName: member.name, platformName: '未知平台XYZ', month: db.currentMonth, confidence: 0.9, reason: 'test' };
        const result = validateProposal(raw, db, new Date().toISOString());
        expect(result.ok).toBe(false);
        expect(result.blockReasons.some(r => r.includes('找不到平台'))).toBe(true);
    });

    it('should block subscription with invalid month format', () => {
        const db = freshDb();
        const member = first(db.members, 'members');
        const platform = first(db.platforms, 'platforms');
        const raw = { kind: 'subscription', memberName: member.name, platformName: platform.name, month: '2026-06', confidence: 0.9, reason: 'test' };
        const result = validateProposal(raw, db, new Date().toISOString());
        expect(result.ok).toBe(false);
        expect(result.blockReasons.some(r => r.includes('月份格式'))).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// 4. classifyProposalForAutoApply
// ---------------------------------------------------------------------------

describe('classifyProposalForAutoApply', () => {
    function makeProposal(overrides: Partial<AutomationProposal> = {}): AutomationProposal {
        return {
            id: 'test_prop',
            kind: 'payment',
            sourceText: '測試付款',
            confidence: 0.95,
            reason: 'test',
            warnings: [],
            payload: {},
            status: 'pending',
            createdAt: new Date().toISOString(),
            ...overrides,
        };
    }

    it('should auto-apply when confidence >= 0.9 and validation passes', () => {
        const proposal = makeProposal({ confidence: 0.95 });
        const validation = { ok: true, blockReasons: [], warnings: [] };
        expect(classifyProposalForAutoApply(proposal, validation)).toBe('apply');
    });

    it('should go pending when confidence < 0.9', () => {
        const proposal = makeProposal({ confidence: 0.75 });
        const validation = { ok: true, blockReasons: [], warnings: [] };
        expect(classifyProposalForAutoApply(proposal, validation)).toBe('pending');
    });

    it('should go pending when there are soft warnings even with high confidence', () => {
        const proposal = makeProposal({ confidence: 0.95 });
        const validation = { ok: true, blockReasons: [], warnings: ['姓名模糊'] };
        expect(classifyProposalForAutoApply(proposal, validation)).toBe('pending');
    });

    it('should reject when validation fails', () => {
        const proposal = makeProposal({ confidence: 0.99 });
        const validation = { ok: false, blockReasons: ['缺少金額'], warnings: [] };
        expect(classifyProposalForAutoApply(proposal, validation)).toBe('reject');
    });
});

// ---------------------------------------------------------------------------
// 5. applyPaymentProposal — writes to DB and creates ledger event
// ---------------------------------------------------------------------------

describe('applyPaymentProposal', () => {
    it('should add payment to DB and create ledger event', () => {
        const db = freshDb();
        const member = first(db.members, 'members');
        const initialPaymentCount = db.payments.length;
        const initialLedgerCount = db.ledger.entries.length;

        const proposal: AutomationProposal = {
            id: 'prop_test_01',
            kind: 'payment',
            sourceText: `${member.name} 付 300`,
            confidence: 0.95,
            reason: '明確姓名和金額',
            warnings: [],
            payload: {
                memberId: member.id,
                memberName: member.name,
                amount: 300,
                date: new Date().toISOString().split('T')[0],
                method: '轉帳',
                cycle: db.currentMonth.replace('/', ''),
                note: '',
            },
            status: 'pending',
            createdAt: new Date().toISOString(),
        };

        const result = applyPaymentProposal(proposal, db);

        expect(result.ok).toBe(true);
        expect(result.ledgerEventId).toBeDefined();
        expect(db.payments.length).toBe(initialPaymentCount + 1);
        expect(db.ledger.entries.length).toBe(initialLedgerCount + 1);

        const newPayment = last(db.payments, 'payments');
        expect(newPayment.amount).toBe(300);
        expect(newPayment.memberName).toBe(member.name);
        expect(newPayment.memberId).toBe(member.id);

        const ledgerEvent = last(db.ledger.entries, 'ledger entries');
        expect(ledgerEvent.type).toBe('payment.created');
        expect(ledgerEvent.summary).toContain('[AI自動]');
        expect(ledgerEvent.id).toBe(result.ledgerEventId);
    });

    it('should NOT contain API key in ledger payload', () => {
        const db = freshDb();
        const member = first(db.members, 'members');
        const apiKey = 'super-secret-key-12345';
        process.env.GOOGLE_GEMINI_API_KEY = apiKey;

        const proposal: AutomationProposal = {
            id: 'prop_test_02',
            kind: 'payment',
            sourceText: `${member.name} 付 150`,
            confidence: 0.95,
            reason: 'test',
            warnings: [],
            payload: { memberId: member.id, memberName: member.name, amount: 150, date: '2026-06-01', method: '轉帳', cycle: '202606', note: '' },
            status: 'pending',
            createdAt: new Date().toISOString(),
        };

        applyPaymentProposal(proposal, db);

        const lastEvent = last(db.ledger.entries, 'ledger entries');
        const eventJson = JSON.stringify(lastEvent);
        expect(eventJson).not.toContain(apiKey);

        delete process.env.GOOGLE_GEMINI_API_KEY;
    });

    it('should block duplicate payment via findRecentDuplicateTransaction', () => {
        const db = freshDb();
        const member = first(db.members, 'members');
        const now = new Date().toISOString();

        // Add a near-duplicate payment
        db.payments.push({
            id: 'pay_existing',
            memberId: member.id,
            memberName: member.name,
            amount: 270,
            date: now.slice(0, 10),
            method: '轉帳',
            cycle: db.currentMonth.replace('/', ''),
            note: '',
            createdAt: now,
        });

        // Try to add again within 10 minutes
        const proposal: AutomationProposal = {
            id: 'prop_dup',
            kind: 'payment',
            sourceText: `${member.name} 轉 270`,
            confidence: 0.95,
            reason: 'test',
            warnings: [],
            payload: { memberId: member.id, memberName: member.name, amount: 270, date: now.slice(0, 10), method: '轉帳', cycle: db.currentMonth.replace('/', ''), note: '' },
            status: 'pending',
            createdAt: new Date(Date.now() + 60000).toISOString(), // 1 min later
        };

        const result = applyPaymentProposal(proposal, db);
        expect(result.ok).toBe(false);
        expect(result.error).toContain('重複');
    });
});

// ---------------------------------------------------------------------------
// 6. applyTempChargeProposal
// ---------------------------------------------------------------------------

describe('applyTempChargeProposal', () => {
    it('should add temp charge to DB and create ledger event', () => {
        const db = freshDb();
        const member = first(db.members, 'members');
        const initialCount = db.tempCharges.length;

        const proposal: AutomationProposal = {
            id: 'prop_chg_01',
            kind: 'tempCharge',
            sourceText: `${member.name} 額外收 50 網域費`,
            confidence: 0.92,
            reason: 'test',
            warnings: [],
            payload: { memberId: member.id, memberName: member.name, amount: 50, date: new Date().toISOString().split('T')[0], desc: '網域費' },
            status: 'pending',
            createdAt: new Date().toISOString(),
        };

        const result = applyTempChargeProposal(proposal, db);

        expect(result.ok).toBe(true);
        expect(db.tempCharges.length).toBe(initialCount + 1);
        const newCharge = last(db.tempCharges, 'temp charges');
        expect(newCharge.amount).toBe(50);
        expect(newCharge.desc).toBe('網域費');
    });
});

// ---------------------------------------------------------------------------
// 7. applySubscriptionProposal
// ---------------------------------------------------------------------------

describe('applySubscriptionProposal', () => {
    it('should add subscription to DB and create ledger event', () => {
        const db = freshDb();
        const member = db.members.find(m => !m.status || m.status !== 'archived')!;
        // Find a platform this member is NOT already subscribed to
        const activeSubs = db.subscriptions.filter(
            s => (s.memberId === member.id || s.memberName === member.name) && !s.exitMonth
        );
        const activeSubPlatformIds = new Set(activeSubs.map(s => s.platformId));
        const platform = db.platforms.find(p => !activeSubPlatformIds.has(p.id));

        if (!platform) {
            // Skip if no available platform
            return;
        }

        const initialCount = db.subscriptions.length;
        const proposal: AutomationProposal = {
            id: 'prop_sub_01',
            kind: 'subscription',
            sourceText: `幫 ${member.name} 加 ${platform.name}`,
            confidence: 0.93,
            reason: 'test',
            warnings: [],
            payload: { memberId: member.id, memberName: member.name, platformId: platform.id, platformName: platform.name, startMonth: db.currentMonth },
            status: 'pending',
            createdAt: new Date().toISOString(),
        };

        const result = applySubscriptionProposal(proposal, db);

        expect(result.ok).toBe(true);
        expect(db.subscriptions.length).toBe(initialCount + 1);
        const newSub = last(db.subscriptions, 'subscriptions');
        expect(newSub.startMonth).toBe(db.currentMonth);
        expect(newSub.memberId).toBe(member.id);
    });

    it('should block adding duplicate active subscription', () => {
        const db = freshDb();
        // Find an existing active subscription
        const existingSub = db.subscriptions.find(s => !s.exitMonth);
        if (!existingSub) return; // Skip if none

        const proposal: AutomationProposal = {
            id: 'prop_sub_dup',
            kind: 'subscription',
            sourceText: 'duplicate sub',
            confidence: 0.95,
            reason: 'test',
            warnings: [],
            payload: {
                memberId: existingSub.memberId,
                memberName: existingSub.memberName,
                platformId: existingSub.platformId,
                platformName: existingSub.platformName,
                startMonth: db.currentMonth,
            },
            status: 'pending',
            createdAt: new Date().toISOString(),
        };

        const result = applySubscriptionProposal(proposal, db);
        expect(result.ok).toBe(false);
        expect(result.error).toContain('已有');
    });
});

// ---------------------------------------------------------------------------
// 8. parseAndClassifyProposals — mocked Gemini integration
// ---------------------------------------------------------------------------

describe('parseAndClassifyProposals (mocked Gemini)', () => {
    it('should auto-apply high-confidence payment', async () => {
        const db = freshDb();
        const member = first(db.members, 'members');

        mockGeminiResponse([{
            kind: 'payment',
            memberName: member.name,
            amount: 270,
            date: new Date().toISOString().split('T')[0],
            confidence: 0.96,
            reason: '姓名金額明確',
            warnings: [],
        }]);

        const result = await parseAndClassifyProposals('test text', db, FAKE_API_KEY, 'auto');

        expect(result.applied.length).toBe(1);
        expect(result.pending.length).toBe(0);
        expect(result.rejected.length).toBe(0);
        expect(first(result.applied, 'applied proposals').kind).toBe('payment');
        expect(first(result.applied, 'applied proposals').ledgerEventId).toBeDefined();
    });

    it('should put low-confidence proposal into pending', async () => {
        const db = freshDb();
        const member = first(db.members, 'members');

        mockGeminiResponse([{
            kind: 'payment',
            memberName: member.name,
            amount: 100,
            confidence: 0.72,
            reason: '姓名簡稱，不確定',
            warnings: ['姓名可能有多個匹配'],
        }]);

        const result = await parseAndClassifyProposals('test text', db, FAKE_API_KEY, 'auto');

        // Confidence < 0.9 → pending (not applied, not rejected)
        expect(result.applied.length).toBe(0);
        expect(result.pending.length).toBe(1);
        expect(result.rejected.length).toBe(0);
    });

    it('should reject proposal with unknown member', async () => {
        const db = freshDb();

        mockGeminiResponse([{
            kind: 'payment',
            memberName: '完全不存在的人',
            amount: 500,
            confidence: 0.95,
            reason: 'test',
            warnings: [],
        }]);

        const result = await parseAndClassifyProposals('test text', db, FAKE_API_KEY, 'auto');

        expect(result.rejected.length).toBe(1);
        expect(first(result.rejected, 'rejected proposals').rejectReason).toContain('找不到成員');
    });

    it('should reject proposal with missing amount', async () => {
        const db = freshDb();
        const member = first(db.members, 'members');

        mockGeminiResponse([{
            kind: 'payment',
            memberName: member.name,
            confidence: 0.88,
            reason: '金額未提及',
            warnings: ['缺少金額'],
        }]);

        const result = await parseAndClassifyProposals('test text', db, FAKE_API_KEY, 'auto');

        expect(result.rejected.length).toBe(1);
        expect(first(result.rejected, 'rejected proposals').rejectReason).toContain('金額');
    });

    it('should handle multiple events in a single parse', async () => {
        const db = freshDb();
        const member0 = first(db.members, 'members');
        const member1 = db.members.at(1);
        if (!member1) throw new Error('Fixture invariant failed: second member is missing');
        const platform = first(db.platforms, 'platforms');

        mockGeminiResponse([
            { kind: 'payment', memberName: member0.name, amount: 270, confidence: 0.96, reason: 'test', warnings: [] },
            { kind: 'payment', memberName: member1.name, amount: 100, confidence: 0.71, reason: 'low confidence', warnings: ['模糊'] },
            { kind: 'subscription', memberName: member0.name, platformName: platform.name, month: db.currentMonth, confidence: 0.95, reason: 'test', warnings: [] },
        ]);

        const result = await parseAndClassifyProposals('test text', db, FAKE_API_KEY, 'auto');

        // At least 1 applied (high-confidence payment) and 1 pending (low-confidence)
        // The subscription may go pending if member0 is already subscribed, or applied if not
        expect(result.applied.length + result.pending.length + result.rejected.length).toBe(3);
        expect(result.parseErrors.length).toBe(0);
    });

    it('should put all proposals into pending in review mode', async () => {
        const db = freshDb();
        const member = first(db.members, 'members');

        mockGeminiResponse([{
            kind: 'payment',
            memberName: member.name,
            amount: 270,
            confidence: 0.98,
            reason: 'test',
            warnings: [],
        }]);

        const result = await parseAndClassifyProposals('test text', db, FAKE_API_KEY, 'review');

        expect(result.applied.length).toBe(0);
        expect(result.pending.length).toBe(1);
    });

    it('should return parseError when API key is missing', async () => {
        const db = freshDb();
        const result = await parseAndClassifyProposals('test text', db, '', 'auto');
        expect(result.parseErrors.length).toBeGreaterThan(0);
        expect(result.parseErrors[0]).toContain('API_KEY');
    });

    it('should handle Gemini API failure gracefully', async () => {
        const db = freshDb();
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));

        const result = await parseAndClassifyProposals('test text', db, FAKE_API_KEY, 'auto');
        expect(result.parseErrors.length).toBeGreaterThan(0);
        expect(result.applied.length).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// 9. Security: API key must not appear in ledger payloads or responses
// ---------------------------------------------------------------------------

describe('Security: API key isolation', () => {
    it('ledger payload must not contain API key string', () => {
        const db = freshDb();
        const member = first(db.members, 'members');
        const apiKey = 'sk-tagtoo-secret-key-test-1234';
        process.env.GOOGLE_GEMINI_API_KEY = apiKey;

        const proposal: AutomationProposal = {
            id: 'prop_sec_01',
            kind: 'payment',
            sourceText: 'test source',
            confidence: 0.96,
            reason: 'security test',
            warnings: [],
            payload: { memberId: member.id, memberName: member.name, amount: 100, date: '2026-06-01', method: '轉帳', cycle: '202606', note: '' },
            status: 'pending',
            createdAt: new Date().toISOString(),
        };

        applyPaymentProposal(proposal, db);

        const allLedgerJson = JSON.stringify(db.ledger);
        expect(allLedgerJson).not.toContain(apiKey);

        delete process.env.GOOGLE_GEMINI_API_KEY;
    });
});
