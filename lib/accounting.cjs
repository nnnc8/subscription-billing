const crypto = require('crypto');

const MONTH_RE = /^\d{4}\/(0[1-9]|1[0-2])$/;

function monthToCode(monthStr) {
    if (typeof monthStr !== 'string' || !MONTH_RE.test(monthStr)) {
        return null;
    }
    const [year, month] = monthStr.split('/').map(Number);
    return year * 12 + month;
}

function isFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
}

function toNumber(value, fallback = 0) {
    const parsed = typeof value === 'number' ? value : parseFloat(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function stableStringify(value) {
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map(stableStringify).join(',')}]`;
    }
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function legacyId(prefix, value, index) {
    const slug = String(value || 'unknown')
        .trim()
        .toLowerCase()
        .replace(/[^\w]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 24);
    return `${prefix}_legacy_${slug || index + 1}`;
}

function buildLookups(db) {
    const memberById = new Map();
    const memberByName = new Map();
    const platformById = new Map();
    const platformByName = new Map();

    (db.members || []).forEach(member => {
        if (member.id) memberById.set(member.id, member);
        if (member.name) memberByName.set(member.name, member);
    });
    (db.platforms || []).forEach(platform => {
        if (platform.id) platformById.set(platform.id, platform);
        if (platform.name) platformByName.set(platform.name, platform);
    });

    return { memberById, memberByName, platformById, platformByName };
}

function resolveMember(db, record) {
    const { memberById, memberByName } = buildLookups(db);
    if (record && record.memberId && memberById.has(record.memberId)) {
        return memberById.get(record.memberId);
    }
    if (record && record.memberName && memberByName.has(record.memberName)) {
        return memberByName.get(record.memberName);
    }
    return null;
}

function resolvePlatform(db, record) {
    const { platformById, platformByName } = buildLookups(db);
    if (record && record.platformId && platformById.has(record.platformId)) {
        return platformById.get(record.platformId);
    }
    if (record && record.platformName && platformByName.has(record.platformName)) {
        return platformByName.get(record.platformName);
    }
    return null;
}

function isMemberRecord(record, member) {
    if (!record || !member) return false;
    if (record.memberId && member.id) return record.memberId === member.id;
    return record.memberName === member.name;
}

function isPlatformRecord(record, platform) {
    if (!record || !platform) return false;
    if (record.platformId && platform.id) return record.platformId === platform.id;
    return record.platformName === platform.name;
}

function memberRecordKey(record) {
    return record && (record.memberId || record.memberName);
}

function isTransactionVoided(transaction) {
    return Boolean(transaction && (transaction.status === 'voided' || transaction.voidedAt || transaction.voided === true));
}

function activeTransactions(transactions) {
    return (transactions || []).filter(transaction => !isTransactionVoided(transaction));
}

function normalizeDuplicateText(value) {
    return String(value || '').trim();
}

function parseTimestamp(value) {
    if (!value) return null;
    const ms = new Date(value).getTime();
    return Number.isFinite(ms) ? ms : null;
}

function findRecentDuplicateTransaction(transactions, candidate, options = {}) {
    const type = options.type || 'payment';
    const windowMs = Number.isFinite(options.windowMs) ? options.windowMs : 10 * 60 * 1000;
    const candidateCreatedAt = parseTimestamp(candidate?.createdAt);
    if (!candidate || candidateCreatedAt === null) return null;

    const candidateMemberKey = memberRecordKey(candidate);
    const candidateAmount = toNumber(candidate.amount, NaN);
    const candidateDate = candidate.date || '';
    const candidateMethod = normalizeDuplicateText(candidate.method);
    const candidateNote = normalizeDuplicateText(candidate.note);
    const candidateDesc = normalizeDuplicateText(candidate.desc);

    return activeTransactions(transactions).find(transaction => {
        const existingCreatedAt = parseTimestamp(transaction.createdAt);
        if (existingCreatedAt === null) return false;
        if (Math.abs(candidateCreatedAt - existingCreatedAt) > windowMs) return false;
        if (memberRecordKey(transaction) !== candidateMemberKey) return false;
        if (toNumber(transaction.amount, NaN) !== candidateAmount) return false;
        if ((transaction.date || '') !== candidateDate) return false;

        if (type === 'charge') {
            return normalizeDuplicateText(transaction.desc) === candidateDesc;
        }

        return normalizeDuplicateText(transaction.method) === candidateMethod
            && normalizeDuplicateText(transaction.note) === candidateNote;
    }) || null;
}

function isEntityArchived(entity) {
    return Boolean(entity && (entity.status === 'archived' || entity.archivedAt));
}

function isEntityBillableInMonth(entity, monthStr) {
    if (!entity || !isEntityArchived(entity)) return true;
    const archivedCode = monthToCode(entity.archivedMonth);
    const targetCode = monthToCode(monthStr);
    if (archivedCode === null || targetCode === null) return false;
    return targetCode < archivedCode;
}

function isIntentionalAdditionalSeat(subscription) {
    return Boolean(
        subscription &&
        (subscription.allowDuplicate === true || subscription.seatLabel || subscription.seatRole === 'additional')
    );
}

function ensureLedger(db) {
    if (!db.ledger || typeof db.ledger !== 'object' || !Array.isArray(db.ledger.entries)) {
        db.ledger = {
            version: 1,
            entries: []
        };
    }
    return db.ledger;
}

function computeLedgerHash(entry) {
    const { hash, ...hashable } = entry;
    return sha256(stableStringify(hashable));
}

function appendLedgerEvent(db, event) {
    const ledger = ensureLedger(db);
    const previous = ledger.entries[ledger.entries.length - 1];
    const entry = {
        id: event.id || `evt_${crypto.randomUUID().slice(0, 12)}`,
        at: event.at || new Date().toISOString(),
        actor: event.actor || 'local-admin',
        type: event.type,
        summary: event.summary || event.type,
        month: event.month || db.currentMonth,
        entityType: event.entityType || null,
        entityId: event.entityId || null,
        amount: event.amount === undefined ? null : event.amount,
        payload: event.payload || {},
        previousHash: previous ? previous.hash : null
    };
    entry.hash = computeLedgerHash(entry);
    ledger.entries.push(entry);
    ledger.lastHash = entry.hash;
    ledger.updatedAt = entry.at;
    return entry;
}

function verifyLedger(db) {
    if (!db.ledger || !Array.isArray(db.ledger.entries)) {
        return {
            ok: false,
            count: 0,
            lastHash: null,
            problems: ['missing_ledger']
        };
    }

    const problems = [];
    let previousHash = null;
    db.ledger.entries.forEach((entry, index) => {
        if (entry.previousHash !== previousHash) {
            problems.push(`entry_${index}_previous_hash_mismatch`);
        }
        if (computeLedgerHash(entry) !== entry.hash) {
            problems.push(`entry_${index}_hash_mismatch`);
        }
        previousHash = entry.hash;
    });

    if ((db.ledger.lastHash || null) !== previousHash) {
        problems.push('last_hash_mismatch');
    }

    return {
        ok: problems.length === 0,
        count: db.ledger.entries.length,
        lastHash: previousHash,
        problems
    };
}

function getLedgerSummary(db) {
    const verification = verifyLedger(db);
    const entries = db.ledger && Array.isArray(db.ledger.entries) ? db.ledger.entries : [];
    return {
        ...verification,
        latest: entries.length ? entries[entries.length - 1] : null,
        recent: entries.slice(-8).reverse()
    };
}

function normalizeDatabaseRelations(db) {
    if (!db) return db;
    ensureLedger(db);

    db.members = (db.members || []).map((member, index) => ({
        ...member,
        id: member.id || legacyId('m', member.name, index)
    }));
    db.platforms = (db.platforms || []).map((platform, index) => ({
        ...platform,
        id: platform.id || legacyId('p', platform.name, index)
    }));

    const lookups = buildLookups(db);

    db.subscriptions = (db.subscriptions || []).map((subscription, index) => {
        const member = subscription.memberId
            ? lookups.memberById.get(subscription.memberId)
            : lookups.memberByName.get(subscription.memberName);
        const platform = subscription.platformId
            ? lookups.platformById.get(subscription.platformId)
            : lookups.platformByName.get(subscription.platformName);

        return {
            ...subscription,
            id: subscription.id || legacyId('s', `${subscription.memberName}_${subscription.platformName}_${subscription.startMonth}`, index),
            ...(member ? { memberId: member.id, memberName: member.name } : {}),
            ...(platform ? { platformId: platform.id, platformName: platform.name } : {})
        };
    });

    const normalizeMemberRecord = (record, index, prefix) => {
        const member = record.memberId
            ? lookups.memberById.get(record.memberId)
            : lookups.memberByName.get(record.memberName);
        return {
            ...record,
            id: record.id || legacyId(prefix, `${record.memberName}_${record.date || index}`, index),
            ...(member ? { memberId: member.id, memberName: record.memberName || member.name } : {})
        };
    };

    db.payments = (db.payments || []).map((payment, index) => normalizeMemberRecord(payment, index, 'pay'));
    db.tempCharges = (db.tempCharges || []).map((charge, index) => normalizeMemberRecord(charge, index, 'chg'));

    db.history = (db.history || []).map(entry => ({
        ...entry,
        balances: (entry.balances || []).map((balance, index) => normalizeMemberRecord(balance, index, 'bal')),
        payments: (entry.payments || []).map((payment, index) => normalizeMemberRecord(payment, index, 'pay')),
        tempCharges: (entry.tempCharges || []).map((charge, index) => normalizeMemberRecord(charge, index, 'chg'))
    }));
    ensureHistorySeals(db);

    return db;
}

function isSubActiveInMonth(sub, monthStr) {
    const targetCode = monthToCode(monthStr);
    const startCode = monthToCode(sub && sub.startMonth);
    if (targetCode === null || startCode === null) return false;

    let exitCode = Infinity;
    if (sub.exitMonth) {
        exitCode = monthToCode(sub.exitMonth);
        if (exitCode === null) return false;
    }

    return targetCode >= startCode && targetCode <= exitCode;
}

function getPlatformPriceForMonth(db, platformRef, monthStr) {
    const platform = typeof platformRef === 'object'
        ? resolvePlatform(db, platformRef)
        : (db.platforms || []).find(p => p.name === platformRef || p.id === platformRef);
    if (!platform) return 0;
    if (!isEntityBillableInMonth(platform, monthStr)) return 0;

    const mode = platform.billingMode || 'fixed';
    if (mode !== 'split') {
        return toNumber(platform.price);
    }

    const activeCount = (db.subscriptions || []).filter(sub => {
        const member = resolveMember(db, sub);
        return (
            isPlatformRecord(sub, platform) &&
            isSubActiveInMonth(sub, monthStr) &&
            isEntityBillableInMonth(member, monthStr)
        );
    }).length;

    const total = toNumber(platform.totalCost);
    return activeCount > 0 ? Math.round(total / activeCount) : 0;
}

function calculateMemberMonthlyFee(member, db, monthStr) {
    if (!member || !db) return 0;
    if (!isEntityBillableInMonth(member, monthStr)) return 0;

    if (member.customFee !== null && member.customFee !== undefined && member.customFee !== '') {
        return toNumber(member.customFee);
    }

    return (db.subscriptions || [])
        .filter(sub => isMemberRecord(sub, member) && isSubActiveInMonth(sub, monthStr))
        .reduce((sum, sub) => sum + getPlatformPriceForMonth(db, sub, monthStr), 0);
}

function calculateCurrentMonthBalances(db) {
    const monthStr = db.currentMonth;
    return (db.members || []).map(member => {
        const priorBalance = toNumber(member.priorBalance);
        const subscriptionFee = calculateMemberMonthlyFee(member, db, monthStr);
        const tempCharge = activeTransactions(db.tempCharges)
            .filter(charge => isMemberRecord(charge, member))
            .reduce((sum, charge) => sum + toNumber(charge.amount), 0);
        const paid = activeTransactions(db.payments)
            .filter(payment => isMemberRecord(payment, member))
            .reduce((sum, payment) => sum + toNumber(payment.amount), 0);

        return {
            memberId: member.id,
            memberName: member.name,
            priorBalance,
            subscriptionFee,
            tempCharge,
            paid,
            endingBalance: priorBalance + subscriptionFee + tempCharge - paid
        };
    });
}

function nextMonthString(monthStr) {
    const code = monthToCode(monthStr);
    if (code === null) return null;
    const [year, month] = monthStr.split('/').map(Number);
    if (month === 12) {
        return `${year + 1}/01`;
    }
    return `${year}/${String(month + 1).padStart(2, '0')}`;
}

function previousMonthString(monthStr) {
    const code = monthToCode(monthStr);
    if (code === null) return null;
    const [year, month] = monthStr.split('/').map(Number);
    if (month === 1) {
        return `${year - 1}/12`;
    }
    return `${year}/${String(month - 1).padStart(2, '0')}`;
}

function getClosePreview(db) {
    const warnings = findAccountingWarnings(db);
    const criticalWarnings = warnings.filter(warning => warning.severity === 'critical');
    const balances = calculateCurrentMonthBalances(db);
    const ledger = getLedgerSummary(db);
    const historyIntegrity = getHistoryIntegrity(db);
    const nextMonth = nextMonthString(db.currentMonth);

    const totals = balances.reduce((acc, balance) => {
        acc.priorBalance += toNumber(balance.priorBalance);
        acc.subscriptionFee += toNumber(balance.subscriptionFee);
        acc.tempCharge += toNumber(balance.tempCharge);
        acc.paid += toNumber(balance.paid);
        acc.endingBalance += toNumber(balance.endingBalance);
        if (balance.endingBalance > 0) {
            acc.receivable += balance.endingBalance;
            acc.unpaidMembers += 1;
        }
        return acc;
    }, {
        priorBalance: 0,
        subscriptionFee: 0,
        tempCharge: 0,
        paid: 0,
        endingBalance: 0,
        receivable: 0,
        unpaidMembers: 0
    });

    const blockers = [];
    if (!nextMonth) {
        blockers.push({ code: 'invalid_current_month', title: '目前帳期格式錯誤', detail: `currentMonth=${db.currentMonth}` });
    }
    criticalWarnings.forEach(warning => {
        blockers.push({ code: warning.code, title: warning.title, detail: warning.detail });
    });

    return {
        ready: blockers.length === 0,
        currentMonth: db.currentMonth,
        nextMonth,
        generatedAt: new Date().toISOString(),
        totals,
        balances,
        checks: [
            {
                id: 'audit',
                label: '帳務稽核',
                status: criticalWarnings.length === 0 ? 'pass' : 'block',
                detail: criticalWarnings.length === 0 ? `${warnings.length} 個提醒，無高風險` : `${criticalWarnings.length} 個高風險問題`
            },
            {
                id: 'ledger',
                label: '事件鏈完整性',
                status: ledger.ok ? 'pass' : 'block',
                detail: ledger.ok ? `${ledger.count} 筆事件，雜湊鏈完整` : ledger.problems.join(', ')
            },
            {
                id: 'history',
                label: '歷史封存',
                status: historyIntegrity.ok ? 'pass' : 'block',
                detail: historyIntegrity.ok ? `${historyIntegrity.sealedCount}/${historyIntegrity.count} 期封存完整` : `${historyIntegrity.problems.length} 個封存問題`
            },
            {
                id: 'rollforward',
                label: '餘額結轉',
                status: 'pass',
                detail: `${balances.length} 位成員將結轉到 ${nextMonth || '下一期'}`
            }
        ],
        blockers,
        warnings,
        ledger
    };
}

function getHistoryHashPayload(entry) {
    return {
        month: entry.month || null,
        balances: entry.balances || [],
        payments: entry.payments || [],
        tempCharges: entry.tempCharges || []
    };
}

function calculateHistoryEntryHash(entry) {
    return sha256(stableStringify(getHistoryHashPayload(entry)));
}

function sealHistoryEntry(entry, previousHash = null, { sealedAt = null, reason = 'legacy-sealed' } = {}) {
    if (!entry) return entry;
    entry.seal = {
        version: 1,
        previousHash,
        hash: calculateHistoryEntryHash(entry),
        sealedAt: entry.seal?.sealedAt || sealedAt || new Date().toISOString(),
        reason: entry.seal?.reason || reason
    };
    return entry;
}

function ensureHistorySeals(db, { sealedAt = null, reason = 'legacy-sealed' } = {}) {
    let previousHash = null;
    (db.history || []).forEach(entry => {
        if (!entry.seal || !entry.seal.hash) {
            sealHistoryEntry(entry, previousHash, { sealedAt, reason });
        }
        previousHash = entry.seal?.hash || calculateHistoryEntryHash(entry);
    });
    return db;
}

function getHistoryIntegrity(db) {
    const entries = db.history || [];
    const problems = [];
    const seenMonths = new Set();
    let previousHash = null;
    let previousMonthCode = null;
    let sealedCount = 0;

    entries.forEach((entry, index) => {
        const monthCode = monthToCode(entry.month);
        const computedHash = calculateHistoryEntryHash(entry);
        const seal = entry.seal || null;

        if (monthCode === null) {
            problems.push({ severity: 'critical', code: 'invalid_history_month', month: entry.month || null, detail: `第 ${index + 1} 筆歷史帳期格式錯誤` });
        }
        if (entry.month && seenMonths.has(entry.month)) {
            problems.push({ severity: 'critical', code: 'duplicate_history_month', month: entry.month, detail: `${entry.month} 重複封存` });
        }
        if (previousMonthCode !== null && monthCode !== null && monthCode <= previousMonthCode) {
            problems.push({ severity: 'warning', code: 'history_month_order', month: entry.month, detail: `${entry.month} 未依時間排序` });
        }
        if (!seal || !seal.hash) {
            problems.push({ severity: 'critical', code: 'missing_history_seal', month: entry.month || null, detail: `${entry.month || '(未知月份)'} 缺少封存指紋` });
        } else {
            sealedCount += 1;
            if (seal.hash !== computedHash) {
                problems.push({ severity: 'critical', code: 'history_seal_mismatch', month: entry.month || null, detail: `${entry.month || '(未知月份)'} 封存後內容已改變` });
            }
            if ((seal.previousHash || null) !== previousHash) {
                problems.push({ severity: 'critical', code: 'history_chain_mismatch', month: entry.month || null, detail: `${entry.month || '(未知月份)'} 與前一期封存鏈不一致` });
            }
        }

        (entry.balances || []).forEach(balance => {
            const expected = toNumber(balance.priorBalance) + toNumber(balance.subscriptionFee) + toNumber(balance.tempCharge) - toNumber(balance.paid);
            if (expected !== toNumber(balance.endingBalance)) {
                problems.push({
                    severity: 'critical',
                    code: 'history_balance_formula_mismatch',
                    month: entry.month || null,
                    detail: `${entry.month} ${balance.memberName}: ${balance.priorBalance} + ${balance.subscriptionFee} + ${balance.tempCharge} - ${balance.paid} 應為 ${expected}，目前為 ${balance.endingBalance}`
                });
            }
        });

        seenMonths.add(entry.month);
        previousHash = seal?.hash || computedHash;
        previousMonthCode = monthCode === null ? previousMonthCode : monthCode;
    });

    return {
        ok: problems.filter(problem => problem.severity === 'critical').length === 0,
        count: entries.length,
        sealedCount,
        latestMonth: entries.length ? entries[entries.length - 1].month : null,
        latestHash: entries.length ? (entries[entries.length - 1].seal?.hash || null) : null,
        problems
    };
}

function getBalanceTotals(balances) {
    return (balances || []).reduce((acc, balance) => {
        acc.priorBalance += toNumber(balance.priorBalance);
        acc.subscriptionFee += toNumber(balance.subscriptionFee);
        acc.tempCharge += toNumber(balance.tempCharge);
        acc.paid += toNumber(balance.paid);
        acc.endingBalance += toNumber(balance.endingBalance);
        if (toNumber(balance.endingBalance) > 0) {
            acc.receivable += toNumber(balance.endingBalance);
            acc.unpaidMembers += 1;
        }
        return acc;
    }, {
        priorBalance: 0,
        subscriptionFee: 0,
        tempCharge: 0,
        paid: 0,
        endingBalance: 0,
        receivable: 0,
        unpaidMembers: 0
    });
}

function getBusinessFingerprint(db) {
    return sha256(stableStringify({
        currentMonth: db.currentMonth || null,
        baseMonth: db.baseMonth || null,
        bankInfo: db.bankInfo || '',
        reminderStyle: db.reminderStyle || '',
        members: db.members || [],
        platforms: db.platforms || [],
        subscriptions: db.subscriptions || [],
        payments: db.payments || [],
        tempCharges: db.tempCharges || [],
        history: db.history || []
    }));
}

function getSystemSnapshot(db) {
    if (!db) {
        return {
            ok: false,
            health: {
                status: 'risk',
                label: '資料不可讀',
                warningCount: 1,
                criticalCount: 1,
                ledgerOk: false
            },
            counts: {},
            totals: {},
            history: {},
            ledger: {}
        };
    }

    normalizeDatabaseRelations(db);
    const balances = calculateCurrentMonthBalances(db);
    const totals = getBalanceTotals(balances);
    const warnings = findAccountingWarnings(db);
    const criticalCount = warnings.filter(warning => warning.severity === 'critical').length;
    const ledger = getLedgerSummary(db);
    const history = db.history || [];
    const historyIntegrity = getHistoryIntegrity(db);
    const activePayments = activeTransactions(db.payments);
    const voidedPayments = (db.payments || []).filter(isTransactionVoided);
    const activeTempCharges = activeTransactions(db.tempCharges);
    const voidedTempCharges = (db.tempCharges || []).filter(isTransactionVoided);
    const activeMembers = (db.members || []).filter(member => !isEntityArchived(member));
    const archivedMembers = (db.members || []).filter(isEntityArchived);
    const activePlatforms = (db.platforms || []).filter(platform => !isEntityArchived(platform));
    const archivedPlatforms = (db.platforms || []).filter(isEntityArchived);
    const status = criticalCount > 0 || !ledger.ok || !historyIntegrity.ok
        ? 'risk'
        : warnings.length > 0 || ledger.count === 0
            ? 'warning'
            : 'clean';

    return {
        ok: status !== 'risk',
        fingerprint: getBusinessFingerprint(db),
        currentMonth: db.currentMonth,
        generatedAt: new Date().toISOString(),
        health: {
            status,
            label: status === 'clean' ? '乾淨可用' : status === 'warning' ? '可用但需確認' : '高風險',
            warningCount: warnings.length,
            criticalCount,
            ledgerOk: ledger.ok
        },
        counts: {
            members: (db.members || []).length,
            activeMembers: activeMembers.length,
            archivedMembers: archivedMembers.length,
            platforms: (db.platforms || []).length,
            activePlatforms: activePlatforms.length,
            archivedPlatforms: archivedPlatforms.length,
            subscriptions: (db.subscriptions || []).length,
            payments: activePayments.length,
            paymentRecords: (db.payments || []).length,
            voidedPayments: voidedPayments.length,
            tempCharges: activeTempCharges.length,
            tempChargeRecords: (db.tempCharges || []).length,
            voidedTempCharges: voidedTempCharges.length,
            history: history.length,
            ledger: ledger.count
        },
        totals,
        history: {
            count: history.length,
            latestMonth: history.length ? history[history.length - 1].month : null,
            integrity: historyIntegrity
        },
        ledger: {
            ok: ledger.ok,
            count: ledger.count,
            lastHash: ledger.lastHash,
            latest: ledger.latest || null
        }
    };
}

function recalculateHistoryBalances(db) {
    if (!db.history || !Array.isArray(db.history) || db.history.length === 0) {
        return db;
    }
    normalizeDatabaseRelations(db);

    const historyEntries = [...db.history].sort((a, b) => {
        const aCode = monthToCode(a.month) ?? 0;
        const bCode = monthToCode(b.month) ?? 0;
        return aCode - bCode;
    });

    const rollingBalances = {};
    (historyEntries[0].balances || []).forEach(balance => {
        rollingBalances[memberRecordKey(balance)] = toNumber(balance.priorBalance);
    });

    historyEntries.forEach((entry, index) => {
        const monthStr = entry.month;

        if (index > 0) {
            const previousEntry = historyEntries[index - 1];
            (previousEntry.balances || []).forEach(previousBalance => {
                rollingBalances[memberRecordKey(previousBalance)] = toNumber(previousBalance.endingBalance);
            });
        }

        (entry.balances || []).forEach(balance => {
            const key = memberRecordKey(balance);
            if (rollingBalances[key] === undefined) {
                rollingBalances[key] = toNumber(balance.priorBalance);
            }

            const member = resolveMember(db, balance) || { id: balance.memberId, name: balance.memberName };
            const priorBalance = rollingBalances[key];
            const subscriptionFee = calculateMemberMonthlyFee(member, db, monthStr);
            const tempCharge = activeTransactions(entry.tempCharges)
                .filter(charge => isMemberRecord(charge, member))
                .reduce((sum, charge) => sum + toNumber(charge.amount), 0);
            const paid = activeTransactions(entry.payments)
                .filter(payment => isMemberRecord(payment, member))
                .reduce((sum, payment) => sum + toNumber(payment.amount), 0);

            if (member.id) balance.memberId = member.id;
            balance.priorBalance = priorBalance;
            balance.subscriptionFee = subscriptionFee;
            balance.tempCharge = tempCharge;
            balance.paid = paid;
            balance.endingBalance = priorBalance + subscriptionFee + tempCharge - paid;
        });
    });

    const lastEntry = historyEntries[historyEntries.length - 1];
    (db.members || []).forEach(member => {
        const lastBalance = (lastEntry.balances || []).find(balance => isMemberRecord(balance, member));
        if (lastBalance) {
            member.priorBalance = toNumber(lastBalance.endingBalance);
        }
    });

    return db;
}

function addWarning(warnings, severity, code, title, detail, impact) {
    warnings.push({ severity, code, title, detail, impact });
}

function findAccountingWarnings(db, monthStr = db && db.currentMonth) {
    const warnings = [];
    if (!db) {
        addWarning(warnings, 'critical', 'database_unavailable', '資料庫無法讀取', '系統目前無法讀取帳務資料。');
        return warnings;
    }

    if (monthToCode(db.currentMonth) === null) {
        addWarning(warnings, 'critical', 'invalid_current_month', '目前帳期格式錯誤', `currentMonth=${db.currentMonth || '(空)'}`);
    }
    if (db.baseMonth && monthToCode(db.baseMonth) === null) {
        addWarning(warnings, 'warning', 'invalid_base_month', '起始帳期格式錯誤', `baseMonth=${db.baseMonth}`);
    }

    const ledgerStatus = verifyLedger(db);
    if (!ledgerStatus.ok) {
        addWarning(
            warnings,
            'critical',
            'ledger_integrity_failed',
            '帳務事件鏈驗證失敗',
            `事件鏈問題：${ledgerStatus.problems.join(', ')}`,
            '請先從備份或事件紀錄確認資料是否被手動改動，再進行月結。'
        );
    }

    const memberNameCounts = new Map();
    (db.members || []).forEach(member => {
        memberNameCounts.set(member.name, (memberNameCounts.get(member.name) || 0) + 1);
        const priorBalance = typeof member.priorBalance === 'number' ? member.priorBalance : parseFloat(member.priorBalance);
        if (!isFiniteNumber(priorBalance)) {
            addWarning(warnings, 'critical', 'invalid_prior_balance', '成員期初餘額不是有效數字', `${member.name} 的 priorBalance=${member.priorBalance}`);
        }
        if (member.customFee !== null && member.customFee !== undefined && member.customFee !== '' && !Number.isFinite(parseFloat(member.customFee))) {
            addWarning(warnings, 'critical', 'invalid_custom_fee', '自訂月費不是有效數字', `${member.name} 的 customFee=${member.customFee}`);
        }
    });
    memberNameCounts.forEach((count, name) => {
        if (count > 1) {
            addWarning(warnings, 'critical', 'duplicate_member_name', '成員姓名重複', `${name} 出現 ${count} 次；目前訂閱與交易用姓名關聯，重名會造成帳務歸戶錯誤。`);
        }
    });

    const platformNameCounts = new Map();
    (db.platforms || []).forEach(platform => {
        platformNameCounts.set(platform.name, (platformNameCounts.get(platform.name) || 0) + 1);
        const mode = platform.billingMode || 'fixed';
        const rawAmount = mode === 'split' ? platform.totalCost : platform.price;
        const amount = typeof rawAmount === 'number' ? rawAmount : parseFloat(rawAmount);
        if (!Number.isFinite(amount) || amount < 0) {
            addWarning(warnings, 'critical', 'invalid_platform_price', '平台價格不是有效金額', `${platform.name} 的金額設定異常。`);
        }
    });
    platformNameCounts.forEach((count, name) => {
        if (count > 1) {
            addWarning(warnings, 'critical', 'duplicate_platform_name', '平台名稱重複', `${name} 出現 ${count} 次；目前訂閱用平台名稱關聯，重名會造成單價抓錯。`);
        }
    });

    const memberIds = new Set((db.members || []).map(member => member.id));
    const memberNames = new Set((db.members || []).map(member => member.name));
    const platformIds = new Set((db.platforms || []).map(platform => platform.id));
    const platformNames = new Set((db.platforms || []).map(platform => platform.name));
    const activeByMemberPlatform = new Map();

    (db.subscriptions || []).forEach(subscription => {
        const member = resolveMember(db, subscription);
        const platform = resolvePlatform(db, subscription);
        if ((subscription.memberId && !memberIds.has(subscription.memberId)) || (!subscription.memberId && !memberNames.has(subscription.memberName))) {
            addWarning(warnings, 'critical', 'orphan_subscription_member', '訂閱找不到成員', `${subscription.id || '(無 id)'} 指向不存在的成員 ${subscription.memberName}`);
        }
        if (subscription.platformName !== '自訂' && ((subscription.platformId && !platformIds.has(subscription.platformId)) || (!subscription.platformId && !platformNames.has(subscription.platformName)))) {
            addWarning(warnings, 'critical', 'orphan_subscription_platform', '訂閱找不到平台', `${subscription.id || '(無 id)'} 指向不存在的平台 ${subscription.platformName}`);
        }

        const startCode = monthToCode(subscription.startMonth);
        const exitCode = subscription.exitMonth ? monthToCode(subscription.exitMonth) : null;
        if (startCode === null) {
            addWarning(warnings, 'critical', 'invalid_subscription_start', '訂閱起算月格式錯誤', `${subscription.id || '(無 id)'} 起算月=${subscription.startMonth || '(空)'}`);
        }
        if (subscription.exitMonth && exitCode === null) {
            addWarning(warnings, 'critical', 'invalid_subscription_exit', '訂閱退出月格式錯誤', `${subscription.id || '(無 id)'} 退出月=${subscription.exitMonth}`);
        }
        if (startCode !== null && exitCode !== null && exitCode < startCode) {
            addWarning(warnings, 'critical', 'subscription_exit_before_start', '訂閱退出月早於起算月', `${subscription.id || '(無 id)'} ${subscription.startMonth} -> ${subscription.exitMonth}`);
        }

        if (
            isSubActiveInMonth(subscription, monthStr) &&
            isEntityBillableInMonth(member, monthStr) &&
            isEntityBillableInMonth(platform, monthStr)
        ) {
            const key = `${member ? member.id : subscription.memberName}::${platform ? platform.id : subscription.platformName}`;
            if (!activeByMemberPlatform.has(key)) activeByMemberPlatform.set(key, []);
            activeByMemberPlatform.get(key).push(subscription);
        }
    });

    activeByMemberPlatform.forEach(subscriptions => {
        if (subscriptions.length <= 1) return;
        if (subscriptions.every(isIntentionalAdditionalSeat)) return;

        const first = subscriptions[0];
        const member = resolveMember(db, first);
        const platform = resolvePlatform(db, first);
        const memberName = member ? member.name : first.memberName;
        const platformName = platform ? platform.name : first.platformName;
        const unitAmount = platform && (platform.billingMode || 'fixed') !== 'split'
            ? toNumber(platform.price)
            : getPlatformPriceForMonth(db, first, monthStr);
        addWarning(
            warnings,
            'critical',
            'duplicate_active_subscription',
            '同一成員同一平台本月重複啟用',
            `${memberName} 在 ${monthStr} 有 ${subscriptions.length} 筆 ${platformName}：${subscriptions.map(s => `${s.id || '(無 id)'}(${s.startMonth}${s.exitMonth ? `-${s.exitMonth}` : '-未退出'})`).join(', ')}`,
            unitAmount ? `若其中一筆不是有意的第二人份，${monthStr} 可能多收約 ${unitAmount * (subscriptions.length - 1)} 元。` : undefined
        );
    });

    (db.platforms || [])
        .filter(platform => (platform.billingMode || 'fixed') === 'split')
        .forEach(platform => {
            const activeCount = (db.subscriptions || []).filter(subscription => (
                isPlatformRecord(subscription, platform) &&
                isSubActiveInMonth(subscription, monthStr) &&
                isEntityBillableInMonth(platform, monthStr) &&
                isEntityBillableInMonth(resolveMember(db, subscription), monthStr)
            )).length;
            if (activeCount === 0) return;
            const totalCost = toNumber(platform.totalCost);
            const perPerson = Math.round(totalCost / activeCount);
            const collected = perPerson * activeCount;
            if (collected !== totalCost) {
                addWarning(
                    warnings,
                    'warning',
                    'split_rounding_delta',
                    '動態均分有四捨五入差額',
                    `${platform.name} ${monthStr}: 總費用 ${totalCost} / ${activeCount} 人 = 每人 ${perPerson}，合計 ${collected}。`,
                    `本月會產生 ${collected - totalCost} 元差額，需要指定誰吸收或建立尾差規則。`
                );
            }
        });

    [...(db.payments || []), ...(db.tempCharges || [])].forEach(transaction => {
        const amount = toNumber(transaction.amount, NaN);
        const isVoided = isTransactionVoided(transaction);
        if (!Number.isFinite(amount)) {
            addWarning(warnings, 'critical', 'invalid_transaction_amount', '交易金額不是有效數字', `${transaction.id || '(無 id)'} 金額=${transaction.amount}`);
        }
        if (amount < 0 && !isVoided) {
            addWarning(warnings, 'warning', 'negative_transaction_amount', '交易金額為負數', `${transaction.id || '(無 id)'} 金額=${transaction.amount}；若是沖銷，建議改用明確的調整類型。`);
        }
        if (isVoided && !transaction.voidedAt) {
            addWarning(warnings, 'warning', 'voided_transaction_missing_time', '作廢交易缺少時間戳', `${transaction.id || '(無 id)'} 已作廢但沒有 voidedAt。`);
        }
        if (transaction.memberId && !memberIds.has(transaction.memberId)) {
            addWarning(warnings, 'critical', 'orphan_transaction_member', '交易找不到成員', `${transaction.id || '(無 id)'} 指向不存在的 memberId ${transaction.memberId}`);
        } else if (!transaction.memberId && transaction.memberName && !memberNames.has(transaction.memberName)) {
            addWarning(warnings, 'critical', 'orphan_transaction_member', '交易找不到成員', `${transaction.id || '(無 id)'} 指向不存在的成員 ${transaction.memberName}`);
        }
    });

    const historyIntegrity = getHistoryIntegrity(db);
    const historyWarningTitles = {
        invalid_history_month: '歷史帳期格式錯誤',
        duplicate_history_month: '歷史帳期重複封存',
        history_month_order: '歷史帳期排序異常',
        missing_history_seal: '歷史封存缺少指紋',
        history_seal_mismatch: '歷史封存後內容被改動',
        history_chain_mismatch: '歷史封存鏈不連續',
        history_balance_formula_mismatch: '歷史帳務公式不平'
    };
    historyIntegrity.problems.forEach(problem => {
        addWarning(
            warnings,
            problem.severity,
            problem.code,
            historyWarningTitles[problem.code] || '歷史封存完整性提醒',
            problem.detail,
            problem.severity === 'critical' ? '請先從備份或事件鏈確認歷史帳是否被改動，再進行月結或設定更新。' : undefined
        );
    });

    if ((db.history || []).some(entry => entry.month === db.currentMonth)) {
        addWarning(warnings, 'warning', 'current_month_already_in_history', '目前帳期已存在於歷史結算', `${db.currentMonth} 已封存在 history；再次結算前要確認是否為還原後狀態。`);
    }

    const lastHistory = (db.history || [])[db.history.length - 1];
    if (lastHistory) {
        const lastBalances = new Map((lastHistory.balances || []).map(balance => [memberRecordKey(balance), toNumber(balance.endingBalance)]));
        (db.members || []).forEach(member => {
            const key = member.id || member.name;
            if (lastBalances.has(key) && toNumber(member.priorBalance) !== lastBalances.get(key)) {
                addWarning(
                    warnings,
                    'critical',
                    'member_prior_not_last_history',
                    '成員期初餘額與最近歷史期末不一致',
                    `${member.name}: 目前期初 ${member.priorBalance}，${lastHistory.month} 期末 ${lastBalances.get(key)}。`
                );
            }
        });
    }

    return warnings;
}

module.exports = {
    MONTH_RE,
    monthToCode,
    previousMonthString,
    toNumber,
    normalizeDatabaseRelations,
    appendLedgerEvent,
    ensureLedger,
    ensureHistorySeals,
    getLedgerSummary,
    getClosePreview,
    getHistoryIntegrity,
    getSystemSnapshot,
    sealHistoryEntry,
    verifyLedger,
    resolveMember,
    resolvePlatform,
    isMemberRecord,
    isPlatformRecord,
    isEntityArchived,
    isEntityBillableInMonth,
    isTransactionVoided,
    findRecentDuplicateTransaction,
    activeTransactions,
    isSubActiveInMonth,
    getPlatformPriceForMonth,
    calculateMemberMonthlyFee,
    calculateCurrentMonthBalances,
    recalculateHistoryBalances,
    findAccountingWarnings
};
