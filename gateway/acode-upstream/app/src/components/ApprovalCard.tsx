import React, { useEffect, useState } from "react";
import type { ApprovalRequest } from "../types";

interface ApprovalCardProps {
  approval: ApprovalRequest;
  onDecision: (requestId: string, decision: "approve" | "deny", amendment?: string[], turnId?: string) => Promise<void>;
}

export const ApprovalCard: React.FC<ApprovalCardProps> = ({ approval, onDecision }) => {
  const [submitting, setSubmitting] = useState(false);
  const [localStatus, setLocalStatus] = useState(approval.status);
  const [remainingSec, setRemainingSec] = useState<number | null>(null);
  const [actionError, setActionError] = useState("");

  useEffect(() => {
    setLocalStatus(approval.status);
  }, [approval.status]);

  useEffect(() => {
    if (localStatus !== "pending" || !approval.expiresAt) return;

    const checkExpiry = () => {
      const diff = Math.floor((new Date(approval.expiresAt!).getTime() - Date.now()) / 1000);
      if (diff <= 0) {
        setRemainingSec(0);
        setLocalStatus("expired");
      } else {
        setRemainingSec(diff);
      }
    };

    checkExpiry();
    const interval = setInterval(checkExpiry, 1000);
    return () => clearInterval(interval);
  }, [approval.expiresAt, localStatus]);

  const handleAction = async (decision: "approve" | "deny", withAmendment = false) => {
    if (submitting || localStatus !== "pending") return;
    setSubmitting(true);
    setActionError("");
    try {
      const amendment = withAmendment
        ? approval.proposedExecpolicyAmendment || (approval.command ? [approval.command] : undefined)
        : undefined;
      await onDecision(approval.requestId, decision, amendment, approval.turnId);
      setLocalStatus(decision === "approve" ? "approved" : "denied");
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "审批操作失败，请重试");
      setSubmitting(false);
    }
  };

  const hasAmendment = Boolean(
    (approval.proposedExecpolicyAmendment && approval.proposedExecpolicyAmendment.length > 0) ||
      approval.command
  );

  return (
    <div className={`approval-card ${localStatus}`}>
      <div className="approval-card-banner">
        <div className="approval-badge">
          <span className="approval-icon">◈</span>
          <span>
            {localStatus === "pending"
              ? "高风险操作安全审批"
              : localStatus === "approved"
              ? "审批已允许"
              : localStatus === "denied"
              ? "审批已拒绝"
              : "审批已过期"}
          </span>
        </div>

        {localStatus === "pending" && remainingSec !== null && (
          <div className="approval-timer">
            <span>剩余时间：</span>
            <strong>{remainingSec}s</strong>
          </div>
        )}
      </div>

      <div className="approval-details">
        {approval.summary && <div className="approval-summary">{approval.summary}</div>}

        {approval.command && (
          <div className="approval-code-field">
            <span className="approval-field-label">待执行命令：</span>
            <pre className="approval-code">
              <code>{approval.command}</code>
            </pre>
          </div>
        )}

        {approval.cwd && (
          <div className="approval-meta-row">
            <span className="approval-meta-label">工作区目录:</span>
            <span className="approval-meta-value">{approval.cwd}</span>
          </div>
        )}

        {approval.proposedExecpolicyAmendment && approval.proposedExecpolicyAmendment.length > 0 && (
          <div className="approval-amendment-box">
            <span className="approval-amendment-title">始终允许策略规则 (Execpolicy Amendment):</span>
            <div className="amendment-tags">
              {approval.proposedExecpolicyAmendment.map((rule, idx) => (
                <code key={idx} className="amendment-tag">
                  {rule}
                </code>
              ))}
            </div>
          </div>
        )}
      </div>

      {localStatus === "pending" ? (
        <>
        <div className="approval-actions">
          <button
            className="btn-approval btn-approve"
            disabled={submitting}
            onClick={() => handleAction("approve", false)}
            type="button"
          >
            {submitting ? "处理中..." : "允许一次"}
          </button>

          {hasAmendment && (
            <button
              className="btn-approval btn-always"
              disabled={submitting}
              onClick={() => handleAction("approve", true)}
              type="button"
              title="在本次会话中始终允许相同前缀命令"
            >
              {submitting ? "处理中..." : "始终允许"}
            </button>
          )}

          <button
            className="btn-approval btn-deny"
            disabled={submitting}
            onClick={() => handleAction("deny", false)}
            type="button"
          >
            {submitting ? "处理中..." : "拒绝"}
          </button>
        </div>
        {actionError && <div className="approval-action-error" role="alert">{actionError}</div>}
        </>
      ) : (
        <div className="approval-resolved-notice">
          <span>
            {localStatus === "approved"
              ? "✓ 已执行授权"
              : localStatus === "denied"
              ? "✕ 已拦截该请求"
              : "⏱ 审批超时已失效"}
          </span>
          <small className="replay-guard-hint">已记录审计日志，不可重复提交</small>
        </div>
      )}
    </div>
  );
};
