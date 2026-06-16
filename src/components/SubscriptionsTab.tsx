import React from 'react';
import type { Database, Member, Platform, Subscription } from '../types/billing.js';

interface SubscriptionsTabProps {
  data: Database;
  subName: string;
  setSubName: (v: string) => void;
  setSubPlatform: (v: string) => void;
  subStart: string;
  setSubStart: (v: string) => void;
  activeMembers: Member[];
  activePlatforms: Platform[];
  effectiveSubPlatform: string;
  handleAddSubscription: (e: React.FormEvent) => void;
  handleSetExitMonth: (id: string, currentExitMonth?: string) => void;
  handleRemoveSubscription: (id: string) => void;
  isSubBillableInMonth: (sub: Subscription, dbState: Database, monthStr: string) => boolean;
}

export const SubscriptionsTab: React.FC<SubscriptionsTabProps> = ({
  data,
  subName,
  setSubName,
  setSubPlatform,
  subStart,
  setSubStart,
  activeMembers,
  activePlatforms,
  effectiveSubPlatform,
  handleAddSubscription,
  handleSetExitMonth,
  handleRemoveSubscription,
  isSubBillableInMonth
}) => {
  return (
    <>
      {/* Quick allocation form */}
      <div className="table-container" style={{ padding: '1.5rem', marginBottom: '2rem' }}>
        <h3 style={{ marginBottom: '1.25rem', fontSize: '1.1rem', fontWeight: '600' }}>建立名額配置</h3>
        <form onSubmit={handleAddSubscription} style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div className="form-group" style={{ flexGrow: 1, minWidth: '150px' }}>
            <label>選擇成員姓名</label>
            <select className="form-control" value={subName} onChange={(e) => setSubName(e.target.value)}>
              <option value="">-- 請選擇 --</option>
              {activeMembers.map(m => (
                <option key={m.id} value={m.name}>{m.name}</option>
              ))}
            </select>
          </div>
          
          <div className="form-group" style={{ flexGrow: 1, minWidth: '150px' }}>
            <label>訂閱平台</label>
            <select className="form-control" value={effectiveSubPlatform} onChange={(e) => setSubPlatform(e.target.value)}>
              {activePlatforms.map(p => (
                <option key={p.id} value={p.name}>{p.name}</option>
              ))}
              <option value="自訂">自訂月費項目</option>
            </select>
          </div>

          <div className="form-group" style={{ width: '150px' }}>
            <label>起算月份 (YYYY/MM)</label>
            <input type="text" className="form-control" placeholder="如 2026/05" value={subStart} onChange={(e) => setSubStart(e.target.value)} />
          </div>

          <button type="submit" className="btn btn-primary" style={{ padding: '0.75rem 1.5rem' }}>寫入配置</button>
        </form>
      </div>

      {/* Subscriptions allocations list */}
      <div className="table-container">
        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <th style={{ width: '60px' }}>#</th>
                <th>姓名</th>
                <th>訂閱項目</th>
                <th>名額</th>
                <th>起算月份</th>
                <th>退出月份</th>
                <th style={{ textAlign: 'right' }}>單價 / 月費</th>
                <th>狀態</th>
                <th style={{ width: '220px', textAlign: 'center' }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {data.subscriptions.map((sub, idx) => {
                const isActive = isSubBillableInMonth(sub, data, data.currentMonth);
                const plat = data.platforms.find(p => p.name === sub.platformName);
                let priceStr = '—';
                if (sub.platformName === '自訂') {
                  const m = data.members.find(mem => mem.name === sub.memberName);
                  priceStr = m && m.customFee ? `$${m.customFee.toLocaleString()} (自訂)` : '$0 (自訂)';
                } else if (plat) {
                  if (plat.billingMode === 'split') {
                    const activeCount = data.subscriptions.filter(s => s.platformName === plat.name && isSubBillableInMonth(s, data, data.currentMonth)).length;
                    const calculatedPrice = activeCount > 0 ? Math.round(plat.totalCost / activeCount) : 0;
                    priceStr = `$${calculatedPrice.toLocaleString()} (均分 $${plat.totalCost} / ${activeCount}人)`;
                  } else {
                    priceStr = `$${plat.price.toLocaleString()} (固定)`;
                  }
                }
                
                return (
                  <tr key={sub.id}>
                    <td>{idx + 1}</td>
                    <td style={{ fontWeight: '600' }}>{sub.memberName}</td>
                    <td>{sub.platformName}</td>
                    <td>{sub.seatLabel || (sub.allowDuplicate ? '額外名額' : '—')}</td>
                    <td>{sub.startMonth}</td>
                    <td>{sub.exitMonth || '—'}</td>
                    <td style={{ textAlign: 'right', fontWeight: '600' }}>{priceStr}</td>
                    <td>
                      <span className={`status-badge ${isActive ? 'paid' : 'unpaid'}`} style={{ fontSize: '0.75rem', padding: '0.2rem 0.5rem' }}>
                        {isActive ? 'ACTIVE' : 'EXITED'}
                      </span>
                    </td>
                    <td style={{ textAlign: 'center' }}>
                      <div style={{ display: 'flex', gap: '0.35rem', justifyContent: 'center' }}>
                        <button className="btn btn-secondary" style={{ padding: '0.4rem 0.75rem', fontSize: '0.75rem' }} onClick={() => handleSetExitMonth(sub.id, sub.exitMonth)}>
                          設定退出月
                        </button>
                        <button className="btn btn-danger" style={{ padding: '0.4rem 0.75rem', fontSize: '0.75rem' }} onClick={() => handleRemoveSubscription(sub.id)}>
                          移除
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
};
