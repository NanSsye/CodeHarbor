import React from "react";
import type { Device, Session } from "../types";
import { projectOf, statusBadgeColor, statusText } from "../utils";

interface HeaderProps {
  user: string;
  devices: Device[];
  selectedDeviceId: string;
  onSelectDevice: (id: string) => void;
  selectedSession?: Session;
  connectionStatus: string;
  onRefresh: () => void;
  onPolicyChange: (mode: "confirm" | "full-access", confirmFullAccess?: boolean) => Promise<void>;
  onOpenSettings: () => void;
  onOpenRawEvents: () => void;
  onToggleMobileSidebar: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  user,
  devices,
  selectedDeviceId,
  onSelectDevice,
  selectedSession,
  connectionStatus,
  onRefresh,
  onPolicyChange,
  onOpenSettings,
  onOpenRawEvents,
  onToggleMobileSidebar
}) => {
  const isLive = connectionStatus === "已连接";
  const [policyChanging, setPolicyChanging] = React.useState(false);

  const handlePolicyChange = async (event: React.ChangeEvent<HTMLSelectElement>) => {
    const mode = event.target.value as "confirm" | "full-access";
    if (mode === "full-access" && !window.confirm("完全访问会自动批准命令和文件修改，允许 Codex 直接操作当前工作区。确定要为后续任务启用吗？")) return;
    setPolicyChanging(true);
    try {
      await onPolicyChange(mode, mode === "full-access");
    } finally {
      setPolicyChanging(false);
    }
  };

  return (
    <header className="topbar">
      {/* Brand & Mobile Hamburger */}
      <div className="topbar-left">
        <button
          className="btn-mobile-menu"
          onClick={onToggleMobileSidebar}
          type="button"
          aria-label="打开会话列表"
        >
          ☰
        </button>

        <div className="brand">
          <span className="brand-mark">✦</span>
          <div className="brand-text">
            <span className="brand-name">CODEHARBOR</span>
            <small className="brand-sub">REMOTE CODEX</small>
          </div>
        </div>

        {/* Breadcrumb Context */}
        {selectedSession && (
          <div className="context-breadcrumb">
            <span className="crumb-sep">/</span>
            <span className="crumb-project">{projectOf(selectedSession)}</span>
            <span className="crumb-sep">/</span>
            <span className="crumb-title" title={selectedSession.title}>
              {selectedSession.title || "当前会话"}
            </span>
            <span
              className="crumb-status-dot"
              style={{ backgroundColor: statusBadgeColor(selectedSession.status) }}
              title={statusText(selectedSession.status)}
            />
          </div>
        )}
      </div>

      {/* Topbar Right Controls */}
      <div className="topbar-right">
        {/* Device Picker */}
        <div className="device-picker-wrapper">
          <select
            className="device-select"
            value={selectedDeviceId}
            onChange={(e) => onSelectDevice(e.target.value)}
          >
            <option value="">-- 选择开发电脑设备 --</option>
            {devices.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.connected ? "● 在线" : "○ 离线"} · {d.deviceName || d.deviceId.slice(0, 12)}
              </option>
            ))}
          </select>
        </div>

        {/* Connection Status Pill */}
        <div className={`connection-pill ${isLive ? "live" : ""}`}>
          <i className="conn-dot" />
          <span>{connectionStatus}</span>
        </div>

        <select
          className="policy-select"
          value={selectedSession?.sessionPolicyMode ?? "confirm"}
          onChange={handlePolicyChange}
          disabled={!selectedSession || policyChanging}
          aria-label="当前会话权限模式"
          title="切换当前会话后续任务的审批策略"
        >
          <option value="confirm">需审批</option>
          <option value="full-access">全自动</option>
        </select>

        {/* Action Buttons */}
        <button
          className="icon-button refresh-button"
          onClick={onRefresh}
          title="刷新数据"
          type="button"
          aria-label="刷新"
        >
          ↻
        </button>

        <button
          className="icon-button raw-events-button"
          onClick={onOpenRawEvents}
          title="查看 Gateway / Codex 原始事件流"
          type="button"
          aria-label="原始事件"
        >
          ⌘
        </button>

        {/* User Avatar */}
        <button
          className="avatar-button"
          onClick={onOpenSettings}
          title={`账号：${user} (点击查看设置)`}
          type="button"
        >
          {user ? user.slice(0, 1).toUpperCase() : "U"}
        </button>
      </div>
    </header>
  );
};
