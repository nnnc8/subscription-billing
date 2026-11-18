import { useCallback, useEffect, useState } from 'react';
import type {
    ApiFetch,
    AutomationIngestResult,
    AutomationProposal,
    ProposalKind,
    ProposalStatus,
} from '../types/billing.js';

type IngestMode = 'auto' | 'review';
type AutomationFilter = 'all' | ProposalStatus;

interface AutomationTabProps {
    active: boolean;
    apiFetch: ApiFetch;
    onDataChange: () => void | Promise<void>;
}

interface StatusMessage {
    text: string;
    isError: boolean;
}

type AutomationIngestResponse = Partial<AutomationIngestResult> & { error?: string };
interface AutomationActionResponse {
    error?: string;
    proposal?: AutomationProposal;
}

const STATUS_CONFIG: Record<ProposalStatus, { label: string; tone: string }> = {
    applied: { label: '已入帳', tone: 'pos' },
    pending: { label: '待覆核', tone: 'warn' },
    rejected: { label: '已擋下', tone: 'neg' },
};

const KIND_LABEL: Record<ProposalKind, string> = {
    payment: '付款',
    subscription: '訂閱',
    tempCharge: '加帳',
};

const MODE_OPTIONS: ReadonlyArray<{ value: IngestMode; label: string }> = [
    { value: 'auto', label: '自動入帳（高信心）' },
    { value: 'review', label: '全部待覆核' },
];

const FILTER_OPTIONS: ReadonlyArray<{ key: AutomationFilter; label: string }> = [
    { key: 'all', label: '全部' },
    { key: 'applied', label: '已入帳' },
    { key: 'pending', label: '待覆核' },
    { key: 'rejected', label: '已擋下' },
];

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function StatusChip({ status }: { status: ProposalStatus }) {
    const c = STATUS_CONFIG[status];
    return <span className={`pill ${c.tone}`}>{c.label}</span>;
}

// Below 70% the parse is shaky enough that the operator should read the source line.
function ConfidenceCell({ score }: { score: number }) {
    const pct = Math.round(score * 100);
    return <span className={pct < 70 ? 'low-confidence' : undefined}>{pct}%</span>;
}

function PayloadDesc({ kind, payload }: { kind: ProposalKind; payload: Record<string, unknown> }) {
    const memberName = typeof payload.memberName === 'string' ? payload.memberName : '';
    const amount = typeof payload.amount === 'number' ? payload.amount : null;
    const date = typeof payload.date === 'string' ? payload.date : '';
    const description = typeof payload.desc === 'string' ? payload.desc : '';
    const platformName = typeof payload.platformName === 'string' ? payload.platformName : '';
    const startMonth = typeof payload.startMonth === 'string' ? payload.startMonth : '';

    if (kind === 'payment') {
        return <span className="proposal-desc"><strong>{memberName}{amount != null && ` 付款 $${amount}`}</strong>{date && <span className="sub">{date}</span>}</span>;
    }
    if (kind === 'tempCharge') {
        return <span className="proposal-desc"><strong>{memberName}{amount != null && ` 加帳 $${amount}`}</strong>{description && <span className="sub">{description}</span>}</span>;
    }
    if (kind === 'subscription') {
        return <span className="proposal-desc"><strong>{memberName}{platformName && ` 加入 ${platformName}`}</strong>{startMonth && <span className="sub">{startMonth} 起算</span>}</span>;
    }
    return <span className="proposal-desc"><span className="sub">{JSON.stringify(payload).slice(0, 40)}</span></span>;
}

interface ProposalRowProps {
    proposal: AutomationProposal;
    onConfirm: (proposalId: string) => Promise<void>;
    onReject: (proposalId: string) => Promise<void>;
    confirmingId: string | null;
    rejectingId: string | null;
}

