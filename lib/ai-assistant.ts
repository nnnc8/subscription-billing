import { z } from 'zod';
import { generateContent, isAIConfigured } from './ai.js';
import { queryRAG } from './rag.js';
import {
    calculateCurrentMonthBalances,
    findAccountingWarnings,
    getSystemSnapshot,
    getClosePreview,
    isMemberRecord
} from './accounting.js';
import type { Database } from '../src/types/billing.js';

const tools: Array<{
    type: string
    function: {
        name: string
        description: string
        parameters: Record<string, unknown>
    }
}> = [
    {
        type: 'function',
        function: {
            name: 'get_member_balance',
            description: '查詢特定成員在當前帳期的餘額、月分攤費、已繳金額及最終應收/應付帳款。',
            parameters: {
                type: 'object',
                properties: {
                    memberName: {
                        type: 'string',
                        description: '成員的名字 (例如: Member Alpha)'
                    }
                },
                required: ['memberName']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'get_member_history',
            description: '查詢特定成員的帳務歷史紀錄，包含最近付款紀錄、最近代墊費用及歷史月結摘要。',
            parameters: {
                type: 'object',
                properties: {
                    memberName: {
                        type: 'string',
                        description: '成員的名字 (例如: Member Beta)'
                    }
                },
                required: ['memberName']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'get_payment_records',
            description: '查詢系統內最近的付款匯款紀錄。可以過濾特定成員，若無指定則顯示全部。',
            parameters: {
                type: 'object',
                properties: {
                    memberName: {
                        type: 'string',
                        description: '可選：成員的名字'
                    }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'get_accounting_warnings',
            description: '查詢當前帳期中是否有任何會計警告或帳務異常（例如：前期餘額不符、重複付款等）。',
            parameters: {
                type: 'object',
                properties: {}
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'get_system_snapshot',
            description: '查詢系統帳務的整體概況（包含目前帳期、基礎帳期、成員數、訂閱服務數、備份狀態等）。',
            parameters: {
                type: 'object',
                properties: {}
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'get_close_preview',
            description: '取得當前帳期的月結（關帳）預覽報告，包含是否滿足關帳條件、阻擋關帳的關鍵問題等。',
            parameters: {
                type: 'object',
                properties: {}
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'get_subscription_impact',
            description: '查詢新增或變更某平台訂閱後，會影響哪些成員的費用以及費用如何變化。適合回答「新增訂閱影響誰」等問題。',
            parameters: {
                type: 'object',
                properties: {
                    platformName: {
                        type: 'string',
                        description: '平台名稱（例如：Netflix、Spotify）'
                    }
                },
                required: ['platformName']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'get_collection_priority',
            description: '取得本期催繳優先順序：依「應收金額高低」及「距上次付款天數」排序，告訴主辦人該先催誰。',
            parameters: {
                type: 'object',
                properties: {}
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'get_month_close_checklist',
            description: '取得月底關帳完整 checklist，包含誰還未付、有沒有 pending proposals 待確認、帳務警告摘要等。',
            parameters: {
                type: 'object',
                properties: {}
            }
        }
    }
];

export interface AssistantMessage {
    role: string
    content?: string
    tool_calls?: Array<{
        id?: string
        type?: string
        function: { name: string; arguments: string }
        _thoughtSignature?: string | null
    }>
    name?: string
    tool_call_id?: string
}

export interface ChatResult {
    reply: string
    history: AssistantMessage[]
}

function buildGeminiTools(): Array<{ functionDeclarations: Array<Record<string, unknown>> }> {
    const declarations = tools.map(t => ({
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters
    }));
    return [{ functionDeclarations: declarations }];
}

function convertToGeminiContents(messages: AssistantMessage[]): { contents: Array<Record<string, unknown>>; systemInstruction: { parts: Array<{ text: string }> } | null } {
    const contents: Array<Record<string, unknown>> = [];
    let systemInstruction: { parts: Array<{ text: string }> } | null = null;

    for (const msg of messages) {
        if (msg.role === 'system') {
            systemInstruction = { parts: [{ text: msg.content || '' }] };
            continue;
        }

        if (msg.role === 'user') {
            contents.push({
                role: 'user',
                parts: [{ text: msg.content }]
            });
            continue;
        }

        if (msg.role === 'tool') {
            contents.push({
                role: 'function',
                parts: [{
                    functionResponse: {
                        name: msg.name || 'unknown',
                        response: {
                            name: msg.name || 'unknown',
                            content: msg.content || ''
                        }
                    }
                }]
            });
            continue;
        }

        if (msg.role === 'assistant' || msg.role === 'model') {
            const parts: Array<Record<string, unknown>> = [];
            if (msg.content) {
                parts.push({ text: msg.content });
            }
            if (msg.tool_calls) {
                for (const tc of msg.tool_calls) {
                    const part: Record<string, unknown> = {
                        functionCall: {
                            name: tc.function.name,
                            args: JSON.parse(tc.function.arguments || '{}')
                        }
                    };
                    if (tc._thoughtSignature) {
                        part.thoughtSignature = tc._thoughtSignature;
                    }
                    parts.push(part);
                }
            }
            contents.push({ role: 'model', parts });
            continue;
        }

        if (msg.role === 'function') {
            contents.push({
                role: 'function',
                parts: [{
                    functionResponse: {
                        name: msg.name || 'unknown',
                        response: {
                            name: msg.name || 'unknown',
                            content: msg.content || ''
                        }
                    }
                }]
            });
        }
    }

    return { contents, systemInstruction };
}

const assistantResponseSchema = z.object({
    candidates: z.array(z.object({
        content: z.object({
            parts: z.array(z.object({
                text: z.string().optional(),
                thoughtSignature: z.string().nullable().optional(),
                functionCall: z.object({
                    id: z.string().optional(),
                    name: z.string(),
                    args: z.record(z.string(), z.unknown())
                }).optional()
            }).passthrough())
        }),
        finishReason: z.string().optional()
    }).passthrough()).optional()
}).passthrough();

type GeminiCandidate = NonNullable<z.infer<typeof assistantResponseSchema>['candidates']>[number];

function geminiResponseToAssistantMessage(candidate: GeminiCandidate): AssistantMessage {
    const parts = candidate.content.parts || [];
    const textParts = parts.filter(p => p.text);
    const content = textParts.map(p => p.text).join('\n') || null;

    const toolCalls: AssistantMessage['tool_calls'] = [];

    for (const part of parts) {
        if (part.functionCall) {
            toolCalls.push({
                id: part.functionCall.id || part.functionCall.name + '_' + Date.now(),
                type: 'function',
                function: {
                    name: part.functionCall.name,
                    arguments: JSON.stringify(part.functionCall.args || {})
                },
                _thoughtSignature: part.thoughtSignature || null
            });
        }
    }

    const msg: AssistantMessage = { role: 'assistant' };
    if (content !== null) msg.content = content;
    if (toolCalls.length > 0) msg.tool_calls = toolCalls;
    return msg;
}

async function callGeminiWithTools(modelName: string, messages: AssistantMessage[], geminiTools: ReturnType<typeof buildGeminiTools>, temperature = 0.2): Promise<AssistantMessage> {
    const { contents, systemInstruction } = convertToGeminiContents(messages);

    const body: Record<string, unknown> = {
        contents,
        tools: geminiTools,
        generationConfig: {
            temperature,
            maxOutputTokens: 2000
        }
    };

    if (systemInstruction) {
        body.systemInstruction = systemInstruction;
    }

    const data = await generateContent(body, assistantResponseSchema, { model: modelName });
    if (!data.candidates || data.candidates.length === 0) {
        throw new Error('No candidates returned from Gemini API');
    }

    const candidate = data.candidates[0];
    if (!candidate) {
        throw new Error('No candidates returned from Gemini API');
    }
    if (candidate.finishReason === 'SAFETY') {
        throw new Error('Response blocked by Gemini safety filters');
    }

    return geminiResponseToAssistantMessage(candidate);
}

function executeTool(db: Database, name: string, args: Record<string, string>): string {
    try {
        switch (name) {
            case 'get_member_balance': {
                const balances = calculateCurrentMonthBalances(db);
                const queryName = (args.memberName || '').trim().toLowerCase();
                const member = db.members.find(m =>
                    m.name.toLowerCase() === queryName ||
                    m.id.toLowerCase() === queryName ||
                    m.name.toLowerCase().includes(queryName)
                );
                if (!member) {
                    return JSON.stringify({ error: `找不到成員 "${args.memberName}"，請確認成員姓名拼寫是否正確。` });
                }
                const balance = balances.find(b => isMemberRecord(b, member));
                if (!balance) {
                    return JSON.stringify({ error: `找不到成員 "${member.name}" 的當月帳務明細。` });
                }
                return JSON.stringify({
                    memberName: member.name,
                    currentMonth: db.currentMonth,
                    priorBalance: member.priorBalance,
                    monthlyFee: balance.subscriptionFee,
                    tempCharges: balance.tempCharge,
                    paid: balance.paid,
                    outstanding: balance.endingBalance,
                    isSettled: balance.endingBalance <= 0
                });
            }
            case 'get_member_history': {
                const queryName = (args.memberName || '').trim().toLowerCase();
                const member = db.members.find(m =>
                    m.name.toLowerCase() === queryName ||
                    m.id.toLowerCase() === queryName ||
                    m.name.toLowerCase().includes(queryName)
                );
                if (!member) {
                    return JSON.stringify({ error: `找不到成員 "${args.memberName}"。` });
                }
                const nameKey = member.name;
                const payments = (db.payments || []).filter(p => p.memberName === nameKey);
                const tempCharges = (db.tempCharges || []).filter(t => t.memberName === nameKey);
                const history: Array<Record<string, unknown>> = [];
                (db.history || []).forEach(h => {
                    const bal = (h.balances || []).find(b => b.memberName === nameKey);
                    if (bal) {
                        history.push({
                            month: h.month,
                            monthlyFee: bal.subscriptionFee,
                            tempCharges: bal.tempCharge,
                            paid: bal.paid,
                            outstanding: bal.endingBalance
                        });
                    }
                });
                return JSON.stringify({
                    memberName: nameKey,
                    payments: payments.slice(-8),
                    tempCharges: tempCharges.slice(-8),
                    history
                });
            }
            case 'get_payment_records': {
                const queryName = (args.memberName || '').trim().toLowerCase();
                let payments = db.payments || [];
                if (queryName) {
                    payments = payments.filter(p => p.memberName.toLowerCase().includes(queryName));
                }
                return JSON.stringify({ payments: payments.slice(-15) });
            }
            case 'get_accounting_warnings': {
                const warnings = findAccountingWarnings(db);
                return JSON.stringify({ warnings });
            }
            case 'get_system_snapshot': {
                const snapshot = getSystemSnapshot(db);
                return JSON.stringify({ snapshot });
            }
            case 'get_close_preview': {
                const preview = getClosePreview(db);
                return JSON.stringify({ preview });
            }
            case 'get_subscription_impact': {
                const targetPlatform = db.platforms.find(
                    p => p.name === args.platformName ||
                         p.name.toLowerCase().includes((args.platformName || '').toLowerCase())
                );
                if (!targetPlatform) {
                    return JSON.stringify({ error: `找不到平台 "${args.platformName}"` });
                }
                const activeSubs = (db.subscriptions || []).filter(
                    s => (s.platformId === targetPlatform.id || s.platformName === targetPlatform.name) &&
                         !s.exitMonth
                );
                const affectedMembers = activeSubs.map(s => {
                    const member = db.members.find(m => m.id === s.memberId || m.name === s.memberName);
                    return {
                        memberName: s.memberName,
                        startMonth: s.startMonth,
                        seatLabel: s.seatLabel || null,
                        customFee: member?.customFee ?? null,
                    };
                });
                return JSON.stringify({
                    platformName: targetPlatform.name,
                    billingMode: targetPlatform.billingMode,
                    price: targetPlatform.price,
                    totalCost: targetPlatform.totalCost,
                    activeSubscribersCount: activeSubs.length,
                    affectedMembers,
                    note: targetPlatform.billingMode === 'split'
                        ? `平台費用 $${targetPlatform.totalCost} 由 ${activeSubs.length} 人均攤，若再加人每人費用會下降`
                        : `固定每人 $${targetPlatform.price}/月`,
                });
            }
            case 'get_collection_priority': {
                const balances = calculateCurrentMonthBalances(db);
                const now = Date.now();
                const prioritized = balances
                    .filter(b => b.endingBalance > 0)
                    .map(b => {
                        const memberPayments = (db.payments || [])
                            .filter(p => p.memberName === b.memberName && !p.status?.includes('voided'))
                            .sort((a, c) => new Date(c.date).getTime() - new Date(a.date).getTime());
                        const lastPayment = memberPayments[0];
                        const daysSinceLastPayment = lastPayment
                            ? Math.floor((now - new Date(lastPayment.date).getTime()) / 86400000)
                            : 999;
                        return {
                            memberName: b.memberName,
                            outstanding: b.endingBalance,
                            lastPaymentDate: lastPayment?.date || null,
                            daysSinceLastPayment,
                            urgency: b.endingBalance > 500 || daysSinceLastPayment > 30 ? '高' : '中',
                        };
                    })
                    .sort((a, c) => {
                        // Primary: urgency high first; secondary: outstanding amount desc
                        if (a.urgency !== c.urgency) return a.urgency === '高' ? -1 : 1;
                        return c.outstanding - a.outstanding;
                    });
                return JSON.stringify({
                    currentMonth: db.currentMonth,
                    unpaidCount: prioritized.length,
                    priority: prioritized,
                });
            }
            case 'get_month_close_checklist': {
                const preview = getClosePreview(db);
                const warnings = findAccountingWarnings(db);
                const unpaidMembers = preview.balances.filter(b => b.endingBalance > 0);
                return JSON.stringify({
                    currentMonth: db.currentMonth,
                    readyToClose: preview.ready,
                    blockers: preview.blockers,
                    unpaidMembers: unpaidMembers.map(b => ({
                        name: b.memberName,
                        outstanding: b.endingBalance,
                    })),
                    unpaidCount: unpaidMembers.length,
                    totalReceivable: preview.totals.receivable,
                    warningCount: warnings.length,
                    checks: preview.checks,
                    note: preview.ready
                        ? '所有條件滿足，可以執行月結'
                        : `尚有 ${preview.blockers.length} 個阻擋項目需要解決`,
                });
            }
            default:
                return JSON.stringify({ error: `未知的工具名稱: ${name}` });
        }
    } catch (err) {
        return JSON.stringify({ error: `執行工具時發生錯誤: ${(err as Error).message}` });
    }
}

export async function handleAssistantChat(db: Database, userMessage: string, history: AssistantMessage[] = []): Promise<ChatResult> {
    if (!isAIConfigured()) {
        return {
            reply: '⚠️ 系統未啟用 AI 功能。請設定環境變數以啟用 AI 帳務助理。',
            history: [...history, { role: 'user', content: userMessage }]
        };
    }

    const model = process.env.AI_MODEL || 'gemini-3.1-flash-lite';
    const geminiTools = buildGeminiTools();

    const ragResults = await queryRAG(db, userMessage, 5);

    let ragSystemContent = '';
    if (ragResults.length > 0) {
        ragSystemContent = '\n\n【從向量資料庫檢索到的相關帳務脈絡】（若回答歷史性或模糊性問題時，請參考以下資訊，但若工具回傳更新或更精準的資料，請以 Tools 為準）：\n' +
            ragResults.map((r, i) => `${i + 1}. [分數: ${r.score.toFixed(2)}] ${r.text}`).join('\n');
    }

    const systemMessage = `你是一個專業、親切的個人共享訂閱帳務理財助理。你的名字是「帳務智能助理」。
你能夠協助主辦人（管理員）分析與查詢目前系統中的帳務數據。

【職責與能力限制】：
1. 你可以查詢當前和過去的成員帳務、訂閱平台、付款、代墊費用、會計稽核警告等。
2. 當使用者詢問如「Beta 這個月要付多少錢？」、「誰還沒繳錢？」、「幫我看看有沒有帳務異常」時，你必須優先使用工具 (Tools) 來獲取即時的真實數據。
3. 你的回答必須基於工具回傳或 RAG 檢索出的脈絡 (Context)，若數據中沒有，不可捏造。
4. 如果使用者詢問與本系統帳務完全無關的內容（例如：今天天氣、微積分、寫程式等），請委婉禮貌地表示你只能協助帳務相關的查詢。
5. 一律使用繁體中文 (zh-TW) 回覆，並適度使用條列式、表格或粗體，讓財務報表和對帳明細更容易被操作者閱讀。
6. 當前帳期（當前月份）為: ${db.currentMonth}。

【AI 自動化處理】：
本系統支援「⚡ 自動處理」功能：使用者可貼上自然語言帳務文字，系統以 Gemini function calling 解析成結構化 proposal，再透過 deterministic 驗證層（重複檢查、金額格式、成員匹配）決定是否自動套用。
若使用者詢問「剛才自動套用了什麼」、「最近 AI 處理了哪些事件」，請引用系統審計日誌（get_system_snapshot 或 RAG 中的 ledger 紀錄）來回答，並標示 [AI自動] 前綴的事件。

【工具呼叫限制】：
- 如果你想查詢某個成員，但使用者只給了簡稱（如 "Alpha" 代替 "Member Alpha"），你依然可以直接將 "Alpha" 傳入 get_member_balance 等工具，工具會進行模糊比對。
- 使用 get_subscription_impact 回答「新增 X 訂閱影響誰」類問題。
- 使用 get_collection_priority 回答「誰該優先催繳」類問題。
- 使用 get_month_close_checklist 回答「月底關帳還差什麼」類問題。
${ragSystemContent}`;
    const messages: AssistantMessage[] = [
        { role: 'system', content: systemMessage },
        ...history,
        { role: 'user', content: userMessage }
    ];

    let loopCount = 0;
    const maxLoops = 5;

    while (loopCount < maxLoops) {
        loopCount++;
        try {
            const assistantMessage = await callGeminiWithTools(model, messages, geminiTools, 0.2);
            messages.push(assistantMessage);

            if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
                for (const toolCall of assistantMessage.tool_calls) {
                    const functionName = toolCall.function.name;
                    let functionArgs: Record<string, string> = {};
                    try {
                        functionArgs = JSON.parse(toolCall.function.arguments || '{}');
                    } catch {
                        // ignore parse errors
                    }
                    const resultText = executeTool(db, functionName, functionArgs);
                    const toolMessage: AssistantMessage = {
                        role: 'tool',
                        name: functionName,
                        content: resultText
                    };
                    if (toolCall.id) toolMessage.tool_call_id = toolCall.id;
                    messages.push(toolMessage);
                }
                continue;
            }

            const finalReply = assistantMessage.content || '';
            const cleanHistory = messages.slice(1);
            return { reply: finalReply, history: cleanHistory };

        } catch (err) {
            return {
                reply: `❌ 抱歉，在處理您的請求或執行工具呼叫時發生錯誤：${(err as Error).message}`,
                history: [...history, { role: 'user', content: userMessage }]
            };
        }
    }

    return {
        reply: '⚠️ 助理執行工具呼叫的次數過多，已達到安全限制。請試著簡化您的提問。',
        history: [...history, { role: 'user', content: userMessage }]
    };
}
