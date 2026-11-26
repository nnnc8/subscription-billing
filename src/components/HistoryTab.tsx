import { useState } from 'react';
import type { CSSProperties } from 'react';
import { Download } from 'lucide-react';
import { exportBillingCsv, formatMoney, isVoidedTransaction } from '../billing.js';
import type { Database } from '../types/billing.js';

interface HistoryTabProps {
  data: Database;
}

// A round top for the y axis: four equal steps, each a 1-2-2.5-5 multiple of a power of ten.
function axisTop(maximum: number): number {
  const rough = Math.max(maximum, 1) / 4;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 3, 4, 5, 6, 8, 10].map((factor) => factor * magnitude).find((value) => value >= rough) ?? 10 * magnitude;
  return step * 4;
}

export function HistoryTab({ data }: HistoryTabProps) {
  const latestMonth = data.history.at(-1)?.month ?? '';
  const [selectedMonth, setSelectedMonth] = useState(latestMonth);

  const selected = data.history.find((entry) => entry.month === selectedMonth) ?? data.history.at(-1);
  const integrity = data._audit?.snapshot.history.integrity;

  if (!selected) {
    return <p className="empty-state" role="status">目前尚無已封存帳期。第一個月結束後，帳期會自動封存到這裡。</p>;
  }

  const totals = selected.balances.reduce((summary, balance) => ({
    priorBalance: summary.priorBalance + balance.priorBalance,
    subscriptionFee: summary.subscriptionFee + balance.subscriptionFee,
    tempCharge: summary.tempCharge + balance.tempCharge,
    paid: summary.paid + balance.paid,
    endingBalance: summary.endingBalance + balance.endingBalance,
  }), { priorBalance: 0, subscriptionFee: 0, tempCharge: 0, paid: 0, endingBalance: 0 });
  const historySeries = data.history.map((entry) => ({
    month: entry.month,
    fees: entry.balances.reduce((sum, balance) => sum + balance.subscriptionFee + balance.tempCharge, 0),
    paid: entry.balances.reduce((sum, balance) => sum + balance.paid, 0),
  }));
  const top = axisTop(Math.max(...historySeries.flatMap((entry) => [entry.fees, entry.paid])));
  const ticks = [4, 3, 2, 1, 0].map((step) => (top / 4) * step);
  const height = (value: number) => `${(value / top) * 100}%`;
  const activePayments = selected.payments.filter((payment) => !isVoidedTransaction(payment)).length;
  // The plot keeps a minimum width per month, so a long history scrolls sideways instead of squeezing.
  const trackStyle = { '--cols': historySeries.length } as CSSProperties;

  return (
    <div className="report">
      <article className="block chart-block">
        <header className="section-head">
          <div className="section-title"><h2>每期應收與已收</h2><p className="meta">點一期查看明細。應收含訂閱費與臨時加帳。</p></div>
          <div className="chart-legend">
            <span><i className="swatch swatch-fee" aria-hidden="true" />應收</span>
            <span><i className="swatch swatch-paid" aria-hidden="true" />已收</span>
          </div>
        </header>
        <div className="bar-chart" role="group" aria-label="歷史訂閱費與收款趨勢">
          <div className="bar-axis" aria-hidden="true">
            {ticks.map((tick) => <span key={tick}>{formatMoney(tick)}</span>)}
          </div>
          <div className="bar-plot">
            <div className="bar-track" style={trackStyle}>
              {historySeries.map((entry) => (
                <div key={entry.month} className="bar-col">
                  <span className="bar-pair" aria-hidden="true">
                    <span className={`bar bar-fee${entry.fees > 0 ? '' : ' bar-none'}`} style={{ height: height(entry.fees) }} />
                    <span className={`bar bar-paid${entry.paid > 0 ? '' : ' bar-none'}`} style={{ height: height(entry.paid) }} />
                  </span>
                  <button
                    type="button"
                    className="bar-month"
                    aria-pressed={entry.month === selected.month}
                    aria-label={`${entry.month}：應收 ${formatMoney(entry.fees)}，已收 ${formatMoney(entry.paid)}`}
                    onClick={() => setSelectedMonth(entry.month)}
                  >
                    <span className="bar-month-full">{entry.month}</span>
                    <span className="bar-month-short">{entry.month.slice(5)}</span>
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      </article>

      <article className="card report-main">
        <header className="section-head">
          <div className="section-title">
            <h2>{selected.month} 帳期</h2>
            <p className="meta">唯讀，封存後不能回頭修改。</p>
          </div>
          <div className="report-controls">
            <div className="field">
              <label htmlFor="history-month">帳期</label>
              <select id="history-month" className="input" value={selected.month} onChange={(event) => setSelectedMonth(event.target.value)}>
                {data.history.map((entry) => <option key={entry.month} value={entry.month}>{entry.month}</option>)}
              </select>
            </div>
            <button
              type="button"
              className="btn"
              onClick={() => exportBillingCsv(selected.month, selected.balances, selected.payments, selected.tempCharges)}
            >
              <Download size={16} />匯出此期報表
            </button>
          </div>
        </header>

        <dl className="figures" aria-label="歷史帳期摘要">
          <div className="figure-lead"><dt>期末餘額</dt><dd>{formatMoney(totals.endingBalance)}</dd></div>
          <div><dt>訂閱費</dt><dd>{formatMoney(totals.subscriptionFee)}</dd></div>
          <div><dt>臨時加帳</dt><dd>{formatMoney(totals.tempCharge)}</dd></div>
          <div><dt>已收款</dt><dd className="positive">+{formatMoney(totals.paid)}</dd></div>
        </dl>

        <div className="table-wrap">
          {/* The rows restack as labelled blocks on a narrow sheet, so the table roles are spelled out. */}
          <table className="stack-table" role="table">
            <thead role="rowgroup">
              <tr role="row">
                <th role="columnheader">成員</th><th role="columnheader" className="n">期初</th><th role="columnheader" className="n">訂閱費</th>
                <th role="columnheader" className="n">加帳</th><th role="columnheader" className="n">已付</th><th role="columnheader" className="n">期末</th>
              </tr>
            </thead>
            <tbody role="rowgroup">
              {selected.balances.map((balance) => (
                <tr key={balance.memberId ?? `${selected.month}-${balance.memberName}`} role="row">
                  <td role="cell" className="cell-lead">{balance.memberName}</td>
                  <td role="cell" className="n" data-label="期初">{formatMoney(balance.priorBalance)}</td>
                  <td role="cell" className="n" data-label="訂閱費">{formatMoney(balance.subscriptionFee)}</td>
                  <td role="cell" className="n" data-label="加帳">{formatMoney(balance.tempCharge)}</td>
                  <td role="cell" className="n" data-label="已付">{formatMoney(balance.paid)}</td>
                  <td role="cell" className="n strong" data-label="期末">{formatMoney(balance.endingBalance)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot role="rowgroup">
              <tr role="row">
                <td role="cell" className="cell-lead">合計</td>
                <td role="cell" className="n" data-label="期初">{formatMoney(totals.priorBalance)}</td>
                <td role="cell" className="n" data-label="訂閱費">{formatMoney(totals.subscriptionFee)}</td>
                <td role="cell" className="n" data-label="加帳">{formatMoney(totals.tempCharge)}</td>
                <td role="cell" className="n" data-label="已付">{formatMoney(totals.paid)}</td>
                <td role="cell" className="n" data-label="期末">{formatMoney(totals.endingBalance)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </article>

      <div className="report-side">
        <article className="block" aria-label="歷史封存完整性">
          <header className="section-head">
            <h2>封存鏈</h2>
            {integrity
              ? <span className={`pill ${integrity.ok ? 'pos' : 'neg'}`}>{integrity.ok ? '歷史帳完整' : '歷史帳異常'}</span>
              : <span className="pill neg">無法取得</span>}
          </header>
          {integrity ? (
            <>
              <dl className="kv ruled">
                <div><dt>已封存</dt><dd>{integrity.sealedCount} / {integrity.count} 期</dd></div>
                <div><dt>最新月份</dt><dd>{integrity.latestMonth ?? '—'}</dd></div>
                <div><dt>最新指紋</dt><dd><code>{integrity.latestHash?.slice(0, 12) ?? '尚未產生'}</code></dd></div>
                <div><dt>{selected.month} 指紋</dt><dd>{selected.seal?.hash ? <code>{selected.seal.hash.slice(0, 12)}</code> : <span className="danger-text">缺少封存</span>}</dd></div>
              </dl>
              {integrity.problems.length > 0 && (
                <ul className="problem-list">
                  {integrity.problems.slice(0, 3).map((problem) => <li key={`${problem.code}-${problem.month ?? 'unknown'}`}>{problem.detail}</li>)}
                </ul>
              )}
            </>
          ) : <p className="notice bad" role="alert">完整性資料目前無法取得，請重新整理或檢查伺服器。</p>}
        </article>

        <article className="block">
          <header className="section-head">
            <h2>當期流水</h2>
            <span className="meta">收款 {activePayments} 筆有效</span>
          </header>
          <div className="ledger-columns">
            <div className="log-group">
              <div className="group-head"><h3>收款</h3><span className="meta">{selected.payments.length} 筆</span></div>
              {selected.payments.length === 0 ? <p className="empty">此期沒有收款紀錄。</p> : (
                <ul className="log-list read-only ruled">
                  {[...selected.payments].reverse().map((payment) => {
                    const voided = isVoidedTransaction(payment);
                    return (
                      <li key={payment.id} className={voided ? 'voided' : undefined}>
                        <span className="log-date">{payment.date}</span>
                        <div className="log-text">
                          <span className="row-title"><strong>{payment.memberName}</strong>{voided && <span className="pill">已作廢</span>}</span>
                          <span className="row-sub">{payment.method}{payment.note ? `，${payment.note}` : ''}</span>
                        </div>
                        <span className={`log-amount${voided ? '' : ' positive'}`}>+{formatMoney(payment.amount)}</span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
            <div className="log-group">
              <div className="group-head"><h3>臨時加帳</h3><span className="meta">{selected.tempCharges.length} 筆</span></div>
              {selected.tempCharges.length === 0 ? <p className="empty">此期沒有臨時加帳。</p> : (
                <ul className="log-list read-only ruled">
                  {selected.tempCharges.map((charge) => {
                    const voided = isVoidedTransaction(charge);
                    return (
                      <li key={charge.id} className={voided ? 'voided' : undefined}>
                        <span className="log-date">{charge.date ?? '—'}</span>
                        <div className="log-text">
                          <span className="row-title"><strong>{charge.memberName}</strong>{voided && <span className="pill">已作廢</span>}</span>
                          {charge.desc && <span className="row-sub">{charge.desc}</span>}
                        </div>
                        <span className="log-amount">{formatMoney(charge.amount)}</span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
        </article>
      </div>
    </div>
  );
}
