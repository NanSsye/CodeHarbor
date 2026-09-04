const { app, BrowserWindow, Menu, Tray, nativeImage, dialog, ipcMain, shell, safeStorage } = require("electron");
const { spawn, execFileSync } = require("child_process");
const { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } = require("fs");
const path = require("path");
const crypto = require("crypto");

const RELAY_ORIGIN = process.env.CODEHARBOR_RELAY_ORIGIN || "https://code.pixlnan.com";
const PORT = Number(process.env.CODEHARBOR_PORT || 8787);
let mainWindow;
let tray;
let isQuitting = false;
const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.quit();
else app.on("second-instance", () => { mainWindow?.show(); mainWindow?.focus(); });
let gatewayProcess;
let managedGateway = false;
let externalGateway = false;
let gatewayError = "";
let relayConnected = false;
let relayError = "";
let relayLoginState = "未配置";
let lastLoggedRelayState = "";
let logLines = [];
let settings = {};
let gatewayStartPromise;

function dataDir() { return path.join(app.getPath("userData"), "data"); }
function settingsPath() { return path.join(dataDir(), "settings.json"); }
function logsPath() { return path.join(dataDir(), "gateway.log"); }
function resourcePath(...parts) { return app.isPackaged ? path.join(process.resourcesPath, ...parts) : path.resolve(__dirname, "..", "..", ...parts); }
function gatewayEntry() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "gateway", "server", "dist", "main.js")
    : resourcePath("server", "dist", "main.js");
}
function appDist() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "gateway", "app", "dist")
    : resourcePath("app", "dist");
}
function nodeRuntime() {
  return app.isPackaged ? path.join(process.resourcesPath, "runtime", "node", "node.exe") : process.execPath;
}

