import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const packageJson = JSON.parse(readText(path.join(root, "package.json")));
const version = packageJson.version;
const arch = process.env.MACOS_PACKAGE_ARCH ?? process.arch;
const nodeVersion = process.env.MACOS_NODE_VERSION ?? "v20.20.2";
const sqliteVersion = process.env.MACOS_SQLITE_VERSION ?? "3530100";
const nodeArch = nodeArchName(arch);
const nodePackageName = `node-${nodeVersion}-darwin-${nodeArch}`;
const nodeTarball = `${nodePackageName}.tar.gz`;
const nodeUrl = `https://nodejs.org/dist/${nodeVersion}/${nodeTarball}`;
const sqlitePackageName = `sqlite-tools-osx-${nodeArch}-${sqliteVersion}`;
const sqliteZip = `${sqlitePackageName}.zip`;
const sqliteUrl = `https://www.sqlite.org/2026/${sqliteZip}`;
const cacheDir = path.join(root, "tmp", "node-cache");
const outRoot = path.join(root, "dist-packages");
const stageDir = path.join(outRoot, `aCode-server-macos-${nodeArch}-${version}`);
const dmgPath = path.join(outRoot, `aCode-server-macos-${nodeArch}-${version}.dmg`);
const appName = "aCode Server.app";
const appDir = path.join(stageDir, appName);
const contentsDir = path.join(appDir, "Contents");
const macOSDir = path.join(contentsDir, "MacOS");
const resourcesDir = path.join(contentsDir, "Resources");
const packageResourcesDir = path.join(resourcesDir, "package");
const nodeRuntimeDir = path.join(packageResourcesDir, "runtime", "node");
const sqliteRuntimeDir = path.join(packageResourcesDir, "runtime", "sqlite");

if (process.platform !== "darwin") {
  console.error("macOS DMG packaging must run on macOS because it uses hdiutil.");
  process.exit(1);
}

run("npm", ["run", "server:build"]);
prepareNodeRuntime();
prepareSqliteRuntime();

rmSync(stageDir, { recursive: true, force: true });
mkdirSync(macOSDir, { recursive: true });
mkdirSync(packageResourcesDir, { recursive: true });

cpSync(path.join(root, "server", "dist"), path.join(packageResourcesDir, "server", "dist"), { recursive: true });
cpSync(path.join(cacheDir, nodePackageName), nodeRuntimeDir, { recursive: true });
mkdirSync(sqliteRuntimeDir, { recursive: true });
cpSync(findCachedFile(path.join(cacheDir, sqlitePackageName), "sqlite3"), path.join(sqliteRuntimeDir, "sqlite3"));
chmodSqlite();
cpSync(path.join(root, ".env.example"), path.join(packageResourcesDir, "config.example.env"));
cpSync(path.join(root, "android_app_icon.svg"), path.join(resourcesDir, "icon.svg"));
if (existsSync(path.join(root, "aCode-debug.apk"))) {
  cpSync(path.join(root, "aCode-debug.apk"), path.join(packageResourcesDir, "aCode-latest.apk"));
}

writeFileSync(path.join(packageResourcesDir, "acode-server"), shellLauncher(), { mode: 0o755 });
writeFileSync(path.join(macOSDir, "aCode Server"), appExecutable(), { mode: 0o755 });
writeFileSync(path.join(contentsDir, "Info.plist"), infoPlist(), "utf8");
writeFileSync(path.join(stageDir, "README-quickstart.md"), quickstart(), "utf8");
writeFileSync(path.join(stageDir, "Open aCode Server.command"), compatibilityLauncher(), { mode: 0o755 });

rmSync(dmgPath, { force: true });
run("hdiutil", [
  "create",
  "-volname",
  "aCode Server",
  "-srcfolder",
  stageDir,
  "-ov",
  "-format",
  "UDZO",
  dmgPath
]);

run("hdiutil", ["verify", dmgPath]);

console.log(`macOS package written: ${stageDir}`);
console.log(`DMG written: ${dmgPath}`);
console.log(`SHA256: ${sha256(dmgPath)}`);

function prepareNodeRuntime() {
  mkdirSync(cacheDir, { recursive: true });
  const extractedDir = path.join(cacheDir, nodePackageName);
  if (existsSync(path.join(extractedDir, "bin", "node"))) return;

  const tarballPath = path.join(cacheDir, nodeTarball);
  if (!existsSync(tarballPath)) {
    run("curl", ["-fL", nodeUrl, "-o", tarballPath]);
  }

  rmSync(extractedDir, { recursive: true, force: true });
  run("tar", ["-xzf", tarballPath, "-C", cacheDir]);
}

