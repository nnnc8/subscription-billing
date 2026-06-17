/**
 * lib/automation.ts
 *
 * Tagtoo GenAI Demo — AI Automation Layer
 *
 * Responsibilities:
 *   1. parseProposalsFromText()  — Gemini function calling → structured proposals
 *   2. validateProposal()        — deterministic checks (member lookup, amount, duplicate)
 *   3. classifyProposals()       — confidence + validation → applied / pending / rejected
 *   4. applyProposal()           — calls existing DB helpers (payment / subscription / tempCharge)
 *
 * AI NEVER directly writes to DB. All real writes go through the deterministic layer.
 */

import crypto from 'node:crypto';
import {
    findRecentDuplicateTransaction,
    resolveMember,
    MONTH_RE,
    appendLedgerEvent,
    isSubActiveInMonth,
} from './accounting.js';
import type {
    Database,
    AutomationProposal,
    AutomationIngestResult,
    ProposalKind,
    Payment,
    TempCharge,
    Subscription,
} from '../src/types/billing.js';

// ---------------------------------------------------------------------------
// Gemini Function-Calling Schema
// ---------------------------------------------------------------------------

const RECORD_BILLING_EVENTS_TOOL = {
    name: 'record_billing_events',
    description:
        '將一段自然語言帳務文字解析為一組結構化帳務事件列表。每個事件對應一筆付款、一筆訂閱新增/異動或一筆臨時加帳。',
    parameters: {
        type: 'object',
        properties: {
            events: {
                type: 'array',
                description: '解析出的帳務事件列表，可能包含多筆',
                items: {
                    type: 'object',
                    properties: {
                        kind: {
                            type: 'string',
                            enum: ['payment', 'subscription', 'tempCharge'],
                            description: 'payment=收款; subscription=訂閱異動; tempCharge=臨時加帳',
                        },
                        memberName: {
                            type: 'string',
                            description: '成員姓名（中文或英文，如「王小明」或「Member Alpha」）',
                        },
                        platformName: {
                            type: 'string',
                            description: '訂閱平台名稱（如 Netflix、Spotify），subscription/tempCharge 類別時使用',
                        },
                        amount: {
                            type: 'number',
                            description: '金額（新台幣，正整數）',
                        },
                        date: {
                            type: 'string',
                            description: '日期，格式 YYYY-MM-DD，若未提及則省略',
                        },
                        month: {
                            type: 'string',
                            description: '帳期月份，格式 YYYY/MM，如 2026/06，用於 subscription startMonth',
                        },
                        note: {
                            type: 'string',
                            description: '備註說明（可省略）',
                        },
                        confidence: {
                            type: 'number',
                            description: '解析信心分數 0.0-1.0；有模糊姓名/未知平台/缺金額時應低於 0.8',
                        },
                        reason: {
                            type: 'string',
                            description: '簡短解釋為何如此判斷（繁體中文）',
                        },
                        warnings: {
                            type: 'array',
                            items: { type: 'string' },
                            description: '潛在風險或模糊點，如「姓名可能有多個匹配」',
                        },
                    },
                    required: ['kind', 'memberName', 'confidence', 'reason'],
                },
            },
            parseErrors: {
                type: 'array',
                items: { type: 'string' },
                description: '無法解析的片段或錯誤說明',
            },
        },
        required: ['events'],
    },
} as const;

// ---------------------------------------------------------------------------
// Types for Gemini raw response
// ---------------------------------------------------------------------------

interface RawGeminiEvent {
    kind?: string;
    memberName?: string;
    platformName?: string;
    amount?: number;
    date?: string;
    month?: string;
    note?: string;
    confidence?: number;
    reason?: string;
    warnings?: string[];
}

interface GeminiParsePart {
    functionCall?: {
        name: string;
        args: Record<string, unknown>;
    };
    text?: string;
}

interface GeminiParseResponse {
    candidates?: Array<{
        content?: {
            parts?: GeminiParsePart[];
        };
        finishReason?: string;
    }>;
}

// ---------------------------------------------------------------------------
// Gemini Caller
// ---------------------------------------------------------------------------

