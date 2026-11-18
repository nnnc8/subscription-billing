import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { formatMoney, isArchivedEntity } from '../billing.js';
import type {
  ApiFetch,
  BackupInventoryItem,
  Database,
  LifecycleStatus,
  Platform,
  RefreshData,
  ShowToast,
  SystemSnapshot,
} from '../types/billing.js';
import { Trash2, X } from 'lucide-react';
import { Modal } from './ui/Modal.js';

interface SettingsTabProps {
  active: boolean;
  data: Database;
  apiFetch: ApiFetch;
  refreshData: RefreshData;
  showToast: ShowToast;
}

interface PlatformDraft {
  billingMode?: Platform['billingMode'];
  price?: string;
  totalCost?: string;
}

interface MemberDraft {
  priorBalance?: string;
  customFee?: string;
}

interface ApiResult {
  success?: boolean;
  message?: string;
  error?: string;
}

interface BackupListResponse extends ApiResult {
  current?: SystemSnapshot;
  backups?: BackupInventoryItem[];
}

function formatBackupTimestamp(item: BackupInventoryItem): string {
  const match = item.label.match(/^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})$/);
  if (match) return `${match[1]}/${match[2]}/${match[3]} ${match[4]}:${match[5]}:${match[6]}`;
  const date = new Date(item.mtime);
  return Number.isNaN(date.getTime()) ? item.label : date.toLocaleString('zh-TW', { hour12: false });
}

function snapshotTone(snapshot: SystemSnapshot | undefined): string {
  const status = snapshot?.health.status ?? 'risk';
  return status === 'clean' ? 'pos' : status === 'warning' ? 'warn' : 'neg';
}

