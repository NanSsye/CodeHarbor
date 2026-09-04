const api = window.codeharborDesktop;
const $ = (id) => document.getElementById(id);
const logLines = [];

function appendLog(line) {
  if (!line) return;
  const value = String(line);
  const stamped = /^\[\d{2}:\d{2}:\d{2}\]/.test(value)
    ? value
    : `[${new Date().toLocaleTimeString("zh-CN", { hour12: false })}] ${value}`;
  logLines.push(stamped.slice(0, 2_000));
  while (logLines.length > 160) logLines.shift();
  $("logs").textContent = logLines.join("\n");
}

function mark(id, ok, detail) {
  const icon = $(id);
  icon.textContent = ok ? "✓" : "!";
  icon.className = `check-icon ${ok ? "ok" : "bad"}`;
  $(id.replace("-check", "-detail")).textContent = detail;
}

function render(state) {
  if (!state) return;
  const card = $("status-card");
  const running = state.gateway?.running === true;
  const relay = state.gateway?.relayConnected === true;
  card.className = `status-card ${running && relay ? "ok" : running ? "" : "bad"}`;
  $("status-title").textContent = running ? (relay ? "Gateway 已连接 · 中转已连接" : "Gateway 已连接 · 中转连接中") : "Gateway 未运行";
  const loginState = state.gateway?.relayLoginState || "未配置";
  $("status-detail").textContent = running
    ? `${loginState}${state.gateway?.relayError ? ` · ${state.gateway.relayError}` : ""}`
    : (state.gateway?.error || "保存配置后启动本机服务");
  const connected = running && relay;
  const loginBadge = $("login-state");
  loginBadge.textContent = connected ? "已连接" : running ? "连接中" : "未连接";
  loginBadge.className = `card-state ${connected ? "connected" : running ? "pending" : ""}`;
  const saveButton = $("save-button");
  saveButton.textContent = connected ? "已连接 · 配置已保存" : "保存并启动 Gateway";
  saveButton.classList.toggle("connected", connected);
  $("workspace-button").disabled = !state.gateway?.running;
  mark("codex-check", state.checks?.codex?.ok, state.checks?.codex?.detail || "未检测");
  mark("home-check", state.checks?.codexHome?.ok, state.checks?.codexHome?.detail || "未检测");
  mark("port-check", state.gateway?.running, state.gateway?.running ? `127.0.0.1:${state.gateway.port}` : "等待启动");
  if (state.settings) {
    $("username").value = state.settings.username || "";
    $("relay-username").value = state.settings.relayUsername || "";
    $("logout-button").hidden = !state.settings.relayUsername;
  }
  if (Array.isArray(state.logs)) $("logs").textContent = state.logs.join("\n");
}

$("setup-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("save-button");
  const password = $("password").value;
  if (password.length < 16) { $("error").textContent = "工作台密码至少需要 16 位。"; return; }
  button.disabled = true; button.textContent = "保存中…"; $("error").textContent = "";
  try {
    const username = $("username").value.trim();
    if (!username) { $("error").textContent = "请输入本机 Gateway 账号。"; return; }
    const result = await api.saveSettings({ username, password, relayUsername: $("relay-username").value.trim(), relayPassword: $("relay-password").value });
    render(result);
  } catch (error) { $("error").textContent = error?.message || "保存失败"; }
  button.disabled = false;
  if (!$("login-state").classList.contains("connected")) button.textContent = "保存并启动 Gateway";
});

$("workspace-button").addEventListener("click", () => api.openWorkspace());
$("register-button").addEventListener("click", () => api.openRegister());
$("logout-button").addEventListener("click", async () => {
  const result = await api.logoutRelay();
  render(result);
  $("relay-password").value = "";
});
$("restart-button").addEventListener("click", async () => { appendLog("正在重启 Gateway…"); render(await api.restartGateway()); });
$("logs-button").addEventListener("click", () => api.openLogs());
$("stop-button").addEventListener("click", async () => { appendLog("正在停止 Gateway…"); render(await api.stopGateway()); });

api.onState(render);
api.getState().then(render).catch((error) => { $("error").textContent = error?.message || "无法读取桌面状态"; });
window.setInterval(() => {
  api.getState().then(render).catch(() => undefined);
}, 1000);