async function callGeminiForParsing(text: string, apiKey: string): Promise<{
    events: RawGeminiEvent[];
    parseErrors: string[];
}> {
    const model = (process.env.AI_MODEL || 'gemini-2.0-flash').replace(/^@vertex-ai\//, '').replace(/^google\//, '');
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const systemInstruction = {
        parts: [{
            text: `你是一個帳務自動化解析引擎。你的工作是將使用者貼上的自然語言帳務紀錄，精確解析為結構化帳務事件，並呼叫 record_billing_events 工具回傳結果。

解析規則：
1. 「王小明 轉 270」→ payment，memberName=王小明, amount=270
2. 「幫李小明 6 月開始加 Netflix」→ subscription，memberName=李小明, platformName=Netflix, month=2026/06
3. 「張大明 這個月額外收 50 網域費」→ tempCharge，memberName=張大明, amount=50, note=網域費
4. 如果姓名、平台、金額任一模糊，confidence 應 < 0.8，並在 warnings 說明原因
5. 今年是 ${new Date().getFullYear()} 年，目前月份是 ${new Date().toISOString().slice(0, 7).replace('-', '/')}
6. 一定要呼叫 record_billing_events 工具，不要只用文字回應`
        }]
    };

    const body = {
        systemInstruction,
        contents: [{ role: 'user', parts: [{ text }] }],
        tools: [{ functionDeclarations: [RECORD_BILLING_EVENTS_TOOL] }],
        toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['record_billing_events'] } },
        generationConfig: { temperature: 0.1, maxOutputTokens: 2000 },
    };

    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });

    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Gemini API error ${res.status}: ${errText.slice(0, 200)}`);
    }

    const data = (await res.json()) as GeminiParseResponse;
    const candidate = data.candidates?.[0];
    if (!candidate?.content?.parts) {
        throw new Error('Gemini 回傳格式異常：無有效 candidate');
    }

    const funcCallPart = candidate.content.parts.find(p => p.functionCall?.name === 'record_billing_events');
    if (!funcCallPart?.functionCall) {
        // Gemini might return text only in edge cases
        const textReply = candidate.content.parts.find(p => p.text)?.text || '';
        throw new Error(`Gemini 未呼叫 function tool，文字回應：${textReply.slice(0, 200)}`);
    }

    const args = funcCallPart.functionCall.args as { events?: RawGeminiEvent[]; parseErrors?: string[] };
    return {
        events: Array.isArray(args.events) ? args.events : [],
        parseErrors: Array.isArray(args.parseErrors) ? args.parseErrors : [],
    };
}

// ---------------------------------------------------------------------------
// Deterministic Validation
// ---------------------------------------------------------------------------

export interface ValidationResult {
    ok: boolean;
    blockReasons: string[];    // hard fail → rejected
    warnings: string[];        // soft warn → stays pending or lowers confidence
    resolvedMemberId?: string;
    resolvedMemberName?: string;
}

export function validateProposal(
    raw: RawGeminiEvent,
    db: Database,
    createdAt: string
): ValidationResult {
    const blockReasons: string[] = [];
    const warnings: string[] = [];

    // --- Member resolution ---
    const memberName = (raw.memberName || '').trim();
    if (!memberName) {
        blockReasons.push('缺少成員姓名');
    } else {
        const exactMatch = db.members.find(
            m => m.name === memberName || m.id === memberName
        );
        const fuzzyMatches = db.members.filter(
            m => m.name.toLowerCase().includes(memberName.toLowerCase()) ||
                 memberName.toLowerCase().includes(m.name.toLowerCase())
        );

        if (!exactMatch && fuzzyMatches.length === 0) {
            blockReasons.push(`找不到成員：「${memberName}」`);
        } else if (!exactMatch && fuzzyMatches.length > 1) {
            warnings.push(`「${memberName}」模糊匹配到多個成員：${fuzzyMatches.map(m => m.name).join('、')}`);
        } else if (!exactMatch && fuzzyMatches.length === 1) {
            warnings.push(`以「${fuzzyMatches[0].name}」代入（原文：${memberName}）`);
        }
    }

    // --- Kind-specific checks ---
    const kind = raw.kind as ProposalKind | undefined;

    if (kind === 'payment' || kind === 'tempCharge') {
        if (raw.amount === undefined || raw.amount === null) {
            blockReasons.push('缺少金額');
        } else if (!Number.isFinite(raw.amount) || raw.amount <= 0) {
            blockReasons.push(`金額不合法：${raw.amount}`);
        }
    }

    if (kind === 'subscription') {
        if (!raw.platformName) {
            blockReasons.push('缺少平台名稱');
        } else {
            const platform = db.platforms.find(
                p => p.name === raw.platformName ||
                     p.name.toLowerCase().includes((raw.platformName || '').toLowerCase())
            );
            if (!platform) {
                blockReasons.push(`找不到平台：「${raw.platformName}」`);
            }
        }
        if (raw.month && !MONTH_RE.test(raw.month)) {
            blockReasons.push(`月份格式不合法：${raw.month}（應為 YYYY/MM）`);
        }
    }

    // --- Date format check ---
    if (raw.date) {
        const dateRe = /^\d{4}-\d{2}-\d{2}$/;
        if (!dateRe.test(raw.date)) {
            warnings.push(`日期格式可能有誤：${raw.date}`);
        }
    }

    // --- Duplicate check for payment/tempCharge ---
    if (kind === 'payment' && blockReasons.length === 0 && raw.amount) {
        const member = db.members.find(m => m.name === memberName || m.name.toLowerCase().includes(memberName.toLowerCase()));
        if (member) {
            const candidatePayment: Partial<Payment> = {
                memberId: member.id,
                memberName: member.name,
                amount: raw.amount,
                date: raw.date || new Date().toISOString().split('T')[0],
                method: '轉帳',
                note: raw.note || '',
                createdAt,
            };
            const dup = findRecentDuplicateTransaction(db.payments, candidatePayment as Payment, { type: 'payment' });
            if (dup) {
                blockReasons.push(`疑似重複付款：10 分鐘內已有 ${member.name} 相同金額 $${raw.amount} 的付款紀錄`);
            }
        }
    }

    if (kind === 'tempCharge' && blockReasons.length === 0 && raw.amount) {
        const member = db.members.find(m => m.name === memberName || m.name.toLowerCase().includes(memberName.toLowerCase()));
        if (member) {
            const candidateCharge: Partial<TempCharge> = {
                memberId: member.id,
                memberName: member.name,
                amount: raw.amount,
                date: raw.date || new Date().toISOString().split('T')[0],
                desc: raw.note || '',
                createdAt,
            };
            const dup = findRecentDuplicateTransaction(db.tempCharges, candidateCharge as TempCharge, { type: 'charge' });
            if (dup) {
                blockReasons.push(`疑似重複加帳：10 分鐘內已有相同加帳紀錄`);
            }
        }
    }

    // Resolve member id/name for payload
    const resolvedMember = resolveMember(db, { memberName }) ||
        db.members.find(m => m.name.toLowerCase().includes(memberName.toLowerCase()));

    return {
        ok: blockReasons.length === 0,
        blockReasons,
        warnings: [...(raw.warnings || []), ...warnings],
        resolvedMemberId: resolvedMember?.id,
        resolvedMemberName: resolvedMember?.name,
    };
}

// ---------------------------------------------------------------------------
// Proposal Builder
// ---------------------------------------------------------------------------

function buildProposal(
    raw: RawGeminiEvent,
    validation: ValidationResult,
    db: Database,
    sourceText: string,
    createdAt: string
): AutomationProposal {
    const id = `prop_${crypto.randomUUID().slice(0, 12)}`;
    const kind = (raw.kind || 'payment') as ProposalKind;

    // Build payload with resolved IDs
    const payload: Record<string, unknown> = {};
    const memberName = validation.resolvedMemberName || raw.memberName || '';
    const memberId = validation.resolvedMemberId;

    if (memberId) payload.memberId = memberId;
    if (memberName) payload.memberName = memberName;

    if (kind === 'payment') {
        payload.amount = raw.amount;
        payload.date = raw.date || new Date().toISOString().split('T')[0];
        payload.method = '轉帳';
        payload.note = raw.note || '';
        payload.cycle = (db.currentMonth || '').replace('/', '');
    }

    if (kind === 'tempCharge') {
        payload.amount = raw.amount;
        payload.date = raw.date || new Date().toISOString().split('T')[0];
        payload.desc = raw.note || raw.platformName || '';
    }

    if (kind === 'subscription') {
        const platform = db.platforms.find(
            p => p.name === raw.platformName ||
                 p.name.toLowerCase().includes((raw.platformName || '').toLowerCase())
        );
        if (platform) {
            payload.platformId = platform.id;
            payload.platformName = platform.name;
        } else {
            payload.platformName = raw.platformName || '';
        }
        payload.startMonth = raw.month || db.currentMonth;
    }

    return {
        id,
        kind,
        sourceText,
        confidence: typeof raw.confidence === 'number' ? Math.max(0, Math.min(1, raw.confidence)) : 0.5,
        reason: raw.reason || '自動解析',
        warnings: validation.warnings,
        payload,
        status: 'pending',
        createdAt,
    };
}

// ---------------------------------------------------------------------------
// Classifier (deterministic)
// ---------------------------------------------------------------------------

const AUTO_APPLY_CONFIDENCE_THRESHOLD = 0.9;

export function classifyProposalForAutoApply(
    proposal: AutomationProposal,
    validation: ValidationResult
): 'apply' | 'pending' | 'reject' {
    if (!validation.ok) return 'reject';
    if (proposal.confidence < AUTO_APPLY_CONFIDENCE_THRESHOLD) return 'pending';
    if (validation.warnings.length > 0) return 'pending'; // any soft warning → human review
    return 'apply';
}

// ---------------------------------------------------------------------------
// Apply Proposal (internal DB write — calls existing accounting helpers)
// ---------------------------------------------------------------------------

export interface ApplyResult {
    ok: boolean;
    error?: string;
    ledgerEventId?: string;
}

export function applyPaymentProposal(
    proposal: AutomationProposal,
    db: Database
): ApplyResult {
    try {
        const { memberId, memberName, amount, date, method, cycle, note } = proposal.payload as Record<string, unknown>;
        if (!memberId && !memberName) return { ok: false, error: '缺少成員資訊' };
        if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
            return { ok: false, error: '金額不合法' };
        }

        const member = resolveMember(db, { memberId: memberId as string, memberName: memberName as string });
        if (!member) return { ok: false, error: `找不到成員：${memberName}` };

        const now = new Date().toISOString();
        const newPayment: Payment = {
            id: `pay_${crypto.randomUUID().slice(0, 8)}`,
            memberId: member.id,
            memberName: member.name,
            date: (date as string) || now.split('T')[0],
            amount: amount as number,
            method: (method as string) || '轉帳',
            cycle: (cycle as string) || (db.currentMonth || '').replace('/', ''),
            note: (note as string) || '',
            createdAt: now,
        };

        // Double-check duplicate before writing
        const dup = findRecentDuplicateTransaction(db.payments, newPayment, { type: 'payment' });
        if (dup) return { ok: false, error: '疑似重複付款（套用時再次確認）' };

        db.payments.push(newPayment);
        const event = appendLedgerEvent(db, {
            type: 'payment.created',
            summary: `[AI自動] ${member.name} 付款 ${amount}（原文：${proposal.sourceText.slice(0, 40)}）`,
            entityType: 'payment',
            entityId: newPayment.id,
            amount: newPayment.amount,
            payload: {
                automationProposalId: proposal.id,
                memberId: member.id,
                memberName: member.name,
                method: newPayment.method,
                date: newPayment.date,
                sourceText: proposal.sourceText,
            },
        });

        return { ok: true, ledgerEventId: event.id };
    } catch (err) {
        return { ok: false, error: (err as Error).message };
    }
}

export function applyTempChargeProposal(
    proposal: AutomationProposal,
    db: Database
): ApplyResult {
    try {
        const { memberId, memberName, amount, date, desc } = proposal.payload as Record<string, unknown>;
        if (!memberId && !memberName) return { ok: false, error: '缺少成員資訊' };
        if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
            return { ok: false, error: '金額不合法' };
        }

        const member = resolveMember(db, { memberId: memberId as string, memberName: memberName as string });
        if (!member) return { ok: false, error: `找不到成員：${memberName}` };

        const now = new Date().toISOString();
        const newCharge: TempCharge = {
            id: `chg_${crypto.randomUUID().slice(0, 8)}`,
            memberId: member.id,
            memberName: member.name,
            date: (date as string) || now.split('T')[0],
            amount: amount as number,
            desc: (desc as string) || '',
            createdAt: now,
        };

        const dup = findRecentDuplicateTransaction(db.tempCharges, newCharge, { type: 'charge' });
        if (dup) return { ok: false, error: '疑似重複加帳（套用時再次確認）' };

        db.tempCharges.push(newCharge);
        const event = appendLedgerEvent(db, {
            type: 'charge.created',
            summary: `[AI自動] ${member.name} 加帳 ${amount}（原文：${proposal.sourceText.slice(0, 40)}）`,
            entityType: 'tempCharge',
            entityId: newCharge.id,
            amount: newCharge.amount,
            payload: {
                automationProposalId: proposal.id,
                memberId: member.id,
                memberName: member.name,
                desc: newCharge.desc,
                date: newCharge.date,
                sourceText: proposal.sourceText,
            },
        });

        return { ok: true, ledgerEventId: event.id };
    } catch (err) {
        return { ok: false, error: (err as Error).message };
    }
}

export function applySubscriptionProposal(
    proposal: AutomationProposal,
    db: Database
): ApplyResult {
    try {
        const { memberId, memberName, platformId, platformName, startMonth } = proposal.payload as Record<string, unknown>;
        if (!memberId && !memberName) return { ok: false, error: '缺少成員資訊' };
        if (!platformId && !platformName) return { ok: false, error: '缺少平台資訊' };

        const member = resolveMember(db, { memberId: memberId as string, memberName: memberName as string });
        if (!member) return { ok: false, error: `找不到成員：${memberName}` };

        const platform = db.platforms.find(
            p => (platformId && p.id === platformId) || p.name === platformName
        );
        if (!platform) return { ok: false, error: `找不到平台：${platformName}` };

        const month = (startMonth as string) || db.currentMonth;
        if (!MONTH_RE.test(month)) return { ok: false, error: `月份格式不合法：${month}` };

        // Check if already subscribed in this month
        const existingSub = db.subscriptions.find(
            s => (s.memberId === member.id || s.memberName === member.name) &&
                 (s.platformId === platform.id || s.platformName === platform.name) &&
                 isSubActiveInMonth(s, month)
        );
        if (existingSub) {
            return { ok: false, error: `${member.name} 在 ${month} 已有 ${platform.name} 的訂閱` };
        }

        const newSub: Subscription = {
            id: `s_${crypto.randomUUID().slice(0, 8)}`,
            memberId: member.id,
            platformId: platform.id,
            memberName: member.name,
            platformName: platform.name,
            startMonth: month,
        };

        db.subscriptions.push(newSub);
        const event = appendLedgerEvent(db, {
            type: 'subscription.created',
            summary: `[AI自動] ${member.name} 訂閱 ${platform.name} 從 ${month} 起（原文：${proposal.sourceText.slice(0, 40)}）`,
            entityType: 'subscription',
            entityId: newSub.id,
            payload: {
                automationProposalId: proposal.id,
                memberId: member.id,
                memberName: member.name,
                platformId: platform.id,
                platformName: platform.name,
                startMonth: month,
                sourceText: proposal.sourceText,
            },
        });

        return { ok: true, ledgerEventId: event.id };
    } catch (err) {
        return { ok: false, error: (err as Error).message };
    }
}

export function applyProposal(proposal: AutomationProposal, db: Database): ApplyResult {
    switch (proposal.kind) {
        case 'payment':
            return applyPaymentProposal(proposal, db);
        case 'tempCharge':
            return applyTempChargeProposal(proposal, db);
        case 'subscription':
            return applySubscriptionProposal(proposal, db);
        default:
            return { ok: false, error: `未知的事件類型：${proposal.kind}` };
    }
}

// ---------------------------------------------------------------------------
// Main Entry Point
// ---------------------------------------------------------------------------

export async function parseAndClassifyProposals(
    text: string,
    db: Database,
    apiKey: string,
    mode: 'auto' | 'review' = 'auto'
): Promise<AutomationIngestResult> {
    const createdAt = new Date().toISOString();
    const result: AutomationIngestResult = {
        applied: [],
        pending: [],
        rejected: [],
        parseErrors: [],
    };

    if (!apiKey) {
        result.parseErrors.push('未設定 GOOGLE_GEMINI_API_KEY，無法執行 AI 解析');
        return result;
    }

    // 1. Call Gemini for parsing
    let rawEvents: RawGeminiEvent[];
    let parseErrors: string[];
    try {
        const parsed = await callGeminiForParsing(text, apiKey);
        rawEvents = parsed.events;
        parseErrors = parsed.parseErrors;
    } catch (err) {
        result.parseErrors.push(`Gemini 解析失敗：${(err as Error).message}`);
        return result;
    }

    result.parseErrors.push(...parseErrors);

    // 2. Validate + classify each proposal
    for (const raw of rawEvents) {
        const validation = validateProposal(raw, db, createdAt);
        const proposal = buildProposal(raw, validation, db, text, createdAt);

        if (!validation.ok) {
            // Hard fail → rejected immediately (no DB write, not silent)
            proposal.status = 'rejected';
            proposal.rejectReason = validation.blockReasons.join('；');
            result.rejected.push(proposal);
            continue;
        }

        const decision = mode === 'review' ? 'pending' : classifyProposalForAutoApply(proposal, validation);

        if (decision === 'apply') {
            // Auto-apply: write to DB in-place (caller must call writeDB + invalidateRAGIndex)
            const applyResult = applyProposal(proposal, db);
            if (applyResult.ok) {
                proposal.status = 'applied';
                proposal.appliedAt = new Date().toISOString();
                proposal.ledgerEventId = applyResult.ledgerEventId;
                result.applied.push(proposal);
            } else {
                // Apply failed → push to rejected with reason
                proposal.status = 'rejected';
                proposal.rejectReason = applyResult.error || '套用失敗';
                result.rejected.push(proposal);
            }
        } else {
            // pending — human review required
            proposal.status = 'pending';
            result.pending.push(proposal);
        }
    }

    return result;
}
