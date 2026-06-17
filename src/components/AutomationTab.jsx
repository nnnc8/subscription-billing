import { useState, useCallback } from 'react';

// ---------------------------------------------------------------------------
// Status chip — operational style (no gradients)
// ---------------------------------------------------------------------------
function StatusChip({ status }) {
    const config = {
        applied: { label: '已入帳', color: 'var(--green)', bg: 'var(--green-bg)' },
        pending: { label: '待覆核', color: 'var(--orange)', bg: 'var(--orange-bg)' },
        rejected: { label: '已擋下', color: 'var(--red)', bg: 'var(--red-bg)' },
    };
    const c = config[status] || config.rejected;
    return (
        <span style={{
            display: 'inline-block',
            padding: '2px 8px',
            borderRadius: 'var(--radius-sm)',
            fontSize: '0.72rem',
            fontWeight: 600,
            color: c.color,
            background: c.bg,
            letterSpacing: '0.01em',
        }}>
            {c.label}
        </span>
    );
}

// ---------------------------------------------------------------------------
// Kind chip — compact
// ---------------------------------------------------------------------------
function KindChip({ kind }) {
    const config = {
        payment: { label: '付款', color: 'var(--blue)', bg: 'var(--blue-bg)' },
        subscription: { label: '訂閱', color: 'var(--purple)', bg: 'var(--purple-bg)' },
        tempCharge: { label: '加帳', color: 'var(--orange)', bg: 'var(--orange-bg)' },
    };
    const c = config[kind] || { label: kind, color: 'var(--text-secondary)', bg: 'transparent' };
    return (
        <span style={{
            display: 'inline-block',
            padding: '2px 7px',
            borderRadius: 'var(--radius-sm)',
            fontSize: '0.7rem',
            fontWeight: 600,
            color: c.color,
            background: c.bg,
        }}>
            {c.label}
        </span>
    );
}

// ---------------------------------------------------------------------------
// Confidence cell — low conf (<70%) in red
// ---------------------------------------------------------------------------
function ConfidenceCell({ score }) {
    const pct = Math.round(score * 100);
    const color = pct >= 90 ? 'var(--green)' : pct >= 70 ? 'var(--text-secondary)' : 'var(--red)';
    return (
        <span style={{ fontVariantNumeric: 'tabular-nums', fontSize: '0.8rem', color }}>
            {pct}%
        </span>
    );
}

// ---------------------------------------------------------------------------
// Payload description — compact single-line summary
// ---------------------------------------------------------------------------
function PayloadDesc({ kind, payload }) {
    if (!payload) return <span style={{ color: 'var(--text-tertiary)' }}>—</span>;
    if (kind === 'payment') {
        return (
            <span>
                <strong>{payload.memberName}</strong>
                {payload.amount != null && <> &nbsp;${payload.amount}</>}
                {payload.date && <> · {payload.date}</>}
            </span>
        );
    }
    if (kind === 'tempCharge') {
        return (
            <span>
                <strong>{payload.memberName}</strong>
                {payload.amount != null && <> &nbsp;+${payload.amount}</>}
                {payload.desc && <> · {payload.desc}</>}
            </span>
        );
    }
    if (kind === 'subscription') {
        return (
            <span>
                <strong>{payload.memberName}</strong>
                {' '}{payload.platformName && <>訂 {payload.platformName}</>}
                {payload.startMonth && <> 從 {payload.startMonth}</>}
            </span>
        );
    }
    return <span style={{ color: 'var(--text-tertiary)', fontSize: '0.78rem' }}>{JSON.stringify(payload).slice(0, 40)}</span>;
}

