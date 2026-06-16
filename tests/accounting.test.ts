import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  findRecentDuplicateTransaction,
  findAccountingWarnings,
  getClosePreview,
  getHistoryIntegrity,
  getSystemSnapshot,
  normalizeDatabaseRelations
} from '../lib/accounting.js';
import type { Database, Payment, TempCharge } from '../src/types/billing.js';

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

// Helper for type checking warnings
function warningSeverity(w: any): string {
  return w.severity || '';
}
