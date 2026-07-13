import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Database, Member, Subscription, BalanceEntry } from '../src/types/billing.js';
import {
  activeTransactions,
  isSubActiveInMonth,
  calculateMemberMonthlyFee
} from '../lib/accounting.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, '../fixtures/demo-database.json');

function loadDb(filePath: string = dbPath): Database {
  const content = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(content) as Database;
}

function activeSubscriptionsFor(db: Database, memberName: string, platformName: string, targetMonth: string): Subscription[] {
  return (db.subscriptions || []).filter(sub =>
    sub.memberName === memberName &&
    sub.platformName === platformName &&
    isSubActiveInMonth(sub, targetMonth)
  );
}

function simulateRollover(db: Database): void {
  const currentMonth = db.currentMonth;
  const year = Number(currentMonth.slice(0, 4));
  const month = Number(currentMonth.slice(5, 7));

  const balancesReport: BalanceEntry[] = [];
  const updatedMembers: Member[] = [];

  for (const member of db.members) {
    const prior = member.priorBalance;
    const fee = calculateMemberMonthlyFee(member, db, currentMonth);
    const temp = activeTransactions(db.tempCharges)
      .filter(charge => charge.memberName === member.name)
      .reduce((sum, charge) => sum + charge.amount, 0);
    const paid = activeTransactions(db.payments)
      .filter(payment => payment.memberName === member.name)
      .reduce((sum, payment) => sum + payment.amount, 0);
    const ending = prior + fee + temp - paid;

    balancesReport.push({
      memberId: member.id,
      memberName: member.name,
      priorBalance: prior,
      subscriptionFee: fee,
      tempCharge: temp,
      paid: paid,
      endingBalance: ending,
    });
    updatedMembers.push({ ...member, priorBalance: ending });
  }

  db.history.push({
    month: currentMonth,
    balances: balancesReport,
    payments: [...db.payments],
    tempCharges: [...db.tempCharges],
  });

  let nextMonth = month + 1;
  let nextYear = year;
  if (nextMonth > 12) {
    nextMonth = 1;
    nextYear += 1;
  }
  db.currentMonth = `${nextYear}/${String(nextMonth).padStart(2, '0')}`;
  db.members = updatedMembers;
  db.payments = [];
  db.tempCharges = [];
}

describe('Rollover integration and consistency tests', () => {
  it('should pass all checks mirroring the legacy python script', () => {
    const db = loadDb();
    const originalHistoryCount = db.history.length;

    // Assert initial currentMonth is 2026/06
    expect(db.currentMonth).toBe('2026/06');

    // Assert stable ID relations
    const memberIds = new Set(db.members.map(m => m.id));
    const platformIds = new Set(db.platforms.map(p => p.id));
    for (const sub of db.subscriptions) {
      expect(memberIds.has(sub.memberId)).toBe(true);
      expect(platformIds.has(sub.platformId)).toBe(true);
    }

    // Assert monthly fee for Member Gamma in 2026/06
    const gamma = db.members.find(m => m.name === 'Member Gamma');
    expect(gamma).toBeDefined();
    expect(calculateMemberMonthlyFee(gamma!, db, '2026/06')).toBe(300);

    // Assert monthly fee for Member Beta in 2026/06
    const beta = db.members.find(m => m.name === 'Member Beta');
    expect(beta).toBeDefined();
    const betaFee = calculateMemberMonthlyFee(beta!, db, '2026/06');
    const betaVideoActive = activeSubscriptionsFor(db, 'Member Beta', 'Shared Video', '2026/06');
    expect(betaFee).toBe(280);
    expect(betaVideoActive.length).toBe(2);
    expect(betaVideoActive.every(s => s.allowDuplicate && s.seatLabel)).toBe(true);

    // Calculate expected ending balances
    const expectedPrior: Record<string, number> = {};
    for (const item of db.members) {
      const fee = calculateMemberMonthlyFee(item, db, '2026/06');
      const temp = activeTransactions(db.tempCharges)
        .filter(charge => charge.memberName === item.name)
        .reduce((sum, charge) => sum + charge.amount, 0);
      const paid = activeTransactions(db.payments)
        .filter(payment => payment.memberName === item.name)
        .reduce((sum, payment) => sum + payment.amount, 0);
      expectedPrior[item.name] = item.priorBalance + fee + temp - paid;
    }

    // Simulate rollover
    simulateRollover(db);

    // Assert post-rollover states
    expect(db.currentMonth).toBe('2026/07');
    expect(db.payments.length).toBe(0);
    expect(db.tempCharges.length).toBe(0);
    expect(db.history.length).toBe(originalHistoryCount + 1);
    const lastHistory = db.history.at(-1);
    if (!lastHistory) throw new Error('Rollover invariant failed: history entry missing');
    expect(lastHistory.month).toBe('2026/06');

    // Assert each member's updated priorBalance
    for (const [name, expected] of Object.entries(expectedPrior)) {
      const matched = db.members.find(m => m.name === name);
      expect(matched).toBeDefined();
      expect(matched!.priorBalance).toBe(expected);
    }

    // Assert monthly fee for Member Beta in 2026/07 is still 280
    const betaNew = db.members.find(m => m.name === 'Member Beta');
    expect(betaNew).toBeDefined();
    expect(calculateMemberMonthlyFee(betaNew!, db, '2026/07')).toBe(280);
  });
});
