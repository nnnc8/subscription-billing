import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ChevronDown, Download, Search, X } from 'lucide-react';
import {
  exportBillingCsv,
  formatEventTime,
  formatLedgerType,
  formatMoney,
  formatRecentTimestamp,
  getDashboardSummary,
  getMemberBalanceSummary,
  getPlatformPrice,
  getSubscriptionDisplayName,
  isArchivedEntity,
  isEntityBillableInMonth,
  isSubscriptionBillable,
  isVoidedTransaction,
} from '../billing.js';
import { initialOf, memberToneStyle } from '../display.js';
import type {
  AIMessage,
  ApiFetch,
  BalanceEntry,
  Database,
  Member,
  RefreshData,
  ReminderStyle,
  ShowToast,
} from '../types/billing.js';
import { Modal } from './ui/Modal.js';

const AiAssistantTab = lazy(() => import('./AiAssistantTab.js').then((module) => ({ default: module.AiAssistantTab })));
const AutomationTab = lazy(() => import('./AutomationTab.js').then((module) => ({ default: module.AutomationTab })));

interface DashboardTabProps {
  active: boolean;
  data: Database;
  apiFetch: ApiFetch;
  refreshData: RefreshData;
  showToast: ShowToast;
}

interface ReminderState {
  text?: string;
  loading?: boolean;
  style?: ReminderStyle;
  error?: boolean;
  isAI?: boolean;
}

interface MutationResponse {
  error?: string;
  duplicate?: { memberName: string; amount: number; createdAt?: string };
}

interface ReminderResponse {
  success: boolean;
  text?: string;
  isAI?: boolean;
  error?: string;
}

interface ChatResponse {
  success: boolean;
  history?: AIMessage[];
  error?: string;
}

const GREETING: AIMessage = {
  id: 'assistant-greeting',
  role: 'assistant',
  content: '您好！我是您的帳務智能助理。您可以查詢成員餘額、歷史交易、系統狀態或帳務警告。',
};

function normalizeMessages(messages: AIMessage[]): AIMessage[] {
  return messages.map((message) => ({ ...message, id: message.id ?? crypto.randomUUID() }));
}

function buildReminder(data: Database, member: Member, summary: ReturnType<typeof getMemberBalanceSummary>): string {
  const services = member.customFee !== null && isEntityBillableInMonth(member, data.currentMonth)
    ? [`  • 自訂費用小計: ${formatMoney(member.customFee)}`]
    : data.subscriptions
      .filter((subscription) => subscription.memberName === member.name && isSubscriptionBillable(subscription, data, data.currentMonth))
      .map((subscription) => {
        const platform = data.platforms.find((item) => item.name === subscription.platformName);
        return `  • ${getSubscriptionDisplayName(subscription)}: ${formatMoney(getPlatformPrice(platform, data, data.currentMonth))}`;
      });
  if (services.length === 0) services.push('  • 本期無訂閱項目');
  const amount = Math.max(summary.outstanding, 0);
  const balanceNote = summary.outstanding > 0
    ? `本期應繳：${formatMoney(amount)}\n\n匯款資訊：\n${data.bankInfo}`
    : summary.outstanding < 0
      ? `本期免繳，預繳餘額 ${formatMoney(Math.abs(summary.outstanding))} 將自動結轉。`
      : '本期帳款已結清，無須匯款。';
  const details = [
    `前期餘額：${formatMoney(member.priorBalance)}`,
    `本期訂閱費：${formatMoney(summary.monthlyFee)}`,
    `臨時加帳：${formatMoney(summary.tempCharges)}`,
    `已付：${formatMoney(summary.paid)}`,
  ].join('\n');

  if (data.reminderStyle === 'minimal') {
    return `${member.name} 您好，${data.currentMonth} 對帳如下：\n${balanceNote}\n\n${details}`;
  }
  if (data.reminderStyle === 'formal') {
    return `訂閱對帳單（${data.currentMonth}）\n\n${member.name} 您好，本期項目：\n${services.join('\n')}\n\n${details}\n\n${balanceNote}`;
  }
  // The bell opens the LINE message itself; it is message copy, not interface decoration.
  return `\u{1F514} ${member.name}，${data.currentMonth} 的訂閱帳單來了！\n\n本期服務：\n${services.join('\n')}\n\n${details}\n\n${balanceNote}\n\n轉帳後再跟我說一聲，謝謝！`;
}

