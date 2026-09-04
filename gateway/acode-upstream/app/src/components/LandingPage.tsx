import React, { useRef, useState } from "react";

const GITHUB_URL = "https://github.com/NanSsye/CodeHarbor";
const DOWNLOAD_URL = "https://github.com/NanSsye/CodeHarbor/releases/download/v1.0.0/CodeHarbor-Setup-1.0.0-x64.exe";

type LandingPageProps = {
  user: string;
  setUser: (value: string) => void;
  password: string;
  setPassword: (value: string) => void;
  login: (options?: { pairCode?: string }) => Promise<void>;
  registerAccount: (username: string, password: string) => Promise<void>;
  error: string | null;
  clearError: () => void;
};

export function LandingPage({
  user,
  setUser,
  password,
  setPassword,
  login,
  registerAccount,
  error,
  clearError
}: LandingPageProps) {
  const authRef = useRef<HTMLDivElement>(null);
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [registerPassword, setRegisterPassword] = useState("");
  const [registerPasswordConfirm, setRegisterPasswordConfirm] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const focusAuth = (mode: "login" | "register") => {
    setAuthMode(mode);
    clearError();
    requestAnimationFrame(() => authRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }));
  };

  const submitAuth = async (event: React.FormEvent) => {
    event.preventDefault();
    if (isSubmitting) return;
    if (authMode === "register" && (registerPassword.length < 12 || registerPassword !== registerPasswordConfirm)) return;
    if (!user.trim() || (authMode === "login" && !password)) return;
    setIsSubmitting(true);
    try {
      if (authMode === "register") await registerAccount(user.trim(), registerPassword);
      else await login();
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="landing-page">
      <header className="landing-nav">
          <a className="landing-brand" href="#top" aria-label="CodeHarbor 首页">
          <span className="landing-brand-mark" aria-hidden="true">⌾</span>
          <span>CODEHARBOR</span>
        </a>
        <nav className="landing-nav-links" aria-label="主导航">
          <a href="#capabilities">产品能力</a>
          <a href="#workbench">工作台</a>
          <a href="#security">安全协议</a>
          <a href={GITHUB_URL} target="_blank" rel="noreferrer">GitHub ↗</a>
        </nav>
        <div className="landing-auth-links">
          <button type="button" className="landing-login-link" onClick={() => focusAuth("login")}>登录</button>
          <button type="button" className="landing-signup-link" onClick={() => focusAuth("register")}>注册账号</button>
        </div>
      </header>

      <main id="top">
        <section className="landing-hero section-shell">
          <div className="hero-copy">
            <p className="eyebrow">安全远程工作区 <span>/</span> CODEX 会话实时串流</p>
            <h1>让代码现场，<br /><em>随时在线。</em></h1>
            <p className="hero-subtitle">把桌面端 Codex 会话实时带到任意屏幕，工具调用、输出和审批状态一目了然。</p>
            <div className="hero-actions">
              <a className="cta-primary" href={DOWNLOAD_URL}>下载 Windows 客户端 <span>↗</span></a>
              <a className="cta-secondary" href={GITHUB_URL} target="_blank" rel="noreferrer">查看 GitHub 源码 <span>↗</span></a>
            </div>
            <p className="hero-note"><span className="status-dot" /> 默认 WSS · 开源核心 · v1.0.0</p>
          </div>
          <div className="hero-visual" aria-label="CodeHarbor session timeline preview">
            <img src="/marketing/hero-console.png" alt="CodeHarbor precision session timeline console" />
            <div className="hero-visual-overlay">
              <span>LIVE SESSION</span><span>EVENT CURSOR 0241</span>
            </div>
          </div>
        </section>

        <section className="landing-capabilities section-shell" id="capabilities">
          <div className="section-rail">产品能力 <span>01—04</span></div>
          <div className="capability-intro"><p className="eyebrow">一个会话 / 全部设备</p><h2>从灵感到合并，<br /><em>每一步都在线。</em></h2><a className="text-link" href="#workbench">查看工作流 →</a></div>
          <div className="capability-grid">
            <article><span>01</span><h3>实时事件流</h3><p>按顺序查看 Codex 时间线，工具调用、输出和恢复状态都不会错过。</p></article>
            <article><span>02</span><h3>关键操作先审批</h3><p>高风险命令在浏览器中确认后才会触达你的工作区。</p></article>
            <article><span>03</span><h3>工作区持续同步</h3><p>项目、分支和对话上下文在桌面与手机之间保持一致。</p></article>
            <article><span>04</span><h3>文件直接回到手机</h3><p>生成的文件可从会话中直接下载，无需离开当前页面。</p></article>
          </div>
        </section>

        <section className="landing-workbench section-shell" id="workbench">
          <div className="workbench-heading"><p className="eyebrow">实时工作台</p><p className="section-caption">看清每一次工具调用，<br /><em>确认一次，</em>继续前进。</p></div>
          <div className="workbench-frame">
            <div className="workbench-topbar"><span>Codex</span><span className="live-label">● 实时</span><span className="frame-meta">会话：API 限流加固</span></div>
            <div className="workbench-columns">
              <aside><small>会话列表</small><strong>API 限流加固</strong><span>重构认证中间件</span><span>补充计费流程测试</span><span>排查 Webhook 重试</span></aside>
              <div className="transcript"><small>实时记录 · LIVE</small><div className="event-line"><b>Codex</b><span>我会更新限流逻辑并运行针对性测试。</span></div><div className="event-line tool"><b>工具调用</b><code>npm test -- --runInBand rateLimit</code></div><div className="event-line success"><b>已完成</b><span>12 项测试通过 · 312ms</span></div></div>
              <aside className="approval-rail"><small>审批 · 02 项待处理</small><strong>写入工作区</strong><code>src/middleware/rateLimit.ts</code><div><button type="button">查看</button><button type="button" className="approve-mini">批准</button></div></aside>
            </div>
            <div className="workbench-input">让 Codex 开始处理… <span>↥</span></div>
          </div>
          <a className="outline-link" href="#security">阅读协议 →</a>
        </section>

        <section className="landing-devices section-shell">
          <div className="devices-copy"><p className="eyebrow">桌面 / 手机 / 持续在线</p><h2>桌面端发起，<br /><em>手机端接续。</em></h2><a className="text-link" href="#download">查看接续流程 →</a></div>
          <div className="device-stage"><div className="device-card desktop-card"><span className="device-label">桌面客户端</span><strong>已连接</strong><small>WSS · LANKE-20250802G</small><div className="device-screen-lines" /></div><div className="device-card phone-card"><span className="device-label">手机网页</span><strong>会话 · 实时</strong><small>刚刚收到 3 条事件</small><div className="phone-chat"><i /> <i /> <i /></div></div><div className="handoff-line">1&nbsp; 登录 <span>→</span> 2&nbsp; 保持连接 <span>→</span> 3&nbsp; 随时接续</div></div>
        </section>

        <section className="landing-security section-shell" id="security">
          <div className="security-art" aria-hidden="true"><span className="security-key">⌁</span></div>
          <div className="security-copy"><p className="eyebrow">权限 / 可追溯</p><h2>权限控制，<br /><em>就是产品能力。</em></h2><p>高风险操作在浏览器中确认，每一条事件都可追溯。</p><div className="security-steps"><span><b>01</b> 请求</span><i>→</i><span><b>02</b> 核验</span><i>→</i><span><b>03</b> 恢复</span></div><a className="text-link" href={GITHUB_URL} target="_blank" rel="noreferrer">阅读协议 →</a></div><div className="security-index">05</div>
        </section>

        <section className="landing-cta section-shell" id="download">
          <div className="cta-object" aria-hidden="true" />
          <div className="cta-copy"><p className="eyebrow">开源核心 / Windows 安装包 / WSS</p><h2>把你的会话，<br /><em>带在身边。</em></h2><p>安装桌面客户端，连接本地工作区，无论身在何处都能继续推进。</p><div className="cta-stack"><a className="cta-primary wide" href={DOWNLOAD_URL}>下载 CodeHarbor Windows 客户端 <span>↓</span></a><a className="cta-secondary wide" href={GITHUB_URL} target="_blank" rel="noreferrer">查看 GitHub 源码 <span>↗</span></a></div></div>
        </section>

        <section className="landing-auth section-shell" ref={authRef} aria-labelledby="auth-title">
          <div><p className="eyebrow">你的私人工程工作区</p><h2 id="auth-title">登录一次，<br /><em>持续在线。</em></h2><p className="auth-support">桌面客户端和浏览器使用同一账号。还没有账号？几秒即可完成注册。</p></div>
          <form className="auth-panel" onSubmit={submitAuth}>
            <div className="auth-panel-tabs"><button type="button" className={authMode === "login" ? "active" : ""} onClick={() => { setAuthMode("login"); clearError(); }}>登录</button><button type="button" className={authMode === "register" ? "active" : ""} onClick={() => { setAuthMode("register"); clearError(); }}>注册账号</button></div>
            {error && <div className="auth-error" role="alert">{error}</div>}
            <label>账号<input value={user} onChange={(event) => { setUser(event.target.value); clearError(); }} autoComplete="username" placeholder="输入账号" required /></label>
            <label>密码<input type="password" value={authMode === "register" ? registerPassword : password} onChange={(event) => { authMode === "register" ? setRegisterPassword(event.target.value) : setPassword(event.target.value); clearError(); }} autoComplete={authMode === "register" ? "new-password" : "current-password"} placeholder={authMode === "register" ? "至少 12 位字符" : "输入密码"} required /></label>
            {authMode === "register" && <label>确认密码<input type="password" value={registerPasswordConfirm} onChange={(event) => setRegisterPasswordConfirm(event.target.value)} autoComplete="new-password" placeholder="再次输入密码" required /></label>}
            <button className="auth-submit" type="submit" disabled={isSubmitting || !user.trim() || (authMode === "register" ? registerPassword.length < 12 || registerPassword !== registerPasswordConfirm : !password)}>{isSubmitting ? "正在连接…" : authMode === "register" ? "注册并进入 →" : "登录工作台 →"}</button>
            <small className="auth-footnote">凭据仅发送至 <strong>code.pixlnan.com</strong>，不会写入页面地址。</small>
          </form>
        </section>
      </main>

      <footer className="landing-footer"><a className="landing-brand" href="#top"><span className="landing-brand-mark" aria-hidden="true">⌾</span><span>CODEHARBOR</span></a><div><a href="#capabilities">产品能力</a><a href="#security">安全协议</a><a href={GITHUB_URL} target="_blank" rel="noreferrer">GitHub</a></div><div><button type="button" onClick={() => focusAuth("login")}>登录</button><button type="button" onClick={() => focusAuth("register")}>注册账号</button></div><small>v1.0.0 / 2026</small></footer>
    </div>
  );
}
