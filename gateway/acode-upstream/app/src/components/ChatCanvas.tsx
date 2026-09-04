import React, { useEffect, useRef, useState } from "react";
import type { ApprovalRequest, Session, TurnMessage } from "../types";
import { fmtBytes, fmtDuration, fmtTime, statusBadgeColor } from "../utils";
import { ApprovalCard } from "./ApprovalCard";
import { DiffView } from "./DiffView";
import { MarkdownView } from "./MarkdownView";

interface ChatCanvasProps {
  turns: TurnMessage[];
  session?: Session;
  isStreaming: boolean;
  onDecision: (requestId: string, decision: "approve" | "deny", amendment?: string[]) => Promise<void>;
  onInterrupt: () => Promise<void>;
  onResume: () => Promise<void>;
  onDownloadFile: (filePath: string) => Promise<void>;
}

export const ChatCanvas: React.FC<ChatCanvasProps> = ({
  turns,
  session,
  isStreaming,
  onDecision,
  onInterrupt,
  onResume,
  onDownloadFile
}) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [openReasoning, setOpenReasoning] = useState<Record<string, boolean>>({});
  const [openOutputs, setOpenOutputs] = useState<Record<string, boolean>>({});

  // Auto-scroll when new content arrives if user is near bottom
  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior: "smooth"
      });
    }
  }, [turns, autoScroll]);

  const handleScroll = () => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    const isBottom = scrollHeight - scrollTop - clientHeight < 80;
    setAutoScroll(isBottom);
  };

  const toggleReasoning = (turnId: string) => {
    setOpenReasoning((prev) => ({ ...prev, [turnId]: !prev[turnId] }));
  };

  const toggleOutput = (toolId: string) => {
    setOpenOutputs((prev) => ({ ...prev, [toolId]: !prev[toolId] }));
  };

  if (!turns || turns.length === 0) {
    return (
      <div className="canvas-empty-state" ref={scrollRef}>
        <div className="empty-mark">✦</div>
        <h2>准备就绪</h2>
        <p>在下方输入框发送需求，或上传附件继续当前会话。</p>
        <div className="empty-shortcuts">
          <div className="shortcut-chip">支持增量流式渲染与代码高亮</div>
          <div className="shortcut-chip">支持终端命令展开与危险操作审批</div>
          <div className="shortcut-chip">支持断线游标无缝恢复</div>
        </div>
      </div>
    );
  }

  return (
    <div className="chat-canvas" ref={scrollRef} onScroll={handleScroll}>
      {turns.map((turn, turnIndex) => {
        const isLast = turnIndex === turns.length - 1;
        const isTurnStreaming = isLast && (turn.assistantStatus === "streaming" || isStreaming);
        const reasoningExpanded = openReasoning[turn.turnId] ?? false;

        return (
          <div key={turn.turnId || turnIndex} className="turn-container">
            {/* User Message Bubble */}
            {turn.userPrompt && (
              <div className="user-message-row">
                <div className="user-bubble">
                  {turn.isInterjection && (
                    <div className="interjection-badge">✦ 插话输入</div>
                  )}
                  <div className="user-text">{turn.userPrompt}</div>

                  {turn.userAttachments && turn.userAttachments.length > 0 && (
                    <div className="user-attachments">
                      {turn.userAttachments.map((att, attIdx) => (
                        <div key={attIdx} className="attachment-chip">
                          <span className="att-icon">📎</span>
                          <span className="att-name">{att.name}</span>
                          {att.size && (
                            <span className="att-size">({fmtBytes(att.size)})</span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="user-timestamp">{fmtTime(turn.userTime)}</div>
                </div>
              </div>
            )}

            {/* Assistant Message Bubble */}
            <div className="assistant-bubble-row">
              <div className="assistant-card">
                {/* Assistant Card Header */}
                <div className="assistant-header">
                  <div className="assistant-identity">
                    <span className="assistant-logo">✦</span>
                    <span className="assistant-title">CODEX AGENT</span>
                    <span
                      className="assistant-status-pill"
                      style={{
                        borderColor: statusBadgeColor(turn.assistantStatus),
                        color: statusBadgeColor(turn.assistantStatus)
                      }}
                    >
                      <i className={`status-dot ${isTurnStreaming ? "pulse" : ""}`} />
                      {turn.assistantStatus === "streaming"
                        ? "思考生成中"
                        : turn.assistantStatus === "waiting-approval"
                        ? "等待审批中"
                        : turn.assistantStatus === "cancelled"
                        ? "已中断"
                        : turn.assistantStatus === "failed"
                        ? "执行异常"
                        : "执行完成"}
                    </span>
                  </div>

                  <div className="assistant-header-right">
                    {turn.tokenUsage && (
                      <span className="token-badge" title="消耗 Token 数量">
                        {turn.tokenUsage.totalTokens?.toLocaleString()} tokens
                      </span>
                    )}

                    {isTurnStreaming && (
                      <button
                        className="btn-interrupt-small"
                        onClick={onInterrupt}
                        type="button"
                        title="立即停止当前任务"
                      >
                        ⏹ 中断
                      </button>
                    )}

                    {turn.assistantStatus === "cancelled" && isLast && (
                      <button
                        className="btn-resume-small"
                        onClick={onResume}
                        type="button"
                        title="恢复继续当前任务"
                      >
                        ↻ 恢复
                      </button>
                    )}
                  </div>
                </div>

                {/* Reasoning Fold */}
                {(turn.reasoning || (turn.reasoningSummary && turn.reasoningSummary.length > 0)) && (
                  <div className="reasoning-fold">
                    <button
                      className="reasoning-toggle-btn"
                      onClick={() => toggleReasoning(turn.turnId)}
                      type="button"
                    >
                      <span className="reasoning-icon">🧠</span>
                      <span className="reasoning-label">
                        {turn.reasoningCompleted ? "已完成思考过程" : "正在思考推理..."}
                      </span>
                      <span className="reasoning-arrow">
                        {reasoningExpanded ? "▲ 收起" : "▼ 展开"}
                      </span>
                    </button>

                    {reasoningExpanded && (
                      <div className="reasoning-content">
                        {turn.reasoningSummary && turn.reasoningSummary.length > 0 && (
                          <div className="reasoning-summary-list">
                            {turn.reasoningSummary.map((sum, sIdx) => (
                              <div key={sIdx} className="summary-item">
                                • {sum}
                              </div>
                            ))}
                          </div>
                        )}
                        {turn.reasoning && (
                          <pre className="reasoning-text">
                            <code>{turn.reasoning}</code>
                          </pre>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* Tool Calls & Command Executions */}
                {turn.tools && turn.tools.length > 0 && (
                  <div className="tools-section">
                    {turn.tools.map((tool, toolIdx) => {
                      if (tool.type === "commandExecution") {
                        const outputExpanded = openOutputs[tool.id] ?? true;
                        return (
                          <div key={tool.id || toolIdx} className="terminal-card">
                            <div
                              className="terminal-header"
                              onClick={() => toggleOutput(tool.id)}
                            >
                              <div className="terminal-prompt-line">
                                <span className="term-symbol">$</span>
                                <span className="term-command">{tool.command}</span>
                              </div>
                              <div className="terminal-header-meta">
                                {tool.durationMs && (
                                  <span className="term-duration">
                                    {fmtDuration(tool.durationMs)}
                                  </span>
                                )}
                                <span
                                  className={`term-status ${tool.status} ${
                                    tool.exitCode !== undefined && tool.exitCode !== 0 ? "failed" : ""
                                  }`}
                                >
                                  {tool.status === "running"
                                    ? "执行中"
                                    : tool.exitCode !== undefined && tool.exitCode !== 0
                                    ? `退出码 ${tool.exitCode}`
                                    : "已完成"}
                                </span>
                                <span className="term-toggle">
                                  {outputExpanded ? "▲" : "▼"}
                                </span>
                              </div>
                            </div>

                            {tool.cwd && (
                              <div className="terminal-cwd">
                                <span>在目录:</span> <code>{tool.cwd}</code>
                              </div>
                            )}

                            {outputExpanded && tool.aggregatedOutput && (
                              <pre className="terminal-stdout">
                                <code>{tool.aggregatedOutput}</code>
                              </pre>
                            )}
                          </div>
                        );
                      }

                      if (tool.type === "fileChange") {
                        return (
                          <DiffView
                            key={tool.id || toolIdx}
                            diff={tool.diff || ""}
                            filePath={tool.path}
                            kind={tool.kind}
                            onDownload={onDownloadFile}
                          />
                        );
                      }

                      if (tool.type === "subAgentActivity") {
                        return (
                          <div key={toolIdx} className="subagent-activity-card">
                            <span className="subagent-icon">⚲</span>
                            <span className="subagent-title">子代理活动</span>
                            <code className="subagent-path">
                              {tool.agentPath || tool.agentThreadId}
                            </code>
                            <span className={`subagent-badge ${tool.kind}`}>
                              {tool.kind === "started" ? "启动中" : "已执行"}
                            </span>
                          </div>
                        );
                      }

                      return null;
                    })}
                  </div>
                )}

                {/* Unified Diffs from turn */}
                {turn.diffs && turn.diffs.length > 0 && (
                  <div className="turn-diffs-section">
                    {turn.diffs.map((d, dIdx) => (
                      <DiffView key={dIdx} diff={d} />
                    ))}
                  </div>
                )}

                {/* Pending Approvals */}
                {turn.approvals && turn.approvals.length > 0 && (
                  <div className="turn-approvals-section">
                    {turn.approvals.map((req) => (
                      <ApprovalCard
                        key={req.requestId}
                        approval={req}
                        onDecision={onDecision}
                      />
                    ))}
                  </div>
                )}

                {/* Final or Streaming Markdown Content */}
                <div className="assistant-content">
                  <MarkdownView
                    content={turn.text}
                    isStreaming={isTurnStreaming}
                  />
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
};
