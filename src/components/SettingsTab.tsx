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
  return snapshot?.health.status ?? 'risk';
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
        body: JSON.stringify({ platforms: editedPlatforms, members: editedMembers, bankInfo, reminderStyle }),
      });
      const result = await response.json() as ApiResult;
      if (!response.ok) {
        showToast(result.error ?? '儲存設定失敗');
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

  return (
    <>
      <section className={`draft-console ${configDirty ? 'dirty' : 'clean'}`}>
        <div className="draft-console-main"><span>設定草稿控制台</span><h2>{configDirty ? '尚有未落帳變更' : '目前與正式設定一致'}</h2><p>{configDirty ? `目前有 ${draftCount} 個變更只存在這個瀏覽器畫面。儲存後會一次寫入資料庫並留下事件。` : '目前畫面已和正式資料庫同步。'}</p></div>
        <div className="draft-stat"><span>平台草稿</span><strong>{dirtyPlatformIds.length}</strong><small>費率或模式</small></div>
        <div className="draft-stat"><span>成員草稿</span><strong>{dirtyMemberIds.length}</strong><small>餘額或特例月費</small></div>
        <div className="draft-stat"><span>文字設定</span><strong>{Number(bankDirty) + Number(reminderDirty)}</strong><small>匯款資訊或語氣</small></div>
        <div className="draft-actions-panel"><button type="button" className="btn btn-primary" onClick={() => void saveConfig()} disabled={!configDirty || configSaving}>{configSaving ? '寫入中...' : '一次寫入正式設定'}</button><button type="button" className="btn btn-secondary" onClick={clearDrafts} disabled={!configDirty || configSaving}>放棄草稿</button></div>
      </section>

      <div className="config-layout">
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          <section className="table-container" style={{ padding: '1.5rem' }}>
            <h2>平台收費模式與定價設定</h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>{data.platforms.map((platform) => {
              const archived = isArchivedEntity(platform);
              const draft = platformDrafts[platform.id];
              const mode = draft?.billingMode ?? platform.billingMode;
              return <div key={platform.id} style={{ paddingBottom: '1rem', borderBottom: '1px solid var(--separator)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}><strong>{platform.name}{archived && <span className="void-badge">已停用</span>}</strong><button type="button" className="btn btn-danger" onClick={() => void archiveEntity('platform', platform.id, platform.name)} disabled={archived}>{archived ? '已停用' : '停用平台'}</button></div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
                  <div className="form-group"><label htmlFor={`platform-mode-${platform.id}`}>收費模式</label><select id={`platform-mode-${platform.id}`} className="form-control" value={mode} disabled={archived} onChange={(event) => setPlatformDrafts((current) => ({ ...current, [platform.id]: { ...current[platform.id], billingMode: event.target.value as Platform['billingMode'] } }))}><option value="fixed">固定價格 (按人)</option><option value="split">動態均分 (平台總價)</option></select></div>
                  <div className="form-group"><label htmlFor={`platform-price-${platform.id}`}>{mode === 'split' ? '平台總月費' : '固定單人月費'} (NT$)</label><input id={`platform-price-${platform.id}`} type="number" className="form-control" disabled={archived} value={mode === 'split' ? draft?.totalCost ?? String(platform.totalCost) : draft?.price ?? String(platform.price)} onChange={(event) => setPlatformDrafts((current) => ({ ...current, [platform.id]: { ...current[platform.id], [mode === 'split' ? 'totalCost' : 'price']: event.target.value } }))} /></div>
                </div>
              </div>;
            })}</div>
          </section>

          <section className="table-container" style={{ padding: '1.5rem' }}>
            <h2>新增訂閱平台</h2>
            <form onSubmit={handleAddPlatform} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div className="form-group"><label htmlFor="new-platform-name">平台名稱</label><input id="new-platform-name" className="form-control" value={newPlatformName} onChange={(event) => setNewPlatformName(event.target.value)} required /></div>
              <div className="form-group"><label htmlFor="new-platform-mode">收費模式</label><select id="new-platform-mode" className="form-control" value={newPlatformMode} onChange={(event) => setNewPlatformMode(event.target.value as Platform['billingMode'])}><option value="fixed">固定價格 (按人)</option><option value="split">動態均分 (平台總價)</option></select></div>
              <div className="form-group"><label htmlFor="new-platform-price">{newPlatformMode === 'split' ? '平台總月費' : '固定單人月費'} (NT$)</label><input id="new-platform-price" type="number" className="form-control" value={newPlatformMode === 'split' ? newPlatformTotal : newPlatformPrice} onChange={(event) => newPlatformMode === 'split' ? setNewPlatformTotal(event.target.value) : setNewPlatformPrice(event.target.value)} /></div>
              <button type="submit" className="btn btn-secondary">建立平台</button>
            </form>
          </section>

          <section className="table-container" style={{ padding: '1.5rem' }}>
            <h2>通知腳本與匯款設定</h2>
            <div className="form-group"><label htmlFor="bank-info">匯款帳戶資訊</label><textarea id="bank-info" className="form-control" rows={2} value={bankInfo} onChange={(event) => setBankDraft(event.target.value)} /></div>
            <div className="form-group"><label htmlFor="reminder-style">催帳訊息風格</label><select id="reminder-style" className="form-control" value={reminderStyle} onChange={(event) => setReminderStyleDraft(event.target.value)}><option value="friendly">幽默親友風</option><option value="formal">正式對帳風</option><option value="minimal">極簡親友風</option></select></div>
          </section>

          <section className="table-container recovery-console">
            <div className="recovery-header"><div><span>Recovery</span><h2>資料備份與還原</h2></div><button type="button" className="btn btn-secondary" onClick={() => { setBackupOpen((open) => !open); if (!backupOpen) void loadBackups(); }}>{backupOpen ? '收合' : '管理備份'}</button></div>
            {backupOpen && <div className="recovery-body">
              {recoveryStatus && <div className={`recovery-current ${snapshotTone(recoveryStatus)}`}><div><span>目前狀態</span><strong>{recoveryStatus.currentMonth} · {recoveryStatus.health.label}</strong><small>{recoveryStatus.health.warningCount} 個提醒</small></div><div><span>待收</span><strong>{formatMoney(recoveryStatus.totals.receivable)}</strong><small>{recoveryStatus.totals.unpaidMembers} 人未結清</small></div><div><span>指紋</span><code>{recoveryStatus.fingerprint.slice(0, 12)}</code><small>{recoveryStatus.counts.ledger} 筆事件</small></div></div>}
              <button type="button" className="btn btn-secondary recovery-create" onClick={() => void createBackup()} disabled={backupLoading}>{backupLoading ? '處理中...' : '建立目前狀態備份'}</button>
              {backups.length === 0 ? <p className="recovery-empty">暫無備份記錄</p> : <div className="recovery-list">{backups.map((backup) => <div key={backup.filename} className={`recovery-item ${snapshotTone(backup.snapshot)}`}><div className="recovery-item-main"><div className="recovery-item-title"><span>{formatBackupTimestamp(backup)}</span><strong>{backup.readable ? backup.snapshot?.health.label : '無法讀取'}</strong></div><div className="recovery-item-meta"><span>{backup.readable ? `${backup.snapshot?.currentMonth} 帳期` : backup.error}</span><span>{(backup.size / 1024).toFixed(1)} KB</span></div><p>{backup.restoreImpact.summary}</p></div><div className="recovery-actions"><button type="button" className="btn btn-success" onClick={() => setSelectedBackup(backup)} disabled={backupLoading || !backup.readable}>還原</button><button type="button" className="btn btn-danger btn-icon-only" aria-label={`刪除備份 ${backup.filename}`} onClick={() => void deleteBackup(backup.filename)} disabled={backupLoading}>×</button></div></div>)}</div>}
            </div>}
          </section>

          <section className="table-container" style={{ padding: '1.25rem' }}>
            <h2>帳期管理</h2>
            {lifecycle ? <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}><div><span>目前帳期</span><strong style={{ display: 'block' }}>{lifecycle.currentMonth}</strong></div><div><span>系統月份（台北）</span><strong style={{ display: 'block' }}>{lifecycle.systemMonth} · {lifecycle.isCurrent ? '已同步' : '待自動更新'}</strong></div>{lifecycle.lastAdvancedAt && <div style={{ gridColumn: '1 / -1' }}><span>上次自動推進</span><p>{lifecycle.lastAdvancedFrom} → {lifecycle.lastAdvancedTo} · {new Date(lifecycle.lastAdvancedAt).toLocaleString('zh-TW')}</p></div>}{lifecycle.blockedReason && <p style={{ gridColumn: '1 / -1', color: 'var(--red)' }}>{lifecycle.blockedReason}</p>}</div> : <p role={lifecycleError ? 'alert' : 'status'}>{lifecycleError || '載入帳期狀態中…'}</p>}
            <p style={{ color: 'var(--text-muted)', marginBottom: 0 }}>帳期由系統依台北時間自動推進；正常操作不提供手動跳月，舊帳期只在歷史紀錄中唯讀瀏覽。</p>
          </section>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          <section className="table-container" style={{ padding: '1.5rem' }}>
            <h2>成員名單、期初餘額與特例月費</h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>{data.members.map((member) => {
              const archived = isArchivedEntity(member);
              const draft = memberDrafts[member.id];
              return <div key={member.id} style={{ paddingBottom: '1rem', borderBottom: '1px solid var(--separator)' }}><div style={{ display: 'flex', justifyContent: 'space-between' }}><strong>{member.name}{archived && <span className="void-badge">已停用</span>}</strong><button type="button" className="btn btn-danger" onClick={() => void archiveEntity('member', member.id, member.name)} disabled={archived}>{archived ? '已停用' : '停用成員'}</button></div><div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}><div className="form-group"><label htmlFor={`member-prior-${member.id}`}>前期餘額 (期初)</label><input id={`member-prior-${member.id}`} type="number" className="form-control" disabled={archived} value={draft?.priorBalance ?? String(member.priorBalance)} onChange={(event) => setMemberDrafts((current) => ({ ...current, [member.id]: { ...current[member.id], priorBalance: event.target.value } }))} /></div><div className="form-group"><label htmlFor={`member-fee-${member.id}`}>自訂月費 (特例)</label><input id={`member-fee-${member.id}`} type="number" className="form-control" disabled={archived} value={draft?.customFee ?? String(member.customFee ?? '')} onChange={(event) => setMemberDrafts((current) => ({ ...current, [member.id]: { ...current[member.id], customFee: event.target.value } }))} /></div></div></div>;
            })}</div>
          </section>

          <section className="table-container" style={{ padding: '1.5rem' }}>
            <h2>新增成員</h2>
            <form onSubmit={handleAddMember} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div className="form-group"><label htmlFor="new-member-name">成員姓名</label><input id="new-member-name" className="form-control" value={newMemberName} onChange={(event) => setNewMemberName(event.target.value)} required /></div>
              <div className="form-group"><label htmlFor="new-member-prior">期初餘額 (NT$)</label><input id="new-member-prior" type="number" className="form-control" value={newMemberPrior} onChange={(event) => setNewMemberPrior(event.target.value)} /></div>
              <div className="form-group"><label htmlFor="new-member-custom">自訂月費 (非必填)</label><input id="new-member-custom" type="number" className="form-control" value={newMemberCustom} onChange={(event) => setNewMemberCustom(event.target.value)} /></div>
              <button type="submit" className="btn btn-secondary">建立成員</button>
            </form>
          </section>
        </div>
      </div>

      <Modal open={Boolean(selectedBackup)} onClose={() => setSelectedBackup(undefined)} labelledBy="restore-modal-title" initialFocusRef={restoreCancelRef}>
        <div className="modal-header"><h2 id="restore-modal-title" className="modal-title">確認還原備份</h2><button type="button" className="modal-close" aria-label="關閉還原確認" onClick={() => setSelectedBackup(undefined)}>×</button></div>
        {selectedBackup && <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}><p>將還原至 <strong>{formatBackupTimestamp(selectedBackup)}</strong>（{selectedBackup.snapshot?.currentMonth} 帳期）。</p><p>{selectedBackup.restoreImpact.summary}</p><p>目前資料會先自動備份，再執行還原。</p><div style={{ display: 'flex', gap: '0.75rem' }}><button ref={restoreCancelRef} type="button" className="btn btn-secondary" onClick={() => setSelectedBackup(undefined)} disabled={backupLoading}>取消</button><button type="button" className="btn btn-danger" onClick={() => void restoreBackup()} disabled={backupLoading}>{backupLoading ? '還原中...' : '確認還原'}</button></div></div>}
      </Modal>
    </>
  );
}
