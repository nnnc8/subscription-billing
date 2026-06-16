const { isAIConfigured, createEmbedding, cosineSimilarity } = require('./ai.cjs');

let cachedIndex = null;
let isDirty = true;
let isBuilding = false;

/**
 * Invalidates the cached RAG index, forcing it to rebuild next time.
 */
function invalidateRAGIndex() {
    isDirty = true;
}

/**
 * Normalizes a month string (e.g. "2026/06" -> "2026-06" or keep it consistent).
 */
function normalizeMonth(m) {
    if (!m) return '';
    return m.replace(/\//g, '-');
}

/**
 * Generates text chunks from the database state.
 * @param {Object} db - The database state
 * @returns {Array<Object>} - Array of { text, source }
 */
function generateChunks(db) {
    const chunks = [];
    const currentMonth = db.currentMonth || '';

    // 1. Members and their active subscriptions & prior balance
    if (Array.isArray(db.members)) {
        db.members.forEach(member => {
            const subs = (db.subscriptions || []).filter(s => {
                return (s.memberId && s.memberId === member.id) || s.memberName === member.name;
            });
            const activeSubs = subs.filter(s => {
                const start = normalizeMonth(s.startMonth);
                const exit = normalizeMonth(s.exitMonth);
                const normCurrent = normalizeMonth(currentMonth);
                return start && start <= normCurrent && (!exit || exit > normCurrent);
            }).map(s => s.platformName);

            let text = `[成員當前狀態] 成員名: ${member.name}, 帳期: ${currentMonth}. `;
            text += `前期餘額(上期結轉): $${member.priorBalance || 0} 元. `;
            if (member.customFee !== null && member.customFee !== undefined && member.customFee !== "") {
                text += `使用自訂費用小計: $${member.customFee} 元. `;
            } else if (activeSubs.length > 0) {
                text += `本期活躍訂閱項目: ${activeSubs.join(', ')}. `;
            } else {
                text += `本期無活躍訂閱服務. `;
            }
            chunks.push({
                text: text,
                source: { type: 'member_status', id: member.id, name: member.name }
            });
        });
    }

    // 2. Payments (recent first)
    if (Array.isArray(db.payments)) {
        db.payments.forEach(pay => {
            let text = `[付款紀錄] 付款人: ${pay.memberName}, 金額: $${pay.amount} 元, 日期: ${pay.date}, `;
            text += `帳期/Cycle: ${pay.cycle || '未填'}, 付款方式: ${pay.method || '未填'}. `;
            if (pay.note) {
                text += `備註: ${pay.note}. `;
            }
            chunks.push({
                text: text,
                source: { type: 'payment', id: pay.id, memberName: pay.memberName }
            });
        });
    }

    // 3. Temporary Charges (recent first)
    if (Array.isArray(db.tempCharges)) {
        db.tempCharges.forEach(tc => {
            let text = `[代墊/臨時費用] 成員: ${tc.memberName}, 金恩/金額: $${tc.amount} 元, 日期: ${tc.date}, 項目說明: ${tc.desc || '無'}. `;
            chunks.push({
                text: text,
                source: { type: 'temp_charge', id: tc.id, memberName: tc.memberName }
            });
        });
    }

    // 4. Ledger Events (system audit logs)
    if (db.ledger && Array.isArray(db.ledger.entries)) {
        // Index last 60 events to avoid bloating but keep historical trace
        const recentEntries = db.ledger.entries.slice(-60);
        recentEntries.forEach(entry => {
            let text = `[系統審計日誌] 時間: ${entry.at}, 操作者: ${entry.actor}, 類別: ${entry.type}, `;
            text += `內容摘要: ${entry.summary}, 影響帳期: ${entry.month || '無'}. `;
            if (entry.amount) {
                text += `相關金額: $${entry.amount} 元. `;
            }
            chunks.push({
                text: text,
                source: { type: 'ledger', id: entry.id }
            });
        });
    }

    // 5. History Entries (past settled months summaries)
    if (Array.isArray(db.history)) {
        db.history.forEach(hist => {
            let text = `[歷史已結算帳期] 帳期: ${hist.month}. 當期已結算成員帳務總結:\n`;
            if (Array.isArray(hist.balances)) {
                hist.balances.forEach(b => {
                    text += `  • 成員 ${b.memberName}: 前期餘額 $${b.priorBalance}, 月分攤費 $${b.monthlyFee}, 臨時費用 $${b.tempCharges}, 已付 $${b.paid}, 最終應收/應付 $${b.outstanding} 元.\n`;
                });
            }
            chunks.push({
                text: text,
                source: { type: 'history_month', month: hist.month }
            });
        });
    }

    // 6. Config / Platform summaries
    if (Array.isArray(db.platforms)) {
        db.platforms.forEach(plat => {
            let text = `[訂閱平台設定] 平台名稱: ${plat.name}, 計費模式: ${plat.billingMode || 'fixed'}, `;
            if (plat.billingMode === 'split') {
                text += `總成本/月: $${plat.totalCost} 元 (由訂閱人數均分). `;
            } else {
                text += `每人每月費用: $${plat.price} 元. `;
            }
            chunks.push({
                text: text,
                source: { type: 'platform', id: plat.id, name: plat.name }
            });
        });
    }

    return chunks;
}

/**
 * Builds the RAG index asynchronously.
 * @param {Object} db - The database state
 */
async function buildRAGIndex(db) {
    if (!isAIConfigured()) {
        cachedIndex = [];
        isDirty = false;
        return;
    }

    if (isBuilding) return;
    isBuilding = true;

    try {
        console.log('Building RAG index...');
        const chunks = generateChunks(db);
        
        // Parallelized creation of embeddings
        const promises = chunks.map(async (chunk) => {
            try {
                const vector = await createEmbedding(chunk.text);
                return {
                    ...chunk,
                    vector
                };
            } catch (err) {
                console.error(`Failed to create embedding for chunk: ${chunk.text.substring(0, 30)}...`, err.message);
                return null;
            }
        });

        const results = await Promise.all(promises);
        cachedIndex = results.filter(Boolean);
        isDirty = false;
        console.log(`RAG index successfully built with ${cachedIndex.length} chunks.`);
    } catch (err) {
        console.error('Error building RAG index:', err);
    } finally {
        isBuilding = false;
    }
}

/**
 * Queries the RAG index using cosine similarity.
 * @param {Object} db - Database state
 * @param {string} queryText - Search query
 * @param {number} [topK=5] - Number of results to return
 * @returns {Promise<Array<Object>>} - Top K chunks matching the query
 */
async function queryRAG(db, queryText, topK = 5) {
    if (!isAIConfigured()) {
        return [];
    }

    // Build/rebuild if dirty or never built
    if (isDirty || !cachedIndex) {
        await buildRAGIndex(db);
    }

    if (!cachedIndex || cachedIndex.length === 0) {
        return [];
    }

    try {
        const queryVector = await createEmbedding(queryText);
        
        const scored = cachedIndex.map(chunk => {
            const score = cosineSimilarity(queryVector, chunk.vector);
            return {
                text: chunk.text,
                source: chunk.source,
                score: score
            };
        });

        // Sort descending by score
        scored.sort((a, b) => b.score - a.score);

        // Filter out very low similarity matching (e.g. score < 0.2 if needed) to keep context clean
        return scored.slice(0, topK);
    } catch (err) {
        console.error('Error querying RAG:', err);
        return [];
    }
}

module.exports = {
    invalidateRAGIndex,
    buildRAGIndex,
    queryRAG
};