// ---------------------------------------------------------------------------
// Proposal row in the queue table
// ---------------------------------------------------------------------------
function ProposalRow({ proposal, onConfirm, onReject, confirmingId, rejectingId }) {
    const [showWarnings, setShowWarnings] = useState(false);
    const { id, kind, sourceText, confidence, reason, warnings, payload, status, rejectReason, ledgerEventId } = proposal;
    const isConfirming = confirmingId === id;
    const isRejecting = rejectingId === id;
    const hasWarnings = warnings && warnings.length > 0;

    return (
        <>
            <tr style={{
                borderBottom: '1px solid var(--separator)',
                background: status === 'applied'
                    ? 'rgba(52,199,89,0.03)'
                    : status === 'rejected'
                    ? 'rgba(255,59,48,0.03)'
                    : 'transparent',
            }}>
                {/* Kind */}
                <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>
                    <KindChip kind={kind} />
                </td>

                {/* Description */}
                <td style={{ padding: '8px 10px', fontSize: '0.82rem', color: 'var(--text-primary)' }}>
                    <PayloadDesc kind={kind} payload={payload} />
                    {hasWarnings && (
                        <button
                            onClick={() => setShowWarnings(v => !v)}
                            style={{
                                marginLeft: '6px', border: 'none', background: 'none',
                                cursor: 'pointer', color: 'var(--orange)', fontSize: '0.7rem',
                                padding: '0 2px', verticalAlign: 'middle',
                            }}
                            title={warnings.join('; ')}
                        >
                            ⚠ {warnings.length}
                        </button>
                    )}
                </td>

                {/* Confidence */}
                <td style={{ padding: '8px 10px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <ConfidenceCell score={confidence} />
                </td>

                {/* Status */}
                <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>
                    <StatusChip status={status} />
                </td>

                {/* Ledger / Actions */}
                <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>
                    {status === 'applied' && ledgerEventId && (
                        <code
                            style={{
                                fontFamily: 'var(--font-mono)',
                                fontSize: '0.68rem',
                                color: 'var(--blue)',
                                cursor: 'pointer',
                                userSelect: 'all',
                            }}
                            title={`Ledger event: ${ledgerEventId}`}
                            onClick={() => navigator.clipboard?.writeText(ledgerEventId)}
                        >
                            {ledgerEventId.slice(0, 12)}
                        </code>
                    )}
                    {status === 'pending' && (
                        <span style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                            <button
                                className="btn btn-primary"
                                style={{ padding: '3px 10px', fontSize: '0.75rem', minHeight: '28px' }}
                                onClick={() => onConfirm(id)}
                                disabled={isConfirming || isRejecting}
                            >
                                {isConfirming ? '…' : '入帳'}
                            </button>
                            <button
                                className="btn btn-secondary"
                                style={{ padding: '3px 10px', fontSize: '0.75rem', minHeight: '28px' }}
                                onClick={() => onReject(id)}
                                disabled={isConfirming || isRejecting}
                            >
                                {isRejecting ? '…' : '拒絕'}
                            </button>
                        </span>
                    )}
                    {status === 'rejected' && rejectReason && (
                        <span
                            style={{ fontSize: '0.72rem', color: 'var(--red)', cursor: 'default' }}
                            title={rejectReason}
                        >
                            {rejectReason.slice(0, 30)}{rejectReason.length > 30 ? '…' : ''}
                        </span>
                    )}
                </td>
            </tr>

            {/* Expandable warnings row */}
            {showWarnings && hasWarnings && (
                <tr style={{ background: 'var(--orange-bg)' }}>
                    <td colSpan={5} style={{ padding: '6px 10px 6px 20px', fontSize: '0.75rem', color: 'var(--orange)' }}>
                        <strong>原文：</strong>
                        <span style={{ color: 'var(--text-secondary)', fontStyle: 'italic' }}>
                            {sourceText.slice(0, 80)}{sourceText.length > 80 ? '…' : ''}
                        </span>
                        <span style={{ margin: '0 8px', color: 'var(--separator-opaque)' }}>|</span>
                        <strong>AI 判斷：</strong>
                        <span style={{ color: 'var(--text-secondary)' }}>{reason}</span>
                        {warnings.map((w, i) => (
                            <span key={i} style={{ marginLeft: '8px' }}>· ⚠ {w}</span>
                        ))}
                    </td>
                </tr>
            )}
        </>
    );
}

// ---------------------------------------------------------------------------
// Main AutomationTab — operational tool layout
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
    const [statusMsg, setStatusMsg] = useState(null); // { text, isError }

    const showStatus = useCallback((text, isError = false) => {
        setStatusMsg({ text, isError });
        setTimeout(() => setStatusMsg(null), 4000);
    }, []);

    const handleIngest = useCallback(async () => {
        if (!text.trim()) return;
        setLoading(true);
        setParseErrors([]);
        setStatusMsg(null);
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

            const a = data.applied.length, p = data.pending.length, r = data.rejected.length;
            const parts = [];
            if (a > 0) parts.push(`${a} 筆已入帳`);
            if (p > 0) parts.push(`${p} 筆待覆核`);
            if (r > 0) parts.push(`${r} 筆已擋下`);
            showStatus(parts.length > 0 ? parts.join('，') : '解析完成（無有效事件）', r > 0 && a === 0 && p === 0);

            if (data.applied.length > 0 && onDataChange) onDataChange();
        } catch (err) {
            showStatus(err.message, true);
        } finally {
            setLoading(false);
        }
    }, [text, mode, onDataChange, showStatus]);

    const handleConfirm = useCallback(async (proposalId) => {
        setConfirmingId(proposalId);
        try {
            const res = await fetch(`/api/automation/confirm/${proposalId}`, {
                method: 'POST',
                credentials: 'include',
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || '入帳失敗');
            setProposals(prev => prev.map(p => p.id === proposalId ? { ...p, ...data.proposal } : p));
            showStatus('已手動入帳');
            if (onDataChange) onDataChange();
        } catch (err) {
            showStatus(err.message, true);
        } finally {
            setConfirmingId(null);
        }
    }, [onDataChange, showStatus]);

    const handleReject = useCallback(async (proposalId) => {
        setRejectingId(proposalId);
        try {
            const res = await fetch(`/api/automation/reject/${proposalId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ reason: '手動拒絕' }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || '拒絕失敗');
            setProposals(prev => prev.map(p => p.id === proposalId ? { ...p, ...data.proposal } : p));
            showStatus('已擋下');
        } catch (err) {
            showStatus(err.message, true);
        } finally {
            setRejectingId(null);
        }
    }, [showStatus]);

    const filteredProposals = proposals.filter(p =>
        activeFilter === 'all' || p.status === activeFilter
    );

    const counts = {
        all: proposals.length,
        applied: proposals.filter(p => p.status === 'applied').length,
        pending: proposals.filter(p => p.status === 'pending').length,
        rejected: proposals.filter(p => p.status === 'rejected').length,
    };

    return (
        <div style={{ display: 'flex', gap: '1.5rem', alignItems: 'flex-start' }}>
            {/* ── Left Panel: Input ── */}
            <div style={{
                flexShrink: 0,
                width: '260px',
                display: 'flex',
                flexDirection: 'column',
                gap: '0.75rem',
            }}>
                <div className="ledger-panel" style={{ padding: '1rem' }}>
                    <div style={{ marginBottom: '0.6rem' }}>
                        <label style={{
                            display: 'block',
                            fontSize: '0.7rem',
                            fontWeight: 600,
                            color: 'var(--text-tertiary)',
                            textTransform: 'uppercase',
                            letterSpacing: '0.04em',
                            marginBottom: '0.4rem',
                        }}>
                            帳務文字
                        </label>
                        <textarea
                            value={text}
                            onChange={e => setText(e.target.value)}
                            placeholder={'例如：\n王小明 轉 270\n幫李小明 6 月起加 Netflix\n張大明 額外加帳 50 網域費'}
                            rows={6}
                            style={{
                                width: '100%',
                                boxSizing: 'border-box',
                                background: 'var(--bg-tertiary)',
                                border: '1px solid var(--separator-opaque)',
                                borderRadius: 'var(--radius-sm)',
                                color: 'var(--text-primary)',
                                padding: '8px 10px',
                                fontSize: '0.82rem',
                                lineHeight: 1.55,
                                resize: 'vertical',
                                outline: 'none',
                                fontFamily: 'var(--font-family)',
                            }}
                            onFocus={e => e.target.style.borderColor = 'var(--blue)'}
                            onBlur={e => e.target.style.borderColor = 'var(--separator-opaque)'}
                        />
                    </div>

                    {/* Mode selector */}
                    <div style={{ marginBottom: '0.75rem', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                        {[
                            { value: 'auto', label: '自動入帳（高信心）' },
                            { value: 'review', label: '全部待覆核' },
                        ].map(opt => (
                            <label key={opt.value} style={{
                                display: 'flex', alignItems: 'center', gap: '6px',
                                fontSize: '0.78rem', color: 'var(--text-secondary)', cursor: 'pointer',
                            }}>
                                <input
                                    type="radio"
                                    name="ingest-mode"
                                    value={opt.value}
                                    checked={mode === opt.value}
                                    onChange={() => setMode(opt.value)}
                                    style={{ accentColor: 'var(--blue)' }}
                                />
                                {opt.label}
                            </label>
                        ))}
                    </div>

                    <button
                        className="btn btn-primary"
                        style={{ width: '100%' }}
                        onClick={handleIngest}
                        disabled={loading || !text.trim()}
                    >
                        {loading ? '解析中…' : '解析並入帳'}
                    </button>
                </div>

                {/* Status message */}
                {statusMsg && (
                    <div style={{
                        padding: '8px 12px',
                        borderRadius: 'var(--radius-sm)',
                        fontSize: '0.78rem',
                        color: statusMsg.isError ? 'var(--red)' : 'var(--green)',
                        background: statusMsg.isError ? 'var(--red-bg)' : 'var(--green-bg)',
                        border: `1px solid ${statusMsg.isError ? 'rgba(255,59,48,0.2)' : 'rgba(52,199,89,0.2)'}`,
                    }}>
                        {statusMsg.text}
                    </div>
                )}

                {/* Parse errors */}
                {parseErrors.length > 0 && (
                    <div style={{
                        padding: '8px 12px',
                        borderRadius: 'var(--radius-sm)',
                        fontSize: '0.75rem',
                        color: 'var(--orange)',
                        background: 'var(--orange-bg)',
                        border: '1px solid rgba(255,149,0,0.2)',
                    }}>
                        <div style={{ fontWeight: 600, marginBottom: '4px' }}>解析警告</div>
                        {parseErrors.map((e, i) => <div key={i}>· {e}</div>)}
                    </div>
                )}
            </div>

            {/* ── Right Panel: Queue table ── */}
            <div style={{ flexGrow: 1, minWidth: 0 }}>
                {/* Filter tabs */}
                {proposals.length > 0 && (
                    <div style={{ display: 'flex', gap: '4px', marginBottom: '0.75rem', flexWrap: 'wrap' }}>
                        {[
                            { key: 'all', label: '全部' },
                            { key: 'applied', label: '已入帳' },
                            { key: 'pending', label: '待覆核' },
                            { key: 'rejected', label: '已擋下' },
                        ].map(({ key, label }) => {
                            const isActive = activeFilter === key;
                            return (
                                <button
                                    key={key}
                                    onClick={() => setActiveFilter(key)}
                                    style={{
                                        padding: '4px 12px',
                                        borderRadius: 'var(--radius-sm)',
                                        fontSize: '0.78rem',
                                        fontWeight: isActive ? 600 : 400,
                                        border: '1px solid',
                                        borderColor: isActive ? 'var(--blue)' : 'var(--separator-opaque)',
                                        background: isActive ? 'var(--blue-bg)' : 'var(--bg-tertiary)',
                                        color: isActive ? 'var(--blue)' : 'var(--text-secondary)',
                                        cursor: 'pointer',
                                        transition: 'var(--transition)',
                                    }}
                                >
                                    {label}
                                    {counts[key] > 0 && (
                                        <span style={{
                                            marginLeft: '4px', fontSize: '0.68rem',
                                            color: isActive ? 'var(--blue)' : 'var(--text-tertiary)',
                                        }}>
                                            {counts[key]}
                                        </span>
                                    )}
                                </button>
                            );
                        })}
                    </div>
                )}

                {/* Proposal table */}
                {filteredProposals.length > 0 ? (
                    <div className="table-container" style={{ overflowX: 'auto' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                            <thead>
                                <tr style={{ borderBottom: '1px solid var(--separator-opaque)' }}>
                                    {['類型', '說明', '信心', '狀態', 'Ledger / 操作'].map(h => (
                                        <th key={h} style={{
                                            padding: '6px 10px',
                                            textAlign: h === '信心' ? 'right' : 'left',
                                            fontSize: '0.7rem',
                                            fontWeight: 600,
                                            color: 'var(--text-tertiary)',
                                            textTransform: 'uppercase',
                                            letterSpacing: '0.04em',
                                            whiteSpace: 'nowrap',
                                        }}>
                                            {h}
                                        </th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {filteredProposals.map(p => (
                                    <ProposalRow
                                        key={p.id}
                                        proposal={p}
                                        onConfirm={handleConfirm}
                                        onReject={handleReject}
                                        confirmingId={confirmingId}
                                        rejectingId={rejectingId}
                                    />
                                ))}
                            </tbody>
                        </table>
                    </div>
                ) : proposals.length === 0 ? (
                    /* Empty state */
                    <div className="table-container" style={{ padding: '2.5rem', textAlign: 'center' }}>
                        <p style={{ color: 'var(--text-tertiary)', fontSize: '0.85rem' }}>
                            輸入帳務文字後，AI 解析結果會在此顯示
                        </p>
                        <p style={{ color: 'var(--text-tertiary)', fontSize: '0.75rem', marginTop: '0.5rem' }}>
                            信心 ≥ 90% 且通過驗證的紀錄會自動入帳；其餘進待覆核佇列
                        </p>
                    </div>
                ) : (
                    <div className="table-container" style={{ padding: '1.5rem', textAlign: 'center' }}>
                        <p style={{ color: 'var(--text-tertiary)', fontSize: '0.85rem' }}>此篩選條件無資料</p>
                    </div>
                )}
            </div>
        </div>
    );
}
