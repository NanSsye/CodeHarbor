import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatCanvas } from "./components/ChatCanvas";
import { Header } from "./components/Header";
import { MessageComposer } from "./components/MessageComposer";
import { NewSessionModal } from "./components/NewSessionModal";
import { RawEventDrawer } from "./components/RawEventDrawer";
import { SessionSidebar } from "./components/SessionSidebar";
import { SettingsModal } from "./components/SettingsModal";
import { useCodeHarbor } from "./hooks/useCodeHarbor";
import "./styles.css";

function App() {
  const {
    user,
    setUser,
    password,
    setPassword,
    token,
    login,
    registerAccount,
    logout,
    devices,
    selectedDeviceId,
    setSelectedDeviceId,
    sessions,
    models,
    selectedSessionId,
    setSelectedSessionId,
    selectedSession,
    turns,
    rawEvents,
    connectionStatus,
    error,
    clearError,
    isStreaming,
    sendPrompt,
    downloadFile,
    sendApprovalDecision,
    interruptTask,
    resumeTask,
    setSessionPolicyMode,
    revokeDevice,
    createNewSession,
    forkSession,
    refreshData
  } = useCodeHarbor();

  const [isNewSessionOpen, setIsNewSessionOpen] = useState(false);
  const [newSessionWorkspace, setNewSessionWorkspace] = useState("");
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isRawDrawerOpen, setIsRawDrawerOpen] = useState(false);
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [loginMode, setLoginMode] = useState<"account" | "pairing">("account");
  const [authMode, setAuthMode] = useState<"login" | "register">(() => new URLSearchParams(window.location.search).get("register") === "1" ? "register" : "login");
  const [registerPassword, setRegisterPassword] = useState("");
  const [registerPasswordConfirm, setRegisterPasswordConfirm] = useState("");
  const [pairCode, setPairCode] = useState("");

  const handleLoginSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isLoggingIn) return;
    if (authMode === "register") {
      if (!user.trim() || registerPassword.length < 12 || registerPassword !== registerPasswordConfirm) return;
    } else if ((loginMode === "account" ? !user.trim() || !password : pairCode.trim().length !== 6)) return;
    setIsLoggingIn(true);
    try {
      if (authMode === "register") {
        await registerAccount(user, registerPassword);
      } else {
        await login(loginMode === "pairing" ? { pairCode } : undefined);
      }
    } finally {
      setIsLoggingIn(false);
    }
  };

  // 1. Welcome & Login Screen (when unauthenticated)
  if (!token) {
    return (
      <div className="welcome-screen">
        <div className="welcome-inner">
          <div className="welcome-info">
            <div className="welcome-brand-row">
              <span className="brand-mark">✦</span>
              <span className="welcome-overline">CODEHARBOR · PRIVATE WORKSPACE</span>
            </div>

            <h1 className="welcome-title">
              把你的开发现场，<br />
              <em>随时带在身边。</em>
            </h1>

            <p className="welcome-desc">
              连接本机 Codex app-server 与本地项目工作区。代码编写、终端命令执行与危险操作审批，全链路流式打通。
            </p>

            <div className="welcome-feature-tags">
              <div className="feat-tag"><i>✓</i> 流式文本打字机合并</div>
              <div className="feat-tag"><i>✓</i> 终端命令与 Git Diff 预览</div>
              <div className="feat-tag"><i>✓</i> 高风险动作一键安全审批</div>
              <div className="feat-tag"><i>✓</i> 游标断点断网自动续传</div>
            </div>
          </div>

          <form className="login-card" onSubmit={handleLoginSubmit}>
            <div className="login-card-title">{authMode === "register" ? "创建 CodeHarbor 账号" : "进入工作台"}</div>

            <div className="login-mode-toggle" role="tablist" aria-label="账号操作">
              <button type="button" className={authMode === "login" ? "active" : ""} onClick={() => { setAuthMode("login"); clearError(); }}>登录</button>
              <button type="button" className={authMode === "register" ? "active" : ""} onClick={() => { setAuthMode("register"); setLoginMode("account"); clearError(); }}>注册</button>
            </div>

            {authMode === "login" && <div className="login-mode-toggle" role="tablist" aria-label="登录方式">
              <button type="button" className={loginMode === "account" ? "active" : ""} onClick={() => { setLoginMode("account"); clearError(); }}>账号密码</button>
              <button type="button" className={loginMode === "pairing" ? "active" : ""} onClick={() => { setLoginMode("pairing"); clearError(); }}>配对码</button>
            </div>}

            {error && <div className="login-error">{error}</div>}

            {authMode === "register" || loginMode === "account" ? <>
              <label className="form-label">
                <span>账号</span>
                <input type="text" value={user} onChange={(e) => { setUser(e.target.value); clearError(); }} autoComplete="username" placeholder="输入账号" required className="form-input" />
              </label>
              <label className="form-label">
                <span>{authMode === "register" ? "设置密码" : "访问密码"}</span>
                <input type="password" value={authMode === "register" ? registerPassword : password} onChange={(e) => { authMode === "register" ? setRegisterPassword(e.target.value) : setPassword(e.target.value); clearError(); }} placeholder={authMode === "register" ? "至少 12 位" : "输入账户访问密码"} autoComplete={authMode === "register" ? "new-password" : "current-password"} required className="form-input" />
              </label>
              {authMode === "register" && <label className="form-label">
                <span>确认密码</span>
                <input type="password" value={registerPasswordConfirm} onChange={(e) => { setRegisterPasswordConfirm(e.target.value); clearError(); }} placeholder="再次输入密码" autoComplete="new-password" required className="form-input" />
              </label>}
            </> : <label className="form-label">
              <span>一次性配对码</span>
              <input type="text" value={pairCode} onChange={(e) => { setPairCode(e.target.value.replace(/[^a-z0-9]/gi, "").slice(0, 6).toUpperCase()); clearError(); }} placeholder="输入电脑端显示的 6 位配对码" autoComplete="one-time-code" inputMode="text" required className="form-input pairing-code-input" />
            </label>}

            <button
              type="submit"
              className="btn-login-submit"
              disabled={isLoggingIn || (authMode === "register" ? !user.trim() || registerPassword.length < 12 || registerPassword !== registerPasswordConfirm : loginMode === "account" ? !user.trim() || !password : pairCode.trim().length !== 6)}
            >
              {isLoggingIn ? (authMode === "register" ? "正在创建账号..." : "正在连接并鉴权...") : authMode === "register" ? "✦ 注册并进入" : "✦ 验证凭据并进入"}
            </button>
          </form>
        </div>
      </div>
    );
  }

  // 2. Main Authenticated Application Workspace
  return (
    <div className="app-shell">
      {/* Topbar */}
      <Header
        user={user}
        devices={devices}
        selectedDeviceId={selectedDeviceId}
        onSelectDevice={setSelectedDeviceId}
        selectedSession={selectedSession}
        connectionStatus={connectionStatus}
        onRefresh={refreshData}
        onPolicyChange={setSessionPolicyMode}
        onOpenSettings={() => setIsSettingsOpen(true)}
        onOpenRawEvents={() => setIsRawDrawerOpen(true)}
        onToggleMobileSidebar={() => setIsMobileSidebarOpen(!isMobileSidebarOpen)}
      />

      {/* Main Workspace Layout */}
      <div className="workspace-container">
        {/* Session List Sidebar */}
        <SessionSidebar
          sessions={sessions}
          selectedSessionId={selectedSessionId}
          onSelectSession={(id) => {
            setSelectedSessionId(id);
            clearError();
          }}
          onOpenNewModal={(workspacePath) => { setNewSessionWorkspace(workspacePath || selectedSession?.workspacePath || selectedSession?.cwd || ""); setIsNewSessionOpen(true); }}
          onForkSession={forkSession}
          isOpenMobile={isMobileSidebarOpen}
          onCloseMobile={() => setIsMobileSidebarOpen(false)}
        />

        {/* Conversation Canvas & Message Composer */}
        <main className="conversation-main">
          <ChatCanvas
            turns={turns}
            session={selectedSession}
            isStreaming={isStreaming}
            onDecision={sendApprovalDecision}
            onInterrupt={interruptTask}
            onResume={resumeTask}
            onDownloadFile={downloadFile}
          />

          <MessageComposer
            onSend={sendPrompt}
            isStreaming={isStreaming}
            onInterrupt={interruptTask}
            disabled={!selectedSessionId || !selectedDeviceId}
            models={models}
          />
        </main>
      </div>

      {/* Modals & Slide-out Panels */}
      <NewSessionModal
        isOpen={isNewSessionOpen}
        onClose={() => setIsNewSessionOpen(false)}
        onSubmit={createNewSession}
        defaultWorkspacePath={newSessionWorkspace || selectedSession?.workspacePath || selectedSession?.cwd}
        models={models}
      />

      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        user={user}
        token={token}
        devices={devices}
        selectedDeviceId={selectedDeviceId}
        onSelectDevice={setSelectedDeviceId}
        onRevokeDevice={revokeDevice}
        onLogout={logout}
      />

      <RawEventDrawer
        isOpen={isRawDrawerOpen}
        onClose={() => setIsRawDrawerOpen(false)}
        events={rawEvents}
        currentSessionId={selectedSessionId}
      />
    </div>
  );
}

const rootElement = document.getElementById("root");
if (rootElement) {
  createRoot(rootElement).render(<App />);
}
