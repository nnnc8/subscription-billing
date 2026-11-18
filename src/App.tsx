import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { History, LayoutGrid, LogOut, Menu, Moon, Settings, Sun, Users, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { formatMoney, getDashboardSummary } from './billing.js';
import { DashboardTab } from './components/DashboardTab.js';
import { HistoryTab } from './components/HistoryTab.js';
import { SettingsTab } from './components/SettingsTab.js';
import { SubscriptionsTab } from './components/SubscriptionsTab.js';
import { initialOf } from './display.js';
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
const BACKGROUND_SYNC_MIN_INTERVAL_MS = 15_000;
const NAV_ITEMS: ReadonlyArray<{ id: TabId; icon: LucideIcon; label: string }> = [
  { id: 'dashboard', icon: LayoutGrid, label: '總覽' },
  { id: 'subscriptions', icon: Users, label: '訂閱名額' },
  { id: 'config', icon: Settings, label: '設定' },
  { id: 'history', icon: History, label: '歷史紀錄' },
];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 24 24" aria-hidden="true">
      <rect width="24" height="24" rx="7" />
      <path className="brand-mark-whole" d="M11 6.5a5.5 5.5 0 1 0 5.5 5.5H11z" />
      <path className="brand-mark-share" d="M13 4.6a5.5 5.5 0 0 1 5.4 5.4H13z" />
    </svg>
  );
}

