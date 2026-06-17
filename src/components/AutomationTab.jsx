import { useState, useCallback } from 'react';

// ---------------------------------------------------------------------------
// Confidence Badge
// ---------------------------------------------------------------------------
function ConfidenceBadge({ score }) {
    const pct = Math.round(score * 100);
    const color = pct >= 90 ? '#10b981' : pct >= 70 ? '#f59e0b' : '#ef4444';
    const bg = pct >= 90 ? 'rgba(16,185,129,0.12)' : pct >= 70 ? 'rgba(245,158,11,0.12)' : 'rgba(239,68,68,0.12)';
    return (
        <span style={{
            display: 'inline-flex', alignItems: 'center', gap: '4px',
            padding: '2px 10px', borderRadius: '999px',
            fontSize: '12px', fontWeight: 700,
            color, background: bg, border: `1px solid ${color}40`,
        }}>
            {pct}% 信心
        </span>
    );
}

// ---------------------------------------------------------------------------
// Proposal Kind Label
// ---------------------------------------------------------------------------
const KIND_META = {
    payment: { icon: '💳', label: '付款', color: '#60a5fa' },
    subscription: { icon: '📦', label: '訂閱', color: '#a78bfa' },
    tempCharge: { icon: '🧾', label: '加帳', color: '#fbbf24' },
};

function KindBadge({ kind }) {
    const meta = KIND_META[kind] || { icon: '❓', label: kind, color: '#9ca3af' };
    return (
        <span style={{
            display: 'inline-flex', alignItems: 'center', gap: '4px',
            padding: '2px 10px', borderRadius: '999px',
            fontSize: '12px', fontWeight: 700,
            color: meta.color,
            background: `${meta.color}18`,
            border: `1px solid ${meta.color}40`,
        }}>
            {meta.icon} {meta.label}
        </span>
    );
}

// ---------------------------------------------------------------------------
// Payload Summary
// ---------------------------------------------------------------------------
function PayloadSummary({ kind, payload }) {
    if (!payload) return null;
    if (kind === 'payment') {
        return (
            <span style={{ color: 'var(--color-text-secondary, #9ca3af)', fontSize: '13px' }}>
                {payload.memberName} 轉 <strong style={{ color: '#10b981' }}>${payload.amount}</strong>
                {payload.date ? ` (${payload.date})` : ''}
                {payload.note ? ` — ${payload.note}` : ''}
            </span>
        );
    }
    if (kind === 'tempCharge') {
        return (
            <span style={{ color: 'var(--color-text-secondary, #9ca3af)', fontSize: '13px' }}>
                {payload.memberName} 加帳 <strong style={{ color: '#fbbf24' }}>${payload.amount}</strong>
                {payload.desc ? ` — ${payload.desc}` : ''}
            </span>
        );
    }
    if (kind === 'subscription') {
        return (
            <span style={{ color: 'var(--color-text-secondary, #9ca3af)', fontSize: '13px' }}>
                {payload.memberName} 訂閱 <strong style={{ color: '#a78bfa' }}>{payload.platformName}</strong>
                {' '}從 {payload.startMonth} 起
            </span>
        );
    }
    return <span style={{ fontSize: '12px', opacity: 0.6 }}>{JSON.stringify(payload)}</span>;
}

// ---------------------------------------------------------------------------
// Status Icon
// ---------------------------------------------------------------------------
function StatusIcon({ status }) {
    if (status === 'applied') return <span title="已自動套用" style={{ fontSize: '18px' }}>✅</span>;
    if (status === 'pending') return <span title="待確認" style={{ fontSize: '18px' }}>⏳</span>;
    return <span title="被擋下" style={{ fontSize: '18px' }}>❌</span>;
}

