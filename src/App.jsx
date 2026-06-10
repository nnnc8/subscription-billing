import { useCallback, useEffect, useState } from 'react';

const API_BASE = window.location.port === '5173'
  ? 'http://localhost:3000/api'
  : `${window.location.origin}/api`;

function buildPriceEditorMap(platforms = []) {
  const priceMap = {};
  platforms.forEach(platform => {
    priceMap[platform.id] = {
      price: platform.price,
      billingMode: platform.billingMode || 'fixed',
      totalCost: platform.totalCost || 0
    };
  });
  return priceMap;
}

function buildMemberEditorMap(members = []) {
  const memberMap = {};
  members.forEach(member => {
    memberMap[member.id] = {
      customFee: member.customFee || '',
      priorBalance: member.priorBalance
    };
  });
  return memberMap;
}

function App() {
  const [data, setData] = useState(null);
  const [activeTab, setActiveTab] = useState('dashboard');
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState('');
  const [error, setError] = useState(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [loginPassword, setLoginPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [authLoading, setAuthLoading] = useState(false);
  
  // Modals
  const [showPayModal, setShowPayModal] = useState(false);
  const [showChargeModal, setShowChargeModal] = useState(false);
  const [showSettleModal, setShowSettleModal] = useState(false);
  const [selectedMember, setSelectedMember] = useState('');
  const [closePreview, setClosePreview] = useState(null);
  const [closePreviewLoading, setClosePreviewLoading] = useState(false);
  
  // Forms
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState('');
  const [noteOrDesc, setNoteOrDesc] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('轉帳');
  
  // Subscriptions Editor Form
  const [subName, setSubName] = useState('');
  const [subPlatform, setSubPlatform] = useState('Shared Video');
  const [subStart, setSubStart] = useState('');
  
  // Configuration Editors
  const [bankInfo, setBankInfo] = useState('');
  const [reminderStyle, setReminderStyle] = useState('friendly');
  const [editingPrices, setEditingPrices] = useState({});
  const [editingMembers, setEditingMembers] = useState({});
  
  // History Browser
  const [selectedHistMonth, setSelectedHistMonth] = useState('');
  const [expandedPreviewMember, setExpandedPreviewMember] = useState(null);

  // CRUD Member form states
  const [newMemberName, setNewMemberName] = useState('');
  const [newMemberPrior, setNewMemberPrior] = useState('0');
  const [newMemberCustom, setNewMemberCustom] = useState('');

  // CRUD Platform form states
  const [newPlatName, setNewPlatName] = useState('');
  const [newPlatPrice, setNewPlatPrice] = useState('0');
  const [newPlatMode, setNewPlatMode] = useState('fixed');
  const [newPlatTotal, setNewPlatTotal] = useState('0');

  // Backup states
  const [backups, setBackups] = useState([]);
  const [recoveryStatus, setRecoveryStatus] = useState(null);
  const [showBackupPanel, setShowBackupPanel] = useState(false);
  const [backupLoading, setBackupLoading] = useState(false);
  const [configSaving, setConfigSaving] = useState(false);
  const [transactionSaving, setTransactionSaving] = useState(null);

  // Logs search/filter states
  const [logSearch, setLogSearch] = useState('');
  const [logMemberFilter, setLogMemberFilter] = useState('');

  const showToast = useCallback((msg) => {
    setToast(msg);
    setTimeout(() => { setToast(''); }, 3000);
  }, []);

  const markUnauthenticated = useCallback(() => {
    setAuthenticated(false);
    setData(null);
    setError(null);
    setLoading(false);
    setAuthChecked(true);
  }, []);

  const apiFetch = useCallback(async (path, options = {}) => {
    const res = await fetch(`${API_BASE}${path}`, {
      ...options,
      credentials: 'include',
      headers: {
        ...(options.headers || {})
      }
    });
    if (res.status === 401) {
      markUnauthenticated();
      const err = new Error('AUTH_REQUIRED');
      err.code = 'AUTH_REQUIRED';
      throw err;
    }
    return res;
  }, [markUnauthenticated]);

  const formatMoney = (value) => `$${Number(value || 0).toLocaleString()}`;

  const formatRecentTimestamp = (iso) => {
    if (!iso) return '剛剛';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '剛剛';
    return date.toLocaleString('zh-TW', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
  };

  const formatBackupTimestamp = (label, iso) => {
    const match = String(label || '').match(/^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})$/);
    if (match) {
      return `${match[1]}/${match[2]}/${match[3]} ${match[4]}:${match[5]}:${match[6]}`;
    }
    if (!iso) return label || '未知時間';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return label || iso;
    return date.toLocaleString('zh-TW', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });
  };

  const getSnapshotTone = (snapshot) => {
    const status = snapshot?.health?.status;
    if (status === 'clean') return 'clean';
    if (status === 'warning') return 'warning';
    return 'risk';
  };

  const isVoidedTransaction = (transaction) => Boolean(
    transaction && (transaction.status === 'voided' || transaction.voidedAt || transaction.voided === true)
  );

  const activeTransactions = (transactions = []) => transactions.filter(transaction => !isVoidedTransaction(transaction));

  const monthToCodeLocal = (monthStr) => {
    if (!/^\d{4}\/(0[1-9]|1[0-2])$/.test(monthStr || '')) return null;
    const [year, month] = monthStr.split('/').map(Number);
    return year * 12 + month;
  };

  const isArchivedEntity = (entity) => Boolean(entity && (entity.status === 'archived' || entity.archivedAt));

  const isEntityBillableInMonth = (entity, monthStr) => {
    if (!entity || !isArchivedEntity(entity)) return true;
    const archivedCode = monthToCodeLocal(entity.archivedMonth);
    const targetCode = monthToCodeLocal(monthStr);
    if (archivedCode === null || targetCode === null) return false;
    return targetCode < archivedCode;
  };

  const syncClientStateFromDb = useCallback((dbState, { keepSelectedHistory = false } = {}) => {
    setData(dbState);
    setBankInfo(dbState.bankInfo || '');
    setReminderStyle(dbState.reminderStyle || 'friendly');
    setEditingPrices(buildPriceEditorMap(dbState.platforms));
    setEditingMembers(buildMemberEditorMap(dbState.members));

    if (!dbState.history || dbState.history.length === 0) {
      setSelectedHistMonth('');
      return;
    }

    if (keepSelectedHistory && dbState.history.some(entry => entry.month === selectedHistMonth)) {
      return;
    }

    setSelectedHistMonth(dbState.history[dbState.history.length - 1].month);
  }, [selectedHistMonth]);

  const buildEditedPlatformsPayload = () => data.platforms.map(platform => {
    const draft = editingPrices[platform.id] || {};
    const billingMode = draft.billingMode || platform.billingMode || 'fixed';
    return {
      ...platform,
      billingMode,
      price: billingMode === 'split' ? 0 : parseFloat(draft.price ?? platform.price) || 0,
      totalCost: billingMode === 'split' ? parseFloat(draft.totalCost ?? platform.totalCost) || 0 : 0
    };
  });

  const buildEditedMembersPayload = () => data.members.map(member => {
    const draft = editingMembers[member.id] || {};
    return {
      ...member,
      priorBalance: parseFloat(draft.priorBalance ?? member.priorBalance) || 0,
      customFee: draft.customFee === '' || draft.customFee === null || draft.customFee === undefined
        ? null
        : parseFloat(draft.customFee)
    };
  });

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch('/data');
      if (!res.ok) {
        throw new Error(`伺服器回應錯誤 (${res.status} ${res.statusText})`);
      }
      const json = await res.json();
      syncClientStateFromDb(json, { keepSelectedHistory: true });
    } catch (err) {
      if (err.code === 'AUTH_REQUIRED') return;
      console.error("Error loading data:", err);
      setError(err.message || String(err));
      showToast("載入資料失敗，請檢查後端服務是否啟動！");
    } finally {
      setLoading(false);
    }
  }, [apiFetch, showToast, syncClientStateFromDb]);

  useEffect(() => {
    let cancelled = false;
    async function checkSession() {
      try {
        const res = await fetch(`${API_BASE}/auth/session`, { credentials: 'include' });
        const json = await res.json();
        if (cancelled) return;
        setAuthenticated(Boolean(json.authenticated));
      } catch {
        if (!cancelled) setAuthenticated(false);
      } finally {
        if (!cancelled) setAuthChecked(true);
      }
    }
    checkSession();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!authChecked || !authenticated) return undefined;
    const loadTimer = window.setTimeout(fetchData, 0);
    return () => window.clearTimeout(loadTimer);
  }, [authChecked, authenticated, fetchData]);

  const handleLogin = async (event) => {
    event.preventDefault();
    setAuthLoading(true);
    setLoginError('');
    try {
      const res = await fetch(`${API_BASE}/auth/login`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: loginPassword })
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload.error || '登入失敗');
      }
      setLoginPassword('');
      setAuthenticated(true);
      setLoading(true);
    } catch (err) {
      setLoginError(err.message || '登入失敗');
    } finally {
      setAuthLoading(false);
    }
  };

  const handleLogout = async () => {
    try {
      await fetch(`${API_BASE}/auth/logout`, {
        method: 'POST',
        credentials: 'include'
      });
    } finally {
      markUnauthenticated();
    }
  };

  // Backup helpers
  const loadBackups = async () => {
    try {
      const res = await apiFetch('/backups');
      const json = await res.json();
      if (json.success) {
        setBackups(json.backups);
        setRecoveryStatus(json.current);
      }
    } catch {
      showToast("無法讀取備份列表");
    }
  };

  const handleCreateBackup = async () => {
    setBackupLoading(true);
    try {
      const res = await apiFetch('/backups/create', { method: 'POST' });
      const json = await res.json();
      if (json.success) {
        showToast(json.message);
        await loadBackups();
      } else {
        showToast(json.error || "備份失敗");
      }
    } catch {
      showToast("建立備份時發生錯誤");
    } finally {
      setBackupLoading(false);
    }
  };

  const handleRestoreBackup = async (backup) => {
    const filename = typeof backup === 'string' ? backup : backup.filename;
    const snapshot = typeof backup === 'string' ? null : backup.snapshot;
    const impact = typeof backup === 'string' ? null : backup.restoreImpact;
    const confirmLines = [
      `確定要還原至 ${filename} 嗎？`,
      snapshot ? `目標帳期：${snapshot.currentMonth}，待收：${formatMoney(snapshot.totals?.receivable)}` : null,
      impact ? `差異：${impact.summary}` : null,
      '',
      '目前的資料將會先備份一次後再還原。'
    ].filter(line => line !== null);
    if (!confirm(confirmLines.join('\n'))) return;
    setBackupLoading(true);
    try {
      const res = await apiFetch('/backups/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename })
      });
      const json = await res.json();
      if (json.success) {
        syncClientStateFromDb(json.data, { keepSelectedHistory: false });
        showToast(`已還原至 ${filename}`);
        await loadBackups();
      } else {
        showToast(json.error || "還原失敗");
      }
    } catch {
      showToast("還原時發生錯誤");
    } finally {
      setBackupLoading(false);
    }
  };

  const handleDeleteBackup = async (filename) => {
    if (!confirm(`確定刪除備份 ${filename}？`)) return;
    setBackupLoading(true);
    try {
      const res = await apiFetch(`/backups/${encodeURIComponent(filename)}`, { method: 'DELETE' });
      const json = await res.json();
      if (json.success) {
        showToast("備份已刪除");
        await loadBackups();
      }
    } catch {
      showToast("刪除備份失敗");
    } finally {
      setBackupLoading(false);
    }
  };

  // Helper: check if a YYYY/MM code is within subscription active range
  const isSubActiveInMonth = (sub, monthStr) => {
    const [sY, sM] = sub.startMonth.split('/').map(Number);
    const startCode = sY * 12 + sM;
    
    const [tY, tM] = monthStr.split('/').map(Number);
    const targetCode = tY * 12 + tM;
    
    let exitCode = Infinity;
    if (sub.exitMonth) {
      const [eY, eM] = sub.exitMonth.split('/').map(Number);
      exitCode = eY * 12 + eM;
    }
    
    return targetCode >= startCode && targetCode <= exitCode;
  };

  const getSubscriptionMember = (sub, dbState) => (
    (dbState.members || []).find(m => (sub.memberId && m.id === sub.memberId) || m.name === sub.memberName)
  );

  const getSubscriptionPlatform = (sub, dbState) => (
    (dbState.platforms || []).find(p => (sub.platformId && p.id === sub.platformId) || p.name === sub.platformName)
  );

  const isSubBillableInMonth = (sub, dbState, monthStr) => {
    if (!isSubActiveInMonth(sub, monthStr)) return false;
    const member = getSubscriptionMember(sub, dbState);
    const platform = getSubscriptionPlatform(sub, dbState);
    return isEntityBillableInMonth(member, monthStr) && isEntityBillableInMonth(platform, monthStr);
  };

  // Helper: Get local calculated platform price supporting split mode
  const getPlatformPriceForMonthLocal = (plat, dbState, monthStr) => {
    if (!plat) return 0;
    if (!isEntityBillableInMonth(plat, monthStr)) return 0;
    const mode = plat.billingMode || "fixed";
    if (mode === "split") {
      const activeCount = dbState.subscriptions.filter(s => {
        const member = getSubscriptionMember(s, dbState);
        return (
          ((s.platformId && s.platformId === plat.id) || s.platformName === plat.name) &&
          isSubActiveInMonth(s, monthStr) &&
          isEntityBillableInMonth(member, monthStr)
        );
      }).length;
      return activeCount > 0 ? Math.round(plat.totalCost / activeCount) : 0;
    }
    return plat.price;
  };

  // Helper: Calculate member subscription monthly fee for active month
  const getMemberMonthlyFee = (member, dbState) => {
    if (!dbState) return 0;
    if (!isEntityBillableInMonth(member, dbState.currentMonth)) return 0;
    if (member.customFee !== null && member.customFee !== '') {
      return parseFloat(member.customFee);
    }
    
    let sum = 0;
    const memberSubs = dbState.subscriptions.filter(s => s.memberName === member.name);
    for (const sub of memberSubs) {
      if (isSubBillableInMonth(sub, dbState, dbState.currentMonth)) {
        const plat = dbState.platforms.find(p => p.name === sub.platformName);
        if (plat) {
          sum += getPlatformPriceForMonthLocal(plat, dbState, dbState.currentMonth);
        }
      }
    }
    return sum;
  };

  const getSubscriptionDisplayName = (sub) => {
    return sub.seatLabel ? `${sub.platformName}（${sub.seatLabel}）` : sub.platformName;
  };

  const formatLedgerType = (type) => {
    const labels = {
      'system.migrated': '系統升級',
      'payment.created': '新增付款',
      'payment.deleted': '刪除付款',
      'payment.voided': '作廢付款',
      'charge.created': '新增加帳',
      'charge.deleted': '刪除加帳',
      'charge.voided': '作廢加帳',
      'platforms.updated': '平台更新',
      'members.updated': '成員更新',
      'subscriptions.updated': '訂閱更新',
      'settings.updated': '設定更新',
      'member.created': '新增成員',
      'member.deleted': '刪除成員',
      'member.archived': '停用成員',
      'platform.created': '新增平台',
      'platform.deleted': '刪除平台',
      'platform.archived': '停用平台',
      'settings.bundle.updated': '一次寫入設定',
      'month.settled': '月結',
      'history.sealed': '歷史封存',
      'backup.created': '建立備份',
      'backup.restored': '還原備份',
      'backup.deleted': '刪除備份'
    };
    return labels[type] || type;
  };

  const formatEventTime = (iso) => {
    if (!iso) return '—';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    return date.toLocaleString('zh-TW', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
  };

  const effectiveSubPlatform = data?.platforms?.some(platform => platform.name === subPlatform)
    ? subPlatform
    : data?.platforms?.[0]?.name || subPlatform;

  const openSettleModal = async () => {
    setClosePreviewLoading(true);
    setShowSettleModal(true);
    try {
      const res = await apiFetch('/close-preview');
      const json = await res.json();
      if (json.success) {
        setClosePreview(json.preview);
      } else {
        showToast(json.error || "月結預檢失敗");
      }
    } catch {
      showToast("月結預檢失敗");
    } finally {
      setClosePreviewLoading(false);
    }
  };

  // Helper: Generate detailed, structured text invoice message
  const generateDetailedReminder = (member, summary) => {
    const memberSubs = data.subscriptions.filter(s => s.memberName === member.name);
    const activeSubsText = [];
    const activeSubsNames = [];
    
    if (isEntityBillableInMonth(member, data.currentMonth) && member.customFee !== null && member.customFee !== "") {
      activeSubsText.push(`  • 自訂費用小計: $${member.customFee}`);
      activeSubsNames.push("自訂月費項目");
    } else {
      memberSubs.forEach(sub => {
        if (isSubBillableInMonth(sub, data, data.currentMonth)) {
          const plat = data.platforms.find(p => p.name === sub.platformName);
          const price = plat ? getPlatformPriceForMonthLocal(plat, data, data.currentMonth) : 0;
          activeSubsText.push(`  • ${getSubscriptionDisplayName(sub)}: $${price}`);
          activeSubsNames.push(getSubscriptionDisplayName(sub));
        }
      });
    }

    if (activeSubsText.length === 0) {
      activeSubsText.push("  • 本期無訂閱項目");
    }

    const absOutstanding = Math.abs(summary.outstanding);
    const style = reminderStyle || "friendly";
    
    if (style === "friendly") {
      // 1. Humorous & Friendly style
      let balanceLine;
      if (summary.outstanding > 0) {
        balanceLine = 
          `💸 最終需要補血的金額：$${summary.outstanding.toLocaleString()} 元\n\n` +
          `🏦 傳送門（匯款帳號）：\n` +
          `${data.bankInfo}\n\n` +
          `轉帳完請隨便傳個貼圖轟炸我喔，感謝乾爹/乾媽！祝您觀影/聽歌愉快 🚀✨`;
      } else if (summary.outstanding < 0) {
        balanceLine = 
          `🎉 本期應繳總額：$0 元\n` +
          `  (上次給太多的預繳餘額：-$${absOutstanding.toLocaleString()} 元)\n\n` +
          `※ 目前您還有滿滿的血條（預繳餘額），本月免匯款！餘額會自動扣抵至下個月。`;
      } else {
        balanceLine = 
          `🎉 本期應繳總額：$0 元\n\n` +
          `※ 本月帳務已完全結清，免匯款！感謝支持，祝您使用愉快 🚀✨`;
      }

      return (
        `🔔 嗶嗶！您的月租費帳單已送達 (${data.currentMonth})\n` +
        `----------------------------------\n` +
        `哈囉 ${member.name}！感謝共乘訂閱專車，本期明細新鮮出爐囉：\n\n` +
        `🍿 本月嗑了哪些服務：\n` +
        activeSubsText.join('\n') + `\n` +
        `  (本月分攤小計: $${summary.monthlyFee.toLocaleString()} 元)\n\n` +
        `⚖️ 歷史恩怨情仇（帳務往來）：\n` +
        `  • 之前的欠債/預繳 (前期餘額): $${member.priorBalance.toLocaleString()} 元\n` +
        `  • 代墊的臨時費用: $${summary.tempCharges.toLocaleString()} 元\n` +
        `  • 本月已上繳金額: -$${summary.paid.toLocaleString()} 元\n` +
        `----------------------------------\n` +
        balanceLine
      );
    } else if (style === "minimal") {
      // 2. Minimalist & Quick style
      const subListNames = activeSubsNames.join('+') || "無訂閱項目";
      let balanceLine;
      if (summary.outstanding > 0) {
        balanceLine = 
          `本期應繳總額為：💰 ${summary.outstanding.toLocaleString()} 元\n\n` +
          `🏦 匯款至：${data.bankInfo}\n` +
          `轉帳後再跟我說一聲，謝啦！😊`;
      } else if (summary.outstanding < 0) {
        balanceLine = 
          `本期應繳總額為：💰 0 元\n` +
          `  (預繳餘額：-$${absOutstanding.toLocaleString()} 元)\n\n` +
          `目前還有預繳，本月免匯款喔！會自動結轉～`;
      } else {
        balanceLine = 
          `本期應繳總額為：💰 0 元\n\n` +
          `本月已結清，免匯款，謝謝啦！`;
      }

      const tempChargeText = summary.tempCharges !== 0 ? `• 代墊臨時費用: $${summary.tempCharges.toLocaleString()} 元\n` : "";
      const paymentText = summary.paid !== 0 ? `• 本期已付金額: -$${summary.paid.toLocaleString()} 元\n` : "";

      return (
        `嗨 ${member.name}！${data.currentMonth} 的訂閱費來囉～\n` +
        balanceLine + `\n\n` +
        `【明細簡覽】\n` +
        `• 本期分攤項目: ${subListNames} ($${summary.monthlyFee.toLocaleString()} 元)\n` +
        `• 歷史結轉餘額: $${member.priorBalance.toLocaleString()} 元\n` +
        tempChargeText +
        paymentText
      );
    } else {
      // 3. Formal style (Original)
      let balanceLine;
      if (summary.outstanding > 0) {
        balanceLine = 
          `💰 本期應繳總額：$${summary.outstanding.toLocaleString()} 元\n\n` +
          `🏦 匯款資訊：\n` +
          `${data.bankInfo}\n\n` +
          `再麻煩您撥空轉帳，謝謝！✨`;
      } else if (summary.outstanding < 0) {
        balanceLine = 
          `💰 本期應繳總額：$0 元\n` +
          `  (預繳/溢繳餘額結轉：-$${absOutstanding.toLocaleString()} 元)\n\n` +
          `※ 您目前尚有預繳金額，本月免匯款！餘額會自動結轉至下個月。`;
      } else {
        balanceLine = 
          `💰 本期應繳總額：$0 元\n\n` +
          `※ 您本月帳款已結清，無須匯款，謝謝！✨`;
      }

      return (
        `📢 訂閱對帳單 (${data.currentMonth})\n` +
        `----------------------------------\n` +
        `親愛的 ${member.name}，本期明細如下：\n\n` +
        `🔹 本月分攤項目：\n` +
        activeSubsText.join('\n') + `\n` +
        `  (本月訂閱費用小計: $${summary.monthlyFee.toLocaleString()} 元)\n\n` +
        `🔹 帳務往來明細：\n` +
        `  • 上期結轉 (前期餘額): $${member.priorBalance.toLocaleString()} 元\n` +
        `  • 本期臨時費用加帳: $${summary.tempCharges.toLocaleString()} 元\n` +
        `  • 本期已繳納款項: -$${summary.paid.toLocaleString()} 元\n` +
        `----------------------------------\n` +
        balanceLine
      );
    }
  };

  // Helper: Redirect to LINE share deep link
  const handleLineShare = (member, summary) => {
    const text = generateDetailedReminder(member, summary);
    const encodedText = encodeURIComponent(text);
    
    // Detect if user is on a mobile device
    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    
    const lineUrl = isMobile
      ? `https://line.me/R/share?text=${encodedText}`
      : `https://social-plugins.line.me/lineit/share?text=${encodedText}`;
    
    window.open(lineUrl, '_blank');
  };

  // Helper: Copy copy-pasteable reminder text to Clipboard
  const copyReminder = (member, summary) => {
    const text = generateDetailedReminder(member, summary);
    navigator.clipboard.writeText(text);
    showToast(`已複製 ${member.name} 的詳細帳單明細！`);
  };

  // Add Log Handlers
  const handleAddPayment = async (e) => {
    e.preventDefault();
    if (!amount || isNaN(amount)) return showToast("請輸入有效的金額！");
    setTransactionSaving('payment');
    try {
      const res = await apiFetch('/payment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          memberName: selectedMember,
          amount: parseFloat(amount),
          date: date || undefined,
          method: paymentMethod,
          note: noteOrDesc
        })
      });
      const resJson = await res.json();
      if (!res.ok) {
        if (res.status === 409 && resJson.duplicate) {
          return showToast(`已擋下重複付款：${resJson.duplicate.memberName} ${formatMoney(resJson.duplicate.amount)}，原紀錄在 ${formatRecentTimestamp(resJson.duplicate.createdAt)} 建立。`);
        }
        return showToast(resJson.error || "登記付款失敗");
      }
      setData(resJson.data);
      setShowPayModal(false);
      resetForms();
      showToast("付款記錄已成功登記！");
    } catch {
      showToast("登記付款失敗");
    } finally {
      setTransactionSaving(null);
    }
  };

  const handleDeletePayment = async (id) => {
    if (!confirm("確定要作廢這筆付款記錄嗎？\n\n原始記錄會保留在流水帳中，但不再計入本期已收。")) return;
    try {
      const res = await apiFetch(`/payment/${id}`, { method: 'DELETE' });
      const resJson = await res.json();
      if (!res.ok) return showToast(resJson.error || "作廢付款失敗");
      setData(resJson.data);
      showToast("付款記錄已作廢。");
    } catch {
      showToast("作廢付款失敗");
    }
  };

  const handleAddTempCharge = async (e) => {
    e.preventDefault();
    if (!amount || isNaN(amount)) return showToast("請輸入有效的金額！");
    setTransactionSaving('charge');
    try {
      const res = await apiFetch('/temp-charge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          memberName: selectedMember,
          amount: parseFloat(amount),
          date: date || undefined,
          desc: noteOrDesc
        })
      });
      const resJson = await res.json();
      if (!res.ok) {
        if (res.status === 409 && resJson.duplicate) {
          return showToast(`已擋下重複加帳：${resJson.duplicate.memberName} ${formatMoney(resJson.duplicate.amount)}，原紀錄在 ${formatRecentTimestamp(resJson.duplicate.createdAt)} 建立。`);
        }
        return showToast(resJson.error || "登記加帳失敗");
      }
      setData(resJson.data);
      setShowChargeModal(false);
      resetForms();
      showToast("臨時加帳已成功登記！");
    } catch {
      showToast("登記加帳失敗");
    } finally {
      setTransactionSaving(null);
    }
  };

  const handleDeleteTempCharge = async (id) => {
    if (!confirm("確定要作廢這筆臨時加帳記錄嗎？\n\n原始記錄會保留在流水帳中，但不再計入本期加帳。")) return;
    try {
      const res = await apiFetch(`/temp-charge/${id}`, { method: 'DELETE' });
      const resJson = await res.json();
      if (!res.ok) return showToast(resJson.error || "作廢加帳失敗");
      setData(resJson.data);
      showToast("臨時加帳已作廢。");
    } catch {
      showToast("作廢加帳失敗");
    }
  };

  const handleAddSubscription = async (e) => {
    e.preventDefault();
    if (!subName || !subStart) return showToast("請輸入姓名與起算月份！");
    
    // Validate date format YYYY/MM
    if (!/^\d{4}\/\d{2}$/.test(subStart)) {
      return showToast("起算月格式必須為 YYYY/MM，例如 2026/05");
    }

    const newSub = {
      id: `s_${data.subscriptions.length + 1}_${subName}_${effectiveSubPlatform}_${subStart}`.replace(/[^\w]/g, '_'),
      memberName: subName,
      platformName: effectiveSubPlatform,
      startMonth: subStart,
      exitMonth: ""
    };

    const newSubsList = [...data.subscriptions, newSub];
    try {
      const res = await apiFetch('/update-subscriptions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscriptions: newSubsList })
      });
      const resJson = await res.json();
      setData(resJson.data);
      setSubName('');
      setSubStart('');
      showToast("訂閱項目已成功指派！");
    } catch {
      showToast("指派訂閱失敗");
    }
  };

  const handleRemoveSubscription = async (id) => {
    if (!confirm("確定要取消此訂閱指派嗎？")) return;
    const newSubsList = data.subscriptions.filter(s => s.id !== id);
    try {
      const res = await apiFetch('/update-subscriptions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscriptions: newSubsList })
      });
      const resJson = await res.json();
      setData(resJson.data);
      showToast("已取消該項訂閱。");
    } catch {
      showToast("取消訂閱失敗");
    }
  };

  const handleSetExitMonth = async (id, currentExit) => {
    const input = prompt("請輸入退出月份 (YYYY/MM) 或留空清除：", currentExit || "");
    if (input === null) return; // user cancelled
    if (input !== "" && !/^\d{4}\/\d{2}$/.test(input)) {
      return showToast("退出月份格式不符！請輸入 YYYY/MM 格式。");
    }

    const newSubsList = data.subscriptions.map(s => {
      if (s.id === id) {
        return { ...s, exitMonth: input };
      }
      return s;
    });

    try {
      const res = await apiFetch('/update-subscriptions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscriptions: newSubsList })
      });
      const resJson = await res.json();
      setData(resJson.data);
      showToast("已更新退出月份。");
    } catch {
      showToast("更新失敗");
    }
  };

  // Settle Month Rollover
  const handleSettleMonth = async () => {
    try {
      const res = await apiFetch('/settle', { method: 'POST' });
      const resJson = await res.json();
      if (!res.ok) {
        if (resJson.preview) setClosePreview(resJson.preview);
        return showToast(resJson.error || "月結預檢未通過");
      }
      syncClientStateFromDb(resJson.data, { keepSelectedHistory: true });
      setShowSettleModal(false);
      setClosePreview(null);
      showToast(`${resJson.data.history[resJson.data.history.length-1].month} 帳務結清，已成功結轉至新一月！`);
    } catch {
      showToast("月結清算失敗");
    }
  };

  // Save Configs Handlers
  const handleSaveConfigs = async () => {
    try {
      if (!configDirty) {
        showToast("目前沒有待儲存的設定草稿。");
        return;
      }

      setConfigSaving(true);
      const res = await apiFetch('/update-config-bundle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          platforms: buildEditedPlatformsPayload(),
          members: buildEditedMembersPayload(),
          bankInfo,
          reminderStyle
        })
      });
      
      const resJson = await res.json();
      if (!res.ok) {
        showToast(resJson.error || "儲存設定失敗");
        return;
      }

      syncClientStateFromDb(resJson.data, { keepSelectedHistory: true });
      if (showBackupPanel) {
        await loadBackups();
      }
      showToast(resJson.message || "設定已一次性寫入正式帳務。");
    } catch {
      showToast("儲存設定失敗");
    } finally {
      setConfigSaving(false);
    }
  };

  // Add Member
  const handleAddMember = async (e) => {
    e.preventDefault();
    if (!newMemberName) return showToast("姓名不可為空！");
    try {
      const res = await apiFetch('/member', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newMemberName,
          priorBalance: parseFloat(newMemberPrior) || 0,
          customFee: newMemberCustom === '' ? null : parseFloat(newMemberCustom)
        })
      });
      const resJson = await res.json();
      if (res.ok) {
        syncClientStateFromDb(resJson.data, { keepSelectedHistory: true });
        setNewMemberName('');
        setNewMemberPrior('0');
        setNewMemberCustom('');
        showToast("成功新增成員！");
      } else {
        showToast(resJson.error || "新增成員失敗");
      }
    } catch {
      showToast("新增成員錯誤");
    }
  };

  // Archive Member
  const handleDeleteMember = async (id, name) => {
    if (!confirm(`確定要停用成員「${name}」嗎？\n\n系統會保留歷史帳、付款、加帳與訂閱紀錄，並從本期起停止其未退出訂閱計費。`)) return;
    try {
      const res = await apiFetch(`/member/${id}`, { method: 'DELETE' });
      const resJson = await res.json();
      if (res.ok) {
        syncClientStateFromDb(resJson.data, { keepSelectedHistory: true });
        showToast(`已停用成員 ${name}，帳務證據已保留。`);
      } else {
        showToast(resJson.error || "停用成員失敗");
      }
    } catch {
      showToast("停用成員錯誤");
    }
  };

  // Add Platform
  const handleAddPlatform = async (e) => {
    e.preventDefault();
    if (!newPlatName) return showToast("平台名稱不可為空！");
    try {
      const res = await apiFetch('/platform', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newPlatName,
          price: parseFloat(newPlatPrice) || 0,
          billingMode: newPlatMode,
          totalCost: parseFloat(newPlatTotal) || 0
        })
      });
      const resJson = await res.json();
      if (res.ok) {
        syncClientStateFromDb(resJson.data, { keepSelectedHistory: true });
        setNewPlatName('');
        setNewPlatPrice('0');
        setNewPlatMode('fixed');
        setNewPlatTotal('0');
        showToast("成功新增訂閱平台！");
      } else {
        showToast(resJson.error || "新增平台失敗");
      }
    } catch {
      showToast("新增平台錯誤");
    }
  };

  // Archive Platform
  const handleDeletePlatform = async (id, name) => {
    if (!confirm(`確定要停用平台「${name}」嗎？\n\n系統會保留平台、訂閱與歷史帳證據，並從本期起停止此平台未退出訂閱計費。`)) return;
    try {
      const res = await apiFetch(`/platform/${id}`, { method: 'DELETE' });
      const resJson = await res.json();
      if (res.ok) {
        syncClientStateFromDb(resJson.data, { keepSelectedHistory: true });
        showToast(`已停用平台 ${name}，帳務證據已保留。`);
      } else {
        showToast(resJson.error || "停用平台失敗");
      }
    } catch {
      showToast("停用平台錯誤");
    }
  };

  const resetForms = () => {
    setAmount('');
    setDate('');
    setNoteOrDesc('');
    setPaymentMethod('轉帳');
  };

  // Build a summary array for the current active month
  const getCurrentMonthBalancesList = () => {
    return data.members.map(m => {
      const summary = getMemberSummary(m);
      return {
        memberName: m.name,
        priorBalance: m.priorBalance,
        subscriptionFee: summary.monthlyFee,
        tempCharge: summary.tempCharges,
        paid: summary.paid,
        endingBalance: summary.outstanding
      };
    });
  };

  // Export to CSV with UTF-8 BOM for Microsoft Excel compatibility
  const exportToCSV = (monthStr, balancesList, paymentsList, tempChargesList) => {
    let csvContent = "\uFEFF"; // UTF-8 BOM
    csvContent += `對帳月份：,${monthStr}\n\n`;
    csvContent += "成員姓名,期初前期餘額,該月分攤訂閱費,該月臨時費用加帳,該月已付金額,期末剩餘應收\n";
    
    let totalPrior = 0, totalFee = 0, totalTemp = 0, totalPaid = 0, totalEnding = 0;
    
    balancesList.forEach(b => {
      csvContent += `"${b.memberName}",${b.priorBalance},${b.subscriptionFee},${b.tempCharge},${b.paid},${b.endingBalance}\n`;
      totalPrior += b.priorBalance;
      totalFee += b.subscriptionFee;
      totalTemp += b.tempCharge;
      totalPaid += b.paid;
      totalEnding += b.endingBalance;
    });
    
    csvContent += `合計,${totalPrior},${totalFee},${totalTemp},${totalPaid},${totalEnding}\n\n`;
    
    if (paymentsList && paymentsList.length > 0) {
      csvContent += "=== 該月收款流水日誌 ===\n";
      csvContent += "狀態,付款成員,付款日期,金額,付款方式,備註,作廢時間,作廢原因\n";
      paymentsList.forEach(p => {
        csvContent += `"${isVoidedTransaction(p) ? '作廢' : '有效'}","${p.memberName}","${p.date}",${p.amount},"${p.method}","${p.note || ''}","${p.voidedAt || ''}","${p.voidReason || ''}"\n`;
      });
      csvContent += "\n";
    }
    
    if (tempChargesList && tempChargesList.length > 0) {
      csvContent += "=== 該月臨時費用加帳日誌 ===\n";
      csvContent += "狀態,加帳成員,加帳日期,金額,事項說明,作廢時間,作廢原因\n";
      tempChargesList.forEach(c => {
        csvContent += `"${isVoidedTransaction(c) ? '作廢' : '有效'}","${c.memberName}","${c.date}",${c.amount},"${c.desc || ''}","${c.voidedAt || ''}","${c.voidReason || ''}"\n`;
      });
    }
    
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", `訂閱對帳單_${monthStr.replace('/', '_')}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // Calculations for dashboard UI
  const getMemberSummary = (member) => {
    const monthlyFee = getMemberMonthlyFee(member, data);
    const tempCharges = activeTransactions(data.tempCharges)
      .filter(c => c.memberName === member.name)
      .reduce((sum, c) => sum + c.amount, 0);
    const paid = activeTransactions(data.payments)
      .filter(p => p.memberName === member.name)
      .reduce((sum, p) => sum + p.amount, 0);
    const outstanding = member.priorBalance + monthlyFee + tempCharges - paid;
    return { monthlyFee, tempCharges, paid, outstanding };
  };

  const editedPlatforms = data ? buildEditedPlatformsPayload() : [];
  const editedMembers = data ? buildEditedMembersPayload() : [];
  const dirtyPlatformIds = data
    ? editedPlatforms.filter(platform => {
      const current = data.platforms.find(item => item.id === platform.id);
      if (!current) return true;
      return current.price !== platform.price
        || (current.billingMode || 'fixed') !== platform.billingMode
        || (current.totalCost || 0) !== platform.totalCost;
    }).map(platform => platform.id)
    : [];
  const dirtyMemberIds = data
    ? editedMembers.filter(member => {
      const current = data.members.find(item => item.id === member.id);
      if (!current) return true;
      return current.priorBalance !== member.priorBalance
        || (current.customFee ?? null) !== (member.customFee ?? null);
    }).map(member => member.id)
    : [];
  const bankDirty = Boolean(data) && bankInfo !== (data.bankInfo || '');
  const reminderStyleDirty = Boolean(data) && reminderStyle !== (data.reminderStyle || 'friendly');
  const configDirty = dirtyPlatformIds.length > 0 || dirtyMemberIds.length > 0 || bankDirty || reminderStyleDirty;
  const draftChangeCount = dirtyPlatformIds.length + dirtyMemberIds.length + (bankDirty ? 1 : 0) + (reminderStyleDirty ? 1 : 0);

  useEffect(() => {
    if (!configDirty) return undefined;
    const handleBeforeUnload = (event) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [configDirty]);

  const handleResetConfigDrafts = () => {
    if (!data || !configDirty) return;
    syncClientStateFromDb(data, { keepSelectedHistory: true });
    showToast("已放棄本地草稿，恢復到正式設定。");
  };

  if (!authChecked) {
    return (
      <div className="auth-shell">
        <div className="auth-panel">
          <span className="auth-kicker">Checking session</span>
          <h1>Subscription Billing</h1>
          <p>正在確認登入狀態...</p>
        </div>
      </div>
    );
  }

  if (!authenticated) {
    return (
      <div className="auth-shell">
        <form className="auth-panel" onSubmit={handleLogin}>
          <span className="auth-kicker">Solo operator access</span>
          <h1>Subscription Billing</h1>
          <p>輸入系統密碼後才會載入帳務資料。</p>
          <label className="auth-label" htmlFor="app-password">系統密碼</label>
          <input
            id="app-password"
            className="form-control auth-input"
            type="password"
            value={loginPassword}
            onChange={(event) => setLoginPassword(event.target.value)}
            autoComplete="current-password"
            autoFocus
          />
          {loginError && <div className="auth-error">{loginError}</div>}
          <button className="btn btn-primary auth-submit" type="submit" disabled={authLoading || !loginPassword}>
            {authLoading ? '登入中...' : '登入'}
          </button>
        </form>
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh', flexDirection: 'column', gap: '1.25rem', padding: '2rem', textAlign: 'center', background: '#0f172a', color: '#f8fafc' }}>
        <div style={{ fontSize: '3rem', animation: 'bounce 2s infinite' }}>⚠️</div>
        <h3 style={{ fontSize: '1.5rem', fontWeight: '700', color: '#f43f5e', margin: '0' }}>連線或載入失敗</h3>
        <p style={{ color: '#9ca3af', maxWidth: '420px', fontSize: '0.95rem', lineHeight: '1.6', margin: '0 0 0.5rem 0' }}>
          系統無法取得帳務資料。若您使用的是手機，請確認手機與 Mac 電腦連線在【同一個 Wi-Fi 網路】，且後端服務正常運作。
        </p>
        <div style={{ background: 'rgba(244, 63, 94, 0.1)', border: '1px solid rgba(244, 63, 94, 0.2)', padding: '0.85rem 1.25rem', borderRadius: '12px', fontSize: '0.85rem', color: '#fda4af', fontFamily: 'monospace', wordBreak: 'break-all', maxWidth: '420px' }}>
          錯誤訊息：{error}
        </div>
        <button 
          className="btn btn-primary" 
          style={{ padding: '0.75rem 2rem', fontSize: '0.95rem', borderRadius: '10px', marginTop: '0.5rem', cursor: 'pointer' }}
          onClick={() => { setError(null); fetchData(); }}
        >
          🔄 重新連線載入
        </button>
      </div>
    );
  }

  if (loading || !data) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh', flexDirection: 'column', gap: '1rem' }}>
        <div style={{ border: '4px solid rgba(255,255,255,0.1)', borderTop: '4px solid #3b82f6', borderRadius: '50%', width: '40px', height: '40px', animation: 'spin 1s linear infinite' }}></div>
        <p style={{ color: '#9ca3af', fontSize: '0.9rem' }}>正在載入帳務系統中...</p>
      </div>
    );
  }

  // Calculate top level metrics
  const activePayments = activeTransactions(data.payments);
  const activeTempCharges = activeTransactions(data.tempCharges);
  const voidedPaymentCount = data.payments.length - activePayments.length;
  const voidedTempChargeCount = data.tempCharges.length - activeTempCharges.length;
  const activeMembers = data.members.filter(m => !isArchivedEntity(m));
  const activePlatforms = data.platforms.filter(p => !isArchivedEntity(p));
  const memberSummaries = data.members.map(m => ({ member: m, summary: getMemberSummary(m) }));
  const totalReceivables = memberSummaries.reduce((sum, item) => sum + (item.summary.outstanding > 0 ? item.summary.outstanding : 0), 0);
  const totalPayments = activePayments.reduce((sum, p) => sum + p.amount, 0);
  const unpaidMembersCount = memberSummaries.filter(item => item.summary.outstanding > 0).length;
  const auditWarnings = data._audit?.warnings || [];
  const criticalAuditCount = auditWarnings.filter(w => w.severity === 'critical').length;
  const activeSeatCount = data.subscriptions.filter(s => isSubBillableInMonth(s, data, data.currentMonth)).length;
  const auditStatus = criticalAuditCount > 0 ? '需處理' : auditWarnings.length > 0 ? '待確認' : '已通過';
  const ledger = data._audit?.ledger || { ok: true, count: 0, recent: [] };
  const ledgerStatus = ledger.ok ? '完整' : '異常';
  const systemSnapshot = data._audit?.snapshot || {};
  const historyIntegrity = systemSnapshot.history?.integrity || { ok: true, count: data.history.length, sealedCount: data.history.length, problems: [] };
  const historySealStatus = historyIntegrity.ok ? '完整' : '異常';
  const receivableQueue = memberSummaries
    .filter(item => item.summary.outstanding > 0)
    .sort((a, b) => b.summary.outstanding - a.summary.outstanding);
  const priorityReceivable = receivableQueue[0] || null;
  const prepaidTotal = memberSummaries
    .filter(item => item.summary.outstanding < 0)
    .reduce((sum, item) => sum + Math.abs(item.summary.outstanding), 0);
  const totalBilled = totalPayments + totalReceivables;
  const collectionRate = totalBilled > 0 ? Math.round((totalPayments / totalBilled) * 100) : 0;
  const closeGateClear = criticalAuditCount === 0 && ledger.ok && historyIntegrity.ok;
  const operatorHeadline = !closeGateClear
    ? '先處理帳務風險'
    : priorityReceivable
      ? `先處理 ${priorityReceivable.member.name}`
      : '可以準備月結';
  const operatorDetail = !closeGateClear
    ? '有稽核、事件鏈或歷史封存問題時，先不要做月結或還原。'
    : priorityReceivable
      ? `${priorityReceivable.member.name} 是目前最大待收：${formatMoney(priorityReceivable.summary.outstanding)}。`
      : '目前無待收款，先跑月結預檢確認結轉前狀態。';
  const latestLedgerEvent = ledger.recent?.[0];
  const systemPosture = !closeGateClear ? 'RISK HOLD' : priorityReceivable ? 'COLLECT' : 'READY';
  const navItems = [
    { id: 'dashboard', code: '01', label: '總覽', helper: 'Ops overview' },
    { id: 'subscriptions', code: '02', label: '名額', helper: 'Seat allocations' },
    { id: 'config', code: '03', label: '設定', helper: 'Pricing and recovery' },
    { id: 'history', code: '04', label: '封存', helper: 'Historical closes' }
  ];
  const tabMeta = {
    dashboard: {
      kicker: 'SETTLEMENT OPERATIONS',
      title: '帳務指揮台',
      description: '集中查看待收暴露、收款操作、月結門檻與可追溯事件鏈。'
    },
    subscriptions: {
      kicker: 'SEAT OWNERSHIP',
      title: '名額配置台',
      description: '管理每位成員的訂閱名額、起算月份與退出月份。'
    },
    config: {
      kicker: 'SYSTEM PARAMETERS',
      title: '定價與復原控制台',
      description: '維護單價、期初餘額、文字設定與還原檢查點。'
    },
    history: {
      kicker: 'ARCHIVE INTELLIGENCE',
      title: '歷史封存與對帳',
      description: '回看每期結帳、封存鏈健康與過往收支明細。'
    }
  };
  const activeTabMeta = tabMeta[activeTab] || tabMeta.dashboard;

  return (
    <div className="app-container">
      {/* Sidebar Navigation */}
      <aside className="sidebar">
        <div className="logo-section">
          <div className="logo-mark">
            <span className="logo-icon">SB</span>
          </div>
          <div className="logo-copy">
            <span className="eyebrow">Subscription Billing</span>
            <span className="logo-text">Operator Console</span>
          </div>
        </div>
        
        <nav className="nav-links">
          {navItems.map(item => (
            <div key={item.id} className={`nav-item ${activeTab === item.id ? 'active' : ''}`} onClick={() => setActiveTab(item.id)}>
              <span className="nav-code">{item.code}</span>
              <span className="nav-copy">
                <strong className="nav-label">{item.label}</strong>
                <small className="nav-helper">{item.helper}</small>
              </span>
              {item.id === 'config' && configDirty && <span className="nav-pill">draft</span>}
            </div>
          ))}
        </nav>

        <div className="rail-section">
          <span className="rail-heading">Live Signals</span>
          <div className="rail-card">
            <span className="rail-card-label">System posture</span>
            <strong className="rail-card-value">{systemPosture}</strong>
            <small className="rail-card-note">{auditWarnings.length} audit items · {ledger.count || 0} ledger writes</small>
          </div>
          <div className="rail-card">
            <span className="rail-card-label">Open exposure</span>
            <strong className="rail-card-value">{formatMoney(totalReceivables)}</strong>
            <small className="rail-card-note">{unpaidMembersCount} members require action</small>
          </div>
          <div className="rail-card">
            <span className="rail-card-label">Latest write</span>
            <strong className="rail-card-value">{latestLedgerEvent ? formatEventTime(latestLedgerEvent.at) : 'No events'}</strong>
            <small className="rail-card-note">{latestLedgerEvent ? latestLedgerEvent.summary : 'Waiting for first ledger event'}</small>
          </div>
        </div>

        <div className="sidebar-footer">
          <p>local operator node</p>
          <p style={{ fontSize: '0.7rem', marginTop: '0.25rem' }}>{data.currentMonth} · solo operator mode</p>
          <button className="sidebar-logout" type="button" onClick={handleLogout}>
            登出
          </button>
        </div>
      </aside>

      {/* Main Container */}
      <main className="main-content">
        {/* Header */}
        <header className="header-section">
          <div className="title-area">
            <span className="title-kicker">{activeTabMeta.kicker}</span>
            <h1>{activeTabMeta.title}</h1>
            <p>{activeTabMeta.description}</p>
          </div>

          <div className="header-actions">
            {activeTab === 'dashboard' && (
              <button className="btn btn-secondary" style={{ padding: '0.65rem 1.25rem' }} onClick={() => exportToCSV(data.currentMonth, getCurrentMonthBalancesList(), data.payments, data.tempCharges)}>
                匯出當月報表
              </button>
            )}
            <div className="month-badge">
              <span className="month-badge-label">Active month</span>
              <strong>{data.currentMonth}</strong>
            </div>
            {activeTab === 'dashboard' && (
              <button className="btn btn-primary" style={{ padding: '0.65rem 1.25rem' }} onClick={openSettleModal}>
                啟動月結預檢
              </button>
            )}
          </div>
        </header>

        {activeTab === 'dashboard' && (
          <section className={`operator-briefing ${closeGateClear ? 'steady' : 'risk'}`}>
            <div className="operator-main">
              <span className="operator-kicker">Command Priority</span>
              <h2>{operatorHeadline}</h2>
              <p>{operatorDetail}</p>
              <div className="operator-actions">
                {priorityReceivable ? (
                  <>
                    <button className="btn btn-primary" onClick={() => copyReminder(priorityReceivable.member, priorityReceivable.summary)}>
                      複製最高待收腳本
                    </button>
                    <button className="btn btn-secondary" onClick={() => {
                      setSelectedMember(priorityReceivable.member.name);
                      setShowPayModal(true);
                    }}>
                      直接登記收款
                    </button>
                  </>
                ) : (
                  <button className="btn btn-primary" onClick={openSettleModal}>
                    開啟月結控制
                  </button>
                )}
              </div>
            </div>

            <div className="operator-grid">
              <div className="operator-card">
                <span>Collection queue</span>
                <strong>{formatMoney(totalReceivables)}</strong>
                <small>{unpaidMembersCount} 人待收 · 收回 {collectionRate}%</small>
                <div className="queue-list">
                  {receivableQueue.length === 0 ? (
                    <p>目前沒有待收款。</p>
                  ) : (
                    receivableQueue.slice(0, 3).map(item => (
                      <button key={item.member.id} className="queue-row" onClick={() => {
                        setSelectedMember(item.member.name);
                        setShowPayModal(true);
                      }}>
                        <span>{item.member.name}{isArchivedEntity(item.member) ? '（已停用）' : ''}</span>
                        <strong>{formatMoney(item.summary.outstanding)}</strong>
                      </button>
                    ))
                  )}
                </div>
              </div>

              <div className="operator-card">
                <span>Close gate</span>
                <strong>{closeGateClear ? '可預檢' : '暫停'}</strong>
                <small>{totalReceivables > 0 ? `${formatMoney(totalReceivables)} 將結轉為下期前期餘額` : '本期已全數結清'}</small>
                <div className="gate-list">
                  <div className={criticalAuditCount === 0 ? 'pass' : 'fail'}><b>{criticalAuditCount === 0 ? '✓' : '!'}</b>帳務稽核 {auditWarnings.length} 提醒</div>
                  <div className={ledger.ok ? 'pass' : 'fail'}><b>{ledger.ok ? '✓' : '!'}</b>事件鏈 {ledger.count || 0} 筆</div>
                  <div className={historyIntegrity.ok ? 'pass' : 'fail'}><b>{historyIntegrity.ok ? '✓' : '!'}</b>歷史封存 {historyIntegrity.sealedCount || 0}/{historyIntegrity.count || 0}</div>
                </div>
              </div>

              <div className="operator-card">
                <span>Evidence chain</span>
                <strong>{ledger.ok && historyIntegrity.ok ? '可追溯' : '需檢查'}</strong>
                <small>{latestLedgerEvent ? `最後操作：${formatLedgerType(latestLedgerEvent.type)} · ${formatEventTime(latestLedgerEvent.at)}` : '尚無事件記錄'}</small>
                <div className="evidence-strip">
                  <code>{ledger.lastHash ? ledger.lastHash.slice(0, 10) : 'genesis'}</code>
                  <span>預收/溢繳 {formatMoney(prepaidTotal)}</span>
                </div>
              </div>
            </div>
          </section>
        )}

        <section className="ops-strip">
          <div className={`ops-tile ${criticalAuditCount > 0 ? 'risk' : 'clear'}`}>
            <span>AUDIT</span>
            <strong>{auditStatus}</strong>
            <small>{auditWarnings.length} 個提醒</small>
          </div>
          <div className="ops-tile">
            <span>OPEN A/R</span>
            <strong>${totalReceivables.toLocaleString()}</strong>
            <small>{unpaidMembersCount} 人未結清</small>
          </div>
          <div className="ops-tile">
            <span>POSTED CASH</span>
            <strong>${totalPayments.toLocaleString()}</strong>
            <small>{activePayments.length} 筆收款{voidedPaymentCount > 0 ? ` · ${voidedPaymentCount} 筆作廢` : ''}</small>
          </div>
          <div className="ops-tile">
            <span>ACTIVE SEATS</span>
            <strong>{activeSeatCount}</strong>
            <small>{activePlatforms.length} 個平台{data.platforms.length - activePlatforms.length > 0 ? ` · ${data.platforms.length - activePlatforms.length} 已停用` : ''}</small>
          </div>
          <div className={`ops-tile ${ledger.ok ? 'clear' : 'risk'}`}>
            <span>LEDGER</span>
            <strong>{ledgerStatus}</strong>
            <small>{ledger.count || 0} 筆事件</small>
          </div>
          <div className={`ops-tile ${historyIntegrity.ok ? 'clear' : 'risk'}`}>
            <span>ARCHIVE</span>
            <strong>{historySealStatus}</strong>
            <small>{historyIntegrity.sealedCount || 0}/{historyIntegrity.count || 0} 期</small>
          </div>
        </section>

        {auditWarnings.length > 0 && (
          <section className={`audit-banner ${criticalAuditCount > 0 ? 'critical' : 'warning'}`}>
            <div className="audit-banner-header">
              <div>
                <span className="audit-kicker">Audit feed</span>
                <h2>{criticalAuditCount > 0 ? `${criticalAuditCount} 個高風險帳務問題` : `${auditWarnings.length} 個帳務提醒`}</h2>
              </div>
              <span className="audit-count">{auditWarnings.length}</span>
            </div>
            <div className="audit-list">
              {auditWarnings.slice(0, 4).map((warning, idx) => (
                <div key={`${warning.code}-${idx}`} className="audit-item">
                  <span className={`audit-severity ${warning.severity}`}>{warning.severity === 'critical' ? '高' : '提'}</span>
                  <div>
                    <strong>{warning.title}</strong>
                    <p>{warning.detail}</p>
                    {warning.impact && <p className="audit-impact">{warning.impact}</p>}
                  </div>
                </div>
              ))}
              {auditWarnings.length > 4 && (
                <p className="audit-more">另有 {auditWarnings.length - 4} 個提醒，可由後端稽核 API 查看完整清單。</p>
              )}
            </div>
          </section>
        )}

        {activeTab === 'dashboard' && ledger.recent && ledger.recent.length > 0 && (
          <section className="ledger-panel">
            <div className="ledger-header">
              <div>
                <span>Tamper-evident ledger</span>
                <h2>Recent writes</h2>
              </div>
              <code>{ledger.lastHash ? ledger.lastHash.slice(0, 12) : 'genesis'}</code>
            </div>
            <div className="ledger-list">
              {ledger.recent.slice(0, 5).map(event => (
                <div className="ledger-item" key={event.id}>
                  <span className="ledger-type">{formatLedgerType(event.type)}</span>
                  <div>
                    <strong>{event.summary}</strong>
                    <p>{formatEventTime(event.at)} · {event.month || data.currentMonth}</p>
                  </div>
                  <code>{event.hash ? event.hash.slice(0, 8) : 'pending'}</code>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Dashboard Tab */}
        {activeTab === 'dashboard' && (
          <>
            {/* Top Metric Blocks */}
            {(() => {
              return (
                <div className="dashboard-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', marginBottom: '2rem' }}>
                  <div className="card" style={{ padding: '1.25rem', gap: '0.5rem' }}>
                    <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Open receivable</span>
                    <h2 style={{ fontSize: '1.75rem', fontWeight: '700', color: 'var(--warning)' }}>${totalReceivables.toLocaleString()}</h2>
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{unpaidMembersCount} 位成員尚未繳清</span>
                  </div>
                  <div className="card" style={{ padding: '1.25rem', gap: '0.5rem' }}>
                    <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Posted cash</span>
                    <h2 style={{ fontSize: '1.75rem', fontWeight: '700', color: 'var(--success)' }}>${totalPayments.toLocaleString()}</h2>
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>有效 {activePayments.length} 筆{voidedPaymentCount > 0 ? `，作廢 ${voidedPaymentCount} 筆` : ''}</span>
                  </div>
                  <div className="card" style={{ padding: '1.25rem', gap: '0.5rem' }}>
                    <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Active seats</span>
                    <h2 style={{ fontSize: '1.75rem', fontWeight: '700', color: '#60a5fa' }}>{activeSeatCount} 次</h2>
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>指派平台數 {data.platforms.length} 個</span>
                  </div>
                  
                  {/* SVG Donut Progress Chart Card */}
                  <div className="card" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', padding: '1.1rem 1.25rem', gap: '1.25rem' }}>
                    <div style={{ position: 'relative', width: '70px', height: '70px', flexShrink: 0 }}>
                      <svg width="70" height="70" viewBox="0 0 120 120" style={{ transform: 'rotate(-90deg)' }}>
                        <circle cx="60" cy="60" r="50" fill="transparent" stroke="rgba(255,255,255,0.05)" strokeWidth="12" />
                        <circle cx="60" cy="60" r="50" fill="transparent" stroke="var(--success)" strokeWidth="12" 
                                strokeDasharray="314.16" strokeDashoffset={314.16 * (1 - collectionRate / 100)} 
                                strokeLinecap="round" style={{ transition: 'stroke-dashoffset 0.8s ease' }} />
                      </svg>
                      <div style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center' }}>
                        <span style={{ fontSize: '1.05rem', fontWeight: '700', color: 'var(--success)' }}>{collectionRate}%</span>
                        <span style={{ fontSize: '0.55rem', color: 'var(--text-muted)' }}>已收回</span>
                      </div>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                      <h3 style={{ fontSize: '0.85rem', fontWeight: '600' }}>Collection rate</h3>
                      <p style={{ fontSize: '0.7rem', color: 'var(--text-muted)', lineHeight: '1.3' }}>
                        Billed total: <strong>${totalBilled.toLocaleString()}</strong>
                      </p>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.1rem', fontSize: '0.65rem', color: 'var(--text-muted)' }}>
                        <span>Posted: ${totalPayments.toLocaleString()}</span>
                        <span>Outstanding: ${totalReceivables.toLocaleString()}</span>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })()}

            {/* Member Cards */}
            <div className="dashboard-grid">
              {data.members.map(member => {
                const summary = getMemberSummary(member);
                const isPaid = summary.outstanding <= 0;
                
                const activeSubs = data.subscriptions.filter(s => s.memberName === member.name && isSubBillableInMonth(s, data, data.currentMonth));
                return (
                  <div key={member.id} className={`card ${isPaid ? 'paid' : 'unpaid'}`}>
                    <div className="card-header" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: '0.35rem' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%', alignItems: 'center' }}>
                        <span className="member-name" style={{ fontSize: '1.1rem', fontWeight: '700' }}>{member.name}</span>
                        <span className={`status-badge ${isPaid ? 'paid' : 'unpaid'}`}>
                          {isPaid ? 'SETTLED' : 'OPEN'}
                        </span>
                      </div>
                      
                      {/* Subscription Badges */}
                      {activeSubs.length > 0 && (
                        <div style={{ display: 'flex', gap: '0.25rem', flexWrap: 'wrap', width: '100%' }}>
                          {activeSubs.map(sub => {
                            const nameLower = sub.platformName.toLowerCase();
                            const isNetflix = nameLower.includes('netflix') || nameLower.includes('nflx');
                            const isSpotify = nameLower.includes('spotify') || nameLower.includes('spot');
                            const isYt = nameLower.includes('yt') || nameLower.includes('youtube');
                            const isGpt = nameLower.includes('chatgpt') || nameLower.includes('gpt');
                            
                            const color = isNetflix ? '#f87171' : 
                                          isSpotify ? '#4ade80' : 
                                          isYt ? '#f472b6' : 
                                          isGpt ? '#34d399' : '#60a5fa';
                            
                            const bg = isNetflix ? 'rgba(239, 68, 68, 0.1)' : 
                                       isSpotify ? 'rgba(34, 197, 94, 0.1)' : 
                                       isYt ? 'rgba(219, 39, 119, 0.1)' : 
                                       isGpt ? 'rgba(16, 185, 129, 0.1)' : 'rgba(59, 130, 246, 0.1)';

                            const border = isNetflix ? 'rgba(239, 68, 68, 0.25)' : 
                                           isSpotify ? 'rgba(34, 197, 94, 0.25)' : 
                                           isYt ? 'rgba(219, 39, 119, 0.25)' : 
                                           isGpt ? 'rgba(16, 185, 129, 0.25)' : 'rgba(59, 130, 246, 0.25)';
                            
                            return (
                              <span key={sub.id} style={{ 
                                fontSize: '0.62rem', 
                                padding: '0.12rem 0.35rem', 
                                borderRadius: '5px', 
                                background: bg, 
                                color: color,
                                border: `1px solid ${border}`,
                                fontWeight: '600',
                                letterSpacing: '0.3px'
                              }}>
                                {getSubscriptionDisplayName(sub)}
                              </span>
                            );
                          })}
                        </div>
                      )}
                    </div>

                    <div className="card-body">
                      <div className="data-row">
                        <span className="data-label">前期餘額結轉:</span>
                        <span className="data-value">${member.priorBalance.toLocaleString()}</span>
                      </div>
                      <div className="data-row">
                        <span className="data-label">本期訂閱費用:</span>
                        <span className="data-value">${summary.monthlyFee.toLocaleString()}</span>
                      </div>
                      <div className="data-row">
                        <span className="data-label">本期臨時費用:</span>
                        <span className="data-value">${summary.tempCharges.toLocaleString()}</span>
                      </div>
                      <div className="data-row">
                        <span className="data-label">本期已繳納款項:</span>
                        <span className="data-value" style={{ color: 'var(--success)' }}>-${summary.paid.toLocaleString()}</span>
                      </div>
                      <div className="data-row" style={{ marginTop: '0.5rem', paddingTop: '0.5rem', borderTop: '1px solid rgba(255, 255, 255, 0.1)' }}>
                        <span className="data-label" style={{ fontWeight: '600' }}>待收餘額:</span>
                        <span className={`data-value outstanding ${summary.outstanding > 0 ? 'positive' : 'negative'}`}>
                          ${summary.outstanding.toLocaleString()}
                        </span>
                      </div>
                    </div>

                    <div className="card-actions" style={{ flexWrap: 'wrap' }}>
                      <div style={{ display: 'flex', width: '100%', gap: '0.35rem' }}>
                        <button className="btn btn-secondary" style={{ flexGrow: 1 }} onClick={() => {
                          setSelectedMember(member.name);
                          setShowPayModal(true);
                        }}>
                          記錄收款
                        </button>
                        <button className="btn btn-secondary" style={{ flexGrow: 1 }} onClick={() => {
                          setSelectedMember(member.name);
                          setShowChargeModal(true);
                        }}>
                          記錄加帳
                        </button>
                      </div>
                      <button className="btn btn-success" style={{ width: '100%', marginTop: '0.25rem' }} onClick={() => handleLineShare(member, summary)}>
                        送出 LINE 帳單
                      </button>
                      
                      <div style={{ display: 'flex', width: '100%', gap: '0.25rem', marginTop: '0.25rem' }}>
                        <button className="btn btn-secondary" style={{ flexGrow: 1, fontSize: '0.72rem', padding: '0.4rem 0.5rem' }} onClick={() => copyReminder(member, summary)}>
                          複製腳本
                        </button>
                        <button 
                          className="btn btn-secondary" 
                          style={{ 
                            flexGrow: 1, 
                            fontSize: '0.72rem', 
                            padding: '0.4rem 0.5rem',
                            borderColor: expandedPreviewMember === member.name ? '#10b981' : 'var(--panel-border)',
                            color: expandedPreviewMember === member.name ? '#34d399' : 'var(--text-main)',
                            background: expandedPreviewMember === member.name ? 'rgba(16, 185, 129, 0.08)' : 'rgba(255,255,255,0.02)'
                          }} 
                          onClick={() => setExpandedPreviewMember(expandedPreviewMember === member.name ? null : member.name)}
                        >
                          {expandedPreviewMember === member.name ? '收合預覽' : '展開預覽'}
                        </button>
                      </div>
                    </div>

                    {/* Expandable LINE Chat Bubble Message Preview */}
                    {expandedPreviewMember === member.name && (
                      <div style={{
                        marginTop: '0.5rem',
                        padding: '0.75rem',
                        background: 'rgba(0,0,0,0.18)',
                        borderRadius: '10px',
                        border: '1px solid rgba(255,255,255,0.04)',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '0.4rem',
                        width: '100%'
                      }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.68rem' }}>
                          <span style={{ fontWeight: '600', color: '#34d399', display: 'flex', alignItems: 'center', gap: '3px' }}>
                            LINE 催款訊息預覽
                          </span>
                          <span style={{ color: 'var(--text-muted)' }}>
                            {reminderStyle === 'friendly' ? '🍿 幽默風' : reminderStyle === 'minimal' ? '📱 極簡風' : '📢 正式風'}
                          </span>
                        </div>
                        <div className="line-preview-bubble" style={{
                          background: 'rgba(16, 185, 129, 0.06)',
                          color: '#f8fafc',
                          padding: '0.75rem 0.85rem',
                          borderRadius: '12px',
                          borderTopRightRadius: '2px',
                          fontSize: '0.78rem',
                          whiteSpace: 'pre-wrap',
                          fontFamily: 'monospace',
                          lineHeight: '1.45',
                          maxHeight: '160px',
                          overflowY: 'auto',
                          textAlign: 'left',
                          border: '1px solid rgba(16, 185, 129, 0.2)'
                        }}>
                          {generateDetailedReminder(member, summary)}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Filter Bar */}
            <div className="table-container" style={{ padding: '0.85rem 1.25rem', marginBottom: '1.5rem', display: 'flex', gap: '1.25rem', flexWrap: 'wrap', alignItems: 'center' }}>
              <span style={{ fontSize: '0.85rem', fontWeight: '600', color: '#60a5fa', display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                流水帳檢索
              </span>
              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>搜尋關鍵字</span>
                <input type="text" className="form-control" style={{ padding: '0.35rem 0.65rem', fontSize: '0.8rem', width: '150px' }} placeholder="備註/說明" value={logSearch} onChange={e => setLogSearch(e.target.value)} />
              </div>
              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>成員姓名</span>
                <select className="form-control" style={{ padding: '0.35rem 0.65rem', fontSize: '0.8rem', width: '120px' }} value={logMemberFilter} onChange={e => setLogMemberFilter(e.target.value)}>
                  <option value="">全部成員</option>
                  {data.members.map(m => (
                    <option key={m.id} value={m.name}>{m.name}</option>
                  ))}
                </select>
              </div>
              {(logSearch || logMemberFilter) && (
                <button className="btn btn-secondary" style={{ padding: '0.35rem 0.65rem', fontSize: '0.75rem', flexGrow: 0 }} onClick={() => { setLogSearch(''); setLogMemberFilter(''); }}>
                  ❌ 重設
                </button>
              )}
            </div>

            {/* Current Month Active Logs */}
            {(() => {
              const filteredPayments = data.payments.filter(p => {
                const matchMember = !logMemberFilter || p.memberName === logMemberFilter;
                const matchSearch = !logSearch || 
                  (p.note || '').toLowerCase().includes(logSearch.toLowerCase()) || 
                  (p.method || '').toLowerCase().includes(logSearch.toLowerCase()) || 
                  (p.memberName || '').toLowerCase().includes(logSearch.toLowerCase()) ||
                  (isVoidedTransaction(p) ? '作廢' : '有效').includes(logSearch);
                return matchMember && matchSearch;
              });

              const filteredTempCharges = data.tempCharges.filter(c => {
                const matchMember = !logMemberFilter || c.memberName === logMemberFilter;
                const matchSearch = !logSearch || 
                  (c.desc || '').toLowerCase().includes(logSearch.toLowerCase()) || 
                  (c.memberName || '').toLowerCase().includes(logSearch.toLowerCase()) ||
                  (isVoidedTransaction(c) ? '作廢' : '有效').includes(logSearch);
                return matchMember && matchSearch;
              });

              return (
                <div className="logs-section">
                  {/* Payment logs */}
	                  <div className="log-panel">
	                    <h3>
	                      <span>本期收款流水帳</span>
	                      <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>已顯示 {filteredPayments.length} 筆 / 有效 {activePayments.length} 筆{voidedPaymentCount > 0 ? ` · 作廢 ${voidedPaymentCount} 筆` : ''}</span>
	                    </h3>
                    
                    <div className="log-list">
                      {filteredPayments.length === 0 ? (
                        <p style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '2rem 0' }}>無符合條件之收款資料</p>
                      ) : (
	                        filteredPayments.map(p => {
                            const voided = isVoidedTransaction(p);
                            return (
	                          <div key={p.id} className={`log-item ${voided ? 'voided' : ''}`}>
	                            <div className="log-info">
	                              <span style={{ fontWeight: '600' }}>{p.memberName} {voided && <span className="void-badge">作廢</span>}</span>
	                              <span className="log-meta">{p.date} • {p.method} {p.note && `• ${p.note}`} {voided && `• ${p.voidedAt?.slice(0, 10) || ''} ${p.voidReason || ''}`}</span>
	                            </div>
	                            <div className="log-amount">
	                              <span style={{ color: 'var(--success)' }}>${p.amount.toLocaleString()}</span>
	                              <button className="btn btn-danger btn-icon-only" style={{ width: '28px', height: '28px', fontSize: '0.75rem' }} onClick={() => handleDeletePayment(p.id)} disabled={voided}>
	                                ×
	                              </button>
	                            </div>
	                          </div>
                            );
                          })
	                      )}
                    </div>
                  </div>

                  {/* Temp charge logs */}
	                  <div className="log-panel">
	                    <h3>
	                      <span>本期臨時費用帳</span>
	                      <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>已顯示 {filteredTempCharges.length} 筆 / 有效 {activeTempCharges.length} 筆{voidedTempChargeCount > 0 ? ` · 作廢 ${voidedTempChargeCount} 筆` : ''}</span>
	                    </h3>

                    <div className="log-list">
                      {filteredTempCharges.length === 0 ? (
                        <p style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '2rem 0' }}>無符合條件之臨時加帳明細</p>
                      ) : (
	                        filteredTempCharges.map(c => {
                            const voided = isVoidedTransaction(c);
                            return (
	                          <div key={c.id} className={`log-item ${voided ? 'voided' : ''}`}>
	                            <div className="log-info">
	                              <span style={{ fontWeight: '600' }}>{c.memberName} {voided && <span className="void-badge">作廢</span>}</span>
	                              <span className="log-meta">{c.date} {c.desc && `• ${c.desc}`} {voided && `• ${c.voidedAt?.slice(0, 10) || ''} ${c.voidReason || ''}`}</span>
	                            </div>
	                            <div className="log-amount">
	                              <span style={{ color: 'var(--warning)' }}>${c.amount.toLocaleString()}</span>
	                              <button className="btn btn-danger btn-icon-only" style={{ width: '28px', height: '28px', fontSize: '0.75rem' }} onClick={() => handleDeleteTempCharge(c.id)} disabled={voided}>
	                                ×
	                              </button>
	                            </div>
	                          </div>
                            );
                          })
	                      )}
                    </div>
                  </div>
                </div>
              );
            })()}
          </>
        )}

        {/* Subscriptions Tab */}
        {activeTab === 'subscriptions' && (
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
        )}

        {/* Configurations Tab */}
        {activeTab === 'config' && (
          <>
          <section className={`draft-console ${configDirty ? 'dirty' : 'clean'}`}>
            <div className="draft-console-main">
              <span>設定草稿控制台</span>
              <h2>{configDirty ? '尚有未落帳變更' : '目前與正式設定一致'}</h2>
              <p>
                {configDirty
                  ? `目前有 ${draftChangeCount} 個設定變更只存在這個瀏覽器畫面。按下儲存後，系統會單次寫入資料庫、自動建立備份，並留下單筆事件。`
                  : '目前畫面已和正式資料庫同步，沒有待處理草稿。'}
              </p>
            </div>
            <div className="draft-stat">
              <span>平台草稿</span>
              <strong>{dirtyPlatformIds.length}</strong>
              <small>{dirtyPlatformIds.length > 0 ? '有費率或模式變更' : '沒有待寫入平台變更'}</small>
            </div>
            <div className="draft-stat">
              <span>成員草稿</span>
              <strong>{dirtyMemberIds.length}</strong>
              <small>{dirtyMemberIds.length > 0 ? '有餘額或特例月費變更' : '沒有待寫入成員變更'}</small>
            </div>
            <div className="draft-stat">
              <span>文字設定</span>
              <strong>{(bankDirty ? 1 : 0) + (reminderStyleDirty ? 1 : 0)}</strong>
              <small>{bankDirty || reminderStyleDirty ? '匯款資訊或催帳語氣已變更' : '匯款資訊與語氣未改動'}</small>
            </div>
            <div className="draft-actions-panel">
              <button className="btn btn-primary" onClick={handleSaveConfigs} disabled={!configDirty || configSaving}>
                {configSaving ? '寫入中...' : '一次寫入正式設定'}
              </button>
              <button className="btn btn-secondary" onClick={handleResetConfigDrafts} disabled={!configDirty || configSaving}>
                放棄草稿
              </button>
            </div>
          </section>
          <div className="config-layout">
            {/* Left Col: Platform Prices & Add Platform */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
              <div className="table-container" style={{ padding: '1.5rem', marginBottom: '0' }}>
                <h3 style={{ marginBottom: '1.25rem', fontSize: '1.1rem', fontWeight: '600' }}>🔧 平台收費模式與定價設定</h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
	                  {data.platforms.map(p => {
	                    const editObj = editingPrices[p.id] || { price: p.price, billingMode: p.billingMode || "fixed", totalCost: p.totalCost || 0 };
                      const archived = isArchivedEntity(p);
	                    return (
	                      <div key={p.id} style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', paddingBottom: '1rem', borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
	                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
	                          <span style={{ fontWeight: '600', color: archived ? 'var(--text-muted)' : '#60a5fa' }}>{p.name} {archived && <span className="void-badge">已停用</span>}</span>
	                          <button className="btn btn-danger" style={{ padding: '0.2rem 0.5rem', fontSize: '0.7rem', flexGrow: 0 }} onClick={() => handleDeletePlatform(p.id, p.name)} disabled={archived}>
	                            {archived ? '已停用' : '停用平台'}
	                          </button>
	                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: '0.75rem', alignItems: 'center' }}>
                          <div className="form-group">
                            <label>收費模式</label>
	                            <select className="form-control" style={{ padding: '0.5rem' }} value={editObj.billingMode} disabled={archived} onChange={(e) => {
                              setEditingPrices({
                                ...editingPrices,
                                [p.id]: { ...editObj, billingMode: e.target.value }
                              });
                            }}>
                              <option value="fixed">固定價格 (按人計費)</option>
                              <option value="split">動態均分 (按平台總價除以人數)</option>
                            </select>
                          </div>
                          
                          {editObj.billingMode === 'split' ? (
                            <div className="form-group">
                              <label>平台總月費 (NT$)</label>
	                              <input type="number" className="form-control" style={{ textAlign: 'right', padding: '0.5rem' }} value={editObj.totalCost} disabled={archived} onChange={(e) => {
                                setEditingPrices({
                                  ...editingPrices,
                                  [p.id]: { ...editObj, totalCost: e.target.value }
                                });
                              }} />
                            </div>
                          ) : (
                            <div className="form-group">
                              <label>固定單人月費 (NT$)</label>
	                              <input type="number" className="form-control" style={{ textAlign: 'right', padding: '0.5rem' }} value={editObj.price} disabled={archived} onChange={(e) => {
                                setEditingPrices({
                                  ...editingPrices,
                                  [p.id]: { ...editObj, price: e.target.value }
                                });
                              }} />
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Add Platform Card */}
              <div className="table-container" style={{ padding: '1.5rem', marginBottom: '0' }}>
                <h3 style={{ marginBottom: '1rem', fontSize: '1.1rem', fontWeight: '600' }}>新增訂閱平台</h3>
                <form onSubmit={handleAddPlatform} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                    <div className="form-group">
                      <label>平台名稱</label>
                      <input type="text" className="form-control" placeholder="例如: Disney+" value={newPlatName} onChange={e => setNewPlatName(e.target.value)} required />
                    </div>
                    <div className="form-group">
                      <label>收費模式</label>
                      <select className="form-control" value={newPlatMode} onChange={e => setNewPlatMode(e.target.value)}>
                        <option value="fixed">固定價格 (按人)</option>
                        <option value="split">動態均分 (平台總價)</option>
                      </select>
                    </div>
                  </div>
                  
                  {newPlatMode === 'split' ? (
                    <div className="form-group">
                      <label>平台總月費 (NT$)</label>
                      <input type="number" className="form-control" placeholder="輸入總月費金額" value={newPlatTotal} onChange={e => setNewPlatTotal(e.target.value)} />
                    </div>
                  ) : (
                    <div className="form-group">
                      <label>單人固定月費 (NT$)</label>
                      <input type="number" className="form-control" placeholder="輸入每人月費金額" value={newPlatPrice} onChange={e => setNewPlatPrice(e.target.value)} />
                    </div>
                  )}
                  <button type="submit" className="btn btn-secondary" style={{ padding: '0.6rem 1rem' }}>建立平台</button>
                </form>
              </div>

              <div className="table-container" style={{ padding: '1.5rem', marginBottom: '0', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
                <h3 style={{ marginBottom: '0', fontSize: '1.1rem', fontWeight: '600' }}>通知腳本與匯款設定</h3>
                <div className="form-group">
                  <label style={{ fontWeight: '500' }}>匯款帳戶資訊</label>
                  <textarea className="form-control" rows="2" style={{ resize: 'none' }} value={bankInfo} onChange={(e) => setBankInfo(e.target.value)} placeholder="如：銀行名稱(000) 帳號 0000000000"></textarea>
                  <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>此帳號將會自動帶入「LINE 催款文字」的訊息範本中。</p>
                </div>

                <div className="form-group">
                  <label style={{ fontWeight: '500' }}>催帳訊息風格</label>
                  <select className="form-control" value={reminderStyle} onChange={(e) => setReminderStyle(e.target.value)}>
                    <option value="friendly">🍿 幽默親友風 (有梗、親切幽默)</option>
                    <option value="formal">📢 正式對帳風 (清晰、商務簡潔)</option>
                    <option value="minimal">📱 極簡親友風 (直奔主題、極速對帳)</option>
                  </select>
                  <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>挑選最適合傳給朋友們的訊息語氣，讓催帳不再尷尬！</p>
                </div>
              </div>

              <div className="table-container recovery-console">
                <div className="recovery-header">
                  <div>
                    <span>Recovery radar</span>
                    <h3>資料備份與還原</h3>
                  </div>
                  <button className="btn btn-secondary recovery-toggle" onClick={() => { setShowBackupPanel(!showBackupPanel); if (!showBackupPanel) loadBackups(); }}>
                    {showBackupPanel ? '收合' : '管理備份'}
                  </button>
                </div>
                {showBackupPanel && (
                  <div className="recovery-body">
                    {recoveryStatus && (
                      <div className={`recovery-current ${getSnapshotTone(recoveryStatus)}`}>
                        <div>
                          <span>目前狀態</span>
                          <strong>{recoveryStatus.currentMonth} · {recoveryStatus.health.label}</strong>
                          <small>{recoveryStatus.health.warningCount} 個提醒 · 事件鏈 {recoveryStatus.ledger.ok ? '完整' : '異常'}</small>
                        </div>
                        <div>
                          <span>待收</span>
                          <strong>{formatMoney(recoveryStatus.totals.receivable)}</strong>
                          <small>{recoveryStatus.totals.unpaidMembers} 人未結清</small>
                        </div>
                        <div>
                          <span>指紋</span>
                          <code>{recoveryStatus.fingerprint?.slice(0, 12) || 'pending'}</code>
                          <small>{recoveryStatus.counts?.ledger || 0} 筆事件</small>
                        </div>
                      </div>
                    )}

                    <button className="btn btn-secondary recovery-create" onClick={handleCreateBackup} disabled={backupLoading}>
                      {backupLoading ? '處理中...' : '建立目前狀態備份'}
                    </button>

                    {backups.length === 0 ? (
                      <p className="recovery-empty">暫無備份記錄</p>
                    ) : (
                      <div className="recovery-list">
                        {backups.map(b => {
                          const snapshot = b.snapshot;
                          const sizeKB = (b.size / 1024).toFixed(1);
                          const tone = b.readable ? getSnapshotTone(snapshot) : 'risk';
                          return (
                            <div key={b.filename} className={`recovery-item ${tone}`}>
                              <div className="recovery-item-main">
                                <div className="recovery-item-title">
                                  <span>{formatBackupTimestamp(b.label, b.mtime)}</span>
                                  <strong>{b.readable ? snapshot.health.label : '無法讀取'}</strong>
                                </div>
                                <div className="recovery-item-meta">
                                  <span>{b.readable ? `${snapshot.currentMonth} 帳期` : b.error}</span>
                                  <span>{sizeKB} KB</span>
                                  {b.readable && <span>待收 {formatMoney(snapshot.totals.receivable)}</span>}
                                  {b.readable && <span>事件 {snapshot.ledger.count}</span>}
                                </div>
                                <p>{b.restoreImpact?.summary || '尚未計算差異'}</p>
                              </div>
                              <div className="recovery-actions">
                                <button className="btn btn-success" onClick={() => handleRestoreBackup(b)} disabled={backupLoading || !b.readable}>
                                  還原
                                </button>
                                <button className="btn btn-danger btn-icon-only" onClick={() => handleDeleteBackup(b.filename)} disabled={backupLoading}>
                                  ×
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
              </div>

              <button className="btn btn-primary" style={{ padding: '0.9rem 2rem', fontSize: '1rem', borderRadius: '12px' }} onClick={handleSaveConfigs} disabled={!configDirty || configSaving}>
                {configSaving ? '寫入中...' : '一次寫入正式設定'}
              </button>
            </div>

            {/* Right Col: Member configurations & Add Member */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
              <div className="table-container" style={{ padding: '1.5rem', marginBottom: '0' }}>
	                <h3 style={{ marginBottom: '1.25rem', fontSize: '1.1rem', fontWeight: '600' }}>成員名單、期初餘額與特例月費</h3>
	                <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
	                  {data.members.map(m => {
                      const archived = isArchivedEntity(m);
                      return (
	                    <div key={m.id} style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', paddingBottom: '1rem', borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
	                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
	                        <span style={{ fontWeight: '600', color: archived ? 'var(--text-muted)' : '#60a5fa' }}>{m.name} {archived && <span className="void-badge">已停用</span>}</span>
	                        <button className="btn btn-danger" style={{ padding: '0.2rem 0.5rem', fontSize: '0.7rem', flexGrow: 0 }} onClick={() => handleDeleteMember(m.id, m.name)} disabled={archived}>
	                          {archived ? '已停用' : '停用成員'}
	                        </button>
	                      </div>
	                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
	                        <div className="form-group">
	                          <label>前期餘額 (期初)</label>
	                          <input type="number" className="form-control" style={{ textAlign: 'right' }} value={editingMembers[m.id]?.priorBalance ?? 0} disabled={archived} onChange={(e) => {
	                            setEditingMembers({
	                              ...editingMembers,
	                              [m.id]: { ...editingMembers[m.id], priorBalance: e.target.value }
	                            });
	                          }} />
	                        </div>
	                        <div className="form-group">
	                          <label>自訂月費 (特例)</label>
	                          <input type="number" className="form-control" style={{ textAlign: 'right' }} placeholder="無特例留空" value={editingMembers[m.id]?.customFee ?? ''} disabled={archived} onChange={(e) => {
	                            setEditingMembers({
	                              ...editingMembers,
	                              [m.id]: { ...editingMembers[m.id], customFee: e.target.value }
	                            });
	                          }} />
	                        </div>
	                      </div>
	                    </div>
                      );
                    })}
	                </div>
              </div>

              {/* Add Member Card */}
              <div className="table-container" style={{ padding: '1.5rem' }}>
                <h3 style={{ marginBottom: '1rem', fontSize: '1.1rem', fontWeight: '600' }}>新增成員</h3>
                <form onSubmit={handleAddMember} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                  <div className="form-group">
                    <label>成員姓名</label>
                    <input type="text" className="form-control" placeholder="例如: 林小明" value={newMemberName} onChange={e => setNewMemberName(e.target.value)} required />
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                    <div className="form-group">
                      <label>期初餘額 (NT$)</label>
                      <input type="number" className="form-control" placeholder="預設為 0" value={newMemberPrior} onChange={e => setNewMemberPrior(e.target.value)} />
                    </div>
                    <div className="form-group">
                      <label>自訂月費 (非必填，特例月費)</label>
                      <input type="number" className="form-control" placeholder="特例月費金額" value={newMemberCustom} onChange={e => setNewMemberCustom(e.target.value)} />
                    </div>
                  </div>
                  <button type="submit" className="btn btn-secondary" style={{ padding: '0.6rem 1rem' }}>建立成員</button>
                </form>
              </div>
            </div>
          </div>
          </>
        )}

        {/* History Browser Tab */}
        {activeTab === 'history' && (
          <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: '2rem' }}>
            {/* Sidebar list of months */}
            <div className="table-container" style={{ padding: '1rem', display: 'flex', flexDirection: 'column', gap: '0.5rem', height: 'fit-content' }}>
              <h4 style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '0.5rem', paddingLeft: '0.5rem' }}>歷史對帳月份</h4>
              {data.history.length === 0 ? (
                <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', paddingLeft: '0.5rem' }}>暫無歷史結算檔案</p>
              ) : (
                data.history.map(hist => (
                  <div key={hist.month} className={`nav-item ${selectedHistMonth === hist.month ? 'active' : ''}`} style={{ padding: '0.65rem 0.85rem', fontSize: '0.85rem' }} onClick={() => setSelectedHistMonth(hist.month)}>
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
              {(() => {
                const histData = data.history.map(h => {
                  const fees = h.balances.reduce((sum, b) => sum + b.subscriptionFee, 0);
                  const paid = h.balances.reduce((sum, b) => sum + b.paid, 0);
                  return { month: h.month, fees, paid };
                });
                
                if (histData.length === 0) return null;
                
                const maxVal = Math.max(...histData.map(d => Math.max(d.fees, d.paid, 100)), 1000);
                
                const chartWidth = 500;
                const chartHeight = 160;
                const plotWidth = 420;
                const plotHeight = 110;
                const startX = 60;
                const startY = 15;
                const barSpacing = plotWidth / histData.length;
                const barWidth = Math.max(8, barSpacing * 0.25);
                
                return (
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
                );
              })()}

              {data.history.find(h => h.month === selectedHistMonth) ? (
                (() => {
                  const hist = data.history.find(h => h.month === selectedHistMonth);
                  return (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
                      {/* Ending Balances Table */}
                      <div className="table-container" style={{ marginBottom: '0' }}>
                        <div style={{ padding: '0.85rem 1.25rem', borderBottom: '1px solid var(--panel-border)', fontWeight: '600', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <span>{hist.month} 結帳對帳單總覽</span>
                          <button className="btn btn-secondary" style={{ padding: '0.4rem 0.85rem', fontSize: '0.8rem', flexGrow: 0 }} onClick={() => exportToCSV(hist.month, hist.balances, hist.payments, hist.tempCharges)}>
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
                              {hist.balances.map(b => (
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
                            {hist.payments.length === 0 ? (
                              <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', padding: '1rem 0' }}>無付款記錄</p>
                            ) : (
                              hist.payments.map(p => (
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
                            {hist.tempCharges.length === 0 ? (
                              <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', padding: '1rem 0' }}>無加帳記錄</p>
                            ) : (
                              hist.tempCharges.map(c => (
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
                  );
                })()
              ) : (
                <div className="table-container" style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-muted)' }}>
                  請選擇左側月份載入歷史對帳報告。
                </div>
              )}
            </div>
          </div>
        )}
      </main>

      {/* ----------------------------------------------------
          MODALS
      ---------------------------------------------------- */}
      
      {/* 1. Payment Modal */}
      {showPayModal && (
        <div className="modal-overlay" onClick={() => setShowPayModal(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">登記收款：{selectedMember}</span>
              <span className="modal-close" onClick={() => setShowPayModal(false)}>&times;</span>
            </div>
            <form onSubmit={handleAddPayment} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
              <div className="form-group">
                <label>付款金額 (NT$)</label>
                <input type="number" className="form-control" placeholder="輸入付款金額" value={amount} onChange={(e) => setAmount(e.target.value)} required />
              </div>
              <div className="form-group">
                <label>付款日期</label>
                <input type="date" className="form-control" value={date} onChange={(e) => setDate(e.target.value)} />
              </div>
              <div className="form-group">
                <label>付款方式</label>
                <select className="form-control" value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value)}>
                  <option value="轉帳">轉帳</option>
                  <option value="LINE Pay">LINE Pay</option>
                  <option value="現金">現金</option>
                  <option value="銀行匯款">銀行匯款</option>
                  <option value="其他">其他</option>
                </select>
              </div>
              <div className="form-group">
                <label>備註 (可選)</label>
                <input type="text" className="form-control" placeholder="如：已收到轉帳" value={noteOrDesc} onChange={(e) => setNoteOrDesc(e.target.value)} />
              </div>
              <p style={{ fontSize: '0.76rem', color: 'var(--text-muted)', lineHeight: '1.45' }}>
                系統會阻擋 10 分鐘內同成員、同日期、同金額、同付款方式與同備註的重複收款。
              </p>
              
              <div style={{ display: 'flex', gap: '0.75rem', marginTop: '0.5rem' }}>
                <button type="button" className="btn btn-secondary" onClick={() => setShowPayModal(false)} disabled={transactionSaving === 'payment'}>取消</button>
                <button type="submit" className="btn btn-primary" disabled={transactionSaving === 'payment'}>{transactionSaving === 'payment' ? '登記中...' : '確認登記'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* 2. Temp Charge Modal */}
      {showChargeModal && (
        <div className="modal-overlay" onClick={() => setShowChargeModal(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">登記臨時加帳：{selectedMember}</span>
              <span className="modal-close" onClick={() => setShowChargeModal(false)}>&times;</span>
            </div>
            <form onSubmit={handleAddTempCharge} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
              <div className="form-group">
                <label>加帳金額 (NT$)</label>
                <input type="number" className="form-control" placeholder="正數為加收，負數為扣減" value={amount} onChange={(e) => setAmount(e.target.value)} required />
              </div>
              <div className="form-group">
                <label>加帳日期</label>
                <input type="date" className="form-control" value={date} onChange={(e) => setDate(e.target.value)} />
              </div>
              <div className="form-group">
                <label>加帳事項說明</label>
                <input type="text" className="form-control" placeholder="如：代墊網購、吃飯費" value={noteOrDesc} onChange={(e) => setNoteOrDesc(e.target.value)} required />
              </div>
              <p style={{ fontSize: '0.76rem', color: 'var(--text-muted)', lineHeight: '1.45' }}>
                系統會阻擋 10 分鐘內同成員、同日期、同金額與同說明的重複加帳。
              </p>

              <div style={{ display: 'flex', gap: '0.75rem', marginTop: '0.5rem' }}>
                <button type="button" className="btn btn-secondary" onClick={() => setShowChargeModal(false)} disabled={transactionSaving === 'charge'}>取消</button>
                <button type="submit" className="btn btn-primary" disabled={transactionSaving === 'charge'}>{transactionSaving === 'charge' ? '登記中...' : '確認登記'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* 3. Settle/Rollover Confirm Modal */}
      {showSettleModal && (
        <div className="modal-overlay" onClick={() => { setShowSettleModal(false); setClosePreview(null); }}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '620px' }}>
            <div className="modal-header">
              <span className="modal-title">月結控制台：{data.currentMonth}</span>
              <span className="modal-close" onClick={() => { setShowSettleModal(false); setClosePreview(null); }}>&times;</span>
            </div>
            {closePreviewLoading ? (
              <div className="close-preview-loading">正在執行月結預檢...</div>
            ) : closePreview ? (
              <div className="close-preview">
                <div className={`close-readiness ${closePreview.ready ? 'ready' : 'blocked'}`}>
                  <span>{closePreview.ready ? '可結算' : '暫停結算'}</span>
                  <strong>{closePreview.currentMonth} → {closePreview.nextMonth || '下一期'}</strong>
                  <small>{closePreview.ready ? '預檢通過，仍請確認本期款項已登載完成。' : '有高風險項目需要先處理。'}</small>
                </div>

                <div className="close-metrics">
                  <div>
                    <span>本期訂閱費</span>
                    <strong>${closePreview.totals.subscriptionFee.toLocaleString()}</strong>
                  </div>
                  <div>
                    <span>已入帳</span>
                    <strong>${closePreview.totals.paid.toLocaleString()}</strong>
                  </div>
                  <div>
                    <span>結轉應收</span>
                    <strong>${closePreview.totals.receivable.toLocaleString()}</strong>
                  </div>
                  <div>
                    <span>未結清</span>
                    <strong>{closePreview.totals.unpaidMembers} 人</strong>
                  </div>
                </div>

                <div className="close-checks">
                  {closePreview.checks.map(check => (
                    <div className={`close-check ${check.status}`} key={check.id}>
                      <span>{check.status === 'pass' ? '✓' : '!'}</span>
                      <div>
                        <strong>{check.label}</strong>
                        <p>{check.detail}</p>
                      </div>
                    </div>
                  ))}
                </div>

                {closePreview.blockers.length > 0 && (
                  <div className="close-blockers">
                    {closePreview.blockers.map(blocker => (
                      <p key={blocker.code}><strong>{blocker.title}</strong>：{blocker.detail}</p>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div className="close-preview-loading">尚未取得月結預檢資料。</div>
            )}
            <div style={{ display: 'flex', gap: '0.75rem', marginTop: '1rem' }}>
              <button type="button" className="btn btn-secondary" onClick={() => { setShowSettleModal(false); setClosePreview(null); }}>取消</button>
              <button type="button" className="btn btn-primary" onClick={handleSettleMonth} disabled={closePreviewLoading || !closePreview?.ready}>確認結算本月</button>
            </div>
          </div>
        </div>
      )}

      {/* Toast Notification */}
      {toast && (
        <div className="toast">
          {toast}
        </div>
      )}
    </div>
  );
}

export default App;
