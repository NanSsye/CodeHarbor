import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("GatewayStore keeps a bounded durable turn request ledger", async () => {
  process.env.ADMIN_TOKEN ??= "test-admin-token-123456";
  process.env.SESSION_SECRET ??= "test-session-secret-123456";
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "codeharbor-store-test-"));
  process.env.GATEWAY_DATA_DIR = dataDir;
  try {
    const { GatewayStore } = await import("./gatewayStore.js");
    const { config } = await import("./config.js");
    config.gatewayDataDir = dataDir;
    const store = new GatewayStore();
    store.saveSession({
      id: "session-test",
      provider: "codex",
      providerSessionId: "session-test",
      title: "test",
      workspacePath: dataDir,
      status: "completed",
      sessionPolicyMode: "confirm",
      canResume: true,
      resumeStatus: "resumable",
      command: "codex",
      args: [],
      prompt: "test",
      createdAt: new Date().toISOString(),
      lastUpdatedAt: new Date().toISOString()
    });
    for (let index = 0; index < 140; index += 1) {
      store.rememberClientRequest("session-test", `request-${index}`);
    }
    assert.equal(store.hasClientRequest("session-test", "request-0"), false);
    assert.equal(store.hasClientRequest("session-test", "request-139"), true);
    assert.equal(store.getSession("session-test")?.recentClientRequestIds?.length, 128);
    store.rememberCreateRequest("create-request-1", "session-test");
    assert.equal(store.getCreateRequestSession("create-request-1"), "session-test");
    await store.flush();
    assert.equal(store.getEventWriteErrors().length, 0);
    const reloaded = new GatewayStore();
    assert.equal(reloaded.getCreateRequestSession("create-request-1"), "session-test");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("GatewayStore prevents deleted-session writes from recreating event history", async () => {
  process.env.ADMIN_TOKEN ??= "test-admin-token-123456";
  process.env.SESSION_SECRET ??= "test-session-secret-123456";
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "codeharbor-store-delete-test-"));
  process.env.GATEWAY_DATA_DIR = dataDir;
  try {
    const { GatewayStore } = await import("./gatewayStore.js");
    const { config } = await import("./config.js");
    config.gatewayDataDir = dataDir;
    const store = new GatewayStore();
    const session = {
      id: "session-delete",
      provider: "codex" as const,
      providerSessionId: "session-delete",
      title: "delete",
      workspacePath: dataDir,
      status: "completed" as const,
      sessionPolicyMode: "confirm" as const,
      canResume: true,
      resumeStatus: "resumable" as const,
      command: "codex",
      args: [],
      prompt: "delete",
      createdAt: new Date().toISOString(),
      lastUpdatedAt: new Date().toISOString()
    };
    store.saveSession(session);
    store.appendEvent({ type: "session-output", sessionId: session.id, timestamp: new Date().toISOString(), payload: {} });
    store.deleteSession(session.id);
    assert.equal(store.appendEvent({ type: "session-output", sessionId: session.id, timestamp: new Date().toISOString(), payload: {} }), undefined);
    await store.flush();
    assert.equal(store.hasEvents(session.id), false);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("GatewayStore keeps valid events when one persisted line is corrupt", async () => {
  process.env.ADMIN_TOKEN ??= "test-admin-token-123456";
  process.env.SESSION_SECRET ??= "test-session-secret-123456";
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "codeharbor-store-recovery-test-"));
  process.env.GATEWAY_DATA_DIR = dataDir;
  try {
    const { GatewayStore } = await import("./gatewayStore.js");
    const { config } = await import("./config.js");
    config.gatewayDataDir = dataDir;
    const store = new GatewayStore();
    const eventsDir = path.join(dataDir, "events");
    await writeFile(path.join(eventsDir, "session-corrupt.jsonl"), [
      JSON.stringify({ message: { type: "session-output", sessionId: "session-corrupt", timestamp: new Date().toISOString(), payload: { index: 1 }, eventSeq: 3 } }),
      "not-json",
      JSON.stringify({ message: { type: "session-output", sessionId: "session-corrupt", timestamp: new Date().toISOString(), payload: { index: 2 } } })
    ].join("\n"));
    const events = store.listEvents("session-corrupt");
    assert.equal(events.length, 2);
    assert.equal(events[0]?.message.eventSeq, 3);
    assert.equal(events[1]?.message.eventSeq, 4);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("GatewayStore bounds the event cache while preserving the durable timeline", async () => {
  process.env.ADMIN_TOKEN ??= "test-admin-token-123456";
  process.env.SESSION_SECRET ??= "test-session-secret-123456";
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "codeharbor-store-cache-test-"));
  process.env.GATEWAY_DATA_DIR = dataDir;
  try {
    const { GatewayStore } = await import("./gatewayStore.js");
    const { config } = await import("./config.js");
    config.gatewayDataDir = dataDir;
    const store = new GatewayStore();
    const sessionId = "session-cache";
    for (let index = 0; index < 600; index += 1) {
      store.appendEvent({
        type: "session-output",
        sessionId,
        timestamp: new Date().toISOString(),
        payload: { index }
      });
    }
    await store.flush();
    const events = store.listEvents(sessionId);
    assert.equal(events.length, 600);
    const cache = (store as unknown as { eventCache: Map<string, { entries: unknown[] }> }).eventCache;
    assert.ok((cache.get(sessionId)?.entries.length ?? 0) <= 512);
    const writeChains = (store as unknown as { eventWriteChains: Map<string, unknown> }).eventWriteChains;
    assert.equal(writeChains.size, 0);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("GatewayStore reserves concurrent client request ids atomically", async () => {
  process.env.ADMIN_TOKEN ??= "test-admin-token-123456";
  process.env.SESSION_SECRET ??= "test-session-secret-123456";
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "codeharbor-store-reservation-test-"));
  process.env.GATEWAY_DATA_DIR = dataDir;
  try {
    const { GatewayStore } = await import("./gatewayStore.js");
    const { config } = await import("./config.js");
    config.gatewayDataDir = dataDir;
    const store = new GatewayStore();
    store.saveSession({
      id: "session-reservation",
      provider: "codex",
      providerSessionId: "session-reservation",
      title: "reservation",
      workspacePath: dataDir,
      status: "completed",
      sessionPolicyMode: "confirm",
      canResume: true,
      resumeStatus: "resumable",
      command: "codex",
      args: [],
      prompt: "reservation",
      createdAt: new Date().toISOString(),
      lastUpdatedAt: new Date().toISOString()
    });
    assert.equal(store.reserveClientRequest("session-reservation", "request-1"), true);
    assert.equal(store.reserveClientRequest("session-reservation", "request-1"), false);
    store.releaseClientRequest("session-reservation", "request-1");
    assert.equal(store.reserveClientRequest("session-reservation", "request-1"), true);
    store.rememberClientRequest("session-reservation", "request-1");
    assert.equal(store.reserveClientRequest("session-reservation", "request-1"), false);

    assert.deepEqual(store.reserveCreateRequest("create-1"), { reserved: true });
    assert.deepEqual(store.reserveCreateRequest("create-1"), { reserved: false, pending: true });
    store.releaseCreateRequest("create-1");
    assert.deepEqual(store.reserveCreateRequest("create-1"), { reserved: true });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
