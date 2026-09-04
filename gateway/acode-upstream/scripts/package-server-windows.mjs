import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const packageJson = JSON.parse(readText(path.join(root, "package.json")));
const version = packageJson.version;
const nodeVersion = process.env.WINDOWS_NODE_VERSION ?? "v20.20.2";
const targetArch = process.env.WINDOWS_PACKAGE_ARCH ?? "x64";
const sqliteVersion = process.env.WINDOWS_SQLITE_VERSION ?? "3530100";
const nodePackageName = `node-${nodeVersion}-win-${targetArch}`;
const nodeZip = `${nodePackageName}.zip`;
const nodeUrl = `https://nodejs.org/dist/${nodeVersion}/${nodeZip}`;
const sqlitePackageArch = targetArch === "arm64" ? "arm64" : "x64";
const sqlitePackageName = `sqlite-tools-win-${sqlitePackageArch}-${sqliteVersion}`;
const sqliteZip = `${sqlitePackageName}.zip`;
const sqliteUrl = `https://www.sqlite.org/2026/${sqliteZip}`;
const stagingRoot = path.join(process.env.LOCALAPPDATA ?? tmpdir(), "aCode-build");
const cacheDir = path.join(stagingRoot, "node-cache");
const seaDir = path.join(stagingRoot, "windows-sea");
const outRoot = path.join(root, "dist-packages");
const packageName = `aCode-server-windows-${targetArch}-${version}`;
const packageDir = path.join(stagingRoot, packageName);
const finalPackageDir = path.join(outRoot, packageName);
const zipPath = path.join(outRoot, `${packageName}.zip`);
const runtimeDir = path.join(packageDir, "runtime", "node");
const sqliteRuntimeDir = path.join(packageDir, "runtime", "sqlite");
const launcherExePath = path.join(packageDir, "aCode Server.exe");
const seaBlobPath = path.join(seaDir, "acode-server-launcher.blob");

if (targetArch !== "x64" && targetArch !== "arm64") {
  console.error(`Unsupported Windows package arch: ${targetArch}`);
  process.exit(1);
}

run("npm", ["run", "server:build"]);
prepareWindowsNodeRuntime();
prepareSqliteRuntime();

rmSync(packageDir, { recursive: true, force: true });
rmSync(finalPackageDir, { recursive: true, force: true });
mkdirSync(path.join(packageDir, "server"), { recursive: true });

cpSync(path.join(root, "server", "dist"), path.join(packageDir, "server", "dist"), { recursive: true });
cpSync(path.join(cacheDir, nodePackageName), runtimeDir, { recursive: true });
mkdirSync(sqliteRuntimeDir, { recursive: true });
cpSync(findCachedFile(path.join(cacheDir, sqlitePackageName), "sqlite3.exe"), path.join(sqliteRuntimeDir, "sqlite3.exe"));
cpSync(path.join(root, ".env.example"), path.join(packageDir, "config.example.env"));
if (existsSync(path.join(root, "aCode-debug.apk"))) {
  cpSync(path.join(root, "aCode-debug.apk"), path.join(packageDir, "aCode-latest.apk"));
}

writeFileSync(path.join(packageDir, "acode-server.cmd"), windowsCliLauncher(), "utf8");
writeFileSync(path.join(packageDir, "aCode Server.cmd"), windowsFriendlyLauncher(), "utf8");
writeFileSync(path.join(packageDir, "README-quickstart.md"), quickstart(), "utf8");
writeLauncherExe();

mkdirSync(outRoot, { recursive: true });
cpSync(packageDir, finalPackageDir, { recursive: true });
rmSync(zipPath, { force: true });
createZip(finalPackageDir, zipPath);

console.log(`Windows package written: ${finalPackageDir}`);
console.log(`ZIP written: ${zipPath}`);
console.log(`SHA256: ${sha256(zipPath)}`);

function prepareWindowsNodeRuntime() {
  mkdirSync(cacheDir, { recursive: true });
  const extractedDir = path.join(cacheDir, nodePackageName);
  if (existsSync(path.join(extractedDir, "node.exe"))) return;

  const zipFilePath = path.join(cacheDir, nodeZip);
  if (!existsSync(zipFilePath)) {
    run("curl", ["-fL", nodeUrl, "-o", zipFilePath]);
  }

  rmSync(extractedDir, { recursive: true, force: true });
  extractZip(zipFilePath, cacheDir);
}

function prepareSqliteRuntime() {
  mkdirSync(cacheDir, { recursive: true });
  const extractedDir = path.join(cacheDir, sqlitePackageName);
  if (existsSync(findCachedFilePath(extractedDir, "sqlite3.exe") ?? "")) return;

  const zipFilePath = path.join(cacheDir, sqliteZip);
  if (!existsSync(zipFilePath)) {
    run("curl", ["-fL", sqliteUrl, "-o", zipFilePath]);
  }

  rmSync(extractedDir, { recursive: true, force: true });
  mkdirSync(extractedDir, { recursive: true });
  extractZip(zipFilePath, cacheDir);
  const looseSqlite = path.join(cacheDir, "sqlite3.exe");
  if (existsSync(looseSqlite)) cpSync(looseSqlite, path.join(extractedDir, "sqlite3.exe"));
}

function findCachedFile(dir, fileName) {
  const found = findCachedFilePath(dir, fileName);
  if (!found) {
    console.error(`Could not find ${fileName} under ${dir}`);
    process.exit(1);
  }
  return found;
}

function findCachedFilePath(dir, fileName) {
  if (!existsSync(dir)) return null;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || !existsSync(current)) continue;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name === fileName) return fullPath;
    }
  }
  return null;
}


