import assert from "node:assert/strict";
import test from "node:test";
import { normalizeCodexCommand, resolveCodexCommand } from "./codexPath.js";

test("normalizes a Windows npm shim path without an extension", () => {
  const existing = new Set(["C:\\Users\\alice\\AppData\\Roaming\\npm\\codex.cmd"]);
  assert.equal(
    normalizeCodexCommand("C:\\Users\\alice\\AppData\\Roaming\\npm\\codex", "win32", (value) => existing.has(value)),
    "C:\\Users\\alice\\AppData\\Roaming\\npm\\codex.cmd"
  );
});

test("keeps an existing Windows executable path unchanged", () => {
  const command = "C:\\tools\\codex.exe";
  assert.equal(normalizeCodexCommand(command, "win32", (value) => value === command), command);
});

test("returns null for an invalid explicit path", () => {
  assert.equal(resolveCodexCommand("C:\\missing\\codex", "win32", () => false, () => ({ status: 1, stdout: "" })), null);
});

test("resolves a PATH entry to codex.cmd", () => {
  const shim = "C:\\Users\\alice\\AppData\\Roaming\\npm\\codex.cmd";
  assert.equal(
    resolveCodexCommand("codex", "win32", (value) => value === shim, () => ({ status: 0, stdout: `${shim}\r\n` })),
    shim
  );
});