export function DashboardTab({ active, data, apiFetch, refreshData, showToast }: DashboardTabProps) {
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [chargeOpen, setChargeOpen] = useState(false);
  const [selectedMember, setSelectedMember] = useState('');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState('');
  const [description, setDescription] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('轉帳');
  const [savingTransaction, setSavingTransaction] = useState<'payment' | 'charge' | null>(null);
  const [logSearch, setLogSearch] = useState('');
  const [logMember, setLogMember] = useState('');
  const [reminders, setReminders] = useState<Record<string, ReminderState>>({});
  const [aiMessages, setAiMessages] = useState<AIMessage[]>([GREETING]);
  const [aiInput, setAiInput] = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  const [expandedMember, setExpandedMember] = useState('');
  const workspaceMounted = true;
  const paymentAmountRef = useRef<HTMLInputElement>(null);
  const chargeAmountRef = useRef<HTMLInputElement>(null);

  const summary = getDashboardSummary(data);
  const collectionRate = summary.totalBilled > 0
    ? Math.round((summary.totalPayments / summary.totalBilled) * 100)
    : 0;
  const closeGateClear = summary.criticalAuditCount === 0 && summary.ledger.ok && summary.historyIntegrity.ok;
  const activePaymentCount = summary.activePayments.length;
  const activeChargeCount = summary.activeTempCharges.length;
  const filteredPayments = data.payments.filter((payment) => {
    const query = logSearch.toLowerCase();
    return (!logMember || payment.memberName === logMember)
      && (!query || [payment.note, payment.method, payment.memberName, isVoidedTransaction(payment) ? '作廢' : '有效']
        .some((value) => (value ?? '').toLowerCase().includes(query)));
  });
  const filteredCharges = data.tempCharges.filter((charge) => {
    const query = logSearch.toLowerCase();
    return (!logMember || charge.memberName === logMember)
      && (!query || [charge.desc, charge.memberName, isVoidedTransaction(charge) ? '作廢' : '有效']
        .some((value) => (value ?? '').toLowerCase().includes(query)));
  });

  useEffect(() => {
    if (!active) return;
    const element = document.getElementById('ai-messages-container');
    if (element) element.scrollTop = element.scrollHeight;
  }, [active, aiLoading, aiMessages]);

  function resetTransactionForm(): void {
    setAmount('');
    setDate('');
    setDescription('');
    setPaymentMethod('轉帳');
  }

  function openTransaction(kind: 'payment' | 'charge', memberName: string): void {
    resetTransactionForm();
    setSelectedMember(memberName);
    if (kind === 'payment') setPaymentOpen(true);
    else setChargeOpen(true);
  }

  async function handleAddPayment(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!amount || !Number.isFinite(Number(amount))) {
      showToast('請輸入有效的金額！');
      return;
    }
    setSavingTransaction('payment');
    try {
      const response = await apiFetch('/payment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          memberName: selectedMember,
          amount: Number(amount),
          date: date || undefined,
          method: paymentMethod,
          note: description,
        }),
      });
      const result = await response.json() as MutationResponse;
      if (!response.ok) {
        if (response.status === 409 && result.duplicate) {
          showToast(`已擋下重複付款：${result.duplicate.memberName} ${formatMoney(result.duplicate.amount)}，原紀錄在 ${formatRecentTimestamp(result.duplicate.createdAt)} 建立。`);
        } else showToast(result.error ?? '登記付款失敗');
        return;
      }
      await refreshData();
      setPaymentOpen(false);
      resetTransactionForm();
      showToast('付款記錄已成功登記！');
    } catch {
      showToast('登記付款失敗');
    } finally {
      setSavingTransaction(null);
    }
  }

  async function handleAddCharge(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!amount || !Number.isFinite(Number(amount))) {
      showToast('請輸入有效的金額！');
      return;
    }
    setSavingTransaction('charge');
    try {
      const response = await apiFetch('/temp-charge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ memberName: selectedMember, amount: Number(amount), date: date || undefined, desc: description }),
      });
      const result = await response.json() as MutationResponse;
      if (!response.ok) {
        if (response.status === 409 && result.duplicate) {
          showToast(`已擋下重複加帳：${result.duplicate.memberName} ${formatMoney(result.duplicate.amount)}，原紀錄在 ${formatRecentTimestamp(result.duplicate.createdAt)} 建立。`);
        } else showToast(result.error ?? '登記加帳失敗');
        return;
      }
      await refreshData();
      setChargeOpen(false);
      resetTransactionForm();
      showToast('臨時加帳已成功登記！');
    } catch {
      showToast('登記加帳失敗');
    } finally {
      setSavingTransaction(null);
    }
  }

  async function voidTransaction(kind: 'payment' | 'temp-charge', id: string): Promise<void> {
    const label = kind === 'payment' ? '付款' : '臨時加帳';
    if (!window.confirm(`確定要作廢這筆${label}記錄嗎？\n\n原始記錄會保留在流水帳中，但不再計入本期帳務。`)) return;
    try {
      const response = await apiFetch(`/${kind}/${id}`, { method: 'DELETE' });
      const result = await response.json() as MutationResponse;
      if (!response.ok) {
        showToast(result.error ?? `作廢${label}失敗`);
        return;
      }
      await refreshData();
      showToast(`${label}記錄已作廢。`);
    } catch {
      showToast(`作廢${label}失敗`);
    }
  }

  async function generateAiReminder(member: Member, style: ReminderStyle): Promise<void> {
    setReminders((current) => ({ ...current, [member.id]: { ...current[member.id], loading: true, style, error: false } }));
    try {
      const response = await apiFetch('/ai/generate-reminder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ memberId: member.id, style }),
      });
      const result = await response.json() as ReminderResponse;
      if (!response.ok || !result.success || !result.text) {
        setReminders((current) => ({ ...current, [member.id]: { style, loading: false, error: true } }));
        showToast(`AI 生成失敗：${result.error ?? '未知錯誤'}`);
        return;
      }
      const text = result.text;
      setReminders((current) => ({
        ...current,
        [member.id]: {
          text,
          style,
          loading: false,
          ...(result.isAI === undefined ? {} : { isAI: result.isAI }),
        },
      }));
      showToast('已使用 AI 生成本期對帳單！');
    } catch {
      setReminders((current) => ({ ...current, [member.id]: { style, loading: false, error: true } }));
      showToast('AI 連線失敗，請檢查網路或 API 設定');
    }
  }

  function reminderText(member: Member): string {
    return reminders[member.id]?.text ?? buildReminder(data, member, getMemberBalanceSummary(member, data));
  }

  async function copyReminder(member: Member): Promise<void> {
    try {
      await navigator.clipboard.writeText(reminderText(member));
      showToast(`已複製 ${member.name} 的詳細帳單明細！`);
    } catch {
      showToast('無法存取剪貼簿');
    }
  }

  function shareReminder(member: Member): void {
    const encoded = encodeURIComponent(reminderText(member));
    const mobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    window.open(mobile ? `https://line.me/R/share?text=${encoded}` : `https://social-plugins.line.me/lineit/share?text=${encoded}`, '_blank', 'noopener,noreferrer');
  }

  async function handleSendChatMessage(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const message = aiInput.trim();
    if (!message || aiLoading) return;
    setAiInput('');
    setAiMessages((current) => [...current, { id: crypto.randomUUID(), role: 'user', content: message }]);
    setAiLoading(true);
    try {
      const response = await apiFetch('/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, history: aiMessages.filter((item) => item.role !== 'system') }),
      });
      const result = await response.json() as ChatResponse;
      if (!response.ok || !result.success || !result.history) {
        setAiMessages((current) => [...current, { id: crypto.randomUUID(), role: 'assistant', content: `對話失敗：${result.error ?? '伺服器錯誤'}` }]);
        showToast(`對話失敗：${result.error ?? '未知錯誤'}`);
        return;
      }
      const history = normalizeMessages(result.history);
      setAiMessages(history.length > 0 ? history : [GREETING]);
    } catch {
      setAiMessages((current) => [...current, { id: crypto.randomUUID(), role: 'assistant', content: '連線失敗，無法取得 AI 回覆。' }]);
      showToast('連線 AI 助理失敗，請確認伺服器與 API 金鑰狀態');
    } finally {
      setAiLoading(false);
    }
  }

  const currentBalances: BalanceEntry[] = summary.memberSummaries.map(({ member, summary: balance }) => ({
    memberId: member.id,
    memberName: member.name,
    priorBalance: member.priorBalance,
    subscriptionFee: balance.monthlyFee,
    tempCharge: balance.tempCharges,
    paid: balance.paid,
    endingBalance: balance.outstanding,
  }));

  const membersByBalance = [...summary.memberSummaries].sort((left, right) => right.summary.outstanding - left.summary.outstanding);
  const sharedPlatforms = summary.activePlatforms.map((platform) => ({
    platform,
    perSeat: getPlatformPrice(platform, data, data.currentMonth),
    seats: data.subscriptions.filter((subscription) => (
      ((subscription.platformId && subscription.platformId === platform.id) || subscription.platformName === platform.name)
      && isSubscriptionBillable(subscription, data, data.currentMonth)
    )),
  })).filter((item) => item.seats.length > 0);
  const newestFirst = <T,>(items: T[]): T[] => [...items].reverse();

  return (
    <>
      <div className="overview-grid">
        <article className="card collect-card">
          <header className="card-head">
            <div>
              <h2>本期收款</h2>
              <p className="meta">{data.currentMonth} · {summary.activeMembers.length} 位成員 · {summary.activeSeatCount} 個名額</p>
            </div>
            <button type="button" className="btn" onClick={() => exportBillingCsv(data.currentMonth, currentBalances, data.payments, data.tempCharges)}>
              <Download size={16} />匯出當月報表
            </button>
          </header>

          <div className="collect-sum">
            <div>
              <span className="label">還沒收到</span>
              <strong className="figure">{formatMoney(summary.totalReceivables)}</strong>
            </div>
            <dl className="collect-facts">
              <div><dt>已收</dt><dd className="positive">+{formatMoney(summary.totalPayments)}</dd></div>
              <div><dt>預繳結轉</dt><dd className={summary.prepaidTotal === 0 ? 'zero' : undefined}>{formatMoney(summary.prepaidTotal)}</dd></div>
            </dl>
          </div>
          <div className="progress" role="img" aria-label={`本期已收回 ${collectionRate}%`}>
            <span style={{ width: `${collectionRate}%` }} />
          </div>
          <div className="progress-labels"><span>已收回 {collectionRate}%</span><span>應收合計 {formatMoney(summary.totalBilled)}</span></div>

          <ul className="member-list">
            {membersByBalance.map(({ member, summary: balance }) => {
              const activeSubscriptions = data.subscriptions.filter((subscription) => (
                subscription.memberName === member.name && isSubscriptionBillable(subscription, data, data.currentMonth)
              ));
              const reminder = reminders[member.id];
              const reminderStyle = reminder?.style ?? 'friendly';
              const expanded = expandedMember === member.id;
              const detailId = `member-detail-${member.id}`;
              return (
                <li key={member.id} className={`member-row${expanded ? ' expanded' : ''}`}>
                  <div className="member-line">
                    <span className="avatar" style={memberToneStyle(data.members, member)} aria-hidden="true">{initialOf(member.name)}</span>
                    <div className="member-text">
                      <strong>{member.name}{isArchivedEntity(member) && <span className="pill">已停用</span>}</strong>
                      <span>{member.customFee !== null ? `自訂月費 ${formatMoney(member.customFee)}` : activeSubscriptions.length > 0 ? activeSubscriptions.map(getSubscriptionDisplayName).join('、') : '本期沒有計費中的名額'}</span>
                    </div>
                    <div className="member-amount">
                      {balance.outstanding > 0 ? (
                        <>
                          <strong>{formatMoney(balance.outstanding)}</strong>
                          <span>{balance.paid > 0 ? `已付 ${formatMoney(balance.paid)}` : '待收'}</span>
                        </>
                      ) : balance.outstanding < 0
                        ? <span className="pill accent">預繳 {formatMoney(-balance.outstanding)}</span>
                        : <span className="pill pos">已結清</span>}
                    </div>
                    <div className="member-actions">
                      <button type="button" className="btn" onClick={() => openTransaction('payment', member.name)}>記錄收款</button>
                      <button
                        type="button"
                        className="icon-btn"
                        aria-label={`${member.name} 的明細與催繳`}
                        aria-expanded={expanded}
                        aria-controls={detailId}
                        onClick={() => setExpandedMember(expanded ? '' : member.id)}
                      >
                        <ChevronDown size={18} />
                      </button>
                    </div>
                  </div>

                  {expanded && (
                    <div className="member-detail" id={detailId}>
                      <dl className="breakdown">
                        <div><dt>前期餘額</dt><dd>{formatMoney(member.priorBalance)}</dd></div>
                        <div><dt>本期訂閱費</dt><dd>{formatMoney(balance.monthlyFee)}</dd></div>
                        <div><dt>臨時加帳</dt><dd>{formatMoney(balance.tempCharges)}</dd></div>
                        <div><dt>已付</dt><dd className={balance.paid > 0 ? 'positive' : undefined}>+{formatMoney(balance.paid)}</dd></div>
                        <div className="breakdown-total"><dt>待收</dt><dd>{formatMoney(balance.outstanding)}</dd></div>
                      </dl>
                      <div className="detail-actions">
                        {balance.outstanding > 0 && (
                          <div className="reminder-tools">
                            <select aria-label={`${member.name} AI 對帳單語氣`} className="input" value={reminderStyle} onChange={(event) => setReminders((current) => ({ ...current, [member.id]: { ...current[member.id], style: event.target.value as ReminderStyle } }))}>
                              <option value="friendly">溫柔幽默</option><option value="professional">專業商務</option><option value="pirate">狂野海盜</option>
                            </select>
                            <button type="button" className="btn" disabled={reminder?.loading} onClick={() => void generateAiReminder(member, reminderStyle)}>{reminder?.loading ? '生成中...' : 'AI 生成'}</button>
                          </div>
                        )}
                        {reminder?.text && (
                          <div className="reminder-ready">
                            <span className="pill pos">AI 對帳單已就緒</span>
                            <button
                              type="button"
                              className="btn btn-ghost"
                              onClick={() => setReminders((current) => {
                                const next = { ...current };
                                delete next[member.id];
                                return next;
                              })}
                            >
                              重設
                            </button>
                          </div>
                        )}
                        <div className="detail-buttons">
                          <button type="button" className="btn btn-primary" onClick={() => shareReminder(member)}>送出 LINE 帳單</button>
                          <button type="button" className="btn" onClick={() => void copyReminder(member)}>複製腳本</button>
                          <button type="button" className="btn" onClick={() => openTransaction('charge', member.name)}>記錄加帳</button>
                        </div>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </article>

        <div className="overview-side">
          <article className="card">
            <header className="card-head">
              <h2>帳務檢查</h2>
              <span className={`pill ${closeGateClear ? 'pos' : 'neg'}`}>{closeGateClear ? '可以月結' : '月結會被擋下'}</span>
            </header>
            <ul className="check-list">
              <li><span>帳務稽核</span><span className={summary.criticalAuditCount === 0 ? 'check-ok' : 'check-bad'}>{summary.criticalAuditCount === 0 ? '通過' : `${summary.criticalAuditCount} 項重大`}</span></li>
              <li><span>事件鏈</span><span className={summary.ledger.ok ? 'check-ok' : 'check-bad'}>{summary.ledger.ok ? `完整，${summary.ledger.count} 筆` : '異常'}</span></li>
              <li><span>歷史封存</span><span className={summary.historyIntegrity.ok ? 'check-ok' : 'check-bad'}>{summary.historyIntegrity.ok ? `完整，${summary.historyIntegrity.sealedCount} 期` : '異常'}</span></li>
            </ul>
            {summary.auditWarnings.length > 0 && (
              <div className="notes">
                <h3>{summary.auditWarnings.length} 則提醒{summary.auditWarnings.length > 2 && <span className="meta">，顯示前 2 則</span>}</h3>
                <ul>
                  {summary.auditWarnings.slice(0, 2).map((warning) => (
                    <li key={warning.id || warning.code} className={warning.severity === 'critical' || warning.severity === 'high' ? 'note-strong' : undefined}>
                      <strong>{warning.title}</strong>
                      <p>{warning.detail}</p>
                      {warning.impact && <p>{warning.impact}</p>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </article>

          <article className="card">
            <header className="card-head">
              <h2>最近操作</h2>
              <span className="meta">{summary.ledger.count} 筆事件</span>
            </header>
            {summary.ledger.recent.length === 0 ? <p className="empty">還沒有任何操作紀錄，登記第一筆收款後會出現在這裡。</p> : (
              <ul className="event-list">
                {summary.ledger.recent.slice(0, 4).map((event) => (
                  <li key={event.id}>
                    <strong>{event.summary}</strong>
                    <span>{formatEventTime(event.at)} · {formatLedgerType(event.type)}</span>
                  </li>
                ))}
              </ul>
            )}
          </article>
        </div>

        <article className="card ledger-card">
          <header className="card-head">
            <div><h2>本期流水帳</h2><p className="meta">有效收款 {activePaymentCount} 筆 · 臨時加帳 {activeChargeCount} 筆</p></div>
          </header>
          <div className="filter-row">
            <label className="search-field">
              <Search size={16} aria-hidden="true" />
              <input id="log-search" className="input" aria-label="搜尋流水帳" placeholder="備註、說明或成員" value={logSearch} onChange={(event) => setLogSearch(event.target.value)} />
            </label>
            <select className="input" aria-label="依成員篩選流水帳" value={logMember} onChange={(event) => setLogMember(event.target.value)}>
              <option value="">全部成員</option>{data.members.map((member) => <option key={member.id} value={member.name}>{member.name}</option>)}
            </select>
            {(logSearch || logMember) && <button type="button" className="btn btn-ghost" onClick={() => { setLogSearch(''); setLogMember(''); }}>清除篩選</button>}
          </div>

          <div className="ledger-columns">
            <div className="log-group">
              <h3>收款 <span>顯示 {filteredPayments.length} / {data.payments.length} 筆</span></h3>
              {filteredPayments.length === 0 ? <p className="empty">{data.payments.length === 0 ? '本期還沒有收款。' : '沒有符合篩選的收款。'}</p> : (
                <ul className="log-list">
                  {newestFirst(filteredPayments).map((payment) => {
                    const voided = isVoidedTransaction(payment);
                    return (
                      <li key={payment.id} className={voided ? 'voided' : undefined}>
                        <span className="avatar avatar-sm" style={memberToneStyle(data.members, { id: payment.memberId, name: payment.memberName })} aria-hidden="true">{initialOf(payment.memberName)}</span>
                        <div className="log-text">
                          <strong>{payment.memberName}{voided && <span className="pill">已作廢</span>}</strong>
                          <span>{payment.date} · {payment.method}{payment.note ? ` · ${payment.note}` : ''}</span>
                        </div>
                        <span className={`log-amount${voided ? '' : ' positive'}`}>+{formatMoney(payment.amount)}</span>
                        <button type="button" className="icon-btn" aria-label={`作廢 ${payment.memberName} 的付款`} onClick={() => void voidTransaction('payment', payment.id)} disabled={voided}><X size={16} /></button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
            <div className="log-group">
              <h3>臨時加帳 <span>顯示 {filteredCharges.length} / {data.tempCharges.length} 筆</span></h3>
              {filteredCharges.length === 0 ? <p className="empty">{data.tempCharges.length === 0 ? '本期沒有臨時加帳。' : '沒有符合篩選的加帳。'}</p> : (
                <ul className="log-list">
                  {newestFirst(filteredCharges).map((charge) => {
                    const voided = isVoidedTransaction(charge);
                    return (
                      <li key={charge.id} className={voided ? 'voided' : undefined}>
                        <span className="avatar avatar-sm" style={memberToneStyle(data.members, { id: charge.memberId, name: charge.memberName })} aria-hidden="true">{initialOf(charge.memberName)}</span>
                        <div className="log-text">
                          <strong>{charge.memberName}{voided && <span className="pill">已作廢</span>}</strong>
                          <span>{charge.date ?? '—'}{charge.desc ? ` · ${charge.desc}` : ''}</span>
                        </div>
                        <span className="log-amount">{formatMoney(charge.amount)}</span>
                        <button type="button" className="icon-btn" aria-label={`作廢 ${charge.memberName} 的臨時加帳`} onClick={() => void voidTransaction('temp-charge', charge.id)} disabled={voided}><X size={16} /></button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
        </article>
        <article className="card share-card">
          <header className="card-head">
            <div><h2>本期分攤</h2><p className="meta">每個平台的名額與每人月費</p></div>
          </header>
          {sharedPlatforms.length === 0 ? <p className="empty">本期沒有計費中的平台。</p> : (
            <ul className="share-list">
              {sharedPlatforms.map(({ platform, perSeat, seats }) => (
                <li key={platform.id}>
                  <div className="share-head">
                    <div>
                      <strong>{platform.name}</strong>
                      <span>{platform.billingMode === 'split' ? `總價 ${formatMoney(platform.totalCost)}，${seats.length} 人均分` : `固定價格，${seats.length} 人`}</span>
                    </div>
                    <strong className="share-price">{formatMoney(perSeat)}<small>/人</small></strong>
                  </div>
                  <div className="seat-strip">
                    {seats.map((seat) => (
                      <span key={seat.id} className="seat" style={memberToneStyle(data.members, { id: seat.memberId, name: seat.memberName })}>
                        {seat.memberName}{seat.seatLabel ? ` · ${seat.seatLabel}` : ''}
                      </span>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </article>

      </div>

      {workspaceMounted && (
        <div hidden={!active} className="ai-workspace-grid">
          <Suspense fallback={<div className="card workspace-loading" role="status">正在載入自動化工具...</div>}><AutomationTab active={active} apiFetch={apiFetch} onDataChange={refreshData} /></Suspense>
          <Suspense fallback={<div className="card workspace-loading" role="status">正在載入 AI 帳務助理...</div>}><AiAssistantTab aiMessages={aiMessages} aiInput={aiInput} setAiInput={setAiInput} aiLoading={aiLoading} handleSendChatMessage={handleSendChatMessage} /></Suspense>
        </div>
      )}

      <Modal open={paymentOpen} onClose={() => setPaymentOpen(false)} labelledBy="payment-modal-title" initialFocusRef={paymentAmountRef}>
        <div className="modal-head"><h2 id="payment-modal-title" className="modal-title">登記收款：{selectedMember}</h2><button type="button" className="icon-btn" aria-label="關閉登記收款" onClick={() => setPaymentOpen(false)}><X size={18} /></button></div>
        <form className="form-stack" onSubmit={handleAddPayment}>
          <div className="field"><label htmlFor="payment-amount">付款金額 (NT$)</label><input id="payment-amount" ref={paymentAmountRef} type="number" inputMode="numeric" className="input" value={amount} onChange={(event) => setAmount(event.target.value)} required /></div>
          <div className="field-pair">
            <div className="field"><label htmlFor="payment-date">付款日期</label><input id="payment-date" type="date" className="input" value={date} onChange={(event) => setDate(event.target.value)} /></div>
            <div className="field"><label htmlFor="payment-method">付款方式</label><select id="payment-method" className="input" value={paymentMethod} onChange={(event) => setPaymentMethod(event.target.value)}><option>轉帳</option><option>LINE Pay</option><option>現金</option><option>銀行匯款</option><option>其他</option></select></div>
          </div>
          <div className="field"><label htmlFor="payment-note">備註 (可選)</label><input id="payment-note" className="input" value={description} onChange={(event) => setDescription(event.target.value)} /></div>
          <p className="hint">10 分鐘內同成員、同日期、同金額、同付款方式與同備註的收款會被當成重複而擋下。</p>
          <div className="modal-actions"><button type="button" className="btn" onClick={() => setPaymentOpen(false)} disabled={savingTransaction === 'payment'}>取消</button><button type="submit" className="btn btn-primary" disabled={savingTransaction === 'payment'}>{savingTransaction === 'payment' ? '登記中...' : '確認登記'}</button></div>
        </form>
      </Modal>

      <Modal open={chargeOpen} onClose={() => setChargeOpen(false)} labelledBy="charge-modal-title" initialFocusRef={chargeAmountRef}>
        <div className="modal-head"><h2 id="charge-modal-title" className="modal-title">登記臨時加帳：{selectedMember}</h2><button type="button" className="icon-btn" aria-label="關閉登記臨時加帳" onClick={() => setChargeOpen(false)}><X size={18} /></button></div>
        <form className="form-stack" onSubmit={handleAddCharge}>
          <div className="field-pair">
            <div className="field"><label htmlFor="charge-amount">加帳金額 (NT$)</label><input id="charge-amount" ref={chargeAmountRef} type="number" inputMode="numeric" className="input" value={amount} onChange={(event) => setAmount(event.target.value)} required /></div>
            <div className="field"><label htmlFor="charge-date">加帳日期</label><input id="charge-date" type="date" className="input" value={date} onChange={(event) => setDate(event.target.value)} /></div>
          </div>
          <div className="field"><label htmlFor="charge-description">加帳事項說明</label><input id="charge-description" className="input" value={description} onChange={(event) => setDescription(event.target.value)} required /></div>
          <p className="hint">10 分鐘內同成員、同日期、同金額與同說明的加帳會被當成重複而擋下。</p>
          <div className="modal-actions"><button type="button" className="btn" onClick={() => setChargeOpen(false)} disabled={savingTransaction === 'charge'}>取消</button><button type="submit" className="btn btn-primary" disabled={savingTransaction === 'charge'}>{savingTransaction === 'charge' ? '登記中...' : '確認登記'}</button></div>
        </form>
      </Modal>
    </>
  );
}
