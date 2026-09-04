import React, { useEffect, useState } from "react";
import type { ModelOption } from "../types";

interface NewSessionModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (params: {
    workspacePath: string;
    prompt: string;
    title?: string;
    sessionPolicyMode: "confirm" | "full-access";
    confirmFullAccess?: boolean;
    model?: string;
    effort?: string;
    multiAgentMode?: string;
  }) => Promise<any>;
  defaultWorkspacePath?: string;
  models?: ModelOption[];
}

const MODEL_PRESETS = [
  { label: "Codex 默认 (app-server 默认配置)", value: "" }
];

export const NewSessionModal: React.FC<NewSessionModalProps> = ({
  isOpen,
  onClose,
  onSubmit,
  defaultWorkspacePath = "",
  models = []
}) => {
  const [workspacePath, setWorkspacePath] = useState(defaultWorkspacePath || "D:\\个人项目\\CodeHarbor");
  const [prompt, setPrompt] = useState("");
  const [title, setTitle] = useState("");
  const [sessionPolicyMode, setSessionPolicyMode] = useState<"confirm" | "full-access">("confirm");
  const [model, setModel] = useState("");
  const [customModel, setCustomModel] = useState("");
  const [effort, setEffort] = useState("medium");
  const [multiAgentMode, setMultiAgentMode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (isOpen && defaultWorkspacePath) setWorkspacePath(defaultWorkspacePath);
  }, [isOpen, defaultWorkspacePath]);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!workspacePath.trim() || !prompt.trim()) {
      setErr("工作区路径和初始需求提示词不能为空");
      return;
    }
    setSubmitting(true);
    setErr("");
    try {
      const selectedModel = model === "custom" ? customModel.trim() : model;
      if (sessionPolicyMode === "full-access" && !window.confirm("完全访问会自动批准命令和文件修改，允许 Codex 直接操作当前工作区。确定要启用吗？")) {
        setSubmitting(false);
        return;
      }
      await onSubmit({
        workspacePath: workspacePath.trim(),
        prompt: prompt.trim(),
        title: title.trim() || undefined,
        sessionPolicyMode,
        confirmFullAccess: sessionPolicyMode === "full-access" ? true : undefined,
        model: selectedModel || undefined,
        effort: effort || undefined,
        multiAgentMode: multiAgentMode || undefined
      });
      onClose();
    } catch (error) {
      setErr(error instanceof Error ? error.message : "创建会话失败");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title">
            <span className="brand-mark-small">✦</span>
            <h3>新建 Codex 会话</h3>
          </div>
          <button className="modal-close-btn" onClick={onClose} type="button">
            ✕
          </button>
        </div>

        <form onSubmit={handleSubmit} className="modal-body">
          {err && <div className="modal-error-banner">{err}</div>}

          <label className="form-label">
            <span>工作区路径 (Workspace Path) *</span>
            <input
              type="text"
              value={workspacePath}
              onChange={(e) => setWorkspacePath(e.target.value)}
              placeholder="例如：D:\个人项目\CodeHarbor"
              required
              className="form-input"
            />
          </label>

          <label className="form-label">
            <span>初始任务需求 (Prompt) *</span>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="请描述你想让 Codex 执行的开发任务..."
              rows={4}
              required
              className="form-textarea"
            />
          </label>

          <label className="form-label">
            <span>会话标题 (可选)</span>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="留空则自动提取提示词摘要"
              className="form-input"
            />
          </label>

          <div className="form-row-2">
            <label className="form-label">
              <span>安全审批策略 (Policy Mode)</span>
              <select
                value={sessionPolicyMode}
                onChange={(e) => setSessionPolicyMode(e.target.value as any)}
                className="form-select"
              >
                <option value="confirm">安全确认 (Confirm - 推荐)</option>
                <option value="full-access">完全访问 (Full Access - 自动批准)</option>
              </select>
            </label>

            <label className="form-label">
              <span>推理强度 (Reasoning Effort)</span>
              <select
                value={effort}
                onChange={(e) => setEffort(e.target.value)}
                className="form-select"
              >
                <option value="low">低 (Low - 极速响应)</option>
                <option value="medium">中 (Medium - 均衡推荐)</option>
                <option value="high">高 (High - 复杂逻辑思考)</option>
              </select>
            </label>
          </div>

          <div className="form-row-2">
            <label className="form-label">
              <span>指定模型 (Model)</span>
              <select
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="form-select"
              >
                {(models.length > 0 ? [{ label: "Codex 默认 (app-server 默认配置)", value: "" }, ...models.map((item) => ({ label: item.name || item.id, value: item.id }))] : MODEL_PRESETS).map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
                <option value="custom">自定义模型名称...</option>
              </select>
            </label>

            <label className="form-label">
              <span>多 Agent 模式 (Multi-Agent)</span>
              <select
                value={multiAgentMode}
                onChange={(e) => setMultiAgentMode(e.target.value)}
                className="form-select"
              >
                <option value="">单 Agent 标准会话</option>
                <option value="subagent">子代理分工 (Subagent 协作)</option>
              </select>
            </label>
          </div>

          {model === "custom" && (
            <label className="form-label">
              <span>输入自定义模型标识</span>
              <input
                type="text"
                value={customModel}
                onChange={(e) => setCustomModel(e.target.value)}
                placeholder="例如：gpt-5.2-turbo"
                className="form-input"
              />
            </label>
          )}

          <div className="modal-footer">
            <button
              type="button"
              className="btn-secondary"
              onClick={onClose}
              disabled={submitting}
            >
              取消
            </button>
            <button
              type="submit"
              className="btn-primary"
              disabled={submitting || !prompt.trim()}
            >
              {submitting ? "正在初始化..." : "✦ 创建并启动任务"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
