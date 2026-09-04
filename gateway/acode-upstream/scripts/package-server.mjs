import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const packageJson = JSON.parse(readText(path.join(root, "package.json")));
const version = packageJson.version;
const outRoot = path.join(root, "dist-packages");
const packageDir = path.join(outRoot, `aCode-server-${version}`);

run("npm", ["run", "server:build"]);
rmSync(packageDir, { recursive: true, force: true });
mkdirSync(path.join(packageDir, "server"), { recursive: true });
mkdirSync(path.join(packageDir, "scripts"), { recursive: true });

cpSync(path.join(root, "server", "dist"), path.join(packageDir, "server", "dist"), { recursive: true });
cpSync(path.join(root, "package.json"), path.join(packageDir, "package.json"));
cpSync(path.join(root, "package-lock.json"), path.join(packageDir, "package-lock.json"));
cpSync(path.join(root, ".env.example"), path.join(packageDir, "config.example.env"));
if (existsSync(path.join(root, "aCode-debug.apk"))) {
  cpSync(path.join(root, "aCode-debug.apk"), path.join(packageDir, "aCode-latest.apk"));
}

writeFileSync(path.join(packageDir, "acode-server"), shellLauncher(), { mode: 0o755 });
writeFileSync(path.join(packageDir, "acode-server.cmd"), windowsLauncher(), "utf8");
writeFileSync(path.join(packageDir, "README-quickstart.md"), quickstart(), "utf8");

console.log(`Package written: ${packageDir}`);

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit", shell: process.platform === "win32" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function readText(filePath) {
  return readFileSync(filePath, "utf8");
}

function shellLauncher() {
  return `#!/usr/bin/env sh
set -eu
DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
node "$DIR/server/dist/cli.js" "$@"
`;
}

function windowsLauncher() {
  return `@echo off
set DIR=%~dp0
node "%DIR%\\server\\dist\\cli.js" %*
`;
}

function quickstart() {
  return `# aCode Server Quickstart

## First run

macOS/Linux:

\`\`\`bash
./acode-server init
./acode-server doctor
./acode-server start
\`\`\`

Windows:

\`\`\`bat
acode-server.cmd init
acode-server.cmd doctor
acode-server.cmd start
\`\`\`

## Config

Default config path:

- macOS/Linux: \`~/.acode-server/config.env\`
- Windows: \`%APPDATA%\\aCode-server\\config.env\`

Use another config:

\`\`\`bash
./acode-server start --config /path/to/config.env
\`\`\`

## Service install

\`\`\`bash
./acode-server install-service
\`\`\`

Then follow the printed platform-specific command.
`;
}
