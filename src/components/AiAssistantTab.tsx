import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Send } from 'lucide-react';
import type { FormEvent } from 'react';
import type { AIMessage } from '../types/billing.js';

interface AiAssistantTabProps {
  aiMessages: AIMessage[];
  aiInput: string;
  setAiInput: (v: string) => void;
  aiLoading: boolean;
  handleSendChatMessage: (event: FormEvent<HTMLFormElement>) => void;
}

const SUGGESTIONS: ReadonlyArray<{ label: string; prompt: string }> = [
  { label: '誰還沒繳錢', prompt: '這個月誰還沒有結清帳款？' },
  { label: '帳務警告', prompt: '有哪些會計警告或異常嗎？' },
  { label: '本期概況', prompt: '系統當前帳務的整體概況為何？' },
  { label: '預繳最多的人', prompt: '目前誰的預繳餘額最多？' },
];

export function AiAssistantTab({
  aiMessages,
  aiInput,
  setAiInput,
  aiLoading,
  handleSendChatMessage
}: AiAssistantTabProps) {
  return (
    <article className="card assistant">
      <header className="card-head">
        <div>
          <h2>AI 帳務助理</h2>
          <p className="meta">查詢成員餘額、付款紀錄與帳務提醒，回答來自目前的帳務資料。</p>
        </div>
      </header>

      <div className="assistant-messages" id="ai-messages-container" aria-live="polite" aria-busy={aiLoading}>
        {aiMessages.map((msg) => (
          <div key={msg.id ?? `${msg.role}-${msg.content}`} className={`bubble ${msg.role === 'user' ? 'user' : msg.role === 'system' ? 'system-info' : 'assistant'}`}>
            {msg.tool_calls && msg.tool_calls.map((t, idx) => (
              <span key={t.id ?? `${t.function.name}-${idx}`} className="tool-call">查詢工具：{t.function.name}</span>
            ))}
            {msg.role === 'user' ? (
              msg.content
            ) : (
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {msg.content}
              </ReactMarkdown>
            )}
          </div>
        ))}
        {aiLoading && (
          <div className="bubble assistant">
            <span className="typing"><span className="typing-dots" aria-hidden="true"><span /><span /><span /></span>正在查詢帳務資料…</span>
          </div>
        )}
      </div>

      <div className="suggestions">
        {SUGGESTIONS.map((item) => (
          <button key={item.label} type="button" onClick={() => setAiInput(item.prompt)}>{item.label}</button>
        ))}
      </div>
      <form className="assistant-form" onSubmit={handleSendChatMessage}>
        <input
          type="text"
          className="input"
          aria-label="詢問 AI 帳務助理"
          placeholder="例如：宇辰這三個月繳了多少？"
          value={aiInput}
          onChange={(e) => setAiInput(e.target.value)}
          disabled={aiLoading}
        />
        <button type="submit" className="btn btn-primary" disabled={aiLoading || !aiInput.trim()}>
          <Send size={16} />傳送
        </button>
      </form>
    </article>
  );
}