function ProposalRow({ proposal, onConfirm, onReject, confirmingId, rejectingId }: ProposalRowProps) {
    const [showDetail, setShowDetail] = useState(false);
    const { id, kind, sourceText, confidence, reason, warnings, payload, status, rejectReason, ledgerEventId } = proposal;
    const isConfirming = confirmingId === id;
    const isRejecting = rejectingId === id;

    return (
        <>
            <tr>
                <td>{KIND_LABEL[kind]}</td>
                <td>
                    <PayloadDesc kind={kind} payload={payload} />
                    <button type="button" className="link-btn" onClick={() => setShowDetail(v => !v)} aria-expanded={showDetail}>
                        {warnings.length > 0 ? `${warnings.length} 則警告` : '原文與判斷'}
                    </button>
                </td>
                <td className="n"><ConfidenceCell score={confidence} /></td>
                <td><StatusChip status={status} /></td>
                <td className="n">
                    {status === 'applied' && ledgerEventId && (
                        <button
                            type="button"
                            className="link-btn"
                            aria-label={`複製 Ledger event ${ledgerEventId}`}
                            title={`Ledger event: ${ledgerEventId}`}
                            onClick={() => { void navigator.clipboard?.writeText(ledgerEventId); }}
                        >
                            {ledgerEventId.slice(0, 12)}
                        </button>
                    )}
                    {status === 'pending' && (
                        <span className="row-actions">
                            <button type="button" className="btn btn-primary" onClick={() => { void onConfirm(id); }} disabled={isConfirming || isRejecting}>
                                {isConfirming ? '入帳中…' : '入帳'}
                            </button>
                            <button type="button" className="btn" onClick={() => { void onReject(id); }} disabled={isConfirming || isRejecting}>
                                {isRejecting ? '處理中…' : '拒絕'}
                            </button>
                        </span>
                    )}
                    {status === 'rejected' && rejectReason && (
                        <span className="danger-text" title={rejectReason}>
                            {rejectReason.slice(0, 30)}{rejectReason.length > 30 ? '…' : ''}
                        </span>
                    )}
                </td>
            </tr>
            {showDetail && (
                <tr className="proposal-note">
                    <td />
                    <td colSpan={4}>
                        <p>原文：{sourceText.slice(0, 80)}{sourceText.length > 80 ? '…' : ''}</p>
                        <p>AI 判斷：{reason}</p>
                        {warnings.map((w, i) => <p key={i} className="danger-text">{w}</p>)}
                    </td>
                </tr>
            )}
        </>
    );
}

