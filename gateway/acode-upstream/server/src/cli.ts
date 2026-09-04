import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { access, constants, stat } from "node:fs/promises";
import { homedir, networkInterfaces } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { createConnection } from "node:net";
import { officialRelay } from "./officialRelay.js";
import { sqlitePath } from "./sqlite.js";
import { detectCodexBin, resolveCodexCommand } from "./codexPath.js";

type Command =
  | "init"
  | "official-init"
  | "start"
  | "official-start"
  | "doctor"
  | "install-service"
  | "official-install-service"
  | "uninstall-service"
  | "help";

const command = normalizeCommand(process.argv[2]);

switch (command) {
  case "init":
    await initConfig();
    break;
  case "official-init":
    await initConfig({ officialRelayMode: true });
    break;
  case "start":
    await start();
    break;
  case "official-start":
    await start({ officialRelayMode: true });
    break;
  case "doctor":
    await doctor();
    break;
  case "install-service":
    installService();
    break;
  case "official-install-service":
    await initConfig({ officialRelayMode: true });
    installService({ officialRelayMode: true });
    break;
  case "uninstall-service":
    uninstallService();
    break;
  case "help":
    printHelp();
    break;
}

async function start(options: { officialRelayMode?: boolean } = {}) {
  if (options.officialRelayMode && !process.env.ACODE_FRIENDLY_LOGS) {
    process.env.ACODE_FRIENDLY_LOGS = "true";
  }
  if (options.officialRelayMode && !existsSync(resolveReadableConfigPath())) {
    await initConfig({ officialRelayMode: true });
  }
  await reconcileConfig(resolveReadableConfigPath());
  const env = readEnvFile(resolveReadableConfigPath());
  const port = Number(env.PORT ?? process.env.PORT ?? "8787");
  const existing = await readExistingHealth(port);
  if (existing?.ok) {
    console.log(`aCode Server is already running on port ${port}.`);
    if (typeof existing.publicOrigin === "string") {
      console.log(`Running service URL: ${existing.publicOrigin}`);
    }
    console.log("This launcher will not start a second server.");
    console.log("If you generated a new Admin token just now, stop the old service first or keep using the old service token.");
    return;
  }
  if (await isPortOpen(port)) {
    console.error(`Port ${port} is already in use, but it does not look like aCode Server.`);
    console.error("Stop the process using this port, or change PORT in the config file.");
    process.exitCode = 1;
    return;
  }
  await import("./main.js");
}

function normalizeCommand(value: string | undefined): Command {
  if (!value || value === "-h" || value === "--help" || value === "help") return "help";
  if ([
    "init",
    "official-init",
    "start",
    "official-start",
    "doctor",
    "install-service",
    "official-install-service",
    "uninstall-service"
  ].includes(value)) {
    return value as Command;
  }
  console.error(`Unknown command: ${value}`);
  return "help";
}

