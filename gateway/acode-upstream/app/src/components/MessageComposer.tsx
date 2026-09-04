import React, { useRef, useState } from "react";
import type { Attachment, ModelOption } from "../types";
import { fileToBase64, fmtBytes } from "../utils";

interface MessageComposerProps {
  onSend: (
    prompt: string,
    attachments: Attachment[],
    options?: { model?: string; effort?: string; multiAgentMode?: string }
  ) => Promise<void>;
  isStreaming: boolean;
  onInterrupt: () => Promise<void>;
  disabled?: boolean;
  models?: ModelOption[];
}

export const MessageComposer: React.FC<MessageComposerProps> = ({
  onSend,
  isStreaming,
  onInterrupt,
  disabled,
  models = []
}) => {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [sending, setSending] = useState(false);
  const [isComposing, setIsComposing] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("medium");
  const [multiAgentMode, setMultiAgentMode] = useState("");

  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value);
    // Auto-grow textarea height
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 180)}px`;
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !isComposing) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const newAttachments: Attachment[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      try {
        const dataBase64 = await fileToBase64(file);
        newAttachments.push({
          name: file.name,
          mimeType: file.type || "application/octet-stream",
          size: file.size,
          dataBase64
        });
      } catch {}
    }

    setAttachments((prev) => [...prev, ...newAttachments]);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const removeAttachment = (index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSend = async () => {
    const promptToSend = text.trim();
    if ((!promptToSend && attachments.length === 0) || sending || disabled) return;

    setSending(true);
    try {
      await onSend(promptToSend, attachments, {
        model: model || undefined,
        effort: effort || undefined,
        multiAgentMode: multiAgentMode || undefined
      });
      setText("");
      setAttachments([]);
      if (textareaRef.current) {
        textareaRef.current.style.height = "auto";
      }
    } catch {
      // Error handled by parent hook
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="message-composer-wrapper">
      {/* Attachments Preview Bar */}
      {attachments.length > 0 && (
        <div className="composer-attachments-bar">
          {attachments.map((att, idx) => (
            <div key={idx} className="composer-att-chip">
              <span className="composer-att-icon">📎</span>
              <span className="composer-att-name">{att.name}</span>
              {att.size && (
                <span className="composer-att-size">({fmtBytes(att.size)})</span>
              )}
              <button
                className="composer-att-remove"
                onClick={() => removeAttachment(idx)}
                type="button"
                title="移除附件"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Advanced Options Bar */}
      {showSettings && (
        <div className="composer-options-bar">
          <div className="composer-option-item">
            <span className="opt-label">模型:</span>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="opt-select"
            >
              <option value="">默认模型</option>
              {models.map((item) => <option key={item.id} value={item.id}>{item.name || item.id}</option>)}
            </select>
          </div>

          <div className="composer-option-item">
            <span className="opt-label">思考强度:</span>
            <select
              value={effort}
              onChange={(e) => setEffort(e.target.value)}
              className="opt-select"
            >
              <option value="low">低 (Fast)</option>
              <option value="medium">中 (Medium)</option>
              <option value="high">高 (Deep)</option>
            </select>
          </div>

          <div className="composer-option-item">
            <span className="opt-label">Agent 模式:</span>
            <select
              value={multiAgentMode}
              onChange={(e) => setMultiAgentMode(e.target.value)}
              className="opt-select"
            >
              <option value="">单主代理</option>
              <option value="subagent">子代理分工</option>
            </select>
          </div>
        </div>
      )}

      {/* Main Input Box */}
      <div className="composer-main-box">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={handleTextChange}
          onKeyDown={handleKeyDown}
          onCompositionStart={() => setIsComposing(true)}
          onCompositionEnd={() => setIsComposing(false)}
          placeholder={
            disabled
              ? "请先选择设备和有效会话..."
              : "给 Codex 发送消息、代码需求或说明 (Shift + Enter 换行)..."
          }
          disabled={disabled || sending}
          className="composer-textarea"
          rows={1}
        />

        <div className="composer-tools-row">
          <div className="composer-tools-left">
            <input
              type="file"
              ref={fileInputRef}
              onChange={handleFileSelect}
              multiple
              style={{ display: "none" }}
            />
            <button
              className="composer-tool-btn"
              onClick={() => fileInputRef.current?.click()}
              disabled={disabled || sending}
              type="button"
              title="添加代码文件或图片附件"
            >
              📎 <span className="tool-btn-text">附件</span>
            </button>

            <button
              className={`composer-tool-btn ${showSettings ? "active" : ""}`}
              onClick={() => setShowSettings(!showSettings)}
              type="button"
              title="配置模型与推理参数"
            >
              ⚙ <span className="tool-btn-text">{model ? model : "模型选项"}</span>
            </button>
          </div>

          <div className="composer-tools-right">
            {isStreaming ? (
              <button
                className="btn-composer-interrupt"
                onClick={onInterrupt}
                type="button"
                title="立即停止当前任务执行"
              >
                ⏹ 停止执行
              </button>
            ) : (
              <button
                className="btn-composer-send"
                onClick={handleSend}
                disabled={disabled || sending || (!text.trim() && attachments.length === 0)}
                type="button"
              >
                {sending ? "发送中..." : "↑ 发送"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