function writeLauncherExe() {
  mkdirSync(seaDir, { recursive: true });
  const launcherScriptPath = path.join(seaDir, "acode-server-launcher.cjs");
  const seaConfigPath = path.join(seaDir, "sea-config.json");
  writeFileSync(launcherScriptPath, windowsSeaLauncher(), "utf8");
  writeFileSync(seaConfigPath, JSON.stringify({
    main: launcherScriptPath,
    output: seaBlobPath,
    useCodeCache: false,
    useSnapshot: false,
    disableExperimentalSEAWarning: true
  }, null, 2), "utf8");

  run(process.execPath, ["--experimental-sea-config", seaConfigPath]);
  cpSync(path.join(runtimeDir, "node.exe"), launcherExePath);
  run("npx", [
    "--yes",
    "postject",
    launcherExePath,
    "NODE_SEA_BLOB",
    seaBlobPath,
    "--sentinel-fuse",
    "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
    "--overwrite"
  ]);
}

function windowsSeaLauncher() {
  return `const { spawnSync } = require("node:child_process");
const path = require("node:path");

const baseDir = path.dirname(process.execPath);
const nodePath = path.join(baseDir, "runtime", "node", "node.exe");
const cliPath = path.join(baseDir, "server", "dist", "cli.js");

function run(args) {
  const result = spawnSync(nodePath, [cliPath, ...args], {
    cwd: baseDir,
    stdio: "inherit",
    windowsHide: false
  });
  return typeof result.status === "number" ? result.status : 1;
}

if (process.argv.length > 2) {
  process.exit(run(process.argv.slice(2)));
}

console.clear();
console.log("aCode Server");
console.log("============");
console.log("");
console.log("Package: " + baseDir);
console.log("");
run(["init"]);
console.log("");
run(["doctor"]);
console.log("");
console.log("Starting aCode Server...");
console.log("Keep this window open while using the Android app.");
console.log("If Windows Firewall asks, allow access on private networks.");
console.log("Press Ctrl+C to stop.");
console.log("");
process.exit(run(["start"]));
`;
}

function windowsCliLauncher() {
  return `@echo off
set "DIR=%~dp0"
"%DIR%runtime\\node\\node.exe" "%DIR%server\\dist\\cli.js" %*
`;
}

function windowsFriendlyLauncher() {
  return `@echo off
set "DIR=%~dp0"
"%DIR%aCode Server.exe"
`;
}

function quickstart() {
  return `# aCode Server for Windows

## 双击启动

解压 ZIP 后，双击：

\`\`\`text
aCode Server.exe
\`\`\`

首次运行会自动创建配置：

\`\`\`text
%APPDATA%\\aCode-server\\config.env
\`\`\`

窗口里会显示：

- Service URL
- Admin token
- APK URL

Android App 登录时填写 Service URL 和 Admin token。

如果 Windows 防火墙弹窗，请允许专用网络访问。

## 命令行启动

\`\`\`bat
acode-server.cmd init
acode-server.cmd doctor
acode-server.cmd start
\`\`\`

## 配置

默认配置文件：

\`\`\`text
%APPDATA%\\aCode-server\\config.env
\`\`\`

启动器会自动探测：

- 当前局域网 IP，并写入 \`PUBLIC_ORIGIN\`
- 可用端口，默认 8787 被占用时会尝试后续端口
- \`codex\` / \`codex.cmd\` / \`codex.exe\` 可执行文件
- 包含 \`state_5.sqlite\` 的 Codex 数据目录
- 内置 \`runtime\\\\sqlite\\\\sqlite3.exe\`，无需系统安装 SQLite

局域网访问通常需要：

\`\`\`env
HOST=0.0.0.0
PORT=8787
PUBLIC_ORIGIN=http://你的电脑IP:8787
\`\`\`

如果 \`codex\` 不在 PATH 中，请设置：

\`\`\`env
CODEX_BIN=C:\\\\path\\\\to\\\\codex.exe
\`\`\`

如果任务列表为空，请先运行 \`doctor\` 看 \`codex home\` 和 \`state db\`。aCode Server 只显示当前这台 Windows 用户目录里的 Codex 历史；如果历史在其他目录，请设置：

\`\`\`env
CODEX_HOME=C:\\\\Users\\\\你的用户名\\\\.codex
\`\`\`

## 常见问题

- 手机无法连接：确认手机和电脑在同一 Wi-Fi，Windows 防火墙允许 aCode Server，VPN 没有拦截局域网。
- 端口占用：如果已经有 aCode Server 在运行，新启动器会提示正在运行，不会重复启动。
- 公网访问：建议使用 HTTPS 反向代理、Tailscale、ZeroTier、Cloudflare Tunnel 或 frp。

本 ZIP 内置 Node.js ${nodeVersion}，目标 Windows 不需要单独安装 Node。
`;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", shell: process.platform === "win32", ...options });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function extractZip(zipFilePath, destinationDir) {
  if (process.platform === "win32") {
    run("powershell", [
      "-NoProfile",
      "-Command",
      `Expand-Archive -LiteralPath '${zipFilePath.replace(/'/g, "''")}' -DestinationPath '${destinationDir.replace(/'/g, "''")}' -Force`
    ]);
    return;
  }
  run("unzip", ["-o", zipFilePath, "-d", destinationDir]);
}

function createZip(sourceDir, zipFilePath) {
  if (process.platform === "win32") {
    run("powershell", [
      "-NoProfile",
      "-Command",
      `Compress-Archive -LiteralPath '${sourceDir.replace(/'/g, "''")}' -DestinationPath '${zipFilePath.replace(/'/g, "''")}' -Force`
    ]);
    return;
  }
  run("zip", ["-r", "-X", zipFilePath, path.basename(sourceDir)], { cwd: path.dirname(sourceDir) });
}

function readText(filePath) {
  return readFileSync(filePath, "utf8");
}

function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}
