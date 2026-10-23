import { useState } from 'react';
import type { FormEvent } from 'react';
import { formatMoney, getPlatformPrice, isArchivedEntity } from '../billing.js';
import { initialOf, memberToneStyle, SEAT_STATE_LABEL, seatState } from '../display.js';
import type { SeatState } from '../display.js';
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

const SEAT_STATE_TONE: Record<SeatState, string> = {
  billing: 'pos',
  upcoming: 'accent',
  ended: '',
  stopped: '',
};

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
        body: JSON.stringify({ subscriptions, baseVersion: data._audit?.configVersion }),
      });
      const result = await response.json() as MutationResponse;
      if (!response.ok) {
        showToast(result.error ?? '更新訂閱名額失敗');
        if (response.status === 409) await refreshData();
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

  // Seats read best grouped by platform; within a platform, the earliest seat first.
  const platformOrder = (name: string) => {
    const index = data.platforms.findIndex((platform) => platform.name === name);
    return index === -1 ? data.platforms.length : index;
  };
  const rows = [...data.subscriptions].sort((left, right) => (
    platformOrder(left.platformName) - platformOrder(right.platformName)
    || left.startMonth.localeCompare(right.startMonth)
  ));

  return (
    <div className="stack">
      <article className="card">
        <header className="card-head">
          <div><h2>新增名額</h2><p className="meta">把成員加進平台，從起算月份開始計費。</p></div>
        </header>
        <form className="seat-form" onSubmit={handleAddSubscription}>
          <div className="field">
            <label htmlFor="subscription-member">選擇成員姓名</label>
            <select id="subscription-member" className="input" value={memberName} onChange={(event) => setMemberName(event.target.value)}>
              <option value="">請選擇成員</option>
              {activeMembers.map((member) => <option key={member.id} value={member.name}>{member.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="subscription-platform">訂閱平台</label>
            <select id="subscription-platform" className="input" value={selectedPlatform} onChange={(event) => setPlatformName(event.target.value)}>
              {activePlatforms.map((platform) => <option key={platform.id} value={platform.name}>{platform.name}</option>)}
              <option value="自訂">自訂月費項目</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="subscription-start">起算月份 (YYYY/MM)</label>
            <input id="subscription-start" className="input" placeholder={data.currentMonth} value={startMonth} onChange={(event) => setStartMonth(event.target.value)} />
          </div>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? '寫入中...' : '加入名額'}
          </button>
        </form>
      </article>

      <article className="card">
        <header className="card-head">
          <div><h2>全部名額</h2><p className="meta">{data.subscriptions.length} 筆配置 · 月費依 {data.currentMonth} 計算</p></div>
        </header>
        {rows.length === 0 ? <p className="empty">還沒有任何名額。先在上方把成員加進平台。</p> : (
          <div className="table-wrap">
            <table className="seat-table">
              <thead>
                <tr>
                  <th>成員</th><th>平台</th><th className="col-optional">名額</th><th className="col-optional">起算</th><th className="col-optional">退出</th>
                  <th className="n">月費</th><th>狀態</th><th className="n">操作</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((subscription) => {
                  const state = seatState(subscription, data);
                  const platform = data.platforms.find((item) => item.name === subscription.platformName);
                  const member = data.members.find((item) => item.name === subscription.memberName);
                  const price = subscription.platformName === '自訂'
                    ? member?.customFee ?? 0
                    : getPlatformPrice(platform, data, data.currentMonth);
                  const basis = subscription.platformName === '自訂'
                    ? '自訂月費'
                    : platform?.billingMode === 'split' ? `均分 ${formatMoney(platform.totalCost)}` : '固定價格';
                  return (
                    <tr key={subscription.id}>
                      <td>
                        <span className="cell-person">
                          <span className="avatar avatar-sm" style={memberToneStyle(data.members, { id: subscription.memberId, name: subscription.memberName })} aria-hidden="true">{initialOf(subscription.memberName)}</span>
                          {subscription.memberName}
                        </span>
                      </td>
                      <td>{subscription.platformName}</td>
                      <td className="col-optional">{subscription.seatLabel || (subscription.allowDuplicate ? '額外名額' : '—')}</td>
                      <td className="col-optional">{subscription.startMonth}</td>
                      <td className="col-optional">{subscription.exitMonth || '—'}</td>
                      <td className="n strong">{state === 'billing' ? formatMoney(price) : '—'}<span className="sub">{basis}</span></td>
                      <td><span className={`pill ${SEAT_STATE_TONE[state]}`}>{SEAT_STATE_LABEL[state]}</span></td>
                      <td className="n">
                        <span className="row-actions">
                          <button type="button" className="btn btn-ghost" onClick={() => void handleSetExitMonth(subscription)} disabled={saving}>設定退出月</button>
                          <button type="button" className="btn btn-ghost btn-danger" onClick={() => void handleRemoveSubscription(subscription.id)} disabled={saving}>移除</button>
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </article>
    </div>
  );
}