async function initConfig(options: { officialRelayMode?: boolean } = {}) {
  const configPath = resolveWritableConfigPath();
  if (existsSync(configPath) && !process.argv.includes("--force")) {
    console.log(`Config already exists: ${configPath}`);
    await reconcileConfig(configPath);
    printConnectionHint(readEnvFile(configPath));
    return;
  }

  const port = await pickAvailablePort(Number(envValue("PORT", "8787")));
  const host = options.officialRelayMode ? "127.0.0.1" : envValue("HOST", "0.0.0.0");
  const origin = options.officialRelayMode
    ? `http://127.0.0.1:${port}`
    : envValue("PUBLIC_ORIGIN", `http://${firstLanAddress()}:${port}`);
  const codexBin = envValue("CODEX_BIN", detectCodexBin());
  const codexHome = envValue("CODEX_HOME", detectCodexHome());
  const configLines = [
    `HOST=${host}`,
    `PORT=${port}`,
    `PUBLIC_ORIGIN=${origin}`,
    `ADMIN_TOKEN=${randomToken()}`,
    `SESSION_SECRET=${randomToken()}`,
    `CODEX_BIN=${codexBin}`,
    `CODEX_HOME=${codexHome}`,
    `CODEX_APP_SERVER_PORT=${envValue("CODEX_APP_SERVER_PORT", "8790")}`,
    // Keep newly initialized Gateway logins aligned with the server default
    // (30 days); existing config files remain operator-controlled.
    `SESSION_TTL_HOURS=${envValue("SESSION_TTL_HOURS", String(30 * 24))}`,
    `APP_UPDATE_VERSION_CODE=${envValue("APP_UPDATE_VERSION_CODE", "100030018")}`,
    `APP_UPDATE_VERSION_NAME=${envValue("APP_UPDATE_VERSION_NAME", "1.0.3.18")}`,
    `APP_UPDATE_NOTES="aCode Android 更新包"`,
    `APP_UPDATE_APK_PATH=${path.join(appBaseDir(), "aCode-latest.apk")}`,
    `APP_UPDATE_PUBLIC_DOWNLOAD=true`
  ];
  if (options.officialRelayMode) {
    configLines.push(`RELAY_URL=${officialRelay.url}`);
    configLines.push("RELAY_DEVICE_NAME=");
  }
  const config = configLines.join("\n");

  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${config}\n`, { encoding: "utf8", mode: 0o600 });
  console.log(`Config written: ${configPath}`);
  if (options.officialRelayMode) {
    console.log("Official relay mode configured.");
  }
  printConnectionHint(readEnvFile(configPath));
}

async function doctor() {
  const env = readEnvFile(resolveReadableConfigPath());
  const codexBin = env.CODEX_BIN || detectCodexBin();
  const codexHome = env.CODEX_HOME || detectCodexHome();
  const statePath = path.join(codexHome, "state_5.sqlite");
  const checks: Array<[string, boolean, string]> = [];
  checks.push(["config", existsSync(resolveReadableConfigPath()), resolveReadableConfigPath()]);
  checks.push(["ADMIN_TOKEN", Boolean(env.ADMIN_TOKEN && env.ADMIN_TOKEN.length >= 16), env.ADMIN_TOKEN ? "set" : "missing"]);
  checks.push(["SESSION_SECRET", Boolean(env.SESSION_SECRET && env.SESSION_SECRET.length >= 16), env.SESSION_SECRET ? "set" : "missing"]);
  checks.push(["codex", commandExists(codexBin), codexBin]);
  checks.push(["sqlite", commandExists(sqlitePath()), sqlitePath()]);
  checks.push(["codex home", existsSync(codexHome), codexHome]);
  checks.push(["state db", existsSync(statePath), statePath]);
  checks.push(["apk", await isReadable(env.APP_UPDATE_APK_PATH ?? path.join(process.cwd(), "aCode-debug.apk")), env.APP_UPDATE_APK_PATH ?? "aCode-debug.apk"]);

  for (const [name, ok, detail] of checks) {
    console.log(`${ok ? "OK " : "ERR"} ${name}: ${detail}`);
  }
  printDoctorHints(checks, env, codexBin, codexHome);
  if (checks.some(([, ok]) => !ok)) process.exitCode = 1;
}

function installService(options: { officialRelayMode?: boolean } = {}) {
  const configPath = resolveReadableConfigPath();
  const nodePath = process.execPath;
  const entryPath = process.argv[1];
  const startCommand = options.officialRelayMode ? "official-start" : "start";
  if (process.platform === "darwin") {
    const plistPath = path.join(homedir(), "Library", "LaunchAgents", "org.acode.gateway.plist");
    mkdirSync(path.dirname(plistPath), { recursive: true });
    writeFileSync(plistPath, macLaunchAgent(nodePath, entryPath, configPath), "utf8");
    console.log(`LaunchAgent written: ${plistPath}`);
    console.log(`Load with: launchctl bootstrap gui/$(id -u) ${plistPath}`);
    return;
  }
  if (process.platform === "linux") {
    const servicePath = path.join(homedir(), ".config", "systemd", "user", "acode-server.service");
    mkdirSync(path.dirname(servicePath), { recursive: true });
    writeFileSync(servicePath, linuxSystemdUser(nodePath, entryPath, configPath), "utf8");
    console.log(`systemd user service written: ${servicePath}`);
    console.log("Run: systemctl --user daemon-reload && systemctl --user enable --now acode-server");
    return;
  }
  if (process.platform === "win32") {
    console.log("Run this PowerShell command as the current user:");
    console.log(`schtasks /Create /TN aCodeServer /SC ONLOGON /TR "\\"${nodePath}\\" \\"${entryPath}\\" ${startCommand} --config \\"${configPath}\\"" /F`);
    return;
  }
  console.log(`Unsupported platform: ${process.platform}`);
}

function uninstallService() {
  if (process.platform === "darwin") {
    console.log("Run: launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/org.acode.gateway.plist");
    return;
  }
  if (process.platform === "linux") {
    console.log("Run: systemctl --user disable --now acode-server");
    return;
  }
  if (process.platform === "win32") {
    console.log("Run: schtasks /Delete /TN aCodeServer /F");
    return;
  }
}

function printHelp() {
  console.log(`aCode server

Usage:
  acode-server init [--force]
  acode-server official-init [--force]
  acode-server start [--config path]
  acode-server official-start [--config path]
  acode-server doctor [--config path]
  acode-server install-service [--config path]
  acode-server official-install-service [--config path]
  acode-server uninstall-service
`);
}

function readEnvFile(filePath: string) {
  const env: Record<string, string> = {};
  if (!existsSync(filePath)) return env;
  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (!match) continue;
    env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
  return env;
}

function printConnectionHint(env: Record<string, string>) {
  if (env.RELAY_URL === officialRelay.url) {
    console.log("Official relay URL is preconfigured.");
    if (hasRelayAccountCredentials(env)) {
      console.log("Relay account credentials are configured; start the gateway to enroll this computer.");
    } else {
      console.log("Set RELAY_ACCOUNT_TOKEN at runtime, or set RELAY_ACCOUNT_USERNAME and RELAY_ACCOUNT_PASSWORD in the config before starting.");
      console.log("Credentials are used only for enrollment and are never printed by this launcher.");
    }
    console.log("After enrollment, the per-device credential is stored locally and reused on reconnect.");
    return;
  }
  console.log(`Service URL: ${env.PUBLIC_ORIGIN ?? `http://${firstLanAddress()}:${env.PORT ?? 8787}`}`);
  console.log(`Admin token: ${env.ADMIN_TOKEN ?? "(missing)"}`);
  console.log(`APK URL: ${(env.PUBLIC_ORIGIN ?? `http://${firstLanAddress()}:${env.PORT ?? 8787}`).replace(/\/+$/, "")}/download/aCode-latest.apk`);
}

function resolveReadableConfigPath() {
  const explicit = argValue("--config") ?? process.env.ACODE_CONFIG;
  if (explicit) return path.resolve(explicit);
  return defaultConfigPath();
}

function resolveWritableConfigPath() {
  return resolveReadableConfigPath();
}

function argValue(name: string) {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  const prefix = `${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : undefined;
}

function envValue(key: string, fallback: string) {
  return process.env[key] ?? fallback;
}

function hasRelayAccountCredentials(env: Record<string, string>) {
  const token = env.RELAY_ACCOUNT_TOKEN || env.CODEHARBOR_ACCOUNT_TOKEN || process.env.RELAY_ACCOUNT_TOKEN || process.env.CODEHARBOR_ACCOUNT_TOKEN;
  const username = env.RELAY_ACCOUNT_USERNAME || env.CODEHARBOR_ACCOUNT_USERNAME || process.env.RELAY_ACCOUNT_USERNAME || process.env.CODEHARBOR_ACCOUNT_USERNAME;
  const password = env.RELAY_ACCOUNT_PASSWORD ?? env.CODEHARBOR_ACCOUNT_PASSWORD ?? process.env.RELAY_ACCOUNT_PASSWORD ?? process.env.CODEHARBOR_ACCOUNT_PASSWORD;
  return Boolean(token || (username && password));
}

function firstLanAddress() {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  return "127.0.0.1";
}

function randomToken() {
  return randomBytes(32).toString("hex");
}

function commandExists(command: string) {
  return resolveCodexCommand(command) !== null;
}

async function isReadable(filePath: string) {
  try {
    const file = await stat(filePath);
    await access(filePath, constants.R_OK);
    return file.isFile();
  } catch {
    return false;
  }
}

async function readExistingHealth(port: number) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(900) });
    if (!response.ok) return null;
    const body = await response.json() as { ok?: unknown; publicOrigin?: unknown };
    if (body?.ok !== true) return null;
    return body;
  } catch {
    return null;
  }
}

