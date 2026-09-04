import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
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
const cacheDir = path.join(stagingRoot, "official-relay-cache");
const outRoot = path.join(root, "dist-packages");
const packageName = `aCode-official-relay-client-windows-${targetArch}-${version}`;
const packageDir = path.join(stagingRoot, packageName);
const finalPackageDir = path.join(outRoot, packageName);
const zipPath = path.join(outRoot, `${packageName}.zip`);

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
mkdirSync(path.join(packageDir, "runtime", "sqlite"), { recursive: true });
mkdirSync(path.join(packageDir, "official-relay-client"), { recursive: true });

cpSync(path.join(root, "server", "dist"), path.join(packageDir, "server", "dist"), { recursive: true });
cpSync(path.join(cacheDir, nodePackageName), path.join(packageDir, "runtime", "node"), { recursive: true });
cpSync(findCachedFile(path.join(cacheDir, sqlitePackageName), "sqlite3.exe"), path.join(packageDir, "runtime", "sqlite", "sqlite3.exe"));
cpSync(path.join(root, ".env.example"), path.join(packageDir, "config.example.env"));
cpSync(path.join(root, "official-relay-client", "README.md"), path.join(packageDir, "official-relay-client", "README.md"));
if (existsSync(path.join(root, "aCode-debug.apk"))) {
  cpSync(path.join(root, "aCode-debug.apk"), path.join(packageDir, "aCode-latest.apk"));
}

writeFileSync(path.join(packageDir, "Start Official Relay Client.cmd"), startLauncher(), "utf8");
writeFileSync(path.join(packageDir, "Install Official Relay Service.cmd"), installLauncher(), "utf8");
writeFileSync(path.join(packageDir, "official-relay-client", "README-quickstart.md"), quickstart(), "utf8");

mkdirSync(outRoot, { recursive: true });
cpSync(packageDir, finalPackageDir, { recursive: true });
rmSync(zipPath, { force: true });
createZip(finalPackageDir, zipPath);

console.log(`Official relay package written: ${finalPackageDir}`);
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

function extractZip(zipFilePath, destinationDir) {
  run("powershell", [
    "-NoProfile",
    "-Command",
    `Expand-Archive -LiteralPath '${zipFilePath.replace(/'/g, "''")}' -DestinationPath '${destinationDir.replace(/'/g, "''")}' -Force`
  ]);
}

function createZip(sourceDir, zipFilePath) {
  run("powershell", [
    "-NoProfile",
    "-Command",
    `Compress-Archive -LiteralPath '${sourceDir.replace(/'/g, "''")}' -DestinationPath '${zipFilePath.replace(/'/g, "''")}' -Force`
  ]);
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

function startLauncher() {
  return `@echo off
set "DIR=%~dp0"
title aCode Official Relay Client
echo aCode Official Relay Client
echo ==========================
echo.
set "ACODE_FRIENDLY_LOGS=true"
"%DIR%runtime\\node\\node.exe" "%DIR%server\\dist\\cli.js" official-start
`;
}

function installLauncher() {
  return `@echo off
set "DIR=%~dp0"
title aCode Official Relay Service Installer
echo Installing Official Relay Service...
echo.
"%DIR%runtime\\node\\node.exe" "%DIR%server\\dist\\cli.js" official-install-service
echo.
pause
`;
}

function quickstart() {
  return `# Official Relay Client for Windows

双击：

\`\`\`text
Start Official Relay Client.cmd
\`\`\`

它会自动：

- 创建本地配置
- 写入官方中转地址
- 写入官方中转注册 token
- 启动本地 Gateway
- 在终端打印配对码

如果要安装为当前用户登录后自动启动，双击：

\`\`\`text
Install Official Relay Service.cmd
\`\`\`

手机端只需要输入配对码，不需要输入域名或 token。
`;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", shell: process.platform === "win32", ...options });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}
