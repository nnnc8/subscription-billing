import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  findRecentDuplicateTransaction,
  findAccountingWarnings,
  findFirstDuplicateSubscriptionMonth,
  getClosePreview,
  getHistoryIntegrity,
  getSystemSnapshot,
  monthToCode,
  normalizeDatabaseRelations
} from '../lib/accounting.js';
import type { AuditWarning, Database, Payment, Subscription, TempCharge } from '../src/types/billing.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, '../fixtures/demo-database.json');
const db = normalizeDatabaseRelations(JSON.parse(fs.readFileSync(dbPath, 'utf8')));

describe('Accounting & Ledger business logic validations', () => {
  it('should have zero critical warnings', () => {
    const warnings = findAccountingWarnings(db);
    expect(warnings.filter(w => warningSeverity(w) === 'critical')).toEqual([]);
  });

  it('should pass month-close requirements checks and balances', () => {
    const closePreview = getClosePreview(db);
    expect(closePreview.ready).toBe(true);
    expect(closePreview.blockers.length).toBe(0);
    expect(closePreview.checks.some(c => c.id === 'history' && c.status === 'pass')).toBe(true);
  });

  it('should produce a non-risk snapshot that matches close-preview totals', () => {
    const closePreview = getClosePreview(db);
    const snapshot = getSystemSnapshot(db);
    expect(snapshot.health.status).not.toBe('risk');
    expect(snapshot.totals.receivable).toBe(closePreview.totals.receivable);
    expect(snapshot.totals.subscriptionFee).toBe(closePreview.totals.subscriptionFee);
    expect(snapshot.ledger.ok).toBe(true);
    expect(snapshot.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('should correctly recalculate balances when a payment is voided', () => {
    const betaPayment = db.payments.find(p => p.memberName === 'Member Beta' && p.amount === 250);
    expect(betaPayment).toBeDefined();

    const voidedPaymentDb = JSON.parse(JSON.stringify(db)) as Database;
    const voidedPayment = voidedPaymentDb.payments.find(p => p.id === betaPayment!.id);
    voidedPayment!.status = 'voided';
    voidedPayment!.voidedAt = '2026-06-04T03:00:00.000Z';
    voidedPayment!.voidReason = 'verification';

    const snapshot = getSystemSnapshot(db);
    const voidedSnapshot = getSystemSnapshot(voidedPaymentDb);
    const voidedClosePreview = getClosePreview(voidedPaymentDb);

    expect(voidedSnapshot.totals).toEqual(voidedClosePreview.totals);
    expect(voidedSnapshot.totals.paid).toBe(snapshot.totals.paid - betaPayment!.amount);
    expect(voidedSnapshot.totals.receivable).toBe(snapshot.totals.receivable + betaPayment!.amount);
    expect(voidedSnapshot.counts.payments).toBe(snapshot.counts.payments - 1);
    expect(voidedSnapshot.counts.paymentRecords).toBe(snapshot.counts.paymentRecords);
    expect(voidedSnapshot.counts.voidedPayments).toBe(snapshot.counts.voidedPayments + 1);
  });

  it('should correctly handle member archiving and zero-out active subscription fees', () => {
    const closePreview = getClosePreview(db);
    const archivedMemberDb = JSON.parse(JSON.stringify(db)) as Database;
    const archivedBeta = archivedMemberDb.members.find(m => m.name === 'Member Beta');
    archivedBeta!.status = 'archived';
    archivedBeta!.archivedAt = '2026-06-04T03:00:00.000Z';
    archivedBeta!.archivedMonth = archivedMemberDb.currentMonth;

    const archivedMemberSnapshot = getSystemSnapshot(archivedMemberDb);
    const archivedBetaBalance = getClosePreview(archivedMemberDb).balances.find(b => b.memberName === 'Member Beta');
    const liveBetaBalance = closePreview.balances.find(b => b.memberName === 'Member Beta');

    expect(archivedBetaBalance!.subscriptionFee).toBe(0);
    expect(archivedBetaBalance!.endingBalance).toBe(liveBetaBalance!.endingBalance - liveBetaBalance!.subscriptionFee);
    expect(archivedMemberSnapshot.counts.members).toBe(db.members.length);
    expect(archivedMemberSnapshot.counts.archivedMembers).toBe(1);
  });

  it('should verify history seal integrity chains', () => {
    const historyIntegrity = getHistoryIntegrity(db);
    expect(historyIntegrity.ok).toBe(true);
    expect(historyIntegrity.sealedCount).toBe(db.history.length);
  });

  it('should verify code structures do not contain forbidden mutable patterns', () => {
    // Reading server.ts (ESM) to make sure there are no legacy mutable or recalculation patterns
    const serverSource = fs.readFileSync(path.join(__dirname, '../server.ts'), 'utf8');
    expect(serverSource.includes('recalculateHistoryBalances')).toBe(false);
    expect(serverSource.includes('db.payments = db.payments.filter(p => p.id !== id)')).toBe(false);
    expect(serverSource.includes('db.tempCharges = db.tempCharges.filter(c => c.id !== id)')).toBe(false);
    expect(serverSource.includes('db.members = db.members.filter(m => m.id !== id)')).toBe(false);
    expect(serverSource.includes('db.platforms = db.platforms.filter(p => p.id !== id)')).toBe(false);
    expect(serverSource.includes('db.subscriptions = db.subscriptions.filter(s => !isMemberRecord')).toBe(false);
    expect(serverSource.includes('db.subscriptions = db.subscriptions.filter(s => !isPlatformRecord')).toBe(false);
  });

  it('should correctly handle duplicate subscription configurations and labels', () => {
    const betaVideoSeats = db.subscriptions.filter(sub => (
      sub.memberName === 'Member Beta' &&
      sub.platformName === 'Shared Video' &&
      !sub.exitMonth
    ));
    expect(betaVideoSeats.length).toBe(2);
    expect(betaVideoSeats.map(s => s.seatLabel).sort()).toEqual(['Seat 1', 'Seat 2']);
    expect(betaVideoSeats.every(s => s.allowDuplicate === true)).toBe(true);
  });

  it('should detect recent duplicate payment transactions', () => {
    const now = '2026-06-04T02:05:00.000Z';
    const duplicatePayment = findRecentDuplicateTransaction([
      {
        id: 'pay_recent',
        memberId: 'm_beta',
        memberName: 'Member Beta',
        amount: 250,
        date: '2026-06-04',
        method: 'transfer',
        note: 'demo payment',
        createdAt: '2026-06-04T02:00:00.000Z'
      } as Payment
    ], {
      memberId: 'm_beta',
      memberName: 'Member Beta',
      amount: 250,
      date: '2026-06-04',
      method: 'transfer',
      note: 'demo payment',
      createdAt: now
    } as Payment, { type: 'payment' });

    expect(duplicatePayment).toBeDefined();
    expect(duplicatePayment!.id).toBe('pay_recent');
  });

  it('should reject duplicate payment transactions outside the window limit', () => {
    const now = '2026-06-04T02:05:00.000Z';
    const stalePayment = findRecentDuplicateTransaction([
      {
        id: 'pay_old',
        memberId: 'm_beta',
        memberName: 'Member Beta',
        amount: 250,
        date: '2026-06-04',
        method: 'transfer',
        note: 'demo payment',
        createdAt: '2026-06-04T01:30:00.000Z'
      } as Payment
    ], {
      memberId: 'm_beta',
      memberName: 'Member Beta',
      amount: 250,
      date: '2026-06-04',
      method: 'transfer',
      note: 'demo payment',
      createdAt: now
    } as Payment, { type: 'payment' });

    expect(stalePayment).toBeNull();
  });

  it('should detect recent duplicate temp charge transactions', () => {
    const duplicateCharge = findRecentDuplicateTransaction([
      {
        id: 'chg_recent',
        memberId: 'm_alpha',
        memberName: 'Member Alpha',
        amount: 50,
        date: '2026-06-05',
        desc: 'demo adjustment',
        createdAt: '2026-06-05T02:00:00.000Z'
      } as TempCharge
    ], {
      memberId: 'm_alpha',
      memberName: 'Member Alpha',
      amount: 50,
      date: '2026-06-05',
      desc: 'demo adjustment',
      createdAt: '2026-06-05T02:04:00.000Z'
    } as TempCharge, { type: 'charge' });

    expect(duplicateCharge).toBeDefined();
    expect(duplicateCharge!.id).toBe('chg_recent');
  });
});

describe('findFirstDuplicateSubscriptionMonth', () => {
  /** The demo fixture is in 2026/06; s_alpha_video bills Member Alpha for Shared Video from 2026/01 on. */
  const fixture = (): Database => normalizeDatabaseRelations(JSON.parse(fs.readFileSync(dbPath, 'utf8')));
  const alphaVideo = (data: Database): Subscription => data.subscriptions.find(subscription => subscription.id === 's_alpha_video')!;
  /** Another Shared Video seat for Member Alpha from `startMonth`. */
  const alphaVideoFrom = (data: Database, startMonth: string, extra: Partial<Subscription> = {}): Subscription => ({
    ...alphaVideo(data), id: `s_alpha_video_${startMonth.replace('/', '_')}`, startMonth, ...extra
  });
  const alphaMusicFrom = (data: Database, startMonth: string): Subscription => ({
    ...alphaVideo(data), id: 's_alpha_music', platformId: 'p_music', platformName: 'Shared Music', startMonth
  });
  const duplicates = (data: Database, month?: string) => findAccountingWarnings(data, month).filter(warning => warning.code === 'duplicate_active_subscription');

  it('reports the first month in which a later subscription overlaps, with that month\'s warning', () => {
    const data = fixture();
    data.subscriptions.push(alphaVideoFrom(data, '2026/08'), alphaMusicFrom(data, '2027/03'));
    // The audit of the open month alone sees nothing.
    expect(duplicates(data)).toEqual([]);
    const found = findFirstDuplicateSubscriptionMonth(data);
    expect(found?.month).toBe('2026/08');
    expect(found?.warnings).toEqual(duplicates(data, '2026/08'));
    expect(found?.warnings).toHaveLength(1);
    expect(found?.warnings[0]).toMatchObject({ severity: 'high', code: 'duplicate_active_subscription' });
    expect(found?.warnings[0]?.detail).toContain('Member Alpha 在 2026/08 有 2 筆 Shared Video');
  });

  it('reports an overlap in the open month as that month', () => {
    const data = fixture();
    data.subscriptions.push(alphaVideoFrom(data, '2026/06'));
    expect(findFirstDuplicateSubscriptionMonth(data)?.month).toBe('2026/06');
  });

  it('finds no overlap once an exit month ends it, between marked extra seats, or on another platform', () => {
    const data = fixture();
    const later = alphaVideoFrom(data, '2026/08');
    data.subscriptions.push(later);
    alphaVideo(data).exitMonth = '2026/07';
    expect(findFirstDuplicateSubscriptionMonth(data)).toBeNull();
    // An exit month equal to the later start month still bills both seats in that month.
    alphaVideo(data).exitMonth = '2026/08';
    expect(findFirstDuplicateSubscriptionMonth(data)?.month).toBe('2026/08');
    delete alphaVideo(data).exitMonth;
    Object.assign(alphaVideo(data), { allowDuplicate: true, seatLabel: 'Seat A' });
    Object.assign(later, { allowDuplicate: true, seatLabel: 'Seat B' });
    expect(findFirstDuplicateSubscriptionMonth(data)).toBeNull();

    const other = fixture();
    other.subscriptions.push(alphaMusicFrom(other, '2026/09'));
    expect(findFirstDuplicateSubscriptionMonth(other)).toBeNull();
  });

  it('finds the same month as an audit of every month through the latest start month', () => {
    const monthOf = (code: number) => `${Math.floor((code - 1) / 12)}/${String(((code - 1) % 12) + 1).padStart(2, '0')}`;
    const everyMonth = (data: Database): string | null => {
      const last = Math.max(...data.subscriptions.map(subscription => monthToCode(subscription.startMonth)!));
      for (let code = monthToCode(data.currentMonth)!; code <= last; code++) {
        if (duplicates(data, monthOf(code)).length) return monthOf(code);
      }
      return null;
    };
    const archived = { status: 'archived', archivedAt: '2026-06-10T00:00:00.000Z' };
    const scenarios: Array<[string, (data: Database) => void, string | null]> = [
      ['an overlap between later start months', data => { data.subscriptions.push(alphaMusicFrom(data, '2027/04'), alphaVideoFrom(data, '2026/09')); }, '2026/09'],
      ['an overlap from the latest start month, after a year end', data => { data.subscriptions.push(alphaVideoFrom(data, '2027/02')); }, '2027/02'],
      ['a handover through an exit month', data => { alphaVideo(data).exitMonth = '2026/11'; data.subscriptions.push(alphaVideoFrom(data, '2026/12')); }, null],
      ['a member archived from the later start month', data => { Object.assign(data.members.find(member => member.id === 'm_alpha')!, archived, { archivedMonth: '2026/08' }); data.subscriptions.push(alphaVideoFrom(data, '2026/08')); }, null],
      ['a platform archived after the later start month', data => { Object.assign(data.platforms.find(platform => platform.id === 'p_video')!, archived, { archivedMonth: '2026/10' }); data.subscriptions.push(alphaVideoFrom(data, '2026/09')); }, '2026/09'],
      ['marked seats beside an unmarked one', data => { data.subscriptions.push(alphaVideoFrom(data, '2026/10', { allowDuplicate: true, seatLabel: 'Seat B' }), alphaVideoFrom(data, '2026/08', { allowDuplicate: true, seatLabel: 'Seat C' })); }, '2026/08'],
      ['the fixture as it is', () => undefined, null]
    ];
    for (const [name, change, expected] of scenarios) {
      const data = fixture();
      change(data);
      expect(everyMonth(data), name).toBe(expected);
      expect(findFirstDuplicateSubscriptionMonth(data)?.month ?? null, name).toBe(expected);
    }
  });
});

// Helper for type checking warnings
function warningSeverity(w: AuditWarning): string {
  return w.severity || '';
}
