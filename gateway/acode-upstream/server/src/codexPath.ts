import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

type Exists = (filePath: string) => boolean;
type Lookup = (command: string, args: string[]) => { status: number | null; stdout?: string };

function looksLikePath(command: string) {
  return command.includes("/") || command.includes("\\") || /^[A-Za-z]:/.test(command);
}

/** Resolve the npm Windows shim that Node spawn can actually execute. */
export function normalizeCodexCommand(command: string, platform = process.platform, exists: Exists = existsSync) {
  const value = command.trim();
  if (platform !== "win32" || !looksLikePath(value)) return value;
  if (!path.extname(value)) {
    for (const extension of [".cmd", ".bat", ".exe"]) {
      const candidate = `${value}${extension}`;
      if (exists(candidate)) return candidate;
    }
  }
  if (exists(value)) return value;
  return value;
}

export function resolveCodexCommand(
  command: string,
  platform = process.platform,
  exists: Exists = existsSync,
  lookup: Lookup = (name, args) => spawnSync(name, args, { encoding: "utf8", shell: false })
) {
  if (!command) return null;
  const normalized = normalizeCodexCommand(command, platform, exists);
  if (looksLikePath(normalized)) return exists(normalized) ? normalized : null;
  const result = lookup(platform === "win32" ? "where.exe" : "which", [normalized]);
  if (result.status !== 0) return null;
  const matches = (result.stdout ?? "").split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  for (const match of matches) {
    const candidate = normalizeCodexCommand(match, platform, exists);
    if (exists(candidate)) return candidate;
  }
  return matches[0] ? normalizeCodexCommand(matches[0], platform, exists) : null;
}

export function detectCodexBin(env: NodeJS.ProcessEnv = process.env) {
  const explicit = env.CODEX_BIN;
  const explicitResolved = explicit ? resolveCodexCommand(explicit) : null;
  if (explicitResolved) return explicitResolved;
  const candidates = process.platform === "win32" ? [
    "codex.cmd",
    "codex.exe",
    path.join(homedir(), "AppData", "Roaming", "npm", "codex.cmd"),
    path.join(homedir(), "AppData", "Roaming", "npm", "codex.exe"),
    "codex"
  ] : [
    "codex",
    path.join(homedir(), ".local", "bin", "codex"),
    path.join(homedir(), ".bun", "bin", "codex"),
    path.join(homedir(), ".npm-global", "bin", "codex"),
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex"
  ];
  for (const candidate of candidates) {
    const resolved = resolveCodexCommand(candidate);
    if (resolved) return resolved;
  }
  return "codex";
}