// ---------------------------------------------------------------------------
// Proposal Card
// ---------------------------------------------------------------------------
function ProposalCard({ proposal, onConfirm, onReject, confirmingId, rejectingId }) {
    const { id, kind, sourceText, confidence, reason, warnings, payload, status, rejectReason, ledgerEventId } = proposal;
    const isConfirming = confirmingId === id;
    const isRejecting = rejectingId === id;

    const cardStyle = {
        background: status === 'applied'
            ? 'linear-gradient(135deg, rgba(16,185,129,0.07), rgba(16,185,129,0.03))'
            : status === 'rejected'
            ? 'linear-gradient(135deg, rgba(239,68,68,0.07), rgba(239,68,68,0.03))'
            : 'linear-gradient(135deg, rgba(255,255,255,0.04), rgba(255,255,255,0.02))',
        border: status === 'applied'
            ? '1px solid rgba(16,185,129,0.2)'
            : status === 'rejected'
            ? '1px solid rgba(239,68,68,0.18)'
            : '1px solid rgba(255,255,255,0.1)',
        borderRadius: '12px',
        padding: '16px 20px',
        marginBottom: '10px',
        transition: 'box-shadow 0.2s',
    };

    return (
        <div style={cardStyle} className="proposal-card">
            {/* Header Row */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginBottom: '8px' }}>
                <StatusIcon status={status} />
                <KindBadge kind={kind} />
                <ConfidenceBadge score={confidence} />
                {status === 'applied' && ledgerEventId && (
                    <span style={{
                        fontSize: '11px', color: '#6ee7b7', background: 'rgba(16,185,129,0.1)',
                        padding: '2px 8px', borderRadius: '6px', fontFamily: 'monospace',
                    }}>
                        ledger: {ledgerEventId}
                    </span>
                )}
            </div>

            {/* Source Text */}
            <div style={{
                fontSize: '12px', color: 'rgba(255,255,255,0.45)',
                fontStyle: 'italic', marginBottom: '6px',
                background: 'rgba(255,255,255,0.04)', padding: '4px 10px', borderRadius: '6px',
                borderLeft: '2px solid rgba(255,255,255,0.15)',
            }}>
                原文：{sourceText.length > 80 ? sourceText.slice(0, 80) + '…' : sourceText}
            </div>

            {/* Payload Summary */}
            <div style={{ marginBottom: '6px' }}>
                <PayloadSummary kind={kind} payload={payload} />
            </div>

            {/* Reason */}
            <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.5)', marginBottom: '4px' }}>
                💡 {reason}
            </div>

            {/* Warnings */}
            {warnings && warnings.length > 0 && (
                <div style={{ marginBottom: '8px' }}>
                    {warnings.map((w, i) => (
                        <div key={i} style={{
                            fontSize: '11px', color: '#fbbf24',
                            display: 'flex', alignItems: 'center', gap: '4px',
                        }}>
                            ⚠️ {w}
                        </div>
                    ))}
                </div>
            )}

            {/* Reject Reason */}
            {status === 'rejected' && rejectReason && (
                <div style={{
                    fontSize: '11px', color: '#fca5a5',
                    background: 'rgba(239,68,68,0.08)', padding: '4px 10px', borderRadius: '6px',
                    marginBottom: '6px',
                }}>
                    🚫 {rejectReason}
                </div>
            )}

            {/* Actions (pending only) */}
            {status === 'pending' && (
                <div style={{ display: 'flex', gap: '8px', marginTop: '10px' }}>
                    <button
                        onClick={() => onConfirm(id)}
                        disabled={isConfirming || isRejecting}
                        style={{
                            padding: '6px 16px', borderRadius: '8px', fontSize: '13px',
                            fontWeight: 600, border: 'none', cursor: 'pointer',
                            background: isConfirming ? 'rgba(16,185,129,0.3)' : 'rgba(16,185,129,0.85)',
                            color: '#fff', transition: 'all 0.15s',
                        }}
                    >
                        {isConfirming ? '套用中…' : '✓ 確認套用'}
                    </button>
                    <button
                        onClick={() => onReject(id)}
                        disabled={isConfirming || isRejecting}
                        style={{
                            padding: '6px 16px', borderRadius: '8px', fontSize: '13px',
                            fontWeight: 600, border: '1px solid rgba(239,68,68,0.4)', cursor: 'pointer',
                            background: isRejecting ? 'rgba(239,68,68,0.2)' : 'transparent',
                            color: '#fca5a5', transition: 'all 0.15s',
                        }}
                    >
                        {isRejecting ? '拒絕中…' : '✕ 拒絕'}
                    </button>
                </div>
            )}
        </div>
    );
}

