import { useState } from 'react';
import type { FormEvent } from 'react';
import { isArchivedEntity, isSubscriptionBillable } from '../billing.js';
import type { ApiFetch, Database, RefreshData, ShowToast, Subscription } from '../types/billing.js';

interface SubscriptionsTabProps {
  data: Database;
  apiFetch: ApiFetch;
  refreshData: RefreshData;
  showToast: ShowToast;
}

interface MutationResponse {
  error?: string;
}

export function SubscriptionsTab({ data, apiFetch, refreshData, showToast }: SubscriptionsTabProps) {
  const [memberName, setMemberName] = useState('');
  const [platformName, setPlatformName] = useState('');
  const [startMonth, setStartMonth] = useState('');
  const [saving, setSaving] = useState(false);

  const activeMembers = data.members.filter((member) => !isArchivedEntity(member));
  const activePlatforms = data.platforms.filter((platform) => !isArchivedEntity(platform));
  const selectedPlatform = platformName === '自訂' || activePlatforms.some((platform) => platform.name === platformName)
    ? platformName
    : activePlatforms[0]?.name ?? '自訂';

  async function saveSubscriptions(subscriptions: Subscription[], successMessage: string): Promise<boolean> {
    setSaving(true);
    try {
      const response = await apiFetch('/update-subscriptions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscriptions }),
      });
      const result = await response.json() as MutationResponse;
      if (!response.ok) {
        showToast(result.error ?? '更新訂閱名額失敗');
        return false;
      }
      await refreshData();
      showToast(successMessage);
      return true;
    } catch {
      showToast('更新訂閱名額失敗');
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function handleAddSubscription(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!memberName || !startMonth) {
      showToast('請輸入姓名與起算月份！');
      return;
    }
    if (!/^\d{4}\/(0[1-9]|1[0-2])$/.test(startMonth)) {
      showToast('起算月格式必須為 YYYY/MM，例如 2026/05');
      return;
    }
    const subscription: Subscription = {
      id: `s_${data.subscriptions.length + 1}_${memberName}_${selectedPlatform}_${startMonth}`.replace(/[^\w]/g, '_'),
      memberId: data.members.find((member) => member.name === memberName)?.id ?? '',
      platformId: data.platforms.find((platform) => platform.name === selectedPlatform)?.id ?? '',
      memberName,
      platformName: selectedPlatform,
      startMonth,
      exitMonth: '',
    };
    if (await saveSubscriptions([...data.subscriptions, subscription], '訂閱項目已成功指派！')) {
      setMemberName('');
      setStartMonth('');
    }
  }

  async function handleSetExitMonth(subscription: Subscription): Promise<void> {
    const value = window.prompt('請輸入退出月份 (YYYY/MM) 或留空清除：', subscription.exitMonth ?? '');
    if (value === null) return;
    if (value && !/^\d{4}\/(0[1-9]|1[0-2])$/.test(value)) {
      showToast('退出月份格式不符！請輸入 YYYY/MM 格式。');
      return;
    }
    await saveSubscriptions(
      data.subscriptions.map((item) => item.id === subscription.id ? { ...item, exitMonth: value } : item),
      '已更新退出月份。',
    );
  }

  async function handleRemoveSubscription(id: string): Promise<void> {
    if (!window.confirm('確定要取消此訂閱指派嗎？')) return;
    await saveSubscriptions(
      data.subscriptions.filter((subscription) => subscription.id !== id),
      '已取消該項訂閱。',
    );
  }

  return (
    <>
      <div className="table-container" style={{ padding: '1.5rem', marginBottom: '2rem' }}>
        <h2 style={{ marginBottom: '1.25rem', fontSize: '1.1rem', fontWeight: 600 }}>建立名額配置</h2>
        <form onSubmit={handleAddSubscription} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '1rem', alignItems: 'end' }}>
          <div className="form-group">
            <label htmlFor="subscription-member">選擇成員姓名</label>
            <select id="subscription-member" className="form-control" value={memberName} onChange={(event) => setMemberName(event.target.value)}>
              <option value="">-- 請選擇 --</option>
              {activeMembers.map((member) => <option key={member.id} value={member.name}>{member.name}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label htmlFor="subscription-platform">訂閱平台</label>
            <select id="subscription-platform" className="form-control" value={selectedPlatform} onChange={(event) => setPlatformName(event.target.value)}>
              {activePlatforms.map((platform) => <option key={platform.id} value={platform.name}>{platform.name}</option>)}
              <option value="自訂">自訂月費項目</option>
            </select>
          </div>
          <div className="form-group">
            <label htmlFor="subscription-start">起算月份 (YYYY/MM)</label>
            <input id="subscription-start" className="form-control" placeholder="如 2026/05" value={startMonth} onChange={(event) => setStartMonth(event.target.value)} />
          </div>
          <button type="submit" className="btn btn-primary" disabled={saving} style={{ height: '42px' }}>
            {saving ? '寫入中...' : '寫入配置'}
          </button>
        </form>
      </div>

      <div className="table-container">
        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>#</th><th>姓名</th><th>訂閱項目</th><th>名額</th><th>起算月份</th><th>退出月份</th>
                <th style={{ textAlign: 'right' }}>單價 / 月費</th><th>狀態</th><th style={{ textAlign: 'center' }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {data.subscriptions.map((subscription, index) => {
                const active = isSubscriptionBillable(subscription, data, data.currentMonth);
                const platform = data.platforms.find((item) => item.name === subscription.platformName);
                const activeCount = platform?.billingMode === 'split'
                  ? data.subscriptions.filter((item) => item.platformName === platform.name && isSubscriptionBillable(item, data, data.currentMonth)).length
                  : 0;
                const price = subscription.platformName === '自訂'
                  ? `${data.members.find((member) => member.name === subscription.memberName)?.customFee ?? 0} (自訂)`
                  : platform?.billingMode === 'split'
                    ? `${activeCount ? Math.round(platform.totalCost / activeCount) : 0} (均分 $${platform.totalCost} / ${activeCount}人)`
                    : `${platform?.price ?? 0} (固定)`;
                return (
                  <tr key={subscription.id}>
                    <td>{index + 1}</td>
                    <td style={{ fontWeight: 600 }}>{subscription.memberName}</td>
                    <td>{subscription.platformName}</td>
                    <td>{subscription.seatLabel || (subscription.allowDuplicate ? '額外名額' : '—')}</td>
                    <td>{subscription.startMonth}</td>
                    <td>{subscription.exitMonth || '—'}</td>
                    <td style={{ textAlign: 'right', fontWeight: 600 }}>${price}</td>
                    <td><span className={`status-badge ${active ? 'paid' : 'unpaid'}`}>{active ? 'ACTIVE' : 'EXITED'}</span></td>
                    <td style={{ textAlign: 'center' }}>
                      <div style={{ display: 'flex', gap: '0.35rem', justifyContent: 'center' }}>
                        <button type="button" className="btn btn-secondary" onClick={() => void handleSetExitMonth(subscription)} disabled={saving}>設定退出月</button>
                        <button type="button" className="btn btn-danger" onClick={() => void handleRemoveSubscription(subscription.id)} disabled={saving}>移除</button>
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
}