function numericValue(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function isLifecycleResponse(value: unknown): value is LifecycleStatus & { success: true } {
  if (!value || typeof value !== 'object') return false;
  const result = value as Record<string, unknown>;
  return result.success === true
    && typeof result.currentMonth === 'string'
    && typeof result.systemMonth === 'string'
    && typeof result.isCurrent === 'boolean'
    && typeof result.timezone === 'string'
    && (result.lastAdvancedAt === null || typeof result.lastAdvancedAt === 'string')
    && (result.lastAdvancedFrom === null || typeof result.lastAdvancedFrom === 'string')
    && (result.lastAdvancedTo === null || typeof result.lastAdvancedTo === 'string')
    && (result.blockedReason === null || typeof result.blockedReason === 'string');
}

function responseError(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const error = (value as Record<string, unknown>).error;
  return typeof error === 'string' ? error : undefined;
}

export function SettingsTab({ active, data, apiFetch, refreshData, showToast }: SettingsTabProps) {
  const [platformDrafts, setPlatformDrafts] = useState<Record<string, PlatformDraft>>({});
  const [memberDrafts, setMemberDrafts] = useState<Record<string, MemberDraft>>({});
  const [bankDraft, setBankDraft] = useState<string>();
  const [reminderStyleDraft, setReminderStyleDraft] = useState<string>();
  const [newMemberName, setNewMemberName] = useState('');
  const [newMemberPrior, setNewMemberPrior] = useState('0');
  const [newMemberCustom, setNewMemberCustom] = useState('');
  const [newPlatformName, setNewPlatformName] = useState('');
  const [newPlatformPrice, setNewPlatformPrice] = useState('0');
  const [newPlatformMode, setNewPlatformMode] = useState<Platform['billingMode']>('fixed');
  const [newPlatformTotal, setNewPlatformTotal] = useState('0');
  const [configSaving, setConfigSaving] = useState(false);
  const [backupOpen, setBackupOpen] = useState(false);
  const [backupLoading, setBackupLoading] = useState(false);
  const [backups, setBackups] = useState<BackupInventoryItem[]>([]);
  const [recoveryStatus, setRecoveryStatus] = useState<SystemSnapshot>();
  const [selectedBackup, setSelectedBackup] = useState<BackupInventoryItem>();
  const [lifecycle, setLifecycle] = useState<LifecycleStatus>();
  const [lifecycleError, setLifecycleError] = useState('');
  const restoreCancelRef = useRef<HTMLButtonElement>(null);

  const editedPlatforms = data.platforms.map((platform) => {
    const draft = platformDrafts[platform.id];
    const billingMode = draft?.billingMode ?? platform.billingMode;
    return {
      ...platform,
      billingMode,
      price: billingMode === 'fixed' ? numericValue(draft?.price, platform.price) : 0,
      totalCost: billingMode === 'split' ? numericValue(draft?.totalCost, platform.totalCost) : 0,
    };
  });
  const editedMembers = data.members.map((member) => {
    const draft = memberDrafts[member.id];
    const customFeeValue = draft?.customFee;
    return {
      ...member,
      priorBalance: numericValue(draft?.priorBalance, member.priorBalance),
      customFee: customFeeValue === undefined
        ? member.customFee
        : customFeeValue.trim() === '' ? null : numericValue(customFeeValue, member.customFee ?? 0),
    };
  });
  const dirtyPlatformIds = editedPlatforms
    .filter((platform) => {
      const current = data.platforms.find((item) => item.id === platform.id);
      return !current || current.price !== platform.price || current.totalCost !== platform.totalCost || current.billingMode !== platform.billingMode;
    })
    .map((platform) => platform.id);
  const dirtyMemberIds = editedMembers
    .filter((member) => {
      const current = data.members.find((item) => item.id === member.id);
      return !current || current.priorBalance !== member.priorBalance || current.customFee !== member.customFee;
    })
    .map((member) => member.id);
  const bankInfo = bankDraft ?? data.bankInfo;
  const reminderStyle = reminderStyleDraft ?? data.reminderStyle;
  const bankDirty = bankDraft !== undefined && bankDraft !== data.bankInfo;
  const reminderDirty = reminderStyleDraft !== undefined && reminderStyleDraft !== data.reminderStyle;
  const draftCount = dirtyPlatformIds.length + dirtyMemberIds.length + Number(bankDirty) + Number(reminderDirty);
  const configDirty = draftCount > 0;

  useEffect(() => {
    if (!configDirty) return undefined;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warnBeforeUnload);
    return () => window.removeEventListener('beforeunload', warnBeforeUnload);
  }, [configDirty]);

  useEffect(() => {
    if (!active) return undefined;
    let cancelled = false;
    void apiFetch('/lifecycle/status')
      .then(async (response) => {
        const result: unknown = await response.json();
        if (!response.ok || !isLifecycleResponse(result)) {
          throw new Error(responseError(result) ?? '帳期狀態目前無法取得');
        }
        if (!cancelled) {
          setLifecycle(result);
          setLifecycleError('');
        }
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setLifecycle(undefined);
        setLifecycleError(error instanceof Error ? error.message : '帳期狀態目前無法取得');
      });
    return () => { cancelled = true; };
  }, [active, apiFetch, data.currentMonth]);

  function clearDrafts(): void {
    setPlatformDrafts({});
    setMemberDrafts({});
    setBankDraft(undefined);
    setReminderStyleDraft(undefined);
  }

  async function saveConfig(): Promise<void> {
    if (!configDirty) {
      showToast('目前沒有待儲存的設定草稿。');
      return;
    }
    setConfigSaving(true);
    try {
      const response = await apiFetch('/update-config-bundle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          platforms: editedPlatforms,
          members: editedMembers,
          bankInfo,
          reminderStyle,
          baseVersion: data._audit?.configVersion,
        }),
      });
      const result = await response.json() as ApiResult;
      if (!response.ok) {
        showToast(result.error ?? '儲存設定失敗');
        // Another device changed the settings: reload them. Drafts are keyed by id, so the
        // operator's unsaved edits stay on screen and can be reviewed and saved again.
        if (response.status === 409) await refreshData();
        return;
      }
      clearDrafts();
      await refreshData();
      if (backupOpen) await loadBackups();
      showToast(result.message ?? '設定已一次性寫入正式帳務。');
    } catch {
      showToast('儲存設定失敗');
    } finally {
      setConfigSaving(false);
    }
  }

  async function mutateEntity(path: string, options: RequestInit, successMessage: string): Promise<boolean> {
    try {
      const response = await apiFetch(path, options);
      const result = await response.json() as ApiResult;
      if (!response.ok) {
        showToast(result.error ?? '更新設定失敗');
        return false;
      }
      await refreshData();
      showToast(successMessage);
      return true;
    } catch {
      showToast('更新設定失敗');
      return false;
    }
  }

  async function handleAddMember(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!newMemberName.trim()) return;
    const saved = await mutateEntity('/member', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newMemberName.trim(), priorBalance: Number(newMemberPrior) || 0, customFee: newMemberCustom === '' ? null : Number(newMemberCustom) }),
    }, '成功新增成員！');
    if (saved) {
      setNewMemberName(''); setNewMemberPrior('0'); setNewMemberCustom('');
    }
  }

  async function handleAddPlatform(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!newPlatformName.trim()) return;
    const saved = await mutateEntity('/platform', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: newPlatformName.trim(),
        price: Number(newPlatformPrice) || 0,
        billingMode: newPlatformMode,
        totalCost: Number(newPlatformTotal) || 0,
      }),
    }, '成功新增訂閱平台！');
    if (saved) {
      setNewPlatformName(''); setNewPlatformPrice('0'); setNewPlatformMode('fixed'); setNewPlatformTotal('0');
    }
  }

  async function archiveEntity(kind: 'member' | 'platform', id: string, name: string): Promise<void> {
    const label = kind === 'member' ? '成員' : '平台';
    if (!window.confirm(`確定要停用${label}「${name}」嗎？\n\n系統會保留歷史帳與相關證據，並停止後續計費。`)) return;
    await mutateEntity(`/${kind}/${id}`, { method: 'DELETE' }, `已停用${label} ${name}，帳務證據已保留。`);
  }

  async function loadBackups(): Promise<void> {
    try {
      const response = await apiFetch('/backups');
      const result = await response.json() as BackupListResponse;
      if (!response.ok || result.success === false) {
        showToast(result.error ?? '無法讀取備份列表');
        return;
      }
      setBackups(result.backups ?? []);
      setRecoveryStatus(result.current);
    } catch {
      showToast('無法讀取備份列表');
    }
  }

  async function createBackup(): Promise<void> {
    setBackupLoading(true);
    try {
      const response = await apiFetch('/backups/create', { method: 'POST' });
      const result = await response.json() as ApiResult;
      if (!response.ok || result.success === false) showToast(result.error ?? '備份失敗');
      else {
        showToast(result.message ?? '備份已建立');
        await loadBackups();
      }
    } catch {
      showToast('建立備份時發生錯誤');
    } finally {
      setBackupLoading(false);
    }
  }

  async function restoreBackup(): Promise<void> {
    if (!selectedBackup) return;
    setBackupLoading(true);
    try {
      const response = await apiFetch('/backups/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: selectedBackup.filename }),
      });
      const result = await response.json() as ApiResult;
      if (!response.ok || result.success === false) showToast(result.error ?? '還原失敗');
      else {
        setSelectedBackup(undefined);
        clearDrafts();
        await refreshData();
        await loadBackups();
        showToast(`已還原至 ${selectedBackup.filename}`);
      }
    } catch {
      showToast('還原時發生錯誤');
    } finally {
      setBackupLoading(false);
    }
  }

  async function deleteBackup(filename: string): Promise<void> {
    if (!window.confirm(`確定刪除備份 ${filename}？`)) return;
    setBackupLoading(true);
    try {
      const response = await apiFetch(`/backups/${encodeURIComponent(filename)}`, { method: 'DELETE' });
      const result = await response.json() as ApiResult;
      if (!response.ok || result.success === false) showToast(result.error ?? '刪除備份失敗');
      else {
        await loadBackups();
        showToast('備份已刪除');
      }
    } catch {
      showToast('刪除備份失敗');
    } finally {
      setBackupLoading(false);
    }
  }

  const activePlatformCount = data.platforms.filter((platform) => !isArchivedEntity(platform)).length;
  const activeMemberCount = data.members.filter((member) => !isArchivedEntity(member)).length;
  const customFeeCount = data.members.filter((member) => member.customFee !== null && !isArchivedEntity(member)).length;
  const textDraftCount = Number(bankDirty) + Number(reminderDirty);

  return (
    <div className="settings">
      <div className={`draft-bar${configDirty ? ' dirty' : ''}`}>
        <div>
          <strong>{configDirty ? `${draftCount} 項變更還沒寫入` : '與正式設定一致'}</strong>
          <p>{configDirty
            ? `平台 ${dirtyPlatformIds.length}、成員 ${dirtyMemberIds.length}、文字 ${textDraftCount}。這些修改只在這台裝置上，寫入後會一次存進資料庫並留下事件。`
            : '修改下方欄位時會先存成草稿，確認後再一次寫入。'}</p>
        </div>
        <div className="draft-actions">
          <button type="button" className="btn" onClick={clearDrafts} disabled={!configDirty || configSaving}>放棄草稿</button>
          <button type="button" className="btn btn-primary" onClick={() => void saveConfig()} disabled={!configDirty || configSaving}>{configSaving ? '寫入中...' : '一次寫入正式設定'}</button>
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-label">
          <h2>平台與定價</h2>
          <p>固定價格按人收費；動態均分把平台總價平分給本期計費中的名額，四捨五入到元。</p>
          <dl>
            <div><dt>使用中</dt><dd>{activePlatformCount} 個平台</dd></div>
            <div><dt>已停用</dt><dd>{data.platforms.length - activePlatformCount} 個</dd></div>
          </dl>
        </div>
        <div className="card">
          <ul className="entity-list">
            {data.platforms.map((platform) => {
              const archived = isArchivedEntity(platform);
              const draft = platformDrafts[platform.id];
              const mode = draft?.billingMode ?? platform.billingMode;
              return (
                <li key={platform.id} className="entity-row">
                  <div className="entity-title">
                    <strong>{platform.name}{archived && <span className="pill">已停用</span>}</strong>
                    <button type="button" className="btn btn-ghost btn-danger" onClick={() => void archiveEntity('platform', platform.id, platform.name)} disabled={archived}>{archived ? '已停用' : '停用平台'}</button>
                  </div>
                  <div className="field-pair">
                    <div className="field"><label htmlFor={`platform-mode-${platform.id}`}>收費模式</label><select id={`platform-mode-${platform.id}`} className="input" value={mode} disabled={archived} onChange={(event) => setPlatformDrafts((current) => ({ ...current, [platform.id]: { ...current[platform.id], billingMode: event.target.value as Platform['billingMode'] } }))}><option value="fixed">固定價格 (按人)</option><option value="split">動態均分 (平台總價)</option></select></div>
                    <div className="field"><label htmlFor={`platform-price-${platform.id}`}>{mode === 'split' ? '平台總月費' : '固定單人月費'} (NT$)</label><input id={`platform-price-${platform.id}`} type="number" inputMode="numeric" className="input" disabled={archived} value={mode === 'split' ? draft?.totalCost ?? String(platform.totalCost) : draft?.price ?? String(platform.price)} onChange={(event) => setPlatformDrafts((current) => ({ ...current, [platform.id]: { ...current[platform.id], [mode === 'split' ? 'totalCost' : 'price']: event.target.value } }))} /></div>
                  </div>
                </li>
              );
            })}
          </ul>
          <div className="card-split">
            <h3>新增平台</h3>
            <form className="inline-form" onSubmit={handleAddPlatform}>
              <div className="field"><label htmlFor="new-platform-name">平台名稱</label><input id="new-platform-name" className="input" value={newPlatformName} onChange={(event) => setNewPlatformName(event.target.value)} required /></div>
              <div className="field"><label htmlFor="new-platform-mode">收費模式</label><select id="new-platform-mode" className="input" value={newPlatformMode} onChange={(event) => setNewPlatformMode(event.target.value as Platform['billingMode'])}><option value="fixed">固定價格 (按人)</option><option value="split">動態均分 (平台總價)</option></select></div>
              <div className="field"><label htmlFor="new-platform-price">{newPlatformMode === 'split' ? '平台總月費' : '固定單人月費'} (NT$)</label><input id="new-platform-price" type="number" inputMode="numeric" className="input" value={newPlatformMode === 'split' ? newPlatformTotal : newPlatformPrice} onChange={(event) => newPlatformMode === 'split' ? setNewPlatformTotal(event.target.value) : setNewPlatformPrice(event.target.value)} /></div>
              <button type="submit" className="btn">建立平台</button>
            </form>
          </div>
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-label">
          <h2>成員與期初餘額</h2>
          <p>期初餘額是第一個帳期之前的欠款或預繳；自訂月費有值時，會取代該成員所有名額的月費。</p>
          <dl>
            <div><dt>使用中</dt><dd>{activeMemberCount} 位成員</dd></div>
            <div><dt>自訂月費</dt><dd>{customFeeCount} 位</dd></div>
          </dl>
        </div>
        <div className="card">
          <ul className="entity-list">
            {data.members.map((member) => {
              const archived = isArchivedEntity(member);
              const draft = memberDrafts[member.id];
              return (
                <li key={member.id} className="entity-row">
                  <div className="entity-title">
                    <strong>{member.name}{archived && <span className="pill">已停用</span>}</strong>
                    <button type="button" className="btn btn-ghost btn-danger" onClick={() => void archiveEntity('member', member.id, member.name)} disabled={archived}>{archived ? '已停用' : '停用成員'}</button>
                  </div>
                  <div className="field-pair">
                    <div className="field"><label htmlFor={`member-prior-${member.id}`}>前期餘額 (期初)</label><input id={`member-prior-${member.id}`} type="number" inputMode="numeric" className="input" disabled={archived} value={draft?.priorBalance ?? String(member.priorBalance)} onChange={(event) => setMemberDrafts((current) => ({ ...current, [member.id]: { ...current[member.id], priorBalance: event.target.value } }))} /></div>
                    <div className="field"><label htmlFor={`member-fee-${member.id}`}>自訂月費 (特例)</label><input id={`member-fee-${member.id}`} type="number" inputMode="numeric" className="input" placeholder="依名額計算" disabled={archived} value={draft?.customFee ?? String(member.customFee ?? '')} onChange={(event) => setMemberDrafts((current) => ({ ...current, [member.id]: { ...current[member.id], customFee: event.target.value } }))} /></div>
                  </div>
                </li>
              );
            })}
          </ul>
          <div className="card-split">
            <h3>新增成員</h3>
            <form className="inline-form" onSubmit={handleAddMember}>
              <div className="field"><label htmlFor="new-member-name">成員姓名</label><input id="new-member-name" className="input" value={newMemberName} onChange={(event) => setNewMemberName(event.target.value)} required /></div>
              <div className="field"><label htmlFor="new-member-prior">期初餘額 (NT$)</label><input id="new-member-prior" type="number" inputMode="numeric" className="input" value={newMemberPrior} onChange={(event) => setNewMemberPrior(event.target.value)} /></div>
              <div className="field"><label htmlFor="new-member-custom">自訂月費 (非必填)</label><input id="new-member-custom" type="number" inputMode="numeric" className="input" value={newMemberCustom} onChange={(event) => setNewMemberCustom(event.target.value)} /></div>
              <button type="submit" className="btn">建立成員</button>
            </form>
          </div>
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-label">
          <h2>催繳訊息與匯款資訊</h2>
          <p>送出 LINE 帳單和複製腳本時，會帶上這裡的匯款資訊與語氣。</p>
        </div>
        <div className="card form-stack">
          <div className="field"><label htmlFor="bank-info">匯款帳戶資訊</label><textarea id="bank-info" className="input" rows={3} value={bankInfo} onChange={(event) => setBankDraft(event.target.value)} /></div>
          <div className="field"><label htmlFor="reminder-style">催帳訊息風格</label><select id="reminder-style" className="input" value={reminderStyle} onChange={(event) => setReminderStyleDraft(event.target.value)}><option value="friendly">幽默親友風</option><option value="formal">正式對帳風</option><option value="minimal">極簡親友風</option></select></div>
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-label">
          <h2>備份與還原</h2>
          <p>每次寫入前系統會自動備份。還原前也會先備份目前資料，所以還原可以再退回。伺服器備份和資料庫在同一處，請定期下載一份到自己的裝置。</p>
        </div>
        <div className="card">
          {!backupOpen ? (
            <div className="entity-title">
              <span className="meta">備份清單收合中</span>
              <button type="button" className="btn" onClick={() => { setBackupOpen(true); void loadBackups(); }}>管理備份</button>
            </div>
          ) : (
            <>
              <div className="entity-title">
                <strong>目前資料</strong>
                <button type="button" className="btn btn-ghost" onClick={() => setBackupOpen(false)}>收合</button>
              </div>
              {recoveryStatus && (
                <dl className="facts card-split">
                  <div><dt>帳期與狀態</dt><dd>{recoveryStatus.currentMonth} · {recoveryStatus.health.label}<small>{recoveryStatus.health.warningCount} 則提醒</small></dd></div>
                  <div><dt>待收</dt><dd>{formatMoney(recoveryStatus.totals.receivable)}<small>{recoveryStatus.totals.unpaidMembers} 人未結清</small></dd></div>
                  <div><dt>資料指紋</dt><dd><code>{recoveryStatus.fingerprint.slice(0, 12)}</code><small>{recoveryStatus.counts.ledger} 筆事件</small></dd></div>
                </dl>
              )}
              <div className="backup-actions">
                <button type="button" className="btn" onClick={() => void createBackup()} disabled={backupLoading}>{backupLoading ? '處理中...' : '建立目前狀態備份'}</button>
                {/* Server backups share the database's disk; a periodic download is the off-site copy. */}
                <a className="btn" href="/api/export-json" download>下載完整資料（JSON）到這台裝置</a>
              </div>
              {backups.length === 0 ? <p className="empty card-split">還沒有備份。寫入任何帳務後，系統會自動建立第一份。</p> : (
                <ul className="backup-list">
                  {backups.map((backup) => (
                    <li key={backup.filename}>
                      <div className="backup-text">
                        <strong>{formatBackupTimestamp(backup)}<span className={`pill ${backup.readable ? snapshotTone(backup.snapshot) : 'neg'}`}>{backup.readable ? backup.snapshot?.health.label : '無法讀取'}</span></strong>
                        <span>{backup.readable ? `${backup.snapshot?.currentMonth} 帳期` : backup.error} · {(backup.size / 1024).toFixed(1)} KB</span>
                        <span>{backup.restoreImpact.summary}</span>
                      </div>
                      <div className="backup-row-actions">
                        <button type="button" className="btn" onClick={() => setSelectedBackup(backup)} disabled={backupLoading || !backup.readable}>還原</button>
                        <button type="button" className="icon-btn" aria-label={`刪除備份 ${backup.filename}`} onClick={() => void deleteBackup(backup.filename)} disabled={backupLoading}><Trash2 size={16} /></button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-label">
          <h2>帳期</h2>
          <p>帳期依台北時間自動推進，不提供手動跳月；過去的帳期只能在歷史紀錄裡唯讀查看。</p>
        </div>
        <div className="card">
          {lifecycle ? (
            <dl className="facts">
              <div><dt>目前帳期</dt><dd>{lifecycle.currentMonth}</dd></div>
              <div><dt>系統月份（台北）</dt><dd>{lifecycle.systemMonth}<small>{lifecycle.isCurrent ? '已同步' : '待自動更新'}</small></dd></div>
              <div><dt>上次自動推進</dt><dd>{lifecycle.lastAdvancedAt ? `${lifecycle.lastAdvancedFrom} → ${lifecycle.lastAdvancedTo}` : '尚未推進'}{lifecycle.lastAdvancedAt && <small>{new Date(lifecycle.lastAdvancedAt).toLocaleString('zh-TW', { hour12: false })}</small>}</dd></div>
            </dl>
          ) : <p role={lifecycleError ? 'alert' : 'status'} className="meta">{lifecycleError || '載入帳期狀態中…'}</p>}
          {lifecycle?.blockedReason && <p className="notice bad card-split">{lifecycle.blockedReason}</p>}
        </div>
      </div>

      <Modal open={Boolean(selectedBackup)} onClose={() => setSelectedBackup(undefined)} labelledBy="restore-modal-title" initialFocusRef={restoreCancelRef}>
        <div className="modal-head"><h2 id="restore-modal-title" className="modal-title">確認還原備份</h2><button type="button" className="icon-btn" aria-label="關閉還原確認" onClick={() => setSelectedBackup(undefined)}><X size={18} /></button></div>
        {selectedBackup && (
          <div className="modal-body">
            <p>將還原至 <strong>{formatBackupTimestamp(selectedBackup)}</strong>（{selectedBackup.snapshot?.currentMonth} 帳期）。</p>
            <p>{selectedBackup.restoreImpact.summary}</p>
            <p className="hint">目前資料會先自動備份，再執行還原。</p>
            <div className="modal-actions"><button ref={restoreCancelRef} type="button" className="btn" onClick={() => setSelectedBackup(undefined)} disabled={backupLoading}>取消</button><button type="button" className="btn btn-primary" onClick={() => void restoreBackup()} disabled={backupLoading}>{backupLoading ? '還原中...' : '確認還原'}</button></div>
          </div>
        )}
      </Modal>
    </div>
  );
}
