import assert from "node:assert/strict";
import test from "node:test";
import { CodexBridge } from "./codexBridge.js";

test("CodexBridge bounds an unterminated app-server stdout frame", () => {
  const bridge = new CodexBridge();
  const events: Array<{ method: string }> = [];
  bridge.on("event", (event) => events.push(event));
  (bridge as unknown as { handleStdoutChunk: (chunk: string) => void }).handleStdoutChunk("x".repeat(32 * 1024 * 1024 + 1));
  assert.equal(events.at(-1)?.method, "codex/app-server/output-limit");
});

test("CodexBridge keeps the per-thread policy cache bounded", () => {
  const bridge = new CodexBridge();
  const policies = (bridge as unknown as { policyByThread: Map<string, string> }).policyByThread;
  for (let index = 0; index < 10_000; index += 1) policies.set(`thread-${index}`, "confirm");
  (bridge as unknown as { setPolicyMode: (threadId: string, mode: "confirm" | "full-access") => void }).setPolicyMode("thread-new", "full-access");
  assert.equal(policies.size, 10_000);
  assert.equal(policies.has("thread-0"), false);
  assert.equal(policies.get("thread-new"), "full-access");
});

test("CodexBridge preserves UTF-8 split across stdout chunks", () => {
  const bridge = new CodexBridge();
  const events: Array<{ method: string; params?: unknown }> = [];
  bridge.on("event", (event) => events.push(event));
  const decoder = (bridge as unknown as { stdoutDecoder: { write: (chunk: Buffer) => string } }).stdoutDecoder;
  const handle = (bridge as unknown as { handleStdoutChunk: (chunk: string) => void }).handleStdoutChunk.bind(bridge);
  const raw = Buffer.from(`${JSON.stringify({ method: "thread/status/changed", params: { threadId: "t-1", text: "你好" } })}\n`, "utf8");
  const split = raw.indexOf(Buffer.from("你", "utf8")) + 1;
  handle(decoder.write(raw.subarray(0, split)));
  handle(decoder.write(raw.subarray(split)));
  assert.equal(events[0]?.method, "thread/status/changed");
  assert.deepEqual(events[0]?.params, { threadId: "t-1", text: "你好" });
});