// ---------------------------------------------------------------------------
// Main AutomationTab — operational tool layout
// ---------------------------------------------------------------------------
export function AutomationTab({ active, apiFetch, onDataChange }: AutomationTabProps) {
    const [text, setText] = useState('');
    const [mode, setMode] = useState<IngestMode>('auto');
    const [loading, setLoading] = useState(false);
    const [proposals, setProposals] = useState<AutomationProposal[]>([]);
    const [parseErrors, setParseErrors] = useState<string[]>([]);
    const [activeFilter, setActiveFilter] = useState<AutomationFilter>('all');
    const [confirmingId, setConfirmingId] = useState<string | null>(null);
    const [rejectingId, setRejectingId] = useState<string | null>(null);
    const [statusMsg, setStatusMsg] = useState<StatusMessage | null>(null);

    const showStatus = useCallback((text: string, isError = false) => {
        setStatusMsg({ text, isError });
    }, []);

    useEffect(() => {
        if (!statusMsg) return undefined;
        const timer = window.setTimeout(() => setStatusMsg(null), 4000);
        return () => window.clearTimeout(timer);
    }, [statusMsg]);

    const handleIngest = useCallback(async () => {
        if (!active || !text.trim()) return;
        setLoading(true);
        setParseErrors([]);
        setStatusMsg(null);
        try {
            const res = await apiFetch('/automation/ingest', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: text.trim(), mode }),
            });
            const data = await res.json() as AutomationIngestResponse;
            if (!res.ok) throw new Error(data.error || '解析失敗');

            const applied = data.applied ?? [];
            const pending = data.pending ?? [];
            const rejected = data.rejected ?? [];
            const allNew = [...applied, ...pending, ...rejected];
            setProposals(prev => [...allNew, ...prev]);
            setParseErrors(data.parseErrors || []);

            const a = applied.length, p = pending.length, r = rejected.length;
            const parts: string[] = [];
            if (a > 0) parts.push(`${a} 筆已入帳`);
            if (p > 0) parts.push(`${p} 筆待覆核`);
            if (r > 0) parts.push(`${r} 筆已擋下`);
            showStatus(parts.length > 0 ? parts.join('，') : '解析完成（無有效事件）', r > 0 && a === 0 && p === 0);

            if (applied.length > 0) void onDataChange();
        } catch (err) {
            showStatus(getErrorMessage(err), true);
        } finally {
            setLoading(false);
        }
    }, [active, apiFetch, text, mode, onDataChange, showStatus]);

    const handleConfirm = useCallback(async (proposalId: string) => {
        if (!active) return;
        setConfirmingId(proposalId);
        try {
            const res = await apiFetch(`/automation/confirm/${proposalId}`, {
                method: 'POST',
            });
            const data = await res.json() as AutomationActionResponse;
            if (!res.ok) throw new Error(data.error || '入帳失敗');
            const updatedProposal = data.proposal;
            if (!updatedProposal) throw new Error('入帳回應缺少 proposal');
            setProposals(prev => prev.map(p => p.id === proposalId ? updatedProposal : p));
            showStatus('已手動入帳');
            void onDataChange();
        } catch (err) {
            showStatus(getErrorMessage(err), true);
        } finally {
            setConfirmingId(null);
        }
    }, [active, apiFetch, onDataChange, showStatus]);

    const handleReject = useCallback(async (proposalId: string) => {
        if (!active) return;
        setRejectingId(proposalId);
        try {
            const res = await apiFetch(`/automation/reject/${proposalId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ reason: '手動拒絕' }),
            });
            const data = await res.json() as AutomationActionResponse;
            if (!res.ok) throw new Error(data.error || '拒絕失敗');
            const updatedProposal = data.proposal;
            if (!updatedProposal) throw new Error('拒絕回應缺少 proposal');
            setProposals(prev => prev.map(p => p.id === proposalId ? updatedProposal : p));
            showStatus('已擋下');
        } catch (err) {
            showStatus(getErrorMessage(err), true);
        } finally {
            setRejectingId(null);
        }
    }, [active, apiFetch, showStatus]);

    const filteredProposals = proposals.filter(p =>
        activeFilter === 'all' || p.status === activeFilter
    );

    const counts: Record<AutomationFilter, number> = {
        all: proposals.length,
        applied: proposals.filter(p => p.status === 'applied').length,
        pending: proposals.filter(p => p.status === 'pending').length,
        rejected: proposals.filter(p => p.status === 'rejected').length,
    };

    return (
        <article className="card automation">
            <header className="card-head">
                <div>
                    <h2>文字入帳</h2>
                    <p className="meta">貼上轉帳通知或對話，解析成收款、加帳或名額變更。</p>
                </div>
            </header>

            <div className="automation-input">
                <label htmlFor="automation-text" className="field-label">帳務文字</label>
                <textarea
                    id="automation-text"
                    className="input"
                    value={text}
                    onChange={e => setText(e.target.value)}
                    placeholder={'例如：\n王小明 轉 270\n幫李小明 6 月起加 Netflix\n張大明 額外加帳 50 網域費'}
                    rows={4}
                />
                <div className="automation-submit">
                    <div className="mode-options" role="radiogroup" aria-label="入帳方式">
                        {MODE_OPTIONS.map(opt => (
                            <label key={opt.value}>
                                <input
                                    type="radio"
                                    name="ingest-mode"
                                    value={opt.value}
                                    checked={mode === opt.value}
                                    onChange={() => setMode(opt.value)}
                                />
                                {opt.label}
                            </label>
                        ))}
                    </div>
                    <button type="button" className="btn btn-primary" onClick={handleIngest} disabled={loading || !text.trim()}>
                        {loading ? '解析中…' : '解析並入帳'}
                    </button>
                </div>
            </div>

            {statusMsg && (
                <div role={statusMsg.isError ? 'alert' : 'status'} className={`notice ${statusMsg.isError ? 'bad' : 'ok'}`}>
                    {statusMsg.text}
                </div>
            )}

            {parseErrors.length > 0 && (
                <div role="alert" className="notice warn">
                    <strong>解析警告</strong>
                    <ul>{parseErrors.map((e, i) => <li key={i}>{e}</li>)}</ul>
                </div>
            )}

            <div>
                {proposals.length > 0 && (
                    <div className="segmented" role="group" aria-label="篩選解析結果">
                        {FILTER_OPTIONS.map(({ key, label }) => (
                            <button key={key} type="button" aria-pressed={activeFilter === key} onClick={() => setActiveFilter(key)}>
                                {label}
                                {counts[key] > 0 && <span className="count">{counts[key]}</span>}
                            </button>
                        ))}
                    </div>
                )}

                {filteredProposals.length > 0 ? (
                    <div className="table-wrap">
                        <table>
                            <thead>
                                <tr><th>類型</th><th>內容</th><th className="n">信心</th><th>狀態</th><th className="n">事件／操作</th></tr>
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
                    <p className="empty">解析結果會出現在這裡。信心 90% 以上且通過檢查的紀錄會直接入帳，其餘等你覆核。</p>
                ) : (
                    <p className="empty">這個篩選條件下沒有資料。</p>
                )}
            </div>
        </article>
    );
}