function prepareSqliteRuntime() {
  mkdirSync(cacheDir, { recursive: true });
  const extractedDir = path.join(cacheDir, sqlitePackageName);
  if (existsSync(findCachedFilePath(extractedDir, "sqlite3") ?? "")) return;

  const zipFilePath = path.join(cacheDir, sqliteZip);
  if (!existsSync(zipFilePath)) {
    run("curl", ["-fL", sqliteUrl, "-o", zipFilePath]);
  }

  rmSync(extractedDir, { recursive: true, force: true });
  mkdirSync(extractedDir, { recursive: true });
  run("ditto", ["-x", "-k", zipFilePath, extractedDir]);
}

function chmodSqlite() {
  run("chmod", ["755", path.join(sqliteRuntimeDir, "sqlite3")]);
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
  const entries = spawnSync("find", [dir, "-name", fileName, "-type", "f"], { encoding: "utf8" });
  return entries.stdout.split(/\r?\n/).find(Boolean) ?? null;
}


function nodeArchName(value) {
  if (value === "arm64") return "arm64";
  if (value === "x64") return "x64";
  console.error(`Unsupported macOS package arch: ${value}`);
  process.exit(1);
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit", shell: false });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function readText(filePath) {
  return readFileSync(filePath, "utf8");
}

function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function shellLauncher() {
  return `#!/usr/bin/env sh
set -eu
DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
NODE="$DIR/runtime/node/bin/node"
if [ ! -x "$NODE" ]; then
  NODE="$(command -v node || true)"
fi
if [ -z "$NODE" ]; then
  echo "Node runtime not found. This package should include runtime/node/bin/node."
  exit 1
fi
exec "$NODE" "$DIR/server/dist/cli.js" "$@"
`;
}

function appExecutable() {
  return `#!/usr/bin/env bash
set -u
APP_MACOS_DIR="$(cd "$(dirname "$0")" && pwd)"
PACKAGE_DIR="$APP_MACOS_DIR/../Resources/package"

osascript <<APPLESCRIPT
tell application "Terminal"
  activate
  do script "cd " & quoted form of "$PACKAGE_DIR" & " && ./acode-server init && echo && ./acode-server doctor || true && echo && echo 'Starting aCode Server...' && echo 'If aCode Server is already running, this window will show the existing service instead of starting a duplicate.' && echo && ./acode-server start"
end tell
APPLESCRIPT
`;
}

function compatibilityLauncher() {
  return `#!/usr/bin/env bash
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
open "$DIR/${appName}"
`;
}

function infoPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>zh_CN</string>
  <key>CFBundleDisplayName</key>
  <string>aCode Server</string>
  <key>CFBundleExecutable</key>
  <string>aCode Server</string>
  <key>CFBundleIdentifier</key>
  <string>cn.kiramao.acode.server</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>aCode Server</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${version}</string>
  <key>CFBundleVersion</key>
  <string>${version}</string>
  <key>LSMinimumSystemVersion</key>
  <string>10.15</string>
</dict>
</plist>
`;
}

function quickstart() {
  return `# aCode Server for macOS

## 双击启动

打开 DMG 后，双击 \`aCode Server.app\`。

首次运行会自动创建配置：

\`\`\`text
~/.acode-server/config.env
\`\`\`

终端里会显示：

- Service URL
- Admin token
- APK URL

Android App 登录时填写 Service URL 和 Admin token。

## 命令行启动

\`\`\`bash
aCode Server.app/Contents/Resources/package/acode-server init
aCode Server.app/Contents/Resources/package/acode-server doctor
aCode Server.app/Contents/Resources/package/acode-server start
\`\`\`

为了兼容旧习惯，DMG 里也保留 \`Open aCode Server.command\`，它只负责打开 \`aCode Server.app\`。

## 配置

默认配置文件：

\`\`\`text
~/.acode-server/config.env
\`\`\`

启动器会自动探测：

- 当前局域网 IP，并写入 \`PUBLIC_ORIGIN\`
- 可用端口，默认 8787 被占用时会尝试后续端口
- \`codex\` 可执行文件
- 包含 \`state_5.sqlite\` 的 Codex 数据目录
- 内置 \`runtime/sqlite/sqlite3\`，无需系统安装 SQLite

如需局域网访问，请确认配置类似：

\`\`\`env
HOST=0.0.0.0
PORT=8787
PUBLIC_ORIGIN=http://你的电脑IP:8787
\`\`\`

如果 \`codex\` 不在 PATH 中，请设置：

\`\`\`env
CODEX_BIN=/path/to/codex
\`\`\`

如果任务列表为空，请先运行 \`doctor\` 看 \`codex home\` 和 \`state db\`。aCode Server 只显示当前这台 Mac 用户目录里的 Codex 历史；如果历史在其他目录，请设置：

\`\`\`env
CODEX_HOME=/path/to/.codex
\`\`\`

## 注意

本 DMG 内置 Node.js ${nodeVersion}，不要求系统预装 Node。

当前 DMG 未做 Apple 签名和公证。如果 macOS 阻止打开，可以右键点击 \`aCode Server.app\` 后选择“打开”，或在系统设置的隐私与安全性中允许打开。
`;
}
