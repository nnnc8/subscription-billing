import type {
  BalanceEntry,
  Database,
  HistoryIntegritySnapshot,
  Member,
  Payment,
  Platform,
  Subscription,
  TempCharge,
} from './types/billing.js';

export interface MemberBalanceSummary {
  monthlyFee: number;
  tempCharges: number;
  paid: number;
  outstanding: number;
}

export function formatMoney(value: number | null | undefined): string {
  return `$${Number(value ?? 0).toLocaleString()}`;
}

export function isVoidedTransaction(transaction: Payment | TempCharge): boolean {
  return transaction.status === 'voided' || transaction.voided === true || Boolean(transaction.voidedAt);
}

export function activeTransactions<T extends Payment | TempCharge>(transactions: T[]): T[] {
  return transactions.filter((transaction) => !isVoidedTransaction(transaction));
}

function monthToCode(month: string | undefined): number | null {
  const match = /^(\d{4})\/(0[1-9]|1[0-2])$/.exec(month ?? '');
  if (!match) return null;
  const year = Number(match[1]);
  const value = Number(match[2]);
  return year * 12 + value;
}

export function isArchivedEntity(entity: Member | Platform | undefined): boolean {
  return Boolean(entity && (entity.status === 'archived' || entity.archivedAt));
}

export function isEntityBillableInMonth(entity: Member | Platform | undefined, month: string): boolean {
  if (!entity || !isArchivedEntity(entity)) return true;
  const archivedCode = monthToCode(entity.archivedMonth);
  const targetCode = monthToCode(month);
  return archivedCode !== null && targetCode !== null && targetCode < archivedCode;
}

function isSubscriptionActiveInMonth(subscription: Subscription, month: string): boolean {
  const startCode = monthToCode(subscription.startMonth);
  const targetCode = monthToCode(month);
  const exitCode = subscription.exitMonth ? monthToCode(subscription.exitMonth) : Number.POSITIVE_INFINITY;
  return startCode !== null && targetCode !== null && exitCode !== null
    && targetCode >= startCode && targetCode <= exitCode;
}

function getSubscriptionMember(subscription: Subscription, data: Database): Member | undefined {
  return data.members.find((member) => (
    (subscription.memberId && member.id === subscription.memberId)
    || member.name === subscription.memberName
  ));
}

function getSubscriptionPlatform(subscription: Subscription, data: Database): Platform | undefined {
  return data.platforms.find((platform) => (
    (subscription.platformId && platform.id === subscription.platformId)
    || platform.name === subscription.platformName
  ));
}

export function isSubscriptionBillable(subscription: Subscription, data: Database, month: string): boolean {
  if (!isSubscriptionActiveInMonth(subscription, month)) return false;
  return isEntityBillableInMonth(getSubscriptionMember(subscription, data), month)
    && isEntityBillableInMonth(getSubscriptionPlatform(subscription, data), month);
}

export function getPlatformPrice(platform: Platform | undefined, data: Database, month: string): number {
  if (!platform || !isEntityBillableInMonth(platform, month)) return 0;
  if (platform.billingMode !== 'split') return platform.price;
  const activeCount = data.subscriptions.filter((subscription) => (
    ((subscription.platformId && subscription.platformId === platform.id)
      || subscription.platformName === platform.name)
    && isSubscriptionActiveInMonth(subscription, month)
    && isEntityBillableInMonth(getSubscriptionMember(subscription, data), month)
  )).length;
  return activeCount > 0 ? Math.round(platform.totalCost / activeCount) : 0;
}

export function getMemberMonthlyFee(member: Member, data: Database): number {
  if (!isEntityBillableInMonth(member, data.currentMonth)) return 0;
  if (member.customFee !== null) return member.customFee;
  return data.subscriptions
    .filter((subscription) => subscription.memberName === member.name)
    .reduce((sum, subscription) => {
      if (!isSubscriptionBillable(subscription, data, data.currentMonth)) return sum;
      return sum + getPlatformPrice(
        data.platforms.find((platform) => platform.name === subscription.platformName),
        data,
        data.currentMonth,
      );
    }, 0);
}

export function getMemberBalanceSummary(member: Member, data: Database): MemberBalanceSummary {
  const monthlyFee = getMemberMonthlyFee(member, data);
  const tempCharges = activeTransactions(data.tempCharges)
    .filter((charge) => charge.memberName === member.name)
    .reduce((sum, charge) => sum + charge.amount, 0);
  const paid = activeTransactions(data.payments)
    .filter((payment) => payment.memberName === member.name)
    .reduce((sum, payment) => sum + payment.amount, 0);
  return {
    monthlyFee,
    tempCharges,
    paid,
    outstanding: member.priorBalance + monthlyFee + tempCharges - paid,
  };
}

