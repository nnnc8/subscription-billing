import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
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
  return `🔔 ${member.name}，${data.currentMonth} 的訂閱帳單來了！\n\n本期服務：\n${services.join('\n')}\n\n${details}\n\n${balanceNote}\n\n轉帳後再跟我說一聲，謝謝！`;
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
        setAiMessages((current) => [...current, { id: crypto.randomUUID(), role: 'assistant', content: `❌ 對話失敗：${result.error ?? '伺服器錯誤'}` }]);
        showToast(`對話失敗：${result.error ?? '未知錯誤'}`);
        return;
      }
      const history = normalizeMessages(result.history);
      setAiMessages(history.length > 0 ? history : [GREETING]);
    } catch {
      setAiMessages((current) => [...current, { id: crypto.randomUUID(), role: 'assistant', content: '❌ 連線失敗，無法取得 AI 回覆。' }]);
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

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '1rem' }}>
        <button type="button" className="btn btn-secondary" onClick={() => exportBillingCsv(data.currentMonth, currentBalances, data.payments, data.tempCharges)}>
          匯出當月報表
        </button>
      </div>

      <section className="operator-briefing-cards" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: '1.25rem', marginBottom: '1.5rem' }}>
        <div className="operator-card">
          <span>待收清單</span><strong>{formatMoney(summary.totalReceivables)}</strong>
          <small>{summary.unpaidMembersCount} 人待收 · 收回 {collectionRate}%</small>
          <div className="queue-list">
            {summary.receivableQueue.length === 0 ? <p>目前沒有待收款。</p> : summary.receivableQueue.slice(0, 3).map((item) => (
              <button type="button" key={item.member.id} className="queue-row" onClick={() => openTransaction('payment', item.member.name)}>
                <span>{item.member.name}{isArchivedEntity(item.member) ? '（已停用）' : ''}</span>
                <strong>{formatMoney(item.summary.outstanding)}</strong>
              </button>
            ))}
          </div>
        </div>
        <div className="operator-card">
          <span>帳務完整性</span><strong>{closeGateClear ? '可預檢' : '暫停'}</strong>
          <small>{summary.auditWarnings.length} 個提醒 · 事件鏈 {summary.ledger.count} 筆</small>
          <div className="gate-list">
            <div className={summary.criticalAuditCount === 0 ? 'pass' : 'fail'}><b>{summary.criticalAuditCount === 0 ? '✓' : '!'}</b>帳務稽核</div>
            <div className={summary.ledger.ok ? 'pass' : 'fail'}><b>{summary.ledger.ok ? '✓' : '!'}</b>事件鏈</div>
            <div className={summary.historyIntegrity.ok ? 'pass' : 'fail'}><b>{summary.historyIntegrity.ok ? '✓' : '!'}</b>歷史封存</div>
          </div>
        </div>
        <div className="operator-card">
          <span>本期收支</span><strong>{formatMoney(summary.totalPayments)}</strong>
          <small>有效 {activePaymentCount} 筆收款 · {summary.activeSeatCount} 個使用中名額</small>
          <div className="evidence-strip"><code>{summary.ledger.lastHash?.slice(0, 10) ?? 'genesis'}</code><span>預收/溢繳 {formatMoney(summary.prepaidTotal)}</span></div>
        </div>
      </section>

      {summary.auditWarnings.length > 0 && (
        <section className={`audit-banner ${summary.criticalAuditCount > 0 ? 'critical' : 'warning'}`}>
          <div className="audit-banner-header"><div><span className="audit-kicker">Audit feed</span><h2>{summary.auditWarnings.length} 個帳務提醒</h2></div><span className="audit-count">{summary.auditWarnings.length}</span></div>
          <div className="audit-list">
            {summary.auditWarnings.slice(0, 4).map((warning) => (
              <div key={warning.id || warning.code} className="audit-item">
                <span className={`audit-severity ${warning.severity}`}>{warning.severity === 'critical' ? '高' : '提'}</span>
                <div><strong>{warning.title}</strong><p>{warning.detail}</p>{warning.impact && <p className="audit-impact">{warning.impact}</p>}</div>
              </div>
            ))}
          </div>
        </section>
      )}

      {summary.ledger.recent.length > 0 && (
        <section className="ledger-panel">
          <div className="ledger-header"><div><span>事件紀錄</span><h2>最近操作</h2></div><code>{summary.ledger.lastHash?.slice(0, 12) ?? 'genesis'}</code></div>
          <div className="ledger-list">
            {summary.ledger.recent.slice(0, 5).map((event) => (
              <div className="ledger-item" key={event.id}>
                <span className="ledger-type">{formatLedgerType(event.type)}</span>
                <div><strong>{event.summary}</strong><p>{formatEventTime(event.at)} · {event.month || data.currentMonth}</p></div>
                <code>{event.hash.slice(0, 8)}</code>
              </div>
            ))}
          </div>
        </section>
      )}

      <div className="dashboard-grid">
        {summary.memberSummaries.map(({ member, summary: balance }) => {
          const activeSubscriptions = data.subscriptions.filter((subscription) => (
            subscription.memberName === member.name && isSubscriptionBillable(subscription, data, data.currentMonth)
          ));
          const reminder = reminders[member.id];
          const reminderStyle = reminder?.style ?? 'friendly';
          return (
            <article key={member.id} className={`card ${balance.outstanding <= 0 ? 'paid' : 'unpaid'}`}>
              <div className="card-header" style={{ flexDirection: 'column', alignItems: 'stretch', gap: '0.5rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}><span className="avatar avatar-initials" aria-hidden="true">{member.name.slice(0, 1)}</span><h3 className="member-name">{member.name}</h3></div>
                  <span className={`status-badge ${balance.outstanding <= 0 ? 'paid' : 'unpaid'}`}>{balance.outstanding <= 0 ? 'SETTLED' : 'OPEN'}</span>
                </div>
                <div style={{ display: 'flex', gap: '0.25rem', flexWrap: 'wrap' }}>{activeSubscriptions.map((subscription) => <span key={subscription.id} className="nav-pill">{getSubscriptionDisplayName(subscription)}</span>)}</div>
              </div>
              <div className="card-body">
                <div className="data-row"><span className="data-label">前期餘額結轉</span><span className="data-value">{formatMoney(member.priorBalance)}</span></div>
                <div className="data-row"><span className="data-label">本期訂閱費用</span><span className="data-value">{formatMoney(balance.monthlyFee)}</span></div>
                <div className="data-row"><span className="data-label">本期臨時費用</span><span className="data-value">{formatMoney(balance.tempCharges)}</span></div>
                <div className="data-row"><span className="data-label">本期已繳納款項</span><span className="data-value">-{formatMoney(balance.paid)}</span></div>
                <div className="data-row"><strong>待收餘額</strong><strong className={`data-value outstanding ${balance.outstanding > 0 ? 'positive' : 'negative'}`}>{formatMoney(balance.outstanding)}</strong></div>
              </div>
              <div className="card-actions" style={{ flexWrap: 'wrap' }}>
                {balance.outstanding > 0 && (
                  <div style={{ display: 'flex', gap: '0.35rem', width: '100%' }}>
                    <select aria-label={`${member.name} AI 對帳單語氣`} className="form-control" value={reminderStyle} onChange={(event) => setReminders((current) => ({ ...current, [member.id]: { ...current[member.id], style: event.target.value as ReminderStyle } }))}>
                      <option value="friendly">溫柔幽默</option><option value="professional">專業商務</option><option value="pirate">狂野海盜</option>
                    </select>
                    <button type="button" className="btn btn-secondary" disabled={reminder?.loading} onClick={() => void generateAiReminder(member, reminderStyle)}>{reminder?.loading ? '生成中...' : 'AI 生成'}</button>
                  </div>
                )}
                {reminder?.text && (
                  <div style={{ width: '100%', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <small style={{ color: 'var(--success)' }}>AI 對帳單已就緒</small>
                    <button
                      type="button"
                      className="btn btn-secondary"
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
                <div style={{ display: 'flex', gap: '0.35rem', width: '100%' }}>
                  <button type="button" className="btn btn-secondary" onClick={() => openTransaction('payment', member.name)}>記錄收款</button>
                  <button type="button" className="btn btn-secondary" onClick={() => openTransaction('charge', member.name)}>記錄加帳</button>
                </div>
                <button type="button" className="btn btn-success" onClick={() => shareReminder(member)}>送出 LINE 帳單</button>
                <button type="button" className="btn btn-secondary" onClick={() => void copyReminder(member)}>複製腳本</button>
              </div>
            </article>
          );
        })}
      </div>

      <section className="table-container filter-bar" style={{ margin: '1.5rem 0', padding: '14px 24px' }}>
        <strong>流水帳檢索</strong>
        <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
          <input id="log-search" className="form-control" aria-label="搜尋流水帳" placeholder="備註、說明或成員" value={logSearch} onChange={(event) => setLogSearch(event.target.value)} />
          <select className="form-control" aria-label="依成員篩選流水帳" value={logMember} onChange={(event) => setLogMember(event.target.value)}>
            <option value="">全部成員</option>{data.members.map((member) => <option key={member.id} value={member.name}>{member.name}</option>)}
          </select>
          {(logSearch || logMember) && <button type="button" className="btn btn-secondary" onClick={() => { setLogSearch(''); setLogMember(''); }}>重設</button>}
        </div>
      </section>

      <div className="logs-section">
        <section className="log-panel">
          <h3><span>本期收款流水帳</span><small>顯示 {filteredPayments.length} 筆 / 有效 {activePaymentCount} 筆</small></h3>
          <div className="log-list">{filteredPayments.length === 0 ? <p className="recovery-empty">無符合條件之收款資料</p> : filteredPayments.map((payment) => {
            const voided = isVoidedTransaction(payment);
            return <div key={payment.id} className={`log-item ${voided ? 'voided' : ''}`}><div className="log-info"><strong>{payment.memberName}{voided && <span className="void-badge">作廢</span>}</strong><span className="log-meta">{payment.date} · {payment.method}{payment.note ? ` · ${payment.note}` : ''}</span></div><div className="log-amount"><span>{formatMoney(payment.amount)}</span><button type="button" className="btn btn-danger btn-icon-only" aria-label={`作廢 ${payment.memberName} 的付款`} onClick={() => void voidTransaction('payment', payment.id)} disabled={voided}>×</button></div></div>;
          })}</div>
        </section>
        <section className="log-panel">
          <h3><span>本期臨時費用帳</span><small>顯示 {filteredCharges.length} 筆 / 有效 {activeChargeCount} 筆</small></h3>
          <div className="log-list">{filteredCharges.length === 0 ? <p className="recovery-empty">無符合條件之臨時加帳</p> : filteredCharges.map((charge) => {
            const voided = isVoidedTransaction(charge);
            return <div key={charge.id} className={`log-item ${voided ? 'voided' : ''}`}><div className="log-info"><strong>{charge.memberName}{voided && <span className="void-badge">作廢</span>}</strong><span className="log-meta">{charge.date ?? '—'}{charge.desc ? ` · ${charge.desc}` : ''}</span></div><div className="log-amount"><span>{formatMoney(charge.amount)}</span><button type="button" className="btn btn-danger btn-icon-only" aria-label={`作廢 ${charge.memberName} 的臨時加帳`} onClick={() => void voidTransaction('temp-charge', charge.id)} disabled={voided}>×</button></div></div>;
          })}</div>
        </section>
      </div>

      {workspaceMounted && (
        <div hidden={!active} className="ai-workspace-grid">
          <Suspense fallback={<div className="table-container ai-workspace-loading" role="status">正在載入自動化工具...</div>}><AutomationTab active={active} apiFetch={apiFetch} onDataChange={refreshData} /></Suspense>
          <Suspense fallback={<div className="table-container ai-workspace-loading" role="status">正在載入 AI 帳務助理...</div>}><AiAssistantTab aiMessages={aiMessages} aiInput={aiInput} setAiInput={setAiInput} aiLoading={aiLoading} handleSendChatMessage={handleSendChatMessage} /></Suspense>
        </div>
      )}

      <Modal open={paymentOpen} onClose={() => setPaymentOpen(false)} labelledBy="payment-modal-title" initialFocusRef={paymentAmountRef}>
        <div className="modal-header"><h2 id="payment-modal-title" className="modal-title">登記收款：{selectedMember}</h2><button type="button" className="modal-close" aria-label="關閉登記收款" onClick={() => setPaymentOpen(false)}>×</button></div>
        <form onSubmit={handleAddPayment} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <div className="form-group"><label htmlFor="payment-amount">付款金額 (NT$)</label><input id="payment-amount" ref={paymentAmountRef} type="number" className="form-control" value={amount} onChange={(event) => setAmount(event.target.value)} required /></div>
          <div className="form-group"><label htmlFor="payment-date">付款日期</label><input id="payment-date" type="date" className="form-control" value={date} onChange={(event) => setDate(event.target.value)} /></div>
          <div className="form-group"><label htmlFor="payment-method">付款方式</label><select id="payment-method" className="form-control" value={paymentMethod} onChange={(event) => setPaymentMethod(event.target.value)}><option>轉帳</option><option>LINE Pay</option><option>現金</option><option>銀行匯款</option><option>其他</option></select></div>
          <div className="form-group"><label htmlFor="payment-note">備註 (可選)</label><input id="payment-note" className="form-control" value={description} onChange={(event) => setDescription(event.target.value)} /></div>
          <p>系統會阻擋 10 分鐘內同成員、同日期、同金額、同付款方式與同備註的重複收款。</p>
          <div style={{ display: 'flex', gap: '0.75rem' }}><button type="button" className="btn btn-secondary" onClick={() => setPaymentOpen(false)} disabled={savingTransaction === 'payment'}>取消</button><button type="submit" className="btn btn-primary" disabled={savingTransaction === 'payment'}>{savingTransaction === 'payment' ? '登記中...' : '確認登記'}</button></div>
        </form>
      </Modal>

      <Modal open={chargeOpen} onClose={() => setChargeOpen(false)} labelledBy="charge-modal-title" initialFocusRef={chargeAmountRef}>
        <div className="modal-header"><h2 id="charge-modal-title" className="modal-title">登記臨時加帳：{selectedMember}</h2><button type="button" className="modal-close" aria-label="關閉登記臨時加帳" onClick={() => setChargeOpen(false)}>×</button></div>
        <form onSubmit={handleAddCharge} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <div className="form-group"><label htmlFor="charge-amount">加帳金額 (NT$)</label><input id="charge-amount" ref={chargeAmountRef} type="number" className="form-control" value={amount} onChange={(event) => setAmount(event.target.value)} required /></div>
          <div className="form-group"><label htmlFor="charge-date">加帳日期</label><input id="charge-date" type="date" className="form-control" value={date} onChange={(event) => setDate(event.target.value)} /></div>
          <div className="form-group"><label htmlFor="charge-description">加帳事項說明</label><input id="charge-description" className="form-control" value={description} onChange={(event) => setDescription(event.target.value)} required /></div>
          <p>系統會阻擋 10 分鐘內同成員、同日期、同金額與同說明的重複加帳。</p>
          <div style={{ display: 'flex', gap: '0.75rem' }}><button type="button" className="btn btn-secondary" onClick={() => setChargeOpen(false)} disabled={savingTransaction === 'charge'}>取消</button><button type="submit" className="btn btn-primary" disabled={savingTransaction === 'charge'}>{savingTransaction === 'charge' ? '登記中...' : '確認登記'}</button></div>
        </form>
      </Modal>
    </>
  );
}
