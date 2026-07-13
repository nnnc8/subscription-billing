import { useState } from 'react';
import { exportBillingCsv, formatMoney, isVoidedTransaction } from '../billing.js';
import type { Database } from '../types/billing.js';

interface HistoryTabProps {
  data: Database;
}

export function HistoryTab({ data }: HistoryTabProps) {
  const latestMonth = data.history.at(-1)?.month ?? '';
  const [selectedMonth, setSelectedMonth] = useState(latestMonth);

  const selected = data.history.find((entry) => entry.month === selectedMonth) ?? data.history.at(-1);
  const integrity = data._audit?.snapshot.history.integrity;

  if (!selected) {
    return <div className="table-container" role="status" style={{ padding: '2rem' }}>目前尚無已封存帳期。</div>;
  }

  const totals = selected.balances.reduce((summary, balance) => ({
    subscriptionFee: summary.subscriptionFee + balance.subscriptionFee,
    paid: summary.paid + balance.paid,
    endingBalance: summary.endingBalance + balance.endingBalance,
  }), { subscriptionFee: 0, paid: 0, endingBalance: 0 });
  const historySeries = data.history.map((entry) => ({
    month: entry.month,
    fees: entry.balances.reduce((sum, balance) => sum + balance.subscriptionFee, 0),
    paid: entry.balances.reduce((sum, balance) => sum + balance.paid, 0),
  }));
  const chartMaximum = Math.max(1, ...historySeries.flatMap((entry) => [entry.fees, entry.paid]));

  return (
    <>
      <section className="table-container" style={{ padding: '1.25rem', marginBottom: '1.5rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'end', gap: '1rem', flexWrap: 'wrap' }}>
          <div>
            <span className="audit-kicker">唯讀歷史</span>
            <h2 style={{ margin: '0.25rem 0' }}>已封存帳期</h2>
            <p style={{ color: 'var(--text-muted)', margin: 0 }}>歷史資料只供檢視與匯出，不能回到舊月份修改。</p>
          </div>
          <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'end', flexWrap: 'wrap' }}>
            <div className="form-group">
              <label htmlFor="history-month">帳期</label>
              <select id="history-month" className="form-control" value={selected.month} onChange={(event) => setSelectedMonth(event.target.value)}>
                {data.history.map((entry) => <option key={entry.month} value={entry.month}>{entry.month}</option>)}
              </select>
            </div>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => exportBillingCsv(selected.month, selected.balances, selected.payments, selected.tempCharges)}
            >
              匯出此期報表
            </button>
          </div>
        </div>
      </section>

      <section className="ops-strip" aria-label="歷史帳期摘要">
        <div className="ops-tile"><span>SUBSCRIPTION</span><strong>{formatMoney(totals.subscriptionFee)}</strong><small>本期訂閱費</small></div>
        <div className="ops-tile"><span>POSTED CASH</span><strong>{formatMoney(totals.paid)}</strong><small>本期已入帳</small></div>
        <div className="ops-tile"><span>ENDING BALANCE</span><strong>{formatMoney(totals.endingBalance)}</strong><small>期末餘額</small></div>
        <div className={`ops-tile ${integrity?.ok === false ? 'risk' : 'clear'}`}>
          <span>ARCHIVE</span>
          <strong>{selected.seal?.hash ? '已封存' : '缺少封存'}</strong>
          <small>{selected.seal?.hash ? selected.seal.hash.slice(0, 12) : '請檢查資料完整性'}</small>
        </div>
      </section>

      {integrity ? (
        <section className={`history-seal-panel ${integrity.ok ? 'clear' : 'risk'}`} aria-label="歷史封存完整性">
          <div><span>封存鏈</span><h2>{integrity.ok ? '歷史帳完整' : '歷史帳異常'}</h2></div>
          <div><span>封存月份</span><strong>{integrity.sealedCount}/{integrity.count}</strong></div>
          <div><span>最新月份</span><strong>{integrity.latestMonth ?? '—'}</strong></div>
          <div><span>最新指紋</span><code>{integrity.latestHash?.slice(0, 12) ?? 'pending'}</code></div>
          {integrity.problems.length > 0 && (
            <div className="history-seal-problems">
              {integrity.problems.slice(0, 3).map((problem) => <p key={`${problem.code}-${problem.month ?? 'unknown'}`}>{problem.detail}</p>)}
            </div>
          )}
        </section>
      ) : (
        <section className="history-seal-panel risk" role="alert"><div><span>封存鏈</span><h2>完整性資料目前無法取得</h2></div></section>
      )}

      <section className="table-container" style={{ padding: '1.25rem', marginBottom: '1.5rem' }} aria-label="歷史訂閱費與收款趨勢">
        <h2 style={{ fontSize: '1rem' }}>歷史收支趨勢</h2>
        <div style={{ display: 'flex', alignItems: 'end', gap: '1rem', minHeight: '180px', overflowX: 'auto', padding: '1rem 0' }}>
          {historySeries.map((entry) => (
            <button
              key={entry.month}
              type="button"
              className="history-bar-group"
              aria-label={`${entry.month}：訂閱費 ${formatMoney(entry.fees)}，已收 ${formatMoney(entry.paid)}`}
              onClick={() => setSelectedMonth(entry.month)}
              style={{ minWidth: '64px', height: '150px', display: 'grid', gridTemplateColumns: '1fr 1fr', alignItems: 'end', gap: '4px', background: 'none', border: 0, color: 'inherit' }}
            >
              <span title={`訂閱費 ${formatMoney(entry.fees)}`} style={{ height: `${Math.max(4, entry.fees / chartMaximum * 120)}px`, background: 'var(--blue)', borderRadius: '4px 4px 0 0' }} />
              <span title={`已收 ${formatMoney(entry.paid)}`} style={{ height: `${Math.max(4, entry.paid / chartMaximum * 120)}px`, background: 'var(--green)', borderRadius: '4px 4px 0 0' }} />
              <small style={{ gridColumn: '1 / -1', whiteSpace: 'nowrap' }}>{entry.month.slice(2)}</small>
            </button>
          ))}
        </div>
        <p style={{ color: 'var(--text-muted)', margin: 0 }}><span style={{ color: 'var(--blue)' }}>■</span> 訂閱費 · <span style={{ color: 'var(--green)' }}>■</span> 已收款</p>
      </section>

      <div className="table-container" style={{ marginBottom: '1.5rem' }}>
        <div className="table-wrapper">
          <table>
            <thead>
              <tr><th>成員</th><th>期初餘額</th><th>訂閱費</th><th>臨時加帳</th><th>已付</th><th>期末餘額</th></tr>
            </thead>
            <tbody>
              {selected.balances.map((balance) => (
                <tr key={balance.memberId ?? `${selected.month}-${balance.memberName}`}>
                  <td style={{ fontWeight: 600 }}>{balance.memberName}</td>
                  <td>{formatMoney(balance.priorBalance)}</td>
                  <td>{formatMoney(balance.subscriptionFee)}</td>
                  <td>{formatMoney(balance.tempCharge)}</td>
                  <td>{formatMoney(balance.paid)}</td>
                  <td style={{ fontWeight: 700 }}>{formatMoney(balance.endingBalance)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="logs-section">
        <section className="log-panel">
          <h3><span>收款流水</span><small>{selected.payments.length} 筆</small></h3>
          <div className="log-list">
            {selected.payments.length === 0 ? <p className="recovery-empty">此期沒有收款紀錄</p> : selected.payments.map((payment) => (
              <div key={payment.id} className={`log-item ${isVoidedTransaction(payment) ? 'voided' : ''}`}>
                <div className="log-info">
                  <strong>{payment.memberName}{isVoidedTransaction(payment) && <span className="void-badge">作廢</span>}</strong>
                  <span className="log-meta">{payment.date} · {payment.method}{payment.note ? ` · ${payment.note}` : ''}</span>
                </div>
                <span className="log-amount">{formatMoney(payment.amount)}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="log-panel">
          <h3><span>臨時費用</span><small>{selected.tempCharges.length} 筆</small></h3>
          <div className="log-list">
            {selected.tempCharges.length === 0 ? <p className="recovery-empty">此期沒有臨時加帳</p> : selected.tempCharges.map((charge) => (
              <div key={charge.id} className={`log-item ${isVoidedTransaction(charge) ? 'voided' : ''}`}>
                <div className="log-info">
                  <strong>{charge.memberName}{isVoidedTransaction(charge) && <span className="void-badge">作廢</span>}</strong>
                  <span className="log-meta">{charge.date ?? '—'}{charge.desc ? ` · ${charge.desc}` : ''}</span>
                </div>
                <span className="log-amount">{formatMoney(charge.amount)}</span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </>
  );
}