export function getDashboardSummary(data: Database) {
  const activePayments = activeTransactions(data.payments);
  const activeTempCharges = activeTransactions(data.tempCharges);
  const memberSummaries = data.members.map((member) => ({
    member,
    summary: getMemberBalanceSummary(member, data),
  }));
  const totalReceivables = memberSummaries.reduce(
    (sum, item) => sum + Math.max(item.summary.outstanding, 0),
    0,
  );
  const totalPayments = activePayments.reduce((sum, payment) => sum + payment.amount, 0);
  const auditWarnings = data._audit?.warnings ?? [];
  const ledger = data._audit?.ledger ?? {
    ok: true,
    count: 0,
    lastHash: null,
    problems: [],
    latest: null,
    recent: [],
  };
  const historyIntegrity: HistoryIntegritySnapshot = data._audit?.snapshot.history.integrity ?? {
    ok: true,
    count: data.history.length,
    sealedCount: data.history.length,
    latestMonth: data.history.at(-1)?.month ?? null,
    latestHash: data.history.at(-1)?.seal?.hash ?? null,
    problems: [],
  };
  const activeMembers = data.members.filter((member) => !isArchivedEntity(member));
  const activePlatforms = data.platforms.filter((platform) => !isArchivedEntity(platform));
  const receivableQueue = memberSummaries
    .filter((item) => item.summary.outstanding > 0)
    .sort((left, right) => right.summary.outstanding - left.summary.outstanding);

  return {
    activePayments,
    activeTempCharges,
    activeMembers,
    activePlatforms,
    memberSummaries,
    totalReceivables,
    totalPayments,
    totalBilled: totalPayments + totalReceivables,
    unpaidMembersCount: receivableQueue.length,
    auditWarnings,
    criticalAuditCount: auditWarnings.filter((warning) => warning.severity === 'critical').length,
    activeSeatCount: data.subscriptions.filter((subscription) => (
      isSubscriptionBillable(subscription, data, data.currentMonth)
    )).length,
    ledger,
    historyIntegrity,
    receivableQueue,
    prepaidTotal: memberSummaries.reduce(
      (sum, item) => sum + Math.max(-item.summary.outstanding, 0),
      0,
    ),
  };
}

export function getSubscriptionDisplayName(subscription: Subscription): string {
  return subscription.seatLabel
    ? `${subscription.platformName}（${subscription.seatLabel}）`
    : subscription.platformName;
}

export function formatRecentTimestamp(value: string | undefined): string {
  if (!value) return '剛剛';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '剛剛';
  return date.toLocaleString('zh-TW', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

export function formatEventTime(value: string | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-TW', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

export function formatLedgerType(type: string): string {
  const labels: Record<string, string> = {
    'system.migrated': '系統升級',
    'payment.created': '新增付款',
    'payment.deleted': '刪除付款',
    'payment.voided': '作廢付款',
    'charge.created': '新增加帳',
    'charge.deleted': '刪除加帳',
    'charge.voided': '作廢加帳',
    'platforms.updated': '平台更新',
    'members.updated': '成員更新',
    'subscriptions.updated': '訂閱更新',
    'settings.updated': '設定更新',
    'member.created': '新增成員',
    'member.archived': '停用成員',
    'platform.created': '新增平台',
    'platform.archived': '停用平台',
    'settings.bundle.updated': '一次寫入設定',
    'month.settled': '月結',
    'history.sealed': '歷史封存',
    'backup.created': '建立備份',
    'backup.restored': '還原備份',
    'backup.deleted': '刪除備份',
  };
  return labels[type] ?? type;
}

export function exportBillingCsv(
  month: string,
  balances: BalanceEntry[],
  payments: Payment[],
  tempCharges: TempCharge[],
): void {
  const rows = [
    `對帳月份：,${month}`,
    '',
    '成員姓名,期初前期餘額,該月分攤訂閱費,該月臨時費用加帳,該月已付金額,期末剩餘應收',
    ...balances.map((balance) => (
      `"${balance.memberName}",${balance.priorBalance},${balance.subscriptionFee},${balance.tempCharge},${balance.paid},${balance.endingBalance}`
    )),
    `合計,${balances.reduce((sum, row) => sum + row.priorBalance, 0)},${balances.reduce((sum, row) => sum + row.subscriptionFee, 0)},${balances.reduce((sum, row) => sum + row.tempCharge, 0)},${balances.reduce((sum, row) => sum + row.paid, 0)},${balances.reduce((sum, row) => sum + row.endingBalance, 0)}`,
    '',
    '=== 該月收款流水日誌 ===',
    '狀態,付款成員,付款日期,金額,付款方式,備註,作廢時間,作廢原因',
    ...payments.map((payment) => (
      `"${isVoidedTransaction(payment) ? '作廢' : '有效'}","${payment.memberName}","${payment.date}",${payment.amount},"${payment.method}","${payment.note ?? ''}","${payment.voidedAt ?? ''}","${payment.voidReason ?? ''}"`
    )),
    '',
    '=== 該月臨時費用加帳日誌 ===',
    '狀態,加帳成員,加帳日期,金額,事項說明,作廢時間,作廢原因',
    ...tempCharges.map((charge) => (
      `"${isVoidedTransaction(charge) ? '作廢' : '有效'}","${charge.memberName}","${charge.date ?? ''}",${charge.amount},"${charge.desc ?? ''}","${charge.voidedAt ?? ''}","${charge.voidReason ?? ''}"`
    )),
  ];
  const url = URL.createObjectURL(new Blob([`\uFEFF${rows.join('\n')}`], { type: 'text/csv;charset=utf-8;' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `訂閱對帳單_${month.replace('/', '_')}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