function protect(value) {
  if (!value) return "";
  if (safeStorage.isEncryptionAvailable()) return `enc:${safeStorage.encryptString(value).toString("base64")}`;
  return `plain:${Buffer.from(value, "utf8").toString("base64")}`;
}
function unprotect(value) {
  if (typeof value !== "string" || !value) return "";
  try {
    if (value.startsWith("enc:")) return safeStorage.decryptString(Buffer.from(value.slice(4), "base64"));
    if (value.startsWith("plain:")) return Buffer.from(value.slice(6), "base64").toString("utf8");
  } catch { return ""; }
  return "";
}
function loadSettings() {
  mkdirSync(dataDir(), { recursive: true });
  try { settings = JSON.parse(readFileSync(settingsPath(), "utf8")); } catch { settings = {}; }
  // Migrate legacy user-managed Gateway credentials to an internal secret.
  // The desktop UI must never expose or require a second local account.
  let changed = false;
  if (!settings.sessionSecret) {
    const legacySecret = unprotect(settings.gatewayPassword);
    settings.sessionSecret = protect(legacySecret || makeSecret());
    changed = true;
  }
  if (Object.prototype.hasOwnProperty.call(settings, "username")) { delete settings.username; changed = true; }
  if (Object.prototype.hasOwnProperty.call(settings, "gatewayPassword")) { delete settings.gatewayPassword; changed = true; }
  if (changed) saveSettingsFile();
  const migratedCodex = settings.codexBin && resolveCodex(settings.codexBin);
  if (migratedCodex && migratedCodex !== settings.codexBin) {
    settings.codexBin = migratedCodex;
    saveSettingsFile();
  }
}
function saveSettingsFile() { mkdirSync(dataDir(), { recursive: true }); writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), { mode: 0o600 }); }
function appendLog(value) {
  const lines = String(value || "").split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean);
  for (const line of lines) {
    const text = `[${new Date().toLocaleTimeString("zh-CN", { hour12: false })}] ${line}`;
    logLines.push(text.slice(0, 4000));
    try { appendFileSync(logsPath(), `${text}\n`, "utf8"); } catch {}
  }
  if (logLines.length > 240) logLines = logLines.slice(-240);
  mainWindow?.webContents.send("desktop:state", getState());
}
function setRelayLoginState(next, detail = "") {
  if (relayLoginState === next && (!detail || relayError === detail)) return;
  relayLoginState = next;
  if (detail) relayError = detail;
  appendLog(`云端账号状态：${next}${detail ? `（${detail}）` : ""}`);
}
function reportRelayState() {
  const state = relayConnected ? "已连接" : relayError ? `错误：${relayError}` : "连接中";
  if (state === lastLoggedRelayState) return;
  lastLoggedRelayState = state;
  appendLog(`中转状态：${state}`);
}
function detectCodex() {
  const configured = process.env.CODEX_BIN;
  const configuredResolved = configured && resolveCodex(configured);
  if (configuredResolved) return configuredResolved;
  try {
    const matches = execFileSync("where.exe", ["codex"], { encoding: "utf8", windowsHide: true }).split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
    return matches.map((value) => normalizeCodexPath(value)).find((value) => existsSync(value)) || matches[0] || "codex";
  } catch { return "codex"; }
}
function normalizeCodexPath(command) {
  const value = String(command || "").trim();
  if (!value || (!value.includes("\\") && !value.includes("/") && !/^[A-Za-z]:/.test(value))) return value;
  if (!path.extname(value)) {
    for (const extension of [".cmd", ".bat", ".exe"]) {
      const candidate = `${value}${extension}`;
      if (existsSync(candidate)) return candidate;
    }
  }
  if (existsSync(value)) return value;
  return value;
}
function resolveCodex(command) {
  const normalized = normalizeCodexPath(command);
  if (normalized.includes("\\") || normalized.includes("/") || /^[A-Za-z]:/.test(normalized)) return existsSync(normalized) ? normalized : null;
  try {
    const matches = execFileSync("where.exe", [normalized], { encoding: "utf8", windowsHide: true }).split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
    return matches.map((value) => normalizeCodexPath(value)).find((value) => existsSync(value)) || null;
  } catch { return null; }
}
function configuredCodex() {
  return (settings.codexBin && resolveCodex(settings.codexBin)) || detectCodex();
}
function codexHome() { return process.env.CODEX_HOME || path.join(process.env.USERPROFILE || app.getPath("home"), ".codex"); }
function makeSecret() { return crypto.randomBytes(32).toString("hex"); }
function currentGatewayPassword() { return unprotect(settings.sessionSecret); }
function gatewayEnv() {
  const password = currentGatewayPassword();
  const secret = unprotect(settings.sessionSecret);
  const relayPassword = unprotect(settings.relayPassword);
  return {
    ...process.env,
    NODE_ENV: "production",
    ACODE_FRIENDLY_LOGS: "true",
    HOST: "127.0.0.1",
    PORT: String(PORT),
    PUBLIC_ORIGIN: `http://127.0.0.1:${PORT}`,
    ADMIN_TOKEN: password,
    GATEWAY_AUTH_TOKEN: password,
    GATEWAY_AUTH_PASSWORD: password,
    GATEWAY_AUTH_USERNAME: "desktop",
    SESSION_SECRET: secret,
    CODEX_BIN: configuredCodex(),
    CODEX_HOME: settings.codexHome || codexHome(),
    RELAY_URL: RELAY_ORIGIN,
    RELAY_ACCOUNT_USERNAME: settings.relayUsername || "",
    RELAY_ACCOUNT_PASSWORD: relayPassword,
    ACODE_CONFIG: path.join(dataDir(), "desktop.env")
  };
}
async function health() {
  try { const response = await fetch(`http://127.0.0.1:${PORT}/healthz`, { signal: AbortSignal.timeout(900) }); return response.ok ? await response.json() : null; } catch { return null; }
}
async function relayStatus() {
  try {
    const response = await fetch(`http://127.0.0.1:${PORT}/api/relay/status`, { headers: { authorization: `Bearer ${currentGatewayPassword()}` }, signal: AbortSignal.timeout(1200) });
    if (!response.ok) return { connected: false, error: `HTTP ${response.status}` };
    const body = await response.json();
    return { connected: body?.relay?.connected === true, error: body?.relay?.lastError || "" };
  } catch (error) { return { connected: false, error: error?.message || "中转状态暂不可用" }; }
}
function isPortOpen(port) {
  return new Promise((resolve) => {
    const net = require("net");
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(500);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("timeout", () => { socket.destroy(); resolve(false); });
    socket.once("error", () => resolve(false));
  });
}
async function waitForHealth(timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) { const result = await health(); if (result?.ok) return result; await new Promise((resolve) => setTimeout(resolve, 250)); }
  return null;
}
async function startGateway() {
  if (gatewayStartPromise) return gatewayStartPromise;
  gatewayStartPromise = (async () => {
    if (gatewayProcess) return getState();
    const existing = await health();
    if (existing) {
      externalGateway = true;
      ({ connected: relayConnected, error: relayError } = await relayStatus());
      relayLoginState = relayConnected ? "已登录并已连接" : (relayError ? "登录失败" : "已启动，等待中转");
      reportRelayState();
      return getState();
    }
    if (!currentGatewayPassword()) return getState();
    if (await isPortOpen(PORT)) {
      gatewayError = `端口 ${PORT} 已被其他程序占用，请先关闭旧 Gateway（${PORT}）`;
      appendLog(`Gateway 未启动：${gatewayError}`);
      return getState();
    }
    if (!existsSync(gatewayEntry())) {
      gatewayError = `找不到 Gateway 构建文件：${gatewayEntry()}`;
      appendLog(gatewayError);
      return getState();
    }
    gatewayError = "";
    appendLog(`正在启动 Gateway（Node ${nodeRuntime()}，端口 ${PORT}）`);
    const nodeExecutable = nodeRuntime();
    gatewayProcess = spawn(nodeExecutable, [gatewayEntry()], { cwd: path.dirname(gatewayEntry()), env: { ...gatewayEnv(), ...(app.isPackaged ? {} : { ELECTRON_RUN_AS_NODE: "1" }) }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    managedGateway = true;
    externalGateway = false;
    relayLoginState = settings.relayUsername && unprotect(settings.relayPassword) ? "正在登录" : "未配置";
    gatewayProcess.stdout.on("data", (chunk) => appendLog(chunk.toString()));
    gatewayProcess.stderr.on("data", (chunk) => appendLog(chunk.toString()));
    gatewayProcess.on("error", (error) => { gatewayError = error.message; setRelayLoginState("不可用", error.message); appendLog(`Gateway 启动失败：${error.message}`); });
    gatewayProcess.on("exit", (code, signal) => { appendLog(`Gateway 已退出（code=${code ?? "?"}, signal=${signal ?? "-"}）`); gatewayProcess = undefined; managedGateway = false; externalGateway = false; relayConnected = false; relayLoginState = "未运行"; mainWindow?.webContents.send("desktop:state", getState()); });
    const ready = await waitForHealth();
    if (!ready) gatewayError = gatewayError || "Gateway 启动超时，请查看日志";
    if (ready) {
      ({ connected: relayConnected, error: relayError } = await relayStatus());
      relayLoginState = relayConnected ? "已登录并已连接" : (relayError ? "登录失败" : "正在连接中转");
      appendLog(`Gateway 已就绪；中转状态：${relayLoginState}`);
      reportRelayState();
    }
    return getState();
  })();
  try { return await gatewayStartPromise; } finally { gatewayStartPromise = undefined; }
}
async function stopGateway() {
  if (!gatewayProcess || !managedGateway) { externalGateway = false; return getState(); }
  gatewayProcess.kill();
  await new Promise((resolve) => setTimeout(resolve, 500));
  if (gatewayProcess && !gatewayProcess.killed) gatewayProcess.kill("SIGTERM");
  gatewayProcess = undefined; managedGateway = false; externalGateway = false;
  return getState();
}
async function restartGateway() { await stopGateway(); return startGateway(); }
function getState() {
  const running = Boolean(gatewayProcess) || externalGateway;
  return {
    settings: { relayUsername: settings.relayUsername || "", relayPasswordSaved: Boolean(unprotect(settings.relayPassword)) },
    gateway: { running, managed: managedGateway, port: PORT, origin: `http://127.0.0.1:${PORT}`, error: gatewayError, relayConnected, relayError, relayLoginState },
    checks: {
      codex: { ok: Boolean(resolveCodex(configuredCodex())), detail: configuredCodex() },
      codexHome: { ok: existsSync(settings.codexHome || codexHome()), detail: settings.codexHome || codexHome() }
    },
    logs: logLines.slice(-40)
  };
}
async function openWorkspace() {
  const ready = await waitForHealth(4000);
  if (!ready) { dialog.showErrorBox("Gateway 尚未就绪", "请先保存配置并等待 Gateway 启动完成。"); return; }
  await authenticateRelay();
  mainWindow.loadURL(RELAY_ORIGIN);
}
async function authenticateRelay() {
  const username = settings.relayUsername;
  const password = unprotect(settings.relayPassword);
  if (!username || !password) return false;
  try {
    const response = await fetch(`${RELAY_ORIGIN}/api/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password }), signal: AbortSignal.timeout(8000) });
    if (!response.ok) { setRelayLoginState("登录失败", `HTTP ${response.status}`); appendLog(`云端登录失败（HTTP ${response.status}），工作台将显示登录页`); return false; }
    const cookies = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
    for (const raw of cookies) {
      const pair = raw.split(";", 1)[0].split("=", 2);
      if (pair.length !== 2) continue;
      await require("electron").session.defaultSession.cookies.set({ url: RELAY_ORIGIN, name: pair[0], value: pair[1], secure: RELAY_ORIGIN.startsWith("https://"), httpOnly: true });
    }
    setRelayLoginState("已登录");
    appendLog("云端账号已登录，正在打开工作台");
    return true;
  } catch (error) { setRelayLoginState("登录失败", error?.message || "网络错误"); appendLog(`云端登录暂不可用：${error?.message || "网络错误"}`); return false; }
}
async function logoutRelay() {
  settings.relayUsername = "";
  settings.relayPassword = "";
  saveSettingsFile();
  relayConnected = false;
  relayError = "";
  relayLoginState = "未配置";
  try { await require("electron").session.defaultSession.cookies.remove(RELAY_ORIGIN, "codeharbor_session"); } catch {}
  appendLog("已退出云端账号");
  return getState();
}
function createWindow() {
  mainWindow = new BrowserWindow({ width: 1180, height: 820, minWidth: 760, minHeight: 620, backgroundColor: "#f5f7fb", title: "CodeHarbor", webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//i.test(url)) shell.openExternal(url); return { action: "deny" }; });
  mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  mainWindow.on("close", (event) => {
    if (isQuitting) return;
    event.preventDefault();
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: "question",
      buttons: ["最小化到托盘", "退出程序"],
      defaultId: 0,
      cancelId: 0,
      title: "关闭 CodeHarbor",
      message: "要让本机 Gateway 继续运行吗？",
      detail: "选择“最小化到托盘”后，Gateway 会继续保持在线；选择“退出程序”才会停止本机 Gateway。"
    });
    if (choice === 0) {
      ensureTray();
      mainWindow.hide();
    } else {
      isQuitting = true;
      app.quit();
    }
  });
  mainWindow.on("closed", () => { mainWindow = undefined; });
}
function ensureTray() {
  if (tray) return;
  const trayIcon = nativeImage.createFromDataURL("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=");
  tray = new Tray(trayIcon);
  tray.setToolTip("CodeHarbor Gateway");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "打开控制台", click: () => { mainWindow?.show(); mainWindow?.focus(); } },
    { label: "打开工作台", click: () => void openWorkspace() },
    { type: "separator" },
    { label: "退出程序", click: () => { isQuitting = true; app.quit(); } }
  ]));
  tray.on("double-click", () => { mainWindow?.show(); mainWindow?.focus(); });
}
function buildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: "CodeHarbor", submenu: [{ label: "打开工作台", click: () => void openWorkspace() }, { label: "重新打开桌面控制台", click: () => mainWindow?.loadFile(path.join(__dirname, "..", "renderer", "index.html")) }, { type: "separator" }, { role: "quit" }] }, { label: "帮助", submenu: [{ label: "打开日志目录", click: () => shell.openPath(dataDir()) }] }]));
}

ipcMain.handle("desktop:get-state", async () => {
  if (await health()) {
    externalGateway = true;
    ({ connected: relayConnected, error: relayError } = await relayStatus());
    if (relayConnected) relayLoginState = "已登录并已连接";
    else if (relayError) relayLoginState = "登录失败";
    else if (!settings.relayUsername) relayLoginState = "未配置";
    else relayLoginState = "正在连接中转";
    reportRelayState();
  } else if (!gatewayProcess) {
    externalGateway = false;
    relayConnected = false;
    relayLoginState = "未运行";
  }
  return getState();
});
ipcMain.handle("desktop:save-settings", async (_event, input) => {
  if (!input || typeof input !== "object") throw new Error("无效的登录配置");
  const relayUsername = String(input.relayUsername || "").trim().slice(0, 160);
  if (!relayUsername) throw new Error("请输入云端账号");
  const relayPassword = typeof input.relayPassword === "string" ? input.relayPassword : "";
  if (!relayPassword && !unprotect(settings.relayPassword)) throw new Error("请输入云端密码");
  if (settings.relayUsername && settings.relayUsername !== relayUsername && !relayPassword) throw new Error("切换云端账号时请输入对应密码");
  settings = { ...settings, sessionSecret: settings.sessionSecret || protect(makeSecret()), relayUsername, relayPassword: relayPassword ? protect(relayPassword) : settings.relayPassword || "", codexBin: configuredCodex(), codexHome: settings.codexHome || codexHome() };
  saveSettingsFile();
  appendLog("配置已保存，正在启动 Gateway…");
  const state = await startGateway();
  if (settings.relayUsername && unprotect(settings.relayPassword)) await openWorkspace();
  return state;
});
ipcMain.handle("desktop:open-workspace", () => openWorkspace());
ipcMain.handle("desktop:open-register", () => shell.openExternal(`${RELAY_ORIGIN}/?register=1`));
ipcMain.handle("desktop:logout-relay", () => logoutRelay());
ipcMain.handle("desktop:open-logs", () => shell.openPath(dataDir()));
ipcMain.handle("desktop:restart-gateway", () => restartGateway());
ipcMain.handle("desktop:stop-gateway", () => stopGateway());

app.whenReady().then(async () => {
  loadSettings();
  try { if (existsSync(logsPath())) logLines = readFileSync(logsPath(), "utf8").split(/\r?\n/).filter(Boolean).slice(-240); } catch {}
  createWindow(); buildMenu();
  if (currentGatewayPassword()) {
    await startGateway();
    mainWindow?.webContents.send("desktop:state", getState());
    if (settings.relayUsername && unprotect(settings.relayPassword)) await openWorkspace();
  }
  app.on("activate", () => { if (!mainWindow) createWindow(); });
});
app.on("before-quit", () => { isQuitting = true; tray?.destroy(); tray = undefined; if (gatewayProcess && managedGateway) gatewayProcess.kill(); });