// ---------------------------------------------------------------------------
// Main AutomationTab Component
// ---------------------------------------------------------------------------
export default function AutomationTab({ onDataChange }) {
    const [text, setText] = useState('');
    const [mode, setMode] = useState('auto');
    const [loading, setLoading] = useState(false);
    const [proposals, setProposals] = useState([]);
    const [parseErrors, setParseErrors] = useState([]);
    const [activeFilter, setActiveFilter] = useState('all');
    const [confirmingId, setConfirmingId] = useState(null);
    const [rejectingId, setRejectingId] = useState(null);
    const [toastMsg, setToastMsg] = useState(null);
    const [stats, setStats] = useState(null);

    const showToast = useCallback((msg, isError = false) => {
        setToastMsg({ msg, isError });
        setTimeout(() => setToastMsg(null), 3500);
    }, []);

    const handleIngest = useCallback(async () => {
        if (!text.trim()) return;
        setLoading(true);
        setParseErrors([]);
        setStats(null);
        try {
            const res = await fetch('/api/automation/ingest', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ text: text.trim(), mode }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || '解析失敗');

            const allNew = [...data.applied, ...data.pending, ...data.rejected];
            setProposals(prev => [...allNew, ...prev]);
            setParseErrors(data.parseErrors || []);
            setStats({
                applied: data.applied.length,
                pending: data.pending.length,
                rejected: data.rejected.length,
            });

            if (data.applied.length > 0 && onDataChange) onDataChange();
            if (data.applied.length > 0) {
                showToast(`✅ 自動套用 ${data.applied.length} 筆，待確認 ${data.pending.length} 筆`);
            } else if (data.pending.length > 0) {
                showToast(`⏳ ${data.pending.length} 筆待確認，${data.rejected.length} 筆被擋下`);
            } else {
                showToast(`已解析（${allNew.length} 筆結果）`, data.rejected.length > 0);
            }
        } catch (err) {
            showToast(err.message, true);
        } finally {
            setLoading(false);
        }
    }, [text, mode, onDataChange, showToast]);

    const handleConfirm = useCallback(async (proposalId) => {
        setConfirmingId(proposalId);
        try {
            const res = await fetch(`/api/automation/confirm/${proposalId}`, {
                method: 'POST',
                credentials: 'include',
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || '套用失敗');
            setProposals(prev => prev.map(p =>
                p.id === proposalId ? { ...p, ...data.proposal } : p
            ));
            showToast('✅ 已手動確認套用');
            if (onDataChange) onDataChange();
        } catch (err) {
            showToast(err.message, true);
        } finally {
            setConfirmingId(null);
        }
    }, [onDataChange, showToast]);

    const handleReject = useCallback(async (proposalId) => {
        setRejectingId(proposalId);
        try {
            const res = await fetch(`/api/automation/reject/${proposalId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ reason: '使用者手動拒絕' }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || '拒絕失敗');
            setProposals(prev => prev.map(p =>
                p.id === proposalId ? { ...p, ...data.proposal } : p
            ));
            showToast('拒絕已記錄');
        } catch (err) {
            showToast(err.message, true);
        } finally {
            setRejectingId(null);
        }
    }, [showToast]);

    // Filter
    const filteredProposals = proposals.filter(p => {
        if (activeFilter === 'all') return true;
        return p.status === activeFilter;
    });

    const counts = {
        all: proposals.length,
        applied: proposals.filter(p => p.status === 'applied').length,
        pending: proposals.filter(p => p.status === 'pending').length,
        rejected: proposals.filter(p => p.status === 'rejected').length,
    };

    const DEMO_TEXTS = [
        '王小明 轉 270\n幫李小明 6 月開始加 Netflix\n張大明 這個月額外收 50 網域費',
        'Member Alpha 付了 450 塊',
        'Beta 從下個月開始加 Spotify',
    ];

    return (
        <div style={{ maxWidth: '860px', margin: '0 auto', padding: '0 0 40px' }}>
            {/* Toast */}
            {toastMsg && (
                <div style={{
                    position: 'fixed', top: '24px', left: '50%', transform: 'translateX(-50%)',
                    zIndex: 9999, padding: '12px 28px', borderRadius: '12px',
                    background: toastMsg.isError ? 'rgba(239,68,68,0.92)' : 'rgba(16,185,129,0.92)',
                    color: '#fff', fontWeight: 600, fontSize: '14px',
                    boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
                    backdropFilter: 'blur(12px)',
                    transition: 'all 0.3s',
                }}>
                    {toastMsg.msg}
                </div>
            )}

            {/* Header */}
            <div style={{ marginBottom: '24px' }}>
                <h2 style={{
                    fontSize: '22px', fontWeight: 700, margin: '0 0 6px',
                    background: 'linear-gradient(90deg, #60a5fa, #a78bfa, #34d399)',
                    WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
                    backgroundClip: 'text',
                }}>
                    ⚡ AI 自動處理
                </h2>
                <p style={{ margin: 0, fontSize: '14px', color: 'rgba(255,255,255,0.5)' }}>
                    貼入自然語言帳務紀錄，Gemini 自動解析 → 驗證 → 套用 / 待確認 / 擋下
                </p>
            </div>

            {/* Input Area */}
            <div style={{
                background: 'linear-gradient(135deg, rgba(255,255,255,0.04), rgba(255,255,255,0.02))',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: '16px',
                padding: '20px',
                marginBottom: '20px',
            }}>
                <div style={{ marginBottom: '12px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                        <label style={{ fontSize: '13px', fontWeight: 600, color: 'rgba(255,255,255,0.7)' }}>
                            貼入帳務文字
                        </label>
                        <div style={{ display: 'flex', gap: '6px' }}>
                            {DEMO_TEXTS.map((t, i) => (
                                <button
                                    key={i}
                                    onClick={() => setText(t)}
                                    style={{
                                        fontSize: '11px', padding: '3px 10px', borderRadius: '6px',
                                        border: '1px solid rgba(96,165,250,0.3)',
                                        background: 'rgba(96,165,250,0.1)', color: '#93c5fd',
                                        cursor: 'pointer',
                                    }}
                                >
                                    範例 {i + 1}
                                </button>
                            ))}
                        </div>
                    </div>
                    <textarea
                        value={text}
                        onChange={e => setText(e.target.value)}
                        placeholder={'貼入帳務文字，例如：\n王小明 轉 270\n幫李小明 6 月開始加 Netflix\n張大明 這個月額外收 50 網域費'}
                        rows={5}
                        style={{
                            width: '100%', boxSizing: 'border-box',
                            background: 'rgba(0,0,0,0.3)',
                            border: '1px solid rgba(255,255,255,0.12)',
                            borderRadius: '10px',
                            color: '#e5e7eb',
                            padding: '12px 14px',
                            fontSize: '14px', lineHeight: 1.6,
                            resize: 'vertical', outline: 'none',
                            fontFamily: 'var(--font-mono, monospace)',
                        }}
                        onFocus={e => e.target.style.borderColor = 'rgba(96,165,250,0.5)'}
                        onBlur={e => e.target.style.borderColor = 'rgba(255,255,255,0.12)'}
                    />
                </div>

                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '12px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <label style={{ fontSize: '13px', color: 'rgba(255,255,255,0.6)' }}>模式：</label>
                        {['auto', 'review'].map(m => (
                            <label key={m} style={{ display: 'flex', alignItems: 'center', gap: '5px', cursor: 'pointer', fontSize: '13px', color: 'rgba(255,255,255,0.7)' }}>
                                <input
                                    type="radio"
                                    name="mode"
                                    value={m}
                                    checked={mode === m}
                                    onChange={() => setMode(m)}
                                    style={{ accentColor: '#60a5fa' }}
                                />
                                {m === 'auto' ? '🤖 自動套用（高信心）' : '👁️ 全部待確認'}
                            </label>
                        ))}
                    </div>
                    <button
                        onClick={handleIngest}
                        disabled={loading || !text.trim()}
                        style={{
                            padding: '10px 28px', borderRadius: '10px', fontSize: '14px', fontWeight: 700,
                            border: 'none', cursor: loading || !text.trim() ? 'not-allowed' : 'pointer',
                            background: loading ? 'rgba(96,165,250,0.4)' : 'linear-gradient(135deg, #3b82f6, #8b5cf6)',
                            color: '#fff',
                            boxShadow: loading ? 'none' : '0 4px 20px rgba(59,130,246,0.3)',
                            transition: 'all 0.2s',
                            opacity: !text.trim() ? 0.5 : 1,
                        }}
                    >
                        {loading ? '⚙️ 解析中…' : '⚡ 解析並處理'}
                    </button>
                </div>
            </div>

            {/* Parse Errors */}
            {parseErrors.length > 0 && (
                <div style={{
                    background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)',
                    borderRadius: '10px', padding: '12px 16px', marginBottom: '16px',
                }}>
                    <div style={{ fontSize: '13px', fontWeight: 600, color: '#fca5a5', marginBottom: '4px' }}>⚠️ 解析警告</div>
                    {parseErrors.map((e, i) => (
                        <div key={i} style={{ fontSize: '12px', color: '#fecaca' }}>• {e}</div>
                    ))}
                </div>
            )}

            {/* Stats Banner */}
            {stats && (
                <div style={{
                    display: 'flex', gap: '12px', marginBottom: '16px', flexWrap: 'wrap',
                }}>
                    {[
                        { label: '已自動套用', value: stats.applied, color: '#10b981' },
                        { label: '待確認', value: stats.pending, color: '#f59e0b' },
                        { label: '被擋下', value: stats.rejected, color: '#ef4444' },
                    ].map(({ label, value, color }) => (
                        <div key={label} style={{
                            flex: 1, minWidth: '110px',
                            background: `${color}12`,
                            border: `1px solid ${color}30`,
                            borderRadius: '10px', padding: '10px 14px', textAlign: 'center',
                        }}>
                            <div style={{ fontSize: '24px', fontWeight: 800, color }}>{value}</div>
                            <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.55)' }}>{label}</div>
                        </div>
                    ))}
                </div>
            )}

            {/* Inbox */}
            {proposals.length > 0 && (
                <>
                    {/* Filter Tabs */}
                    <div style={{ display: 'flex', gap: '8px', marginBottom: '16px', flexWrap: 'wrap' }}>
                        {[
                            { key: 'all', label: '全部', color: '#9ca3af' },
                            { key: 'applied', label: '✅ 已套用', color: '#10b981' },
                            { key: 'pending', label: '⏳ 待確認', color: '#f59e0b' },
                            { key: 'rejected', label: '❌ 被擋下', color: '#ef4444' },
                        ].map(({ key, label, color }) => {
                            const isActive = activeFilter === key;
                            return (
                                <button
                                    key={key}
                                    onClick={() => setActiveFilter(key)}
                                    style={{
                                        padding: '6px 16px', borderRadius: '8px', fontSize: '13px',
                                        fontWeight: isActive ? 700 : 500,
                                        border: `1px solid ${isActive ? color : 'rgba(255,255,255,0.1)'}`,
                                        background: isActive ? `${color}20` : 'transparent',
                                        color: isActive ? color : 'rgba(255,255,255,0.55)',
                                        cursor: 'pointer', transition: 'all 0.15s',
                                    }}
                                >
                                    {label} {counts[key] > 0 && (
                                        <span style={{
                                            marginLeft: '4px', background: `${color}30`,
                                            borderRadius: '999px', padding: '1px 7px', fontSize: '11px',
                                        }}>
                                            {counts[key]}
                                        </span>
                                    )}
                                </button>
                            );
                        })}
                    </div>

                    {/* Proposal List */}
                    {filteredProposals.length === 0 ? (
                        <div style={{ textAlign: 'center', padding: '32px', color: 'rgba(255,255,255,0.3)', fontSize: '14px' }}>
                            此分類目前無 proposals
                        </div>
                    ) : (
                        filteredProposals.map(p => (
                            <ProposalCard
                                key={p.id}
                                proposal={p}
                                onConfirm={handleConfirm}
                                onReject={handleReject}
                                confirmingId={confirmingId}
                                rejectingId={rejectingId}
                            />
                        ))
                    )}
                </>
            )}

            {/* Empty State */}
            {proposals.length === 0 && !loading && (
                <div style={{
                    textAlign: 'center', padding: '60px 20px',
                    color: 'rgba(255,255,255,0.25)', fontSize: '15px',
                }}>
                    <div style={{ fontSize: '48px', marginBottom: '12px' }}>⚡</div>
                    <div>貼入帳務文字，AI 自動解析並分類</div>
                    <div style={{ fontSize: '12px', marginTop: '8px', opacity: 0.7 }}>
                        支援付款、訂閱、臨時加帳，可同時處理多筆
                    </div>
                </div>
            )}

            {/* GenAI Tech Note (for demo context) */}
            <div style={{
                marginTop: '40px',
                background: 'linear-gradient(135deg, rgba(96,165,250,0.06), rgba(167,139,250,0.06))',
                border: '1px solid rgba(96,165,250,0.15)',
                borderRadius: '12px', padding: '16px 20px',
            }}>
                <div style={{ fontSize: '12px', fontWeight: 700, color: '#93c5fd', marginBottom: '8px', letterSpacing: '0.05em' }}>
                    🔬 GenAI 技術架構
                </div>
                <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.4)', lineHeight: 1.7 }}>
                    <strong style={{ color: 'rgba(255,255,255,0.65)' }}>Gemini function calling</strong> 解析文字 →{' '}
                    <strong style={{ color: 'rgba(255,255,255,0.65)' }}>Deterministic 驗證層</strong>（重複檢查、成員匹配、格式驗證）→{' '}
                    <strong style={{ color: 'rgba(255,255,255,0.65)' }}>信心分數分類</strong>（≥90% 自動套用）→{' '}
                    所有寫入走既有 <strong style={{ color: 'rgba(255,255,255,0.65)' }}>SQLite + Ledger + RAG invalidation</strong> 鏈
                </div>
            </div>
        </div>
    );
}
