import React, { useState } from "react";
import { copyToClipboard } from "../utils";

interface DiffViewProps {
  diff: string;
  filePath?: string;
  kind?: string;
  onDownload?: (filePath: string) => Promise<void>;
}

export const DiffView: React.FC<DiffViewProps> = ({ diff, filePath, kind, onDownload }) => {
  const [copied, setCopied] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const success = await copyToClipboard(diff);
    if (success) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleDownload = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!filePath || !onDownload || downloading) return;
    setDownloading(true);
    try {
      await onDownload(filePath);
    } finally {
      setDownloading(false);
    }
  };

  const lines = diff.split("\n");

  return (
    <div className="diff-view-card">
      <div className="diff-header" onClick={() => setCollapsed(!collapsed)}>
        <div className="diff-header-left">
          <span className="diff-collapse-icon">{collapsed ? "▶" : "▼"}</span>
          <span className={`diff-kind-badge ${kind || "modify"}`}>
            {kind === "add" ? "新增" : kind === "delete" ? "删除" : "修改"}
          </span>
          <span className="diff-filepath" title={filePath}>
            {filePath || "文件差异"}
          </span>
        </div>
        <div className="diff-header-right">
          <button
            className="diff-copy-btn"
            onClick={handleCopy}
            type="button"
            title="复制 Diff"
          >
            {copied ? "✓ 已复制" : "复制 Diff"}
          </button>
          {filePath && onDownload && (
            <button
              className="diff-download-btn"
              onClick={handleDownload}
              type="button"
              title="下载当前工作区文件"
              disabled={downloading}
            >
              {downloading ? "准备中..." : "下载文件"}
            </button>
          )}
        </div>
      </div>

      {!collapsed && (
        <div className="diff-content">
          {lines.map((line, idx) => {
            let lineType = "context";
            if (line.startsWith("+") && !line.startsWith("+++")) {
              lineType = "added";
            } else if (line.startsWith("-") && !line.startsWith("---")) {
              lineType = "removed";
            } else if (line.startsWith("@@")) {
              lineType = "chunk-header";
            } else if (line.startsWith("diff --git") || line.startsWith("index ")) {
              lineType = "meta";
            }

            return (
              <div key={idx} className={`diff-line diff-${lineType}`}>
                <span className="diff-line-prefix">
                  {lineType === "added" ? "+" : lineType === "removed" ? "-" : " "}
                </span>
                <span className="diff-line-text">{line.slice(1) || line}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
