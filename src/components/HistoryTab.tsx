import React from 'react';
import type { Database, BalanceEntry, Payment, TempCharge } from '../types/billing.js';

interface HistoryIntegrityType {
  ok: boolean;
  count: number;
  sealedCount: number;
  latestMonth?: string | null;
  latestHash?: string | null;
  problems?: Array<{ code: string; detail: string }> | null;
}

interface HistoryTabProps {
  data: Database;
  selectedHistMonth: string;
  setSelectedHistMonth: (month: string) => void;
  historyIntegrity: HistoryIntegrityType;
  exportToCSV: (monthStr: string, balances: BalanceEntry[], payments: Payment[], tempCharges: TempCharge[]) => void;
}

export const HistoryTab: React.FC<HistoryTabProps> = ({
  data,
  selectedHistMonth,
  setSelectedHistMonth,
  historyIntegrity,
  exportToCSV
}) => {
  const selectedHist = data.history.find(h => h.month === selectedHistMonth);

  const histData = data.history.map(h => {
    const fees = h.balances.reduce((sum, b) => sum + b.subscriptionFee, 0);
    const paid = h.balances.reduce((sum, b) => sum + b.paid, 0);
    return { month: h.month, fees, paid };
  });

  const maxVal = histData.length > 0 
    ? Math.max(...histData.map(d => Math.max(d.fees, d.paid, 100)), 1000)
    : 1000;

  const chartWidth = 500;
  const chartHeight = 160;
  const plotWidth = 420;
  const plotHeight = 110;
  const startX = 60;
  const startY = 15;
  const barSpacing = histData.length > 0 ? plotWidth / histData.length : plotWidth;
  const barWidth = histData.length > 0 ? Math.max(8, barSpacing * 0.25) : 8;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: '2rem' }}>
      {/* Sidebar list of months */}
      <div className="table-container" style={{ padding: '1rem', display: 'flex', flexDirection: 'column', gap: '0.5rem', height: 'fit-content' }}>
        <h4 style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '0.5rem', paddingLeft: '0.5rem' }}>歷史對帳月份</h4>
        {data.history.length === 0 ? (
          <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', paddingLeft: '0.5rem' }}>暫無歷史結算檔案</p>
        ) : (
          data.history.map(hist => (
            <div 
              key={hist.month} 
              className={`nav-item ${selectedHistMonth === hist.month ? 'active' : ''}`} 
              style={{ padding: '0.65rem 0.85rem', fontSize: '0.85rem', cursor: 'pointer' }} 
              onClick={() => setSelectedHistMonth(hist.month)}
            >
              <span className="nav-code">AR</span> {hist.month}
            </div>
          ))
        )}
      </div>

      {/* Selected Month Report */}
      <div>
        <section className={`history-seal-panel ${historyIntegrity.ok ? 'clear' : 'risk'}`}>
          <div>
            <span>封存鏈</span>
            <h3>{historyIntegrity.ok ? '歷史帳完整' : '歷史帳異常'}</h3>
          </div>
          <div>
            <span>封存月份</span>
            <strong>{historyIntegrity.sealedCount || 0}/{historyIntegrity.count || 0}</strong>
          </div>
          <div>
            <span>最新月份</span>
            <strong>{historyIntegrity.latestMonth || '—'}</strong>
          </div>
          <div>
            <span>最新指紋</span>
            <code>{historyIntegrity.latestHash ? historyIntegrity.latestHash.slice(0, 12) : 'pending'}</code>
          </div>
          {historyIntegrity.problems && historyIntegrity.problems.length > 0 && (
            <div className="history-seal-problems">
              {historyIntegrity.problems.slice(0, 3).map((problem, idx) => (
                <p key={`${problem.code}-${idx}`}>{problem.detail}</p>
              ))}
            </div>
          )}
        </section>

        {/* SVG Trend Chart */}
        {histData.length > 0 && (
          <div className="table-container" style={{ padding: '1.25rem', marginBottom: '1.5rem' }}>
            <h3 style={{ marginBottom: '1rem', fontSize: '1rem', fontWeight: '600' }}>歷史收費與收款趨勢</h3>
            <div style={{ width: '100%', overflowX: 'auto' }}>
              <svg width="100%" height={chartHeight} viewBox={`0 0 ${chartWidth} ${chartHeight}`} style={{ minWidth: '450px' }}>
                {/* Grid lines (horizontal) */}
                {[0, 0.25, 0.5, 0.75, 1].map((ratio, idx) => {
                  const y = startY + plotHeight * (1 - ratio);
                  const val = Math.round(maxVal * ratio);
                  return (
                    <g key={idx}>
                      <line x1={startX} y1={y} x2={startX + plotWidth} y2={y} stroke="rgba(255,255,255,0.05)" strokeDasharray="3,3" />
                      <text x={startX - 8} y={y + 4} fill="var(--text-muted)" fontSize="9" textAnchor="end">${val.toLocaleString()}</text>
                    </g>
                  );
                })}
                
                {/* Draw bars */}
                {histData.map((d, idx) => {
                  const x = startX + idx * barSpacing + barSpacing / 2;
                  const feeHeight = (d.fees / maxVal) * plotHeight;
                  const paidHeight = (d.paid / maxVal) * plotHeight;
                  const label = d.month.split('/')[1] + '月'; // e.g. "05月"
                  
                  return (
                    <g key={idx}>
                      {/* Fees bar (blue) */}
                      <rect x={x - barWidth - 2} y={startY + plotHeight - feeHeight} width={barWidth} height={feeHeight} 
                            fill="#60a5fa" rx="2" opacity="0.8" />
                      {/* Paid bar (green) */}
                      <rect x={x + 2} y={startY + plotHeight - paidHeight} width={barWidth} height={paidHeight} 
                            fill="var(--success)" rx="2" opacity="0.8" />
                      {/* Month label */}
                      <text x={x} y={startY + plotHeight + 16} fill="var(--text-muted)" fontSize="10" textAnchor="middle">{label}</text>
                    </g>
                  );
                })}
                
                {/* Axis line */}
                <line x1={startX} y1={startY + plotHeight} x2={startX + plotWidth} y2={startY + plotHeight} stroke="rgba(255,255,255,0.15)" />
              </svg>
              <div style={{ display: 'flex', justifyContent: 'center', gap: '1.5rem', marginTop: '0.5rem', fontSize: '0.75rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                  <span style={{ width: '10px', height: '10px', borderRadius: '2px', background: '#60a5fa' }}></span>
                  <span>應收訂閱月費</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                  <span style={{ width: '10px', height: '10px', borderRadius: '2px', background: 'var(--success)' }}></span>
                  <span>實收已入帳金額</span>
                </div>
              </div>
            </div>
          </div>
        )}

        {selectedHist ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
            {/* Ending Balances Table */}
            <div className="table-container" style={{ marginBottom: '0' }}>
              <div style={{ padding: '0.85rem 1.25rem', borderBottom: '1px solid var(--panel-border)', fontWeight: '600', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>{selectedHist.month} 結帳對帳單總覽</span>
                <button className="btn btn-secondary" style={{ padding: '0.4rem 0.85rem', fontSize: '0.8rem', flexGrow: 0 }} onClick={() => exportToCSV(selectedHist.month, selectedHist.balances, selectedHist.payments, selectedHist.tempCharges)}>
                  匯出該月報表
                </button>
              </div>
              <div className="table-wrapper">
                <table>
                  <thead>
                    <tr>
                      <th>成員姓名</th>
                      <th style={{ textAlign: 'right' }}>期初前期餘額</th>
                      <th style={{ textAlign: 'right' }}>該月訂閱費</th>
                      <th style={{ textAlign: 'right' }}>該月臨時加帳</th>
                      <th style={{ textAlign: 'right' }}>該月已付金額</th>
                      <th style={{ textAlign: 'right' }}>期末剩餘應收</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedHist.balances.map(b => (
                      <tr key={b.memberName}>
                        <td style={{ fontWeight: '600' }}>{b.memberName}</td>
                        <td style={{ textAlign: 'right' }}>${b.priorBalance.toLocaleString()}</td>
                        <td style={{ textAlign: 'right' }}>${b.subscriptionFee.toLocaleString()}</td>
                        <td style={{ textAlign: 'right' }}>${b.tempCharge.toLocaleString()}</td>
                        <td style={{ textAlign: 'right', color: 'var(--success)' }}>-${b.paid.toLocaleString()}</td>
                        <td style={{ textAlign: 'right', fontWeight: '700', color: b.endingBalance > 0 ? 'var(--warning)' : '#60a5fa' }}>
                          ${b.endingBalance.toLocaleString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Transaction Logs for that month */}
            <div className="logs-section">
              <div className="log-panel">
                <h4>該月付款歷史日誌</h4>
                <div className="log-list" style={{ marginTop: '1rem' }}>
                  {selectedHist.payments.length === 0 ? (
                    <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', padding: '1rem 0' }}>無付款記錄</p>
                  ) : (
                    selectedHist.payments.map(p => (
                      <div key={p.id} className="log-item" style={{ background: 'rgba(255,255,255,0.01)' }}>
                        <div className="log-info">
                          <span style={{ fontWeight: '600' }}>{p.memberName}</span>
                          <span className="log-meta">{p.date} • {p.method} {p.note && `• ${p.note}`}</span>
                        </div>
                        <div className="log-amount" style={{ color: 'var(--success)' }}>
                          ${p.amount.toLocaleString()}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>

              <div className="log-panel">
                <h4>該月臨時加帳歷史日誌</h4>
                <div className="log-list" style={{ marginTop: '1rem' }}>
                  {selectedHist.tempCharges.length === 0 ? (
                    <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', padding: '1rem 0' }}>無加帳記錄</p>
                  ) : (
                    selectedHist.tempCharges.map(c => (
                      <div key={c.id} className="log-item" style={{ background: 'rgba(255,255,255,0.01)' }}>
                        <div className="log-info">
                          <span style={{ fontWeight: '600' }}>{c.memberName}</span>
                          <span className="log-meta">{c.date} {c.desc && `• ${c.desc}`}</span>
                        </div>
                        <div className="log-amount" style={{ color: 'var(--warning)' }}>
                          ${c.amount.toLocaleString()}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="table-container" style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-muted)' }}>
            請選擇左側月份載入歷史對帳報告。
          </div>
        )}
      </div>
    </div>
  );
};
