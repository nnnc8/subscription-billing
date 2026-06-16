import React from 'react';
import type { AIMessage } from '../types/billing.js';

interface AiAssistantTabProps {
  aiMessages: AIMessage[];
  aiInput: string;
  setAiInput: (v: string) => void;
  aiLoading: boolean;
  handleSendChatMessage: (e: React.FormEvent) => void;
}

export const AiAssistantTab: React.FC<AiAssistantTabProps> = ({
  aiMessages,
  aiInput,
  setAiInput,
  aiLoading,
  handleSendChatMessage
}) => {
  return (
    <div className="ai-assistant-container">
      <div className="ai-chat-header">
        <div className="ai-chat-header-title">
          <span style={{ fontSize: '1.5rem' }}>✨</span>
          <div>
            <h2>AI 帳務助理</h2>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
              結合 RAG 向量搜尋與智能 Tool Calling 對話查帳
            </span>
          </div>
        </div>
        <div className="ai-status-badge">
          <span className="ai-typing-dot" style={{ width: '8px', height: '8px', background: '#34d399', opacity: 1, animation: 'none' }}></span>
          Google AI Studio 已啟用
        </div>
      </div>

      <div className="ai-messages-area" id="ai-messages-container">
        {aiMessages.map((msg, i) => (
          <div key={i} className={`ai-message ${msg.role === 'user' ? 'user' : msg.role === 'system' ? 'system-info' : 'assistant'}`}>
            {msg.tool_calls && msg.tool_calls.map((t, idx) => (
              <div key={idx} className="ai-message-tool-badge">
                🛠️ 呼叫工具: {t.function.name}
              </div>
            ))}
            {msg.content}
          </div>
        ))}
        {aiLoading && (
          <div className="ai-message assistant" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <div className="ai-typing-indicator">
              <span className="ai-typing-dot"></span>
              <span className="ai-typing-dot"></span>
              <span className="ai-typing-dot"></span>
            </div>
            <span>助理正在思考並查詢資料庫中...</span>
          </div>
        )}
      </div>

      <div className="ai-input-area">
        <div className="ai-chat-suggestions">
          <span className="ai-suggestion-chip" style={{ cursor: 'pointer' }} onClick={() => setAiInput("有哪些會計警告或異常嗎？")}>🔍 檢查會計警告</span>
          <span className="ai-suggestion-chip" style={{ cursor: 'pointer' }} onClick={() => setAiInput("系統當前帳務的整體概況為何？")}>📊 系統整體概況</span>
          <span className="ai-suggestion-chip" style={{ cursor: 'pointer' }} onClick={() => setAiInput("這個月誰還沒有結清帳款？")}>💸 誰還沒繳錢</span>
          <span className="ai-suggestion-chip" style={{ cursor: 'pointer' }} onClick={() => setAiInput("查詢 Member Beta 的歷史付款紀錄")}>🕒 Beta 歷史紀錄</span>
        </div>
        <form className="ai-input-form" onSubmit={handleSendChatMessage}>
          <input
            type="text"
            className="ai-chat-input"
            placeholder="問我任何關於帳務的問題，例如: 'Beta 以前繳了多少錢？'..."
            value={aiInput}
            onChange={(e) => setAiInput(e.target.value)}
            disabled={aiLoading}
          />
          <button type="submit" className="ai-chat-send-btn" disabled={aiLoading || !aiInput.trim()}>
            傳送 ✨
          </button>
        </form>
      </div>
    </div>
  );
};
