import React, { useMemo, useState } from "react";
import { getEventSessionId } from "../aggregator";
import type { EventMessage } from "../types";
import { copyToClipboard, fmtTime } from "../utils";

interface RawEventDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  events: EventMessage[];
  currentSessionId?: string;
}

export const RawEventDrawer: React.FC<RawEventDrawerProps> = ({
  isOpen,
  onClose,
  events,
  currentSessionId
}) => {
  const [filterCurrent, setFilterCurrent] = useState(true);
  const [search, setSearch] = useState("");
  const [copiedId, setCopiedId] = useState<number | null>(null);

  const displayedEvents = useMemo(() => {
    return events
      .filter((e) => {
        if (filterCurrent && currentSessionId) {
          if (getEventSessionId(e) !== currentSessionId) return false;
        }

        if (search.trim()) {
          const str = JSON.stringify(e).toLowerCase();
          return str.includes(search.toLowerCase());
        }

        return true;
      })
      .slice(-150)
      .reverse();
  }, [events, filterCurrent, currentSessionId, search]);

  if (!isOpen) return null;

  const handleCopy = async (item: EventMessage, idx: number) => {
    const success = await copyToClipboard(JSON.stringify(item, null, 2));
    if (success) {
      setCopiedId(idx);
      setTimeout(() => setCopiedId(null), 1500);
    }
  };

  return (
    <div className="event-drawer-backdrop" onClick={onClose}>
      <div className="event-drawer-panel" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-header">
          <div className="drawer-title">
            <span className="drawer-icon">⌘</span>
            <h3>Gateway / Codex 原始事件流</h3>
            <span className="drawer-count">{displayedEvents.length} 条</span>
          </div>

          <button className="modal-close-btn" onClick={onClose} type="button">
            ✕
          </button>
        </div>

        <div className="drawer-toolbar">
          <input
            type="text"
            className="drawer-search-input"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="在事件流中搜索方法名或内容..."
          />

          <label className="drawer-filter-label">
            <input
              type="checkbox"
              checked={filterCurrent}
              onChange={(e) => setFilterCurrent(e.target.checked)}
            />
            <span>仅看当前会话</span>
          </label>
        </div>

        <div className="drawer-events-list">
          {displayedEvents.length === 0 ? (
            <div className="drawer-empty">暂无事件记录</div>
          ) : (
            displayedEvents.map((evt, idx) => {
              const eventType =
                evt.type || evt.method || evt.payload?.eventType || "unknown";
              const time = fmtTime(evt.timestamp || evt.payload?.timestamp);

              return (
                <div key={idx} className="raw-event-item">
                  <div className="raw-event-summary">
                    <div className="raw-event-badges">
                      <span className="event-type-badge">{eventType}</span>
                      {evt.eventSeq && (
                        <span className="event-seq-badge">seq: {evt.eventSeq}</span>
                      )}
                      {time && <span className="event-time-badge">{time}</span>}
                    </div>

                    <button
                      className="event-copy-btn"
                      onClick={() => handleCopy(evt, idx)}
                      type="button"
                    >
                      {copiedId === idx ? "✓ 已复制" : "复制 JSON"}
                    </button>
                  </div>

                  <pre className="raw-event-json">
                    <code>{JSON.stringify(evt, null, 2)}</code>
                  </pre>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};
