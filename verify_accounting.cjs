const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
    findRecentDuplicateTransaction,
    findAccountingWarnings,
    getClosePreview,
    getHistoryIntegrity,
    getSystemSnapshot,
    normalizeDatabaseRelations
} = require('./lib/accounting');

const dbPath = process.env.TEST_DB_PATH || path.join(__dirname, 'fixtures', 'demo-database.json');
const db = normalizeDatabaseRelations(JSON.parse(fs.readFileSync(dbPath, 'utf8')));

const warnings = findAccountingWarnings(db);
assert.deepStrictEqual(warnings.filter(warning => warning.severity === 'critical'), []);

const closePreview = getClosePreview(db);
assert.strictEqual(closePreview.ready, true);
assert.strictEqual(closePreview.blockers.length, 0);
assert(closePreview.checks.some(check => check.id === 'history' && check.status === 'pass'));

const snapshot = getSystemSnapshot(db);
assert.notStrictEqual(snapshot.health.status, 'risk');
assert.strictEqual(snapshot.totals.receivable, closePreview.totals.receivable);
assert.strictEqual(snapshot.totals.subscriptionFee, closePreview.totals.subscriptionFee);
assert.strictEqual(snapshot.ledger.ok, true);
assert.match(snapshot.fingerprint, /^[a-f0-9]{64}$/);

const betaPayment = db.payments.find(payment => payment.memberName === 'Member Beta' && payment.amount === 250);
assert(betaPayment);

const voidedPaymentDb = JSON.parse(JSON.stringify(db));
const voidedPayment = voidedPaymentDb.payments.find(payment => payment.id === betaPayment.id);
voidedPayment.status = 'voided';
voidedPayment.voidedAt = '2026-06-04T03:00:00.000Z';
voidedPayment.voidReason = 'verification';
const voidedSnapshot = getSystemSnapshot(voidedPaymentDb);
const voidedClosePreview = getClosePreview(voidedPaymentDb);
assert.deepStrictEqual(voidedSnapshot.totals, voidedClosePreview.totals);
assert.strictEqual(voidedSnapshot.totals.paid, snapshot.totals.paid - betaPayment.amount);
assert.strictEqual(voidedSnapshot.totals.receivable, snapshot.totals.receivable + betaPayment.amount);
assert.strictEqual(voidedSnapshot.counts.payments, snapshot.counts.payments - 1);
assert.strictEqual(voidedSnapshot.counts.paymentRecords, snapshot.counts.paymentRecords);
assert.strictEqual(voidedSnapshot.counts.voidedPayments, snapshot.counts.voidedPayments + 1);

const archivedMemberDb = JSON.parse(JSON.stringify(db));
const archivedBeta = archivedMemberDb.members.find(member => member.name === 'Member Beta');
archivedBeta.status = 'archived';
archivedBeta.archivedAt = '2026-06-04T03:00:00.000Z';
archivedBeta.archivedMonth = archivedMemberDb.currentMonth;
const archivedMemberSnapshot = getSystemSnapshot(archivedMemberDb);
const archivedBetaBalance = getClosePreview(archivedMemberDb).balances.find(balance => balance.memberName === 'Member Beta');
const liveBetaBalance = closePreview.balances.find(balance => balance.memberName === 'Member Beta');
assert.strictEqual(archivedBetaBalance.subscriptionFee, 0);
assert.strictEqual(archivedBetaBalance.endingBalance, liveBetaBalance.endingBalance - liveBetaBalance.subscriptionFee);
assert.strictEqual(archivedMemberSnapshot.counts.members, db.members.length);
assert.strictEqual(archivedMemberSnapshot.counts.archivedMembers, 1);

const historyIntegrity = getHistoryIntegrity(db);
assert.strictEqual(historyIntegrity.ok, true);
assert.strictEqual(historyIntegrity.sealedCount, db.history.length);

const serverSource = fs.readFileSync(path.join(__dirname, 'server.ts'), 'utf8');
assert(!serverSource.includes('recalculateHistoryBalances'));
assert(!serverSource.includes('db.payments = db.payments.filter(p => p.id !== id)'));
assert(!serverSource.includes('db.tempCharges = db.tempCharges.filter(c => c.id !== id)'));
assert(!serverSource.includes('db.members = db.members.filter(m => m.id !== id)'));
assert(!serverSource.includes('db.platforms = db.platforms.filter(p => p.id !== id)'));
assert(!serverSource.includes('db.subscriptions = db.subscriptions.filter(s => !isMemberRecord'));
assert(!serverSource.includes('db.subscriptions = db.subscriptions.filter(s => !isPlatformRecord'));

const betaVideoSeats = db.subscriptions.filter(subscription => (
    subscription.memberName === 'Member Beta' &&
    subscription.platformName === 'Shared Video' &&
    subscription.exitMonth === ''
));
assert.strictEqual(betaVideoSeats.length, 2);
assert.deepStrictEqual(
    betaVideoSeats.map(subscription => subscription.seatLabel).sort(),
    ['Seat 1', 'Seat 2']
);
assert(betaVideoSeats.every(subscription => subscription.allowDuplicate === true));

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
    }
], {
    memberId: 'm_beta',
    memberName: 'Member Beta',
    amount: 250,
    date: '2026-06-04',
    method: 'transfer',
    note: 'demo payment',
    createdAt: now
}, { type: 'payment' });
assert(duplicatePayment);
assert.strictEqual(duplicatePayment.id, 'pay_recent');

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
    }
], {
    memberId: 'm_beta',
    memberName: 'Member Beta',
    amount: 250,
    date: '2026-06-04',
    method: 'transfer',
    note: 'demo payment',
    createdAt: now
}, { type: 'payment' });
assert.strictEqual(stalePayment, null);

const duplicateCharge = findRecentDuplicateTransaction([
    {
        id: 'chg_recent',
        memberId: 'm_alpha',
        memberName: 'Member Alpha',
        amount: 50,
        date: '2026-06-05',
        desc: 'demo adjustment',
        createdAt: '2026-06-05T02:00:00.000Z'
    }
], {
    memberId: 'm_alpha',
    memberName: 'Member Alpha',
    amount: 50,
    date: '2026-06-05',
    desc: 'demo adjustment',
    createdAt: '2026-06-05T02:04:00.000Z'
}, { type: 'charge' });
assert(duplicateCharge);
assert.strictEqual(duplicateCharge.id, 'chg_recent');

console.log('Accounting snapshot verification passed.');
