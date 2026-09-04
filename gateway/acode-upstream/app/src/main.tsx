import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatCanvas } from "./components/ChatCanvas";
import { Header } from "./components/Header";
import { MessageComposer } from "./components/MessageComposer";
import { NewSessionModal } from "./components/NewSessionModal";
import { RawEventDrawer } from "./components/RawEventDrawer";
import { SessionSidebar } from "./components/SessionSidebar";
import { SettingsModal } from "./components/SettingsModal";
import { LandingPage } from "./components/LandingPage";
import { useCodeHarbor } from "./hooks/useCodeHarbor";
import "./styles.css";
import "./landing.css";

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

  // 1. Welcome & Login Screen (when unauthenticated)
  if (!token) {
    return <LandingPage user={user} setUser={setUser} password={password} setPassword={setPassword} login={login} registerAccount={registerAccount} error={error} clearError={clearError} />;
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
