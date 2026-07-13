import { useCallback, useEffect, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import { formatEventTime, formatMoney, getDashboardSummary } from './billing.js';
import { DashboardTab } from './components/DashboardTab.js';
import { HistoryTab } from './components/HistoryTab.js';
import { SettingsTab } from './components/SettingsTab.js';
import { SubscriptionsTab } from './components/SubscriptionsTab.js';
import type { ApiFetch, Database } from './types/billing.js';

type TabId = 'dashboard' | 'subscriptions' | 'config' | 'history';

interface AuthUser {
  email: string;
  name?: string;
}

interface SessionResponse {
  authenticated: boolean;
  user?: AuthUser | null;
}

const API_BASE = '/api';
const AUTH_REQUIRED = 'AUTH_REQUIRED';
const NAV_ITEMS: ReadonlyArray<{ id: TabId; code: string; label: string }> = [
  { id: 'dashboard', code: '📊', label: '總覽' },
  { id: 'subscriptions', code: '👥', label: '訂閱名額' },
  { id: 'config', code: '⚙️', label: '設定' },
  { id: 'history', code: '📋', label: '歷史紀錄' },
];
const TAB_META: Record<TabId, { title: string; description: string }> = {
  dashboard: { title: '總覽', description: '查看帳務概況、待收款項與本期收支狀態。' },
  subscriptions: { title: '訂閱名額', description: '管理成員的訂閱配置與起算月份。' },
  config: { title: '設定', description: '調整定價、期初餘額、備份與帳期狀態。' },
  history: { title: '歷史紀錄', description: '唯讀瀏覽過往帳期的結帳紀錄與封存狀態。' },
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function App() {
  const [data, setData] = useState<Database>();
  const [activeTab, setActiveTab] = useState<TabId>('dashboard');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [authChecked, setAuthChecked] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [authUser, setAuthUser] = useState<AuthUser>();
  const [isDark, setIsDark] = useState(() => localStorage.getItem('theme') === 'dark');
  const [auditAlertClosed, setAuditAlertClosed] = useState(false);
  const [toast, setToast] = useState('');
  const toastTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    document.body.classList.toggle('dark-mode', isDark);
    localStorage.setItem('theme', isDark ? 'dark' : 'light');
  }, [isDark]);

  useEffect(() => () => {
    if (toastTimer.current !== undefined) window.clearTimeout(toastTimer.current);
  }, []);

  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current !== undefined) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(''), 3000);
  }, []);

  const markUnauthenticated = useCallback(() => {
    setAuthenticated(false);
    setAuthUser(undefined);
    setData(undefined);
    setError(undefined);
    setLoading(false);
    setAuthChecked(true);
  }, []);

  const apiFetch = useCallback<ApiFetch>(async (path, options = {}) => {
    const response = await fetch(`${API_BASE}${path}`, { ...options, credentials: 'include' });
    if (response.status === 401) {
      markUnauthenticated();
      throw new Error(AUTH_REQUIRED);
    }
    return response;
  }, [markUnauthenticated]);

  const refreshData = useCallback(async () => {
    setError(undefined);
    try {
      const response = await apiFetch('/data');
      if (!response.ok) throw new Error(`伺服器回應錯誤 (${response.status} ${response.statusText})`);
      setData(await response.json() as Database);
    } catch (caught) {
      if (errorMessage(caught) === AUTH_REQUIRED) return;
      setError(errorMessage(caught));
      showToast('載入資料失敗，請檢查後端服務是否啟動！');
    } finally {
      setLoading(false);
    }
  }, [apiFetch, showToast]);

  useEffect(() => {
    let cancelled = false;
    void fetch(`${API_BASE}/auth/session`, { credentials: 'include' })
      .then((response) => response.json() as Promise<SessionResponse>)
      .then((session) => {
        if (cancelled) return;
        setAuthenticated(session.authenticated);
        setAuthUser(session.user ?? undefined);
      })
      .catch(() => { if (!cancelled) setAuthenticated(false); })
      .finally(() => { if (!cancelled) setAuthChecked(true); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!authChecked || !authenticated) return undefined;
    const timer = window.setTimeout(() => void refreshData(), 0);
    return () => window.clearTimeout(timer);
  }, [authChecked, authenticated, refreshData]);

  async function handleLogout(): Promise<void> {
    try {
      await fetch(`${API_BASE}/auth/logout`, { method: 'POST', credentials: 'include' });
    } finally {
      markUnauthenticated();
    }
  }

  if (!authChecked) return <div className="auth-shell"><div className="auth-panel"><span className="auth-kicker">Checking session</span><h1>Subscription Billing</h1><p>正在確認登入狀態...</p></div></div>;
  if (!authenticated) return <div className="auth-shell"><div className="auth-panel"><span className="auth-kicker">Google account access</span><h1>Subscription Billing</h1><p>使用允許名單內的 Google 帳號登入後才會載入帳務資料。</p><button type="button" className="btn btn-primary auth-submit" onClick={() => { window.location.href = `${API_BASE}/auth/login`; }}>使用 Google 登入</button></div></div>;
  if (error) return <div className="auth-shell"><div className="auth-panel"><span className="auth-kicker">Connection error</span><h1>連線或載入失敗</h1><p>{error}</p><button type="button" className="btn btn-primary" onClick={() => { setLoading(true); void refreshData(); }}>重新連線載入</button></div></div>;
  if (loading || !data) return <div className="auth-shell"><div className="auth-panel"><span className="auth-kicker">Loading</span><h1>Subscription Billing</h1><p>正在載入帳務系統中...</p></div></div>;

  const summary = getDashboardSummary(data);
  const systemState = summary.criticalAuditCount > 0 || !summary.ledger.ok
    ? '需處理'
    : summary.totalReceivables > 0 ? '待收款' : '正常';
  const meta = TAB_META[activeTab];

  return (
    <div className="app-container">
      <div className="liquid-glass-bg" />
      <aside className="sidebar">
        <div className="logo-section"><strong>收支帳務</strong></div>
        <nav className="nav-links" aria-label="主要導航">
          {NAV_ITEMS.map((item) => (
            <button key={item.id} type="button" className={`nav-item ${activeTab === item.id ? 'active' : ''}`} aria-current={activeTab === item.id ? 'page' : undefined} onClick={() => setActiveTab(item.id)}>
              <span aria-hidden="true">{item.code}</span><span className="nav-label">{item.label}</span>
            </button>
          ))}
        </nav>
        <section className="rail-section" aria-label="即時帳務狀態">
          <span className="rail-heading">即時狀態</span>
          <div className="rail-card"><span className="rail-card-label">系統狀態</span><strong className="rail-card-value">{systemState}</strong><small className="rail-card-note">{summary.auditWarnings.length} 個提醒 · {summary.ledger.count} 筆紀錄</small></div>
          <div className="rail-card"><span className="rail-card-label">待收金額</span><strong className="rail-card-value">{formatMoney(summary.totalReceivables)}</strong><small className="rail-card-note">{summary.unpaidMembersCount} 位成員未結清</small></div>
          <div className="rail-card"><span className="rail-card-label">最近操作</span><strong className="rail-card-value">{summary.ledger.latest ? formatEventTime(summary.ledger.latest.at) : '尚無紀錄'}</strong><small className="rail-card-note">{summary.ledger.latest?.summary ?? '等待第一筆操作'}</small></div>
        </section>
        <div className="sidebar-footer"><p>{data.currentMonth} · 單一操作者模式</p>{authUser?.email && <p>{authUser.email}</p>}<button type="button" className="sidebar-logout" onClick={() => void handleLogout()}>登出</button></div>
      </aside>

      <main className="main-content">
        <nav className="topnav" aria-label="畫面工具">
          <button type="button" className="icon-btn avatar avatar-initials" aria-label="顯示系統歡迎訊息" onClick={() => showToast('歡迎使用共乘訂閱對帳系統！')}>帳</button>
          <div className="toggle-container"><button type="button" className="mode-switch" aria-label="切換深色模式" aria-pressed={isDark} onClick={() => setIsDark((current) => !current)}><span className="mode-track" /><span className="mode-icon">{isDark ? '☾' : '☀'}</span><span className="mode-handle" /></button><button type="button" className="nav-btn" onClick={() => setActiveTab('config')}>Settings</button></div>
          {summary.auditWarnings.length > 0 && !auditAlertClosed && <div className="meeting-alert"><span className="avatar avatar-initials" aria-hidden="true">!</span><span>帳務系統稽核提醒</span><span className="time-tag">{summary.auditWarnings.length}</span><button type="button" className="ring-close" aria-label="關閉帳務系統稽核提醒" onClick={() => setAuditAlertClosed(true)}><X size={12} /></button></div>}
          {activeTab === 'dashboard' && <button type="button" className="icon-btn" aria-label="聚焦至流水帳搜尋" onClick={() => document.getElementById('log-search')?.focus()}><Search size={20} /></button>}
        </nav>

        <header className="header-section"><div className="title-area"><h1>{meta.title}</h1><p>{meta.description}</p></div><div className="month-badge"><span className="month-badge-label">Active month</span><strong>{data.currentMonth}</strong></div></header>

        <section hidden={activeTab !== 'dashboard'} aria-label="總覽">
          <DashboardTab active={activeTab === 'dashboard'} data={data} apiFetch={apiFetch} refreshData={refreshData} showToast={showToast} />
        </section>
        <section hidden={activeTab !== 'subscriptions'} aria-label="訂閱名額">
          <SubscriptionsTab data={data} apiFetch={apiFetch} refreshData={refreshData} showToast={showToast} />
        </section>
        <section hidden={activeTab !== 'config'} aria-label="設定">
          <SettingsTab active={activeTab === 'config'} data={data} apiFetch={apiFetch} refreshData={refreshData} showToast={showToast} />
        </section>
        <section hidden={activeTab !== 'history'} aria-label="歷史紀錄">
          <HistoryTab data={data} />
        </section>
      </main>

      {toast && <div className="toast" role="status" aria-live="polite" aria-atomic="true">{toast}</div>}
    </div>
  );
}
