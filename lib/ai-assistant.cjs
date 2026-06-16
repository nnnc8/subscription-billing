const { isAIConfigured } = require('./ai.cjs');
const { queryRAG } = require('./rag.cjs');
const {
    calculateCurrentMonthBalances,
    findAccountingWarnings,
    getSystemSnapshot,
    getClosePreview,
    isMemberRecord
} = require('./accounting.cjs');

const GEMINI_API_KEY = '***REMOVED***';

const tools = [
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
    }
];

/**
 * Converts Gemini's FunctionDeclaration format (no 'type' wrapping) to
 * the nested format expected by the Gemini API 'tools' field.
 */
function buildGeminiTools() {
    const declarations = tools.map(t => ({
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters
    }));
    return [{ functionDeclarations: declarations }];
}

/**
 * Converts OpenAI-format messages to Gemini API contents format,
 * specifically for the function-calling loop.
 */
function convertToGeminiContents(messages) {
    const contents = [];
    let systemInstruction = null;

    for (const msg of messages) {
        if (msg.role === 'system') {
            systemInstruction = { parts: [{ text: msg.content }] };
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
            // Gemini expects functionResponse parts for tool results
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
            const parts = [];
            if (msg.content) {
                parts.push({ text: msg.content });
            }
            if (msg.tool_calls) {
                for (const tc of msg.tool_calls) {
                    const part = {
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

/**
 * Converts Gemini's response content back to OpenAI-format assistant message.
 * Preserves thoughtSignature for function call loops.
 */
function geminiResponseToAssistantMessage(candidate) {
    const parts = candidate.content.parts || [];
    const textParts = parts.filter(p => p.text);
    const content = textParts.map(p => p.text).join('\n') || null;

    const toolCalls = [];

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

    const msg = { role: 'assistant' };
    if (content !== null) msg.content = content;
    if (toolCalls.length > 0) msg.tool_calls = toolCalls;
    return msg;
}

/**
 * Calls Google AI Studio REST API with full function-calling support.
 */
async function callGeminiWithTools(modelName, messages, geminiTools, temperature = 0.2) {
    const { contents, systemInstruction } = convertToGeminiContents(messages);

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${GEMINI_API_KEY}`;

    const body = {
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

    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });

    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Gemini API returned ${res.status}: ${errText}`);
    }

    const data = await res.json();
    if (!data.candidates || data.candidates.length === 0) {
        throw new Error('No candidates returned from Gemini API');
    }

    const candidate = data.candidates[0];
    if (candidate.finishReason === 'SAFETY') {
        throw new Error('Response blocked by Gemini safety filters');
    }

    return geminiResponseToAssistantMessage(candidate);
}

/**
 * Executes a tool called by the model.
 */
function executeTool(db, name, args) {
    try {
        switch (name) {
            case 'get_member_balance': {
                const balances = calculateCurrentMonthBalances(db);
                const queryName = args.memberName?.trim().toLowerCase();
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
                const queryName = args.memberName?.trim().toLowerCase();
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
                const history = [];
                (db.history || []).forEach(h => {
                    const bal = (h.balances || []).find(b => b.memberName === nameKey);
                    if (bal) {
                        history.push({
                            month: h.month,
                            monthlyFee: bal.monthlyFee,
                            tempCharges: bal.tempCharges,
                            paid: bal.paid,
                            outstanding: bal.outstanding
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
                const queryName = args.memberName?.trim().toLowerCase();
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
            default:
                return JSON.stringify({ error: `未知的工具名稱: ${name}` });
        }
    } catch (err) {
        console.error(`Error executing tool ${name}:`, err);
        return JSON.stringify({ error: `執行工具時發生錯誤: ${err.message}` });
    }
}

/**
 * Handles a conversation turn between the user and the assistant.
 * Uses direct Google AI Studio REST API with function calling.
 */
async function handleAssistantChat(db, userMessage, history = []) {
    if (!isAIConfigured()) {
        return {
            reply: "⚠️ 系統未啟用 AI 功能。請設定環境變數以啟用 AI 帳務助理。",
            history: [...history, { role: 'user', content: userMessage }]
        };
    }

    const model = (process.env.AI_MODEL || 'gemini-3.1-flash-lite').replace(/^@vertex-ai\//, '').replace(/^google\//, '');
    const geminiTools = buildGeminiTools();

    // 1. Run RAG to find relevant historical context
    console.log(`RAG query for: "${userMessage}"`);
    const ragResults = await queryRAG(db, userMessage, 5);

    let ragSystemContent = "";
    if (ragResults.length > 0) {
        ragSystemContent = "\n\n【從向量資料庫檢索到的相關帳務脈絡】（若回答歷史性或模糊性問題時，請參考以下資訊，但若工具回傳更新或更精準的資料，請以 Tools 為準）：\n" +
            ragResults.map((r, i) => `${i+1}. [分數: ${r.score.toFixed(2)}] ${r.text}`).join('\n');
    }

    const systemMessage = `你是一個專業、親切的個人共享訂閱帳務理財助理。你的名字是「Antigravity 帳務小幫手」。
你能夠協助主辦人（管理員）分析與查詢目前系統中的帳務數據。

【職責與能力限制】：
1. 你可以查詢當前和過去的成員帳務、訂閱平台、付款、代墊費用、會計稽核警告等。
2. 當使用者詢問如「Beta 這個月要付多少錢？」、「誰還沒繳錢？」、「幫我看看有沒有帳務異常」時，你必須優先使用工具 (Tools) 來獲取即時的真實數據。
3. 你的回答必須基於工具回傳或 RAG 檢索出的脈絡 (Context)，若數據中沒有，不可捏造。
4. 如果使用者詢問與本系統帳務完全無關的內容（例如：今天天氣、微積分、寫程式等），請委婉禮貌地表示你只能協助帳務相關的查詢。
5. 一律使用繁體中文 (zh-TW) 回覆，並適度使用條列式、表格或粗體，讓財務報表和對帳明細更容易被操作者閱讀。
6. 當前帳期（當前月份）為: ${db.currentMonth}。

【工具呼叫限制】：
- 如果你想查詢某個成員，但使用者只給了簡稱（如 "Alpha" 代替 "Member Alpha"），你依然可以直接將 "Alpha" 傳入 get_member_balance 等工具，工具會進行模糊比對。
${ragSystemContent}`;

    const messages = [
        { role: 'system', content: systemMessage },
        ...history,
        { role: 'user', content: userMessage }
    ];

    let loopCount = 0;
    const maxLoops = 5;

    while (loopCount < maxLoops) {
        loopCount++;
        try {
            console.log(`Calling Gemini with function calling (Loop ${loopCount})...`);
            const assistantMessage = await callGeminiWithTools(model, messages, geminiTools, 0.2);
            messages.push(assistantMessage);

            if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
                console.log(`Model requested ${assistantMessage.tool_calls.length} tool calls.`);
                for (const toolCall of assistantMessage.tool_calls) {
                    const functionName = toolCall.function.name;
                    let functionArgs = {};
                    try {
                        functionArgs = JSON.parse(toolCall.function.arguments || '{}');
                    } catch (_) {}
                    console.log(`Executing tool: ${functionName} with args:`, functionArgs);
                    const resultText = executeTool(db, functionName, functionArgs);
                    messages.push({
                        role: 'tool',
                        tool_call_id: toolCall.id,
                        name: functionName,
                        content: resultText
                    });
                }
                continue;
            }

            const finalReply = assistantMessage.content || '';
            const cleanHistory = messages.slice(1);
            return { reply: finalReply, history: cleanHistory };

        } catch (err) {
            console.error('Error during assistant completion loop:', err);
            return {
                reply: `❌ 抱歉，在處理您的請求或執行工具呼叫時發生錯誤：${err.message}`,
                history: [...history, { role: 'user', content: userMessage }]
            };
        }
    }

    return {
        reply: "⚠️ 助理執行工具呼叫的次數過多，已達到安全限制。請試著簡化您的提問。",
        history: [...history, { role: 'user', content: userMessage }]
    };
}

module.exports = {
    handleAssistantChat
};
