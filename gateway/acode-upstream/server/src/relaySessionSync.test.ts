import assert from "node:assert/strict";
import test from "node:test";
import { buildSessionSyncPayload, loadSessionSyncPayload, sendSessionSync } from "./relaySessionSync.js";

const fallback = [{
  id: "fallback",
  provider: "codex" as const,
  providerSessionId: "fallback",
  title: "Fallback",
  workspacePath: "C:\\work",
  status: "completed" as const,
  sessionPolicyMode: "confirm" as const,
  canResume: true,
  resumeStatus: "resumable" as const,
  command: "codex",
  args: [],
  prompt: "",
  createdAt: "2026-01-01T00:00:00.000Z",
  lastUpdatedAt: "2026-01-01T00:00:01.000Z"
}];

test("session sync keeps only cloud-safe metadata and normalizes cursors", () => {
  const payload = buildSessionSyncPayload({ sessions: [
    { id: "thread-a", title: "A", workspacePath: "/repo", status: "completed", updatedAt: "2026-01-02T00:00:00.000Z", prompt: "private" },
    { id: "thread-a", title: "A newer", workspacePath: "/repo", status: "running", updatedAt: "2026-01-03T00:00:00.000Z" },
    { id: "" },
  ] }, fallback, { "thread-a": 2, invalid: -1, fractional: 1.5 }, "sync-1");

  assert.deepEqual(payload, {
    type: "session-sync",
    requestId: "sync-1",
    sessions: [{ id: "thread-a", title: "A newer", workspacePath: "/repo", status: "running", updatedAt: "2026-01-03T00:00:00.000Z", sessionPolicyMode: "confirm" }],
    cursors: { "thread-a": 2 }
  });
});

test("session sync falls back to persisted sessions when local listing fails", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: "unavailable" }), { status: 503 })) as typeof fetch;
  try {
    const result = await loadSessionSyncPayload({
      localUrl: "http://127.0.0.1:8787/sessions",
      gatewayAuthToken: "gateway-token",
      fallback,
      cursors: { fallback: 4 },
      requestId: "sync-2"
    });
    assert.match(result.listingError ?? "", /503/);
    assert.equal(result.payload.sessions[0]?.id, "fallback");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("session sync treats a successful empty local listing as authoritative", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ sessions: [] }), { status: 200 })) as typeof fetch;
  const sent: string[] = [];
  try {
    await sendSessionSync({
      localUrl: "http://127.0.0.1:8787/sessions",
      gatewayAuthToken: "gateway-token",
      fallback,
      cursors: {},
      requestId: "sync-3",
      isOpen: () => true,
      send: (text) => sent.push(text)
    });
    assert.equal(sent.length, 1);
    assert.deepEqual(JSON.parse(sent[0]!), {
      type: "session-sync",
      requestId: "sync-3",
      sessions: [],
      cursors: {}
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