function isPortOpen(port: number) {
  return new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(700);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(false));
  });
}

function appBaseDir() {
  const entryDir = path.dirname(process.argv[1] ? path.resolve(process.argv[1]) : process.cwd());
  if (path.basename(entryDir) === "dist" && path.basename(path.dirname(entryDir)) === "server") {
    return path.dirname(path.dirname(entryDir));
  }
  return entryDir;
}

async function reconcileConfig(configPath: string) {
  if (!existsSync(configPath)) return;
  const env = readEnvFile(configPath);
  const updates: Record<string, string> = {};
  const currentPort = Number(env.PORT ?? "8787");
  const officialRelayMode = env.RELAY_URL === officialRelay.url;

  if (!env.CODEX_BIN || env.CODEX_BIN === "codex" || !commandExists(env.CODEX_BIN)) {
    updates.CODEX_BIN = detectCodexBin();
  }
  if (!env.CODEX_HOME || !existsSync(path.join(env.CODEX_HOME, "state_5.sqlite"))) {
    updates.CODEX_HOME = detectCodexHome();
  }
  if (officialRelayMode) {
    if (env.PUBLIC_ORIGIN !== `http://127.0.0.1:${currentPort}`) {
      updates.PUBLIC_ORIGIN = `http://127.0.0.1:${currentPort}`;
    }
  } else if (!env.PUBLIC_ORIGIN || isLocalOrigin(env.PUBLIC_ORIGIN) || isStaleLanOrigin(env.PUBLIC_ORIGIN)) {
    updates.PUBLIC_ORIGIN = `http://${firstLanAddress()}:${currentPort}`;
  }
  const packageApkPath = path.join(appBaseDir(), "aCode-latest.apk");
  if (existsSync(packageApkPath) && (!env.APP_UPDATE_APK_PATH || !(await isReadable(env.APP_UPDATE_APK_PATH)))) {
    updates.APP_UPDATE_APK_PATH = packageApkPath;
  }

  if (Object.keys(updates).length === 0) return;
  writeEnvFile(configPath, { ...env, ...updates });
  console.log(`Config auto-updated: ${configPath}`);
  for (const [key, value] of Object.entries(updates)) {
    console.log(`AUTO ${key}: ${value}`);
  }
}

