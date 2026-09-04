import React, { useState } from "react";
import type { Device } from "../types";

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  user: string;
  token: string;
  devices: Device[];
  selectedDeviceId: string;
  onSelectDevice: (id: string) => void;
  onRevokeDevice: (id: string) => Promise<void>;
  onLogout: () => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  user,
  token,
  devices,
  selectedDeviceId,
  onSelectDevice,
  onRevokeDevice,
  onLogout
}) => {
  const [clearedNotice, setClearedNotice] = useState(false);

  if (!isOpen) return null;

  const handleClearLocalCache = () => {
    localStorage.removeItem("codeharbor.eventCursors");
    setClearedNotice(true);
    setTimeout(() => setClearedNotice(false), 2500);
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-dialog settings-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title">
            <span className="brand-mark-small">⚙</span>
            <h3>工作台与账号设置</h3>
          </div>
          <button className="modal-close-btn" onClick={onClose} type="button">
            ✕
          </button>
        </div>

        <div className="modal-body settings-body">
          {/* Account Profile Section */}
          <section className="settings-section">
            <h4 className="settings-section-title">当前账号</h4>
            <div className="settings-user-card">
              <div className="settings-avatar">{user.slice(0, 1).toUpperCase()}</div>
              <div className="settings-user-info">
                <div className="settings-user-name">{user}</div>
                <div className="settings-token-meta">
                  <span>凭证：</span>
                  <code>{token ? `${token.slice(0, 16)}...${token.slice(-8)}` : "未登录"}</code>
                </div>
              </div>
              <button
                className="btn-danger-small"
                onClick={() => {
                  onLogout();
                  onClose();
                }}
                type="button"
              >
                退出登录
              </button>
            </div>
          </section>

          {/* Device Management Section */}
          <section className="settings-section">
            <h4 className="settings-section-title">绑定设备列表 ({devices.length})</h4>
            <div className="settings-device-list">
              {devices.length === 0 ? (
                <div className="settings-device-empty">暂无注册设备</div>
              ) : (
                devices.map((dev) => {
                  const isCurrent = dev.deviceId === selectedDeviceId;
                  const revoke = async () => {
                    if (!window.confirm(`撤销“${dev.deviceName || dev.deviceId}”？该设备将立即断开，需重新配对才能使用。`)) return;
                    try {
                      await onRevokeDevice(dev.deviceId);
                    } catch (error) {
                      window.alert(error instanceof Error ? error.message : "撤销设备失败");
                    }
                  };
                  return (
                    <div
                      key={dev.deviceId}
                      className={`settings-device-item ${isCurrent ? "active" : ""}`}
                      onClick={() => onSelectDevice(dev.deviceId)}
                    >
                      <div className="dev-left">
                        <span className={`dev-dot ${dev.connected ? "online" : "offline"}`} />
                        <div>
                          <div className="dev-name">
                            {dev.deviceName || "默认开发电脑"}
                            {isCurrent && <span className="dev-current-badge">当前选择</span>}
                          </div>
                          <div className="dev-id">{dev.deviceId}</div>
                        </div>
                      </div>
                      <div className="dev-status">
                        <span>{dev.connected ? "在线 (已连通 Gateway)" : "离线"}</span>
                        <button className="btn-danger-small" type="button" onClick={(event) => { event.stopPropagation(); void revoke(); }}>
                          撤销
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </section>

          {/* Network & Protocol Status */}
          <section className="settings-section">
            <h4 className="settings-section-title">网络与协议状态</h4>
            <div className="settings-meta-grid">
              <div className="meta-item">
                <span className="meta-k">云端连接:</span>
                <span className="meta-v">当前网页入口（HTTPS / WSS）</span>
              </div>
              <div className="meta-item">
                <span className="meta-k">实时通道:</span>
                <span className="meta-v">安全 WebSocket，自动保活与断线恢复</span>
              </div>
              <div className="meta-item">
                <span className="meta-k">网关协议:</span>
                <code className="meta-v">codeharbor.gateway.v1</code>
              </div>
              <div className="meta-item">
                <span className="meta-k">断点补发游标:</span>
                <button
                  className="btn-text-action"
                  onClick={handleClearLocalCache}
                  type="button"
                >
                  {clearedNotice ? "✓ 游标缓存已重置" : "重置断点游标缓存"}
                </button>
              </div>
            </div>
          </section>
        </div>

        <div className="modal-footer">
          <button className="btn-secondary" onClick={onClose} type="button">
            关闭
          </button>
        </div>
      </div>
    </div>
  );
};
