import { isAIConfigured, chatCompletion } from './ai.js';
import type { Member, ReminderStyle } from '../src/types/billing.js';

interface ReminderParams {
    member: Member
    summary: {
        outstanding: number
        monthlyFee: number
        tempCharges: number
        paid: number
    }
    activeSubsText: string[]
    bankInfo: string
    currentMonth: string
    style: string
}

interface ReminderResult {
    text: string
    isAI: boolean
    note?: string
    error?: string
}

export async function generateAIReminder({ member, summary, activeSubsText, bankInfo, currentMonth, style }: ReminderParams): Promise<ReminderResult> {
    const fallbackText = getFallbackReminder({ member, summary, activeSubsText, bankInfo, currentMonth, style });

    if (!isAIConfigured()) {
        return { text: fallbackText, isAI: false, note: 'AI is not configured. Using local fallback template.' };
    }

    const tonePrompts: Record<string, string> = {
        friendly: "幽默幽默、溫柔體貼的語氣，把收費這件事包裝得像好朋友間的溫馨提醒，可以用些活潑的貼圖和親切的稱呼（如：乾爹、乾媽、共乘夥伴）。",
        professional: "專業、禮貌、商務且有條理的正式公文語氣。適合對帳和公司化管理的訂閱服務，稱呼為「親愛的會員」或「您」。",
        pirate: "狂野霸氣的海盜船長語氣！「嘿，老兄！」「揚帆起航！」把分攤服務當成是「維持海盜船運作的朗姆酒與火藥稅」，催收則是「分贓時間到了」，但依然必須清楚交代所有帳務細節（特別是應繳金額與匯款資訊）。",
        poetic: "文藝青年、帶有一點詩意與哲學感的溫柔語氣。將訂閱的串流/音樂服務形容成「灌溉生活荒蕪的養分」、「靈魂的避風港」，在交代帳務明細時，帶有對生活美好的期盼。",
        urgent: "禮貌但極具急迫性、強烈提醒儘速繳費的語氣。特別強調請在近期內撥空匯款，避免影響下期服務的使用權限。"
    };

    const targetTone = tonePrompts[style] || tonePrompts.friendly;

    const systemPrompt = `你是一個專業的帳務秘書。你的任務是為共享訂閱（如 Netflix, Spotify, YouTube Premium 等）的團員/朋友生成一份精緻的「本月訂閱費用催繳/對帳通知」。

根據以下給定的帳務數據，以及使用者指定的【語氣風格】，生成一封客製化的通知簡訊/訊息：
【語氣風格】：${targetTone}

【基本限制】：
1. 必須以繁體中文 (zh-TW) 回覆。
2. 必須清楚列出帳務明細。
3. 必須包含付款方式（銀行資訊）和最終應繳金額。
4. 如果應繳金額為 0 或小於 0（預繳），請用適當的語氣恭喜他們本月不需要匯款，並說明餘額會結轉到下個月。
5. 保持格式工整，適當使用 markdown 或換行，方便使用者直接複製發送到 LINE 等通訊軟體。
6. 不要編造或遺漏給定的真實數據（如金額、名字、銀行帳號）。
7. 請只輸出生成的通知內容本身，不要有任何「好的，這是為您生成的...」等無關的前言或結語。`;

    const userPrompt = `【帳務數據如下】：
- 成員名稱: ${member.name}
- 當前月份: ${currentMonth}
- 訂閱服務明細:
${activeSubsText.length > 0 ? activeSubsText.join('\n') : '  • 本期無訂閱項目'}
- 當月分攤費用小計: $${summary.monthlyFee.toLocaleString()} 元
- 上期結轉(前期餘額): $${member.priorBalance.toLocaleString()} 元
- 本期臨時費用加帳: $${summary.tempCharges.toLocaleString()} 元
- 本期已付金額: -$${summary.paid.toLocaleString()} 元
- 最終應繳金額: $${summary.outstanding.toLocaleString()} 元
- 匯款帳號（銀行資訊）: ${bankInfo}
`;

    try {
        const text = await chatCompletion([
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
        ], {
            temperature: 0.85,
            max_tokens: 1200
        });

        return {
            text: text.trim(),
            isAI: true
        };
    } catch (err) {
        console.error('Failed to generate AI reminder, falling back:', err);
        return {
            text: fallbackText,
            isAI: false,
            error: (err as Error).message
        };
    }
}