async function pickAvailablePort(preferred: number) {
  if (!(await isPortOpen(preferred))) return preferred;
  const existing = await readExistingHealth(preferred);
  if (existing?.ok) return preferred;
  for (let port = preferred + 1; port <= preferred + 20; port += 1) {
    if (!(await isPortOpen(port))) {
      console.log(`Port ${preferred} is busy. Using ${port} instead.`);
      return port;
    }
  }
  return preferred;
}

function detectCodexHome() {
  const explicit = process.env.CODEX_HOME;
  if (explicit && existsSync(explicit)) return explicit;
  const candidates = [
    path.join(homedir(), ".codex"),
    path.join(process.env.APPDATA ?? path.join(homedir(), "AppData", "Roaming"), "Codex"),
    path.join(process.env.LOCALAPPDATA ?? path.join(homedir(), "AppData", "Local"), "Codex"),
    path.join(process.env.XDG_STATE_HOME ?? path.join(homedir(), ".local", "state"), "codex"),
    path.join(process.env.XDG_CONFIG_HOME ?? path.join(homedir(), ".config"), "codex")
  ];
  const withState = candidates.find((candidate) => existsSync(path.join(candidate, "state_5.sqlite")));
  if (withState) return withState;
  return candidates.find((candidate) => existsSync(candidate)) ?? path.join(homedir(), ".codex");
}