function AuthScreen({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="auth-shell">
      <div className="auth-card">
        <div className="brand"><BrandMark /><strong>收支帳務</strong></div>
        <h1>{title}</h1>
        {children}
      </div>
    </div>
  );
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
  const [menuOpen, setMenuOpen] = useState(false);
  const [toast, setToast] = useState('');
  const toastTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    document.body.classList.toggle('dark-mode', isDark);
    localStorage.setItem('theme', isDark ? 'dark' : 'light');
  }, [isDark]);

  useEffect(() => () => {
    if (toastTimer.current !== undefined) window.clearTimeout(toastTimer.current);
  }, []);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenuOpen(false); };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [menuOpen]);

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

  // With several devices signed in, pick up changes made elsewhere when this one comes back
  // into view. Failures stay silent so a flaky mobile connection keeps the last good data.
  useEffect(() => {
    if (!authenticated) return undefined;
    let lastSyncAt = Date.now();
    function syncInBackground(): void {
      if (document.visibilityState !== 'visible' || Date.now() - lastSyncAt < BACKGROUND_SYNC_MIN_INTERVAL_MS) return;
      lastSyncAt = Date.now();
      void apiFetch('/data')
        .then(async (response) => {
          if (response.ok) setData(await response.json() as Database);
        })
        .catch(() => undefined);
    }
    document.addEventListener('visibilitychange', syncInBackground);
    window.addEventListener('focus', syncInBackground);
    return () => {
      document.removeEventListener('visibilitychange', syncInBackground);
      window.removeEventListener('focus', syncInBackground);
    };
  }, [authenticated, apiFetch]);

  async function handleLogout(): Promise<void> {
    try {
      await fetch(`${API_BASE}/auth/logout`, { method: 'POST', credentials: 'include' });
    } finally {
      markUnauthenticated();
    }
  }

  async function handleLogoutAll(): Promise<void> {
    if (!window.confirm('要登出所有裝置嗎？\n\n包含這台在內，所有已登入的手機和電腦都需要重新用 Google 登入。')) return;
    try {
      const response = await fetch(`${API_BASE}/auth/logout-all`, { method: 'POST', credentials: 'include' });
      if (!response.ok && response.status !== 401) {
        showToast('登出所有裝置失敗，請稍後再試');
        return;
      }
    } catch {
      showToast('登出所有裝置失敗，請稍後再試');
      return;
    }
    markUnauthenticated();
  }

  if (!authChecked) return <AuthScreen title="正在確認登入狀態"><p>稍等一下，馬上就好。</p></AuthScreen>;
  if (!authenticated) {
    return (
      <AuthScreen title="登入後查看本期帳務">
        <p>只有允許名單內的 Google 帳號可以載入帳務資料。</p>
        <button type="button" className="btn btn-primary btn-block" onClick={() => { window.location.href = `${API_BASE}/auth/login`; }}>使用 Google 登入</button>
      </AuthScreen>
    );
  }
  if (error) {
    return (
      <AuthScreen title="連線或載入失敗">
        <p>{error}</p>
        <button type="button" className="btn btn-primary btn-block" onClick={() => { setLoading(true); void refreshData(); }}>重新連線載入</button>
      </AuthScreen>
    );
  }
  if (loading || !data) return <AuthScreen title="正在載入帳務資料"><p>正在讀取帳期、名額與收款紀錄。</p></AuthScreen>;

  const summary = getDashboardSummary(data);
  const headings: Record<TabId, { title: string; finding: string }> = {
    dashboard: {
      title: '總覽',
      finding: summary.unpaidMembersCount > 0
        ? `${data.currentMonth} 還有 ${summary.unpaidMembersCount} 位沒結清，共 ${formatMoney(summary.totalReceivables)}`
        : `${data.currentMonth} 的帳款都已結清`,
    },
    subscriptions: {
      title: '訂閱名額',
      finding: `${summary.activeSeatCount} 個名額計費中，分屬 ${summary.activePlatforms.length} 個平台`,
    },
    config: { title: '設定', finding: '定價、成員、匯款資訊與備份。寫入前的修改只留在這台裝置。' },
    history: {
      title: '歷史紀錄',
      finding: data.history.length === 0
        ? '還沒有已封存的帳期'
        : `${data.history.length} 期已封存，${summary.historyIntegrity.ok ? '封存鏈完整' : '封存鏈需要檢查'}`,
    },
  };
  const heading = headings[activeTab];
  const accountLabel = authUser?.email ?? '帳務管理者';

  return (
    <div className="app">
      <header className="phone-bar">
        <BrandMark />
        <span className="phone-bar-title">收支帳務</span>
        <button type="button" className="icon-btn" aria-label="開啟選單" aria-expanded={menuOpen} aria-controls="app-sidebar" onClick={() => setMenuOpen(true)}>
          <Menu size={20} />
        </button>
      </header>

      <aside id="app-sidebar" className={`sidebar${menuOpen ? ' open' : ''}`}>
        <div className="sidebar-head">
          <div className="brand">
            <BrandMark />
            <div className="brand-text"><strong>收支帳務</strong><span>{data.currentMonth} 帳期</span></div>
          </div>
          <button type="button" className="icon-btn sidebar-close" aria-label="關閉選單" onClick={() => setMenuOpen(false)}><X size={20} /></button>
        </div>
        <nav className="nav" aria-label="主要導航">
          {NAV_ITEMS.map(({ id, icon: Icon, label }) => (
            <button
              key={id}
              type="button"
              className="nav-item"
              aria-current={activeTab === id ? 'page' : undefined}
              onClick={() => { setActiveTab(id); setMenuOpen(false); }}
            >
              <Icon size={16} strokeWidth={1.75} /><span>{label}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className="user-row">
            <button type="button" className="avatar avatar-self" aria-label="顯示系統歡迎訊息" onClick={() => showToast('歡迎使用共乘訂閱對帳系統！')}>
              {initialOf(accountLabel).toUpperCase()}
            </button>
            <div className="user-text"><strong>{authUser?.name ?? '帳務管理者'}</strong>{authUser?.email && <span>{authUser.email}</span>}</div>
            <button type="button" className="icon-btn" aria-label="切換深色模式" aria-pressed={isDark} onClick={() => setIsDark((current) => !current)}>
              {isDark ? <Sun size={16} /> : <Moon size={16} />}
            </button>
          </div>
          <div className="sidebar-actions">
            <button type="button" className="btn btn-ghost" onClick={() => void handleLogout()}><LogOut size={16} />登出</button>
            <button type="button" className="btn btn-ghost" onClick={() => void handleLogoutAll()}>登出所有裝置</button>
          </div>
        </div>
      </aside>

      <main className="canvas">
        <header className="page-head">
          <h1>{heading.title}</h1>
          <p>{heading.finding}</p>
        </header>

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
