import React, { useMemo, useState } from "react";
import type { Session } from "../types";
import { fmtRelativeTime, projectOf, statusBadgeColor, statusText } from "../utils";

interface SessionSidebarProps {
  sessions: Session[];
  selectedSessionId: string;
  onSelectSession: (id: string) => void;
  onOpenNewModal: (workspacePath?: string) => void;
  onForkSession: (sourceId: string) => Promise<any>;
  isOpenMobile?: boolean;
  onCloseMobile?: () => void;
}

export const SessionSidebar: React.FC<SessionSidebarProps> = ({
  sessions,
  selectedSessionId,
  onSelectSession,
  onOpenNewModal,
  onForkSession,
  isOpenMobile,
  onCloseMobile
}) => {
  const [keyword, setKeyword] = useState("");
  const [filterStatus, setFilterStatus] = useState<string>("all");
  const [forkingId, setForkingId] = useState<string | null>(null);
  const [collapsedProjects, setCollapsedProjects] = useState<Record<string, boolean>>({});

  // Filtered sessions are grouped by project, with the most recently active
  // project first. Within each project, newest conversations remain first.
  const filteredSessions = useMemo(() => {
    const matching = sessions.filter((s) => {
      const matchKeyword =
        !keyword.trim() ||
        (s.title && s.title.toLowerCase().includes(keyword.toLowerCase())) ||
        (s.workspacePath && s.workspacePath.toLowerCase().includes(keyword.toLowerCase())) ||
        (s.cwd && s.cwd.toLowerCase().includes(keyword.toLowerCase())) ||
        projectOf(s).toLowerCase().includes(keyword.toLowerCase());

      const matchStatus =
        filterStatus === "all" ||
        (filterStatus === "running" && s.status === "running") ||
        (filterStatus === "waiting-approval" && s.status === "waiting-approval") ||
        (filterStatus === "completed" && s.status === "completed") ||
        (filterStatus === "cancelled" && s.status === "cancelled");

      return matchKeyword && matchStatus;
    });
    const projects = new Map<string, Session[]>();
    for (const session of matching) {
      const project = projectOf(session);
      const list = projects.get(project) ?? [];
      list.push(session);
      projects.set(project, list);
    }
    return Array.from(projects.entries())
      .sort(([, left], [, right]) => {
        const leftLatest = left.reduce((latest, item) => Math.max(latest, Date.parse(item.lastUpdatedAt || item.updatedAt || item.createdAt || "") || 0), 0);
        const rightLatest = right.reduce((latest, item) => Math.max(latest, Date.parse(item.lastUpdatedAt || item.updatedAt || item.createdAt || "") || 0), 0);
        return rightLatest - leftLatest;
      })
      .flatMap(([, list]) => list.sort((a, b) => (b.lastUpdatedAt || b.updatedAt || b.createdAt || "").localeCompare(a.lastUpdatedAt || a.updatedAt || a.createdAt || "")));
  }, [sessions, keyword, filterStatus]);

  const handleFork = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (forkingId) return;
    setForkingId(id);
    try {
      await onForkSession(id);
    } finally {
      setForkingId(null);
    }
  };

  return (
    <aside className={`session-sidebar ${isOpenMobile ? "open-mobile" : ""}`}>
      {/* Sidebar Header */}
      <div className="sidebar-header">
        <div className="sidebar-title-row">
          <div className="sidebar-title">
            <span className="sidebar-mark">⌂</span>
            <span>会话列表</span>
            <span className="session-count-badge">{filteredSessions.length}</span>
          </div>

          <div className="sidebar-actions">
            <button
              className="btn-new-session"
              onClick={() => onOpenNewModal()}
              title="新建 Codex 会话"
              type="button"
            >
              + 新建会话
            </button>
            {isOpenMobile && (
              <button
                className="btn-close-mobile"
                onClick={onCloseMobile}
                type="button"
                aria-label="关闭抽屉"
              >
                ✕
              </button>
            )}
          </div>
        </div>

        {/* Search & Filter Toolbar */}
        <div className="sidebar-search-box">
          <input
            type="text"
            className="sidebar-search-input"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="搜索会话、项目或工作区..."
          />
          {keyword && (
            <button
              className="sidebar-clear-search"
              onClick={() => setKeyword("")}
              type="button"
            >
              ✕
            </button>
          )}
        </div>

        <div className="sidebar-filter-chips">
          {[
            { id: "all", label: "全部" },
            { id: "running", label: "运行中" },
            { id: "waiting-approval", label: "等待审批" },
            { id: "completed", label: "已完成" }
          ].map((tab) => (
            <button
              key={tab.id}
              className={`filter-chip ${filterStatus === tab.id ? "active" : ""}`}
              onClick={() => setFilterStatus(tab.id)}
              type="button"
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Session List */}
      <div className="session-scroll-list">
        {filteredSessions.length === 0 ? (
          <div className="sidebar-empty">
            <p>未找到匹配会话</p>
            <button className="btn-empty-new" onClick={() => onOpenNewModal()} type="button">
              创建首个任务
            </button>
          </div>
          ) : (
          filteredSessions.map((sess, index) => {
            const isSelected = sess.id === selectedSessionId;
            const isForked = Boolean(sess.parentSessionId);
            const isRunning = sess.status === "running";
            const project = projectOf(sess);
            const previousProject = index > 0 ? projectOf(filteredSessions[index - 1]) : "";
            const showProjectHeader = project !== previousProject;

            const collapsed = Boolean(collapsedProjects[project]);
            return (<React.Fragment key={sess.id}>{showProjectHeader && <div className="project-tree-header"><button type="button" className="tree-toggle" onClick={() => setCollapsedProjects((prev) => ({ ...prev, [project]: !prev[project] }))}><span className={`tree-chevron ${collapsed ? "collapsed" : ""}`}>⌄</span><span className="tree-folder">⌂</span><strong>{project}</strong><small>{filteredSessions.filter((item) => projectOf(item) === project).length}</small></button><button type="button" className="tree-new" onClick={(e) => { e.stopPropagation(); const target = filteredSessions.find((item) => projectOf(item) === project); onOpenNewModal(target?.workspacePath || target?.cwd); }} title={`在 ${project} 中新建会话`}>＋</button></div>}{!collapsed && <div
                className={`session-item-card ${isSelected ? "selected" : ""} ${isForked ? "is-forked" : ""}`}
                onClick={() => { onSelectSession(sess.id); if (isOpenMobile && onCloseMobile) onCloseMobile(); }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onSelectSession(sess.id);
                    if (isOpenMobile && onCloseMobile) onCloseMobile();
                  }
                }}
                role="button"
                tabIndex={0}
                aria-current={isSelected ? "page" : undefined}
              >
                {/* Active Indicator Bar */}
                {isSelected && <div className="selected-active-bar" />}

                <div className="session-item-header">
                  <div className="session-project-tag">
                    {isForked && <span className="fork-icon" title="分叉自父会话">↳ </span>}
                    <span>{projectOf(sess)}</span>
                  </div>
                  <div className="session-time">
                    {fmtRelativeTime(sess.lastUpdatedAt || sess.updatedAt || sess.createdAt)}
                  </div>
                </div>

                <div className="session-item-title" title={sess.title || "未命名会话"}>
                  {sess.title || sess.id.slice(0, 18)}
                </div>

                <div className="session-item-footer">
                  <div className="session-status-badge">
                    <i
                      className={`status-circle ${isRunning ? "live" : ""}`}
                      style={{ backgroundColor: statusBadgeColor(sess.status) }}
                    />
                    <span>{statusText(sess.status)}</span>
                  </div>

                  <button
                    className="btn-fork-small"
                    onClick={(e) => handleFork(e, sess.id)}
                    title="从当前进度分叉新会话 (Fork)"
                    disabled={forkingId === sess.id}
                    type="button"
                  >
                    {forkingId === sess.id ? "分叉中..." : "分叉"}
                  </button>
                </div>
              </div>}</React.Fragment>);
          })
        )}
      </div>
    </aside>
  );
};