function writeEnvFile(filePath: string, env: Record<string, string>) {
  const order = [
    "HOST",
    "PORT",
    "PUBLIC_ORIGIN",
    "ADMIN_TOKEN",
    "SESSION_SECRET",
    "CODEX_BIN",
    "CODEX_HOME",
    "CODEX_APP_SERVER_PORT",
    "SESSION_TTL_HOURS",
    "APP_UPDATE_VERSION_CODE",
    "APP_UPDATE_VERSION_NAME",
    "APP_UPDATE_NOTES",
    "APP_UPDATE_APK_PATH",
    "APP_UPDATE_PUBLIC_DOWNLOAD",
    "RELAY_URL",
    "RELAY_ORIGIN",
    "RELAY_ACCOUNT_TOKEN",
    "RELAY_ACCOUNT_USERNAME",
    "RELAY_ACCOUNT_PASSWORD",
    "RELAY_SERVER_TOKEN",
    "RELAY_DEVICE_NAME"
  ];
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const key of order) {
    if (env[key] === undefined) continue;
    lines.push(`${key}=${env[key]}`);
    seen.add(key);
  }
  for (const [key, value] of Object.entries(env)) {
    if (!seen.has(key)) lines.push(`${key}=${value}`);
  }
  writeFileSync(filePath, `${lines.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
}

function isLocalOrigin(origin: string) {
  return /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/i.test(origin);
}

function isStaleLanOrigin(origin: string) {
  try {
    const host = new URL(origin).hostname;
    if (!isPrivateIpv4(host)) return false;
    return !lanAddresses().includes(host);
  } catch {
    return false;
  }
}

function isPrivateIpv4(host: string) {
  return /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[0-1])\./.test(host);
}

function lanAddresses() {
  const addresses: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) addresses.push(entry.address);
    }
  }
  return addresses;
}

function printDoctorHints(checks: Array<[string, boolean, string]>, env: Record<string, string>, codexBin: string, codexHome: string) {
  const failed = new Set(checks.filter(([, ok]) => !ok).map(([name]) => name));
  if (failed.size === 0) return;
  console.log("");
  console.log("Hints:");
  if (failed.has("codex")) {
    console.log(`- Codex command was not found. Install Codex or set CODEX_BIN in ${resolveReadableConfigPath()}. Current value: ${codexBin}`);
  }
  if (failed.has("codex home") || failed.has("state db")) {
    console.log(`- No Codex history was found at ${codexHome}. Run Codex once on this computer, or set CODEX_HOME to the folder that contains state_5.sqlite.`);
  }
  if (failed.has("apk")) {
    console.log(`- APK file was not readable. Set APP_UPDATE_APK_PATH in ${resolveReadableConfigPath()} if you moved the package.`);
  }
  if (!env.PUBLIC_ORIGIN || isLocalOrigin(env.PUBLIC_ORIGIN)) {
    console.log("- PUBLIC_ORIGIN should use this computer's LAN IP so the Android app can connect from your phone.");
  }
}

function defaultConfigPath() {
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA ?? path.join(homedir(), "AppData", "Roaming"), "aCode-server", "config.env");
  }
  return path.join(homedir(), ".acode-server", "config.env");
}

function macLaunchAgent(nodePath: string, entryPath: string, configPath: string) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>org.acode.gateway</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string><string>${entryPath}</string><string>start</string><string>--config</string><string>${configPath}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>StandardOutPath</key><string>${path.join(path.dirname(configPath), "server.log")}</string>
  <key>StandardErrorPath</key><string>${path.join(path.dirname(configPath), "server.err.log")}</string>
</dict>
</plist>
`;
}

function linuxSystemdUser(nodePath: string, entryPath: string, configPath: string) {
  return `[Unit]
Description=aCode server
After=network.target

[Service]
ExecStart=${nodePath} ${entryPath} start --config ${configPath}
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
`;
}