interface FallbackParams extends ReminderParams {}

function getFallbackReminder({ member, summary, activeSubsText, bankInfo, currentMonth, style }: FallbackParams): string {
    const absOutstanding = Math.abs(summary.outstanding);
    const useStyle = style || 'friendly';

    if (useStyle === 'friendly' || useStyle === 'poetic' || useStyle === 'pirate') {
        let balanceLine: string;
        if (summary.outstanding > 0) {
            balanceLine =
                `💸 最終需要補血的金額：$${summary.outstanding.toLocaleString()} 元\n\n` +
                `🏦 傳送門（匯款帳號）：\n` +
                `${bankInfo}\n\n` +
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
            `🔔 嗶嗶！您的月租費帳單已送達 (${currentMonth})\n` +
            `----------------------------------\n` +
            `哈囉 ${member.name}！感謝共乘訂閱專車，本期明細新鮮出爐囉：\n\n` +
            `🍿 本月嗑了哪些服務：\n` +
            (activeSubsText.length > 0 ? activeSubsText.join('\n') : '  • 本期無訂閱項目') + `\n` +
            `  (本月分攤小計: $${summary.monthlyFee.toLocaleString()} 元)\n\n` +
            `⚖️ 歷史恩怨情仇（帳務往來）：\n` +
            `  • 之前的欠債/預繳 (前期餘額): $${member.priorBalance.toLocaleString()} 元\n` +
            `  • 代墊的臨時費用: $${summary.tempCharges.toLocaleString()} 元\n` +
            `  • 本月已上繳金額: -$${summary.paid.toLocaleString()} 元\n` +
            `----------------------------------\n` +
            balanceLine
        );
    } else if (useStyle === 'minimal') {
        let balanceLine: string;
        if (summary.outstanding > 0) {
            balanceLine =
                `本期應繳總額為：💰 ${summary.outstanding.toLocaleString()} 元\n\n` +
                `🏦 匯款至：${bankInfo}\n` +
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

        const tempChargeText = summary.tempCharges !== 0 ? `• 代墊臨時費用: $${summary.tempCharges.toLocaleString()} 元\n` : '';
        const paymentText = summary.paid !== 0 ? `• 本期已付金額: -$${summary.paid.toLocaleString()} 元\n` : '';

        return (
            `嗨 ${member.name}！${currentMonth} 的訂閱費來囉～\n` +
            balanceLine + `\n\n` +
            `【明細簡覽】\n` +
            `• 本期分攤項目: $${summary.monthlyFee.toLocaleString()} 元\n` +
            `• 歷史結轉餘額: $${member.priorBalance.toLocaleString()} 元\n` +
            tempChargeText +
            paymentText
        );
    } else {
        let balanceLine: string;
        if (summary.outstanding > 0) {
            balanceLine =
                `💰 本期應繳總額：$${summary.outstanding.toLocaleString()} 元\n\n` +
                `🏦 匯款資訊：\n` +
                `${bankInfo}\n\n` +
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
            `📢 訂閱對帳單 (${currentMonth})\n` +
            `----------------------------------\n` +
            `親愛的 ${member.name}，本期明細如下：\n\n` +
            `🔹 本月分攤項目：\n` +
            (activeSubsText.length > 0 ? activeSubsText.join('\n') : '  • 本期無訂閱項目') + `\n` +
            `  (本月訂閱費用小計: $${summary.monthlyFee.toLocaleString()} 元)\n\n` +
            `🔹 帳務往來明細：\n` +
            `  • 上期結轉 (前期餘額): $${member.priorBalance.toLocaleString()} 元\n` +
            `  • 本期臨時費用加帳: $${summary.tempCharges.toLocaleString()} 元\n` +
            `  • 本期已繳納款項: -$${summary.paid.toLocaleString()} 元\n` +
            `----------------------------------\n` +
            balanceLine
        );
    }
}
