import { createReadStream } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import fastifyCookie from "@fastify/cookie";
import fastifyWebsocket from "@fastify/websocket";
import Fastify from "fastify";
import { WebSocket } from "ws";
import { z } from "zod";
import { maxAttachmentBase64Chars, maxAttachmentBytes, maxAttachmentsPerTurn, storeAttachments } from "./attachments.js";
import { audit } from "./audit.js";
import { allowLoginAttempt, clearLoginFailures, createSession, getRequestToken, getWebSocketProtocolToken, recordLoginFailure, requireAuth, revokeSession, validateGatewayLogin, verifyAdminToken, verifySession } from "./auth.js";
import { codexBridge, type CodexEvent } from "./codexBridge.js";
import { appUpdateHistory, config } from "./config.js";
import { gatewayStore, type GatewayMessage, type GatewaySession } from "./gatewayStore.js";
import { relayClient } from "./relayClient.js";
import { sessionRunState } from "./sessionRunState.js";
import { listThreads, listThreadsFromIndex, readThreadFallback, type ThreadSummary } from "./threads.js";
import { turnGate } from "./turnGate.js";

type SessionStatus = "starting" | "running" | "waiting-approval" | "completed" | "failed" | "cancelled";

type RemoteSession = {
  id: string;
  provider: "codex";
  providerSessionId: string;
  title: string;
  workspacePath: string;
  status: SessionStatus;
  sessionPolicyMode: "confirm" | "full-access";
  canResume: boolean;
  resumeStatus: "resumable" | "history-only" | "missing-thread";
  command: string;
  args: string[];
  prompt: string;
  modelLabel?: string;
  modelProvider?: string;
  createdAt: string;
  lastUpdatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  lastTurnFinishedAt?: string;
  lastClientRequestId?: string;
  parentSessionId?: string;
  childSessionIds?: string[];
  threadSource?: string;
  agentNickname?: string;
  agentRole?: string;
  agentPath?: string;
};

type Client = {
  socket: WebSocket;
  authedAt: number;
  isAlive: boolean;
  heartbeatTimer: NodeJS.Timeout;
  lastResumeAt: number;
};

const attachmentSchema = z.object({
  name: z.string().min(1).max(240),
  mimeType: z.string().max(160).optional(),
  size: z.number().int().nonnegative().max(maxAttachmentBytes).optional(),
  dataBase64: z.string().min(1).max(maxAttachmentBase64Chars)
});

const clients = new Set<Client>();
const subagentParents = new Map<string, string>();
const processLiveSessionIds = new Set<string>();
// A stopped turn may still emit a late active status from Codex. Keep a
// cancellation tombstone so stale events cannot reopen the turn gate or make
// the browser think the session is busy again.
const cancelledSessions = new Set<string>();
const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "authorization,content-type",
  "access-control-max-age": "86400"
};
const friendlyLogs = process.env.ACODE_FRIENDLY_LOGS === "true";
const maxFileDownloadBytes = 8 * 1024 * 1024;
const maxFilesystemEntries = 2_000;
const maxClientBufferedBytes = 32 * 1024 * 1024;
const maxAttachmentRequestBodyBytes = 170 * 1024 * 1024;
const maxResumeEvents = 5_000;
const maxResumeBytes = 32 * 1024 * 1024;
const maxResumeSessions = 512;
const workspaceCheckTimeoutMs = 5_000;

const app = Fastify({
  bodyLimit: 16 * 1024 * 1024,
  logger: friendlyLogs ? false : {
    level: process.env.LOG_LEVEL ?? "info"
  }
});

await app.register(fastifyCookie);
await app.register(fastifyWebsocket, { options: { maxPayload: 16 * 1024 * 1024 } });

app.addHook("onRequest", async (_request, reply) => {
  reply.headers(corsHeaders);
});

app.addHook("onSend", async (request, reply, payload) => {
  // Gateway responses include account/session metadata and may contain raw
  // Codex content. Prevent browsers, service workers, and intermediaries from
  // caching authenticated API or protected file responses.
  if (request.url.startsWith("/api/") || isGatewayProtectedPath(request.url)) {
    reply.header("cache-control", "no-store");
  }
  return payload;
});

app.options("/*", async (_request, reply) => {
  return reply.code(204).send();
});

app.addHook("preHandler", async (request, reply) => {
  if (
    request.method === "OPTIONS" ||
    request.url.startsWith("/api/auth/login") ||
    request.url.startsWith("/download/aCode-latest.apk") ||
    request.url === "/healthz" ||
    request.url === "/protocol" ||
    request.url.startsWith("/auth/login") ||
    (request.url === "/api/health" && isLoopbackAddress(request.ip))
  ) {
    return;
  }
  if (request.url.startsWith("/api/")) {
    return requireAuth(request, reply);
  }
  if (isGatewayProtectedPath(request.url) && !verifySession(getRequestToken(request))) {
    return reply.code(401).send({ error: "unauthorized", message: "缺少有效认证信息" });
  }
});

app.get("/healthz", async () => ({
  ok: true,
  gatewayName: config.gatewayName,
  gatewayVersion: config.gatewayVersion,
  timestamp: new Date().toISOString()
}));

app.get("/api/health", async () => ({
  ok: true,
  publicOrigin: config.publicOrigin
}));

app.get("/api/relay/status", async () => ({
  ok: true,
  relay: relayClient.getStatus()
}));

app.get("/api/capabilities", async () => ({
  turnStart: true,
  turnInterrupt: true,
  turnSteer: true,
  sameTurnInterjection: true,
  stopWithoutClientTurnId: true
}));

app.post("/api/relay/pair-code", async () => {
  const pair = await relayClient.requestPairCode();
  return {
    ok: true,
    relay: relayClient.getStatus(),
    pair
  };
});

app.get("/api/app/update", async (request) => {
  const apk = await stat(config.appUpdateApkPath).catch(() => null);
  const downloadUrl = new URL("/api/app/update/apk", config.publicOrigin);
  const publicDownloadUrl = new URL("/download/aCode-latest.apk", config.publicOrigin);
  await audit("thread.read", { action: "app.update.check", ip: request.ip });
  return {
    app: "aCode",
    platform: "android",
    versionCode: config.appUpdateVersionCode,
    versionName: config.appUpdateVersionName,
    notes: config.appUpdateNotes,
    minServerVersion: "1.0.1",
    compatibleClientVersionCode: 10000,
    apkAvailable: Boolean(apk?.isFile()),
    apkSizeBytes: apk?.isFile() ? apk.size : null,
    downloadUrl: downloadUrl.toString(),
    publicDownloadUrl: publicDownloadUrl.toString(),
    history: appUpdateHistory
  };
});

app.get("/download/aCode-latest.apk", async (request, reply) => {
  if (!config.appUpdatePublicDownload) {
    return reply.code(404).send({ error: "not_found" });
  }
  return sendApk(request, reply, "app.update.public_download");
});

app.get("/api/app/update/apk", async (request, reply) => {
  return sendApk(request, reply, "app.update.download");
});

async function sendApk(request: { ip: string }, reply: { code: (statusCode: number) => { send: (payload: unknown) => unknown }; header: (name: string, value: string) => unknown; send: (payload: unknown) => unknown }, action: string) {
  const apk = await stat(config.appUpdateApkPath).catch(() => null);
  await audit("thread.read", { action, ip: request.ip });
  if (!apk?.isFile()) {
    return reply.code(404).send({ error: "apk_not_found" });
  }
  reply.header("content-type", "application/vnd.android.package-archive");
  reply.header("content-length", String(apk.size));
  reply.header("content-disposition", `attachment; filename="aCode-${config.appUpdateVersionName}.apk"`);
  return reply.send(createReadStream(config.appUpdateApkPath));
}

app.post("/auth/login", { bodyLimit: 16 * 1024 }, async (request, reply) => {
  if (!allowLoginAttempt(request.ip)) {
    reply.header("retry-after", "60");
    return reply.code(429).send({ error: "login_rate_limited" });
  }
  const parsed = z.object({
    username: z.string().min(1),
    password: z.string().min(1)
  }).safeParse(request.body);
  if (!parsed.success) {
    recordLoginFailure(request.ip);
    await audit("login.failed", { ip: request.ip, protocol: "gateway" });
    return reply.code(400).send({ error: "invalid_request" });
  }
  const body = parsed.data;
  if (!validateGatewayLogin(body.username, body.password)) {
    recordLoginFailure(request.ip);
    await audit("login.failed", { ip: request.ip, username: body.username, protocol: "gateway" });
    return reply.code(401).send({ error: "unauthorized", message: "账号或密码错误" });
  }
  clearLoginFailures(request.ip);
  await audit("login.success", { ip: request.ip, username: body.username, protocol: "gateway" });
  return {
    token: config.gatewayAuthToken,
    username: config.gatewayAuthUsername,
    gatewayName: config.gatewayName
  };
});

app.post("/api/auth/login", { bodyLimit: 16 * 1024 }, async (request, reply) => {
  if (!allowLoginAttempt(request.ip)) {
    reply.header("retry-after", "60");
    return reply.code(429).send({ error: "login_rate_limited" });
  }
  const schema = z.object({ token: z.string().min(16) });
  const parsed = schema.safeParse(request.body);
  if (!parsed.success || !verifyAdminToken(parsed.data.token)) {
    recordLoginFailure(request.ip);
    await audit("login.failed", { ip: request.ip });
    return reply.code(401).send({ error: "invalid token" });
  }
  clearLoginFailures(request.ip);
  const session = createSession();
  await audit("login.success", { ip: request.ip });
  return session;
});

function isLoopbackAddress(value: string) {
  return value === "127.0.0.1" || value === "::1" || value === "::ffff:127.0.0.1";
}

function isRequestExpired(expiresAt?: string) {
  if (!expiresAt) return false;
  const parsed = Date.parse(expiresAt);
  return !Number.isFinite(parsed) || parsed <= Date.now();
}

function fullAccessConfirmationRequired(
  requestedMode: "confirm" | "full-access" | undefined,
  confirmed: boolean | undefined,
  currentMode?: "confirm" | "full-access"
) {
  return requestedMode === "full-access" && currentMode !== "full-access" && confirmed !== true;
}

app.post("/api/auth/logout", async (request) => {
  revokeSession(getRequestToken(request));
  return { ok: true };
});

app.get("/api/threads", async (request) => {
  const query = z
    .object({
      limit: z.coerce.number().optional(),
      cursor: z.string().optional()
    })
    .parse(request.query);
  await audit("threads.list", { limit: query.limit ?? 40, cursor: query.cursor ?? null });
  try {
    const response = await listThreadsPortable(query.limit ?? 40, query.cursor);
    return {
      ...response,
      data: (await filterAllowedThreads(response.data)).map(withGatewayThreadStatus)
    };
  } catch (error) {
    app.log.warn({ err: error }, "threads.list failed, falling back to gateway sessions");
    await audit("threads.list.degraded", { error: error instanceof Error ? error.message : String(error) });
    const fallbackSessions = (await filterAllowedSessions(gatewayStore.listSessions())).map(sessionToThreadSummary);
    return {
      data: fallbackSessions,
      nextCursor: null,
      degraded: true,
      error: error instanceof Error ? error.message : String(error)
    };
  }
});

app.get("/sessions", async () => {
  // The persisted Gateway snapshot already contains the last synchronized
  // metadata. Return it immediately so a multi-gigabyte Codex rollout tree
  // cannot block login/session sync on every request. A cold Gateway still
  // falls through to the one-time index import below.
  const persisted = gatewayStore.listSessions();
  if (persisted.length > 0) return { sessions: await filterAllowedSessions(persisted) };
  const { data } = await Promise.resolve().then(() => listThreadsFromIndex(100)).catch(() => listThreadsPortable(100)).catch((error: unknown) => {
    app.log.warn({ err: error }, "sessions import failed, using persisted sessions only");
    return { data: [] };
  });
  const importedSessions = (await filterAllowedThreads(data)).map((thread) => {
    const existing = gatewayStore.getSession(thread.id);
    const session = threadToSession(thread, existing?.status);
    return {
      ...session,
      status: existing?.status ?? session.status,
      activeTurnId: existing?.activeTurnId,
      lastUpdatedAt: latestIso(existing?.lastUpdatedAt, session.lastUpdatedAt)
    };
  });
  gatewayStore.upsertSessions(importedSessions);
  return { sessions: gatewayStore.listSessions() };
});

app.post("/sessions", async (request, reply) => {
  const body = z.object({
    workspacePath: z.string().min(1),
    prompt: z.string().min(1).max(80_000),
    clientRequestId: z.string().min(1).max(120).optional(),
    expiresAt: z.string().datetime({ offset: true }).optional(),
    title: z.string().max(200).optional(),
    sessionPolicyMode: z.enum(["confirm", "full-access"]).default("confirm"),
    confirmFullAccess: z.boolean().optional(),
    model: z.string().min(1).max(100).optional(),
    effort: z.string().min(1).max(30).optional(),
    threadSource: z.string().min(1).max(80).optional(),
    multiAgentMode: z.string().min(1).max(80).optional()
  }).parse(request.body);
  if (isRequestExpired(body.expiresAt)) return reply.code(400).send({ error: "request_expired" });
  if (fullAccessConfirmationRequired(body.sessionPolicyMode, body.confirmFullAccess)) {
    return reply.code(400).send({ error: "full_access_confirmation_required" });
  }
  const createReservation = body.clientRequestId ? gatewayStore.reserveCreateRequest(body.clientRequestId) : undefined;
  if (createReservation && !createReservation.reserved) {
    return reply.code(202).send({
      ...(createReservation.sessionId ? { session: gatewayStore.getSession(createReservation.sessionId) } : {}),
      accepted: true,
      duplicate: true,
      ...(createReservation.pending ? { pending: true } : {})
    });
  }
  let workspacePath: string | null;
  try {
    workspacePath = await resolveAllowedWorkspace(body.workspacePath);
  } catch (error) {
    if (body.clientRequestId) gatewayStore.releaseCreateRequest(body.clientRequestId);
    throw error;
  }
  if (!workspacePath) {
    if (body.clientRequestId) gatewayStore.releaseCreateRequest(body.clientRequestId);
    return reply.code(403).send({ error: "forbidden", message: "工作区不在允许访问的范围内" });
  }
  let response: unknown;
  try {
    await audit("thread.start", { cwd: workspacePath, textLength: body.prompt.length, protocol: "gateway" });
    response = await codexBridge.startThread(workspacePath, body.sessionPolicyMode, { model: body.model, effort: body.effort, threadSource: body.threadSource, multiAgentMode: body.multiAgentMode });
  } catch (error) {
    if (body.clientRequestId) gatewayStore.releaseCreateRequest(body.clientRequestId);
    throw error;
  }
  const threadId = extractThreadId(response);
  if (!threadId) {
    if (body.clientRequestId) gatewayStore.releaseCreateRequest(body.clientRequestId);
    throw new Error("Codex app-server did not return a thread id");
  }
  const admission = turnGate.acquire(threadId, body.clientRequestId);
  if (admission === "busy") {
    if (body.clientRequestId) gatewayStore.releaseCreateRequest(body.clientRequestId);
    return reply.code(409).send({ error: "turn_already_running" });
  }
  const session = {
    ...threadToSession({
    id: threadId,
    title: body.title || body.prompt.slice(0, 32) || "Codex 会话",
    cwd: workspacePath,
    preview: body.prompt,
    model: null,
    modelProvider: "codex",
    source: "web",
    status: "starting",
    createdAtMs: Date.now(),
    updatedAtMs: Date.now(),
    tokensUsed: 0,
    archived: false,
    gitBranch: null
    }),
    sessionPolicyMode: body.sessionPolicyMode
  };
  try {
    gatewayStore.saveSession({
      ...session,
      status: "starting",
      activeTurnId: undefined,
      args: ["thread/start", "turn/start"],
      lastClientRequestId: body.clientRequestId,
      lastTurnStartedAt: new Date().toISOString()
    });
  } catch (error) {
    turnGate.release(threadId);
    if (body.clientRequestId) gatewayStore.releaseCreateRequest(body.clientRequestId);
    throw error;
  }
  if (body.clientRequestId) gatewayStore.rememberCreateRequest(body.clientRequestId, threadId);
  if (body.clientRequestId) gatewayStore.rememberClientRequest(threadId, body.clientRequestId);
  processLiveSessionIds.add(threadId);
  broadcastGateway({
    type: "session-started",
    sessionId: threadId,
    timestamp: new Date().toISOString(),
    payload: { session }
  });
  void (async () => {
    try {
      const turn = await codexBridge.startTurn(threadId, body.prompt, [], body.sessionPolicyMode, {
        model: body.model,
        effort: body.effort,
        multiAgentMode: body.multiAgentMode
      });
      const turnId = extractTurnId(turn);
      const timestamp = new Date().toISOString();
      gatewayStore.updateSession(threadId, (current) => ({
        ...current,
        status: "running",
        activeTurnId: turnId,
        lastUpdatedAt: timestamp
      }));
      broadcastGateway({
        type: "session-status",
        sessionId: threadId,
        timestamp,
        payload: { sessionId: threadId, threadId, status: "running", activeTurnId: turnId }
      });
      broadcast({ method: "remote/thread/started", params: { threadId, response, turn } });
    } catch (error) {
      turnGate.release(threadId);
      processLiveSessionIds.delete(threadId);
      const timestamp = new Date().toISOString();
      gatewayStore.updateSession(threadId, (current) => ({
        ...current,
        status: "failed",
        activeTurnId: undefined,
        finishedAt: timestamp,
        lastUpdatedAt: timestamp
      }));
      broadcastGateway({
        type: "session-finished",
        sessionId: threadId,
        timestamp,
        payload: { sessionId: threadId, status: "failed", error: error instanceof Error ? error.message : String(error) }
      });
      app.log.error({ err: error, threadId, phase: "new_session_turn_failed" }, "Codex turn failed after session creation");
    }
  })();
  return reply.code(201).send({ session });
});

app.post("/api/threads", async (request, reply) => {
  const body = z.object({
    cwd: z.string().min(1),
    text: z.string().min(1).max(80_000),
    expiresAt: z.string().datetime({ offset: true }).optional(),
    title: z.string().max(200).optional(),
    sessionPolicyMode: z.enum(["confirm", "full-access"]).default("confirm"),
    confirmFullAccess: z.boolean().optional(),
    model: z.string().min(1).max(100).optional(),
    effort: z.string().min(1).max(30).optional(),
    threadSource: z.string().min(1).max(80).optional(),
    multiAgentMode: z.string().min(1).max(80).optional()
  }).parse(request.body);
  if (isRequestExpired(body.expiresAt)) return reply.code(400).send({ error: "request_expired" });
  if (fullAccessConfirmationRequired(body.sessionPolicyMode, body.confirmFullAccess)) {
    return reply.code(400).send({ error: "full_access_confirmation_required" });
  }
  const workspacePath = await resolveAllowedWorkspace(body.cwd);
  if (!workspacePath) return reply.code(403).send({ error: "forbidden", message: "工作区不在允许访问的范围内" });
  await audit("thread.start", { cwd: workspacePath, textLength: body.text.length });
  const response = await codexBridge.startThread(workspacePath, body.sessionPolicyMode, { model: body.model, effort: body.effort, threadSource: body.threadSource, multiAgentMode: body.multiAgentMode });
  const threadId = extractThreadId(response);
  if (!threadId) {
    throw new Error("Codex app-server did not return a thread id");
  }
  const turn = await codexBridge.startTurn(threadId, body.text, [], body.sessionPolicyMode, { model: body.model, effort: body.effort });
  broadcast({ method: "remote/thread/started", params: { threadId, response, turn } });
  return {
    threadId,
    response,
    turn
  };
});

app.get("/api/threads/:id", async (request, reply) => {
  const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
  const context = await authorizedThreadContext(id);
  if (!context) return reply.code(404).send({ error: "session_not_found", sessionId: id });
  if (!context.workspacePath) return reply.code(403).send({ error: "forbidden", message: "工作区不在允许访问的范围内" });
  await audit("thread.read", { threadId: id });
  try {
    return await codexBridge.readThread(id);
  } catch (error) {
    app.log.warn({ err: error, threadId: id }, "thread/read failed, using rollout fallback");
    try {
      return await readThreadFallback(id);
    } catch (fallbackError) {
      app.log.warn({ err: fallbackError, threadId: id }, "thread fallback failed, using gateway session snapshot");
      const session = gatewayStore.getSession(id);
      if (session) {
        return gatewaySessionToThreadDetail(session);
      }
      throw fallbackError;
    }
  }
});

app.get("/sessions/:id", async (request, reply) => {
  const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
  const context = await authorizedThreadContext(id);
  if (!context) {
    return reply.code(404).send({ error: "session_not_found", sessionId: id });
  }
  if (!context.workspacePath) return reply.code(403).send({ error: "forbidden", message: "工作区不在允许访问的范围内" });
  return { session: context.session ?? threadToSession(context.thread!) };
});

app.patch("/sessions/:id/policy", async (request, reply) => {
  const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
  const body = z.object({ sessionPolicyMode: z.enum(["confirm", "full-access"]), confirmFullAccess: z.boolean().optional(), expiresAt: z.string().datetime({ offset: true }).optional() }).parse(request.body ?? {});
  if (isRequestExpired(body.expiresAt)) return reply.code(400).send({ error: "request_expired" });
  const context = await authorizedThreadContext(id);
  const existing = context?.session;
  if (!context || !existing) return reply.code(404).send({ error: "session_not_found", sessionId: id });
  if (!context.workspacePath) return reply.code(403).send({ error: "forbidden", message: "工作区不在允许访问的范围内" });
  if (fullAccessConfirmationRequired(body.sessionPolicyMode, body.confirmFullAccess, existing.sessionPolicyMode)) {
    return reply.code(400).send({ error: "full_access_confirmation_required" });
  }

  // A running turn cannot have its sandbox changed safely. Store the choice
  // now; the next turn applies it through thread/resume and turn/start.
  codexBridge.setPolicyMode(id, body.sessionPolicyMode);
  const timestamp = new Date().toISOString();
  const session = gatewayStore.updateSession(id, (current) => ({
    ...current,
    sessionPolicyMode: body.sessionPolicyMode,
    lastUpdatedAt: timestamp
  })) ?? { ...existing, sessionPolicyMode: body.sessionPolicyMode, lastUpdatedAt: timestamp };
  await audit("thread.policy.update", { threadId: id, sessionPolicyMode: body.sessionPolicyMode });
  broadcastGateway({
    type: "session-policy-changed",
    sessionId: id,
    timestamp,
    payload: { sessionId: id, sessionPolicyMode: body.sessionPolicyMode, session }
  });
  // Wait for the metadata push to be queued after the local snapshot update.
  // This prevents an immediate browser refresh from reading the previous
  // policy from the cloud session list while an older sync is still running.
  await relayClient.syncSessionsNow();
  return { ok: true, session };
});

app.get("/sessions/:id/events", async (request, reply) => {
  const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
  const context = await authorizedThreadContext(id);
  if (!context) return reply.code(404).send({ error: "session_not_found", sessionId: id });
  if (!context.workspacePath) return reply.code(403).send({ error: "forbidden", message: "工作区不在允许访问的范围内" });
  const query = z.object({ after: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(5_000).default(1_000) }).parse(request.query ?? {});
  const persistedEvents = gatewayStore.listEventsAfterLimited(id, query.after, query.limit);
  if (persistedEvents.entries.length > 0 || gatewayStore.hasEvents(id)) {
    return { events: persistedEvents.entries, nextCursor: persistedEvents.nextCursor, truncated: persistedEvents.truncated };
  }
  try {
    const detail = await readThreadDetail(id);
    const allEvents = threadDetailToGatewayEvents(detail);
    const pending = allEvents.filter((entry) => (entry.message.eventSeq ?? 0) > query.after);
    const page = pending.slice(0, query.limit);
    const nextCursor = page.at(-1)?.message.eventSeq ?? query.after;
    return {
      events: page,
      nextCursor,
      truncated: page.length < pending.length
    };
  } catch {
    return reply.code(404).send({ error: "session_not_found", sessionId: id });
  }
});

app.post("/api/threads/:id/resume", async (request, reply) => {
  const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
  const body = z.object({ sessionPolicyMode: z.enum(["confirm", "full-access"]).optional(), confirmFullAccess: z.boolean().optional(), expiresAt: z.string().datetime({ offset: true }).optional() }).parse(request.body ?? {});
  if (isRequestExpired(body.expiresAt)) return reply.code(400).send({ error: "request_expired" });
  const mode = body.sessionPolicyMode ?? gatewayStore.getSession(id)?.sessionPolicyMode ?? "confirm";
  const existing = gatewayStore.getSession(id);
  if (fullAccessConfirmationRequired(mode, body.confirmFullAccess, existing?.sessionPolicyMode)) {
    return reply.code(400).send({ error: "full_access_confirmation_required" });
  }
  const resumeSession = gatewayStore.getSession(id) ?? await findThreadSummary(id);
  const resumeWorkspace = resumeSession
    ? ("workspacePath" in resumeSession ? resumeSession.workspacePath : resumeSession.cwd)
    : undefined;
  if (!resumeWorkspace) {
    return reply.code(404).send({ error: "session_not_found", sessionId: id });
  }
  if (!await resolveAllowedWorkspace(resumeWorkspace)) {
    return reply.code(403).send({ error: "forbidden", message: "工作区不在允许访问的范围内" });
  }
  await audit("thread.resume", { threadId: id });
  const response = await codexBridge.resumeThread(id, mode);
  codexBridge.setPolicyMode(id, mode);
  const updatedSession = gatewayStore.updateSession(id, (session) => ({
    ...session,
    sessionPolicyMode: mode,
    lastUpdatedAt: new Date().toISOString()
  }));
  if (updatedSession) {
    broadcastGateway({
      type: "session-policy-changed",
      sessionId: id,
      timestamp: new Date().toISOString(),
      payload: { sessionId: id, sessionPolicyMode: mode, session: updatedSession }
    });
  }
  broadcast({ method: "remote/thread/resumed", params: { threadId: id, response } });
  return response;
});

app.post("/sessions/:id/turns", { bodyLimit: maxAttachmentRequestBodyBytes }, async (request, reply) => {
  const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
  const body = z.object({
    prompt: z.string().max(80_000),
    clientRequestId: z.string().min(1).max(120).optional(),
    requestId: z.string().min(1).max(120).optional(),
    expiresAt: z.string().datetime({ offset: true }).optional(),
    attachments: z.array(attachmentSchema).max(maxAttachmentsPerTurn).optional(),
    sessionPolicyMode: z.enum(["confirm", "full-access"]).optional(),
    confirmFullAccess: z.boolean().optional(),
    model: z.string().min(1).max(100).optional(),
    effort: z.string().min(1).max(30).optional(),
    multiAgentMode: z.string().min(1).max(80).optional()
  }).superRefine((value, ctx) => {
    if (!value.prompt.trim() && (value.attachments?.length ?? 0) === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["prompt"], message: "prompt_or_attachment_required" });
    }
  }).parse(request.body);
  const clientRequestId = body.clientRequestId ?? body.requestId;
  logInfo(`收到网页消息：session=${id} request=${clientRequestId ?? "-"}`);
  if (body.expiresAt && Date.parse(body.expiresAt) <= Date.now()) {
    return reply.code(400).send({ error: "request_expired" });
  }
  const receivedAt = Date.now();
  const persisted = gatewayStore.getSession(id);
  const trustedThread = persisted ? undefined : await findTrustedThreadSummary(id);
  logInfo(`网页消息上下文已读取：session=${id}（${Date.now() - receivedAt}ms）`);
  if (!persisted && !trustedThread) {
    return reply.code(404).send({ error: "session_not_found", sessionId: id });
  }
  const policy = body.sessionPolicyMode ?? persisted?.sessionPolicyMode ?? "confirm";
  if (fullAccessConfirmationRequired(body.sessionPolicyMode, body.confirmFullAccess, persisted?.sessionPolicyMode)) {
    return reply.code(400).send({ error: "full_access_confirmation_required" });
  }
  const session = persisted
    ? { ...persisted, status: "running" as const, sessionPolicyMode: policy, lastTurnStartedAt: new Date(receivedAt).toISOString(), lastUpdatedAt: new Date(receivedAt).toISOString() }
    : { ...threadToSession(trustedThread!, "running"), prompt: body.prompt, sessionPolicyMode: policy };
  const workspaceCheckStarted = Date.now();
  // A persisted session was previously imported from this local Codex
  // installation, so validate that its directory still exists even when it
  // lives outside the packaged Gateway's process.cwd(). New sessions remain
  // restricted to configured roots.
  // Persisted sessions originate from this local Codex installation and are
  // already trusted by the session import boundary. Re-resolving their path
  // on every turn can hang behind a stale filesystem provider; new sessions
  // still require the full allowed-root check below.
  const allowedWorkspace = persisted
    ? session.workspacePath
    : await resolveAllowedWorkspace(session.workspacePath, false);
  logInfo(`网页消息工作区校验完成：session=${id} allowed=${Boolean(allowedWorkspace)}（${Date.now() - workspaceCheckStarted}ms）`);
  if (!allowedWorkspace) {
    return reply.code(403).send({ error: "forbidden", message: "工作区不在允许访问的范围内" });
  }
  if (clientRequestId && gatewayStore.hasClientRequest(id, clientRequestId)) {
    return reply.code(202).send({ session: persisted, accepted: true, duplicate: true });
  }
  const turnReservation = clientRequestId ? gatewayStore.reserveClientRequest(id, clientRequestId) : true;
  if (!turnReservation) {
    return reply.code(202).send({ session: persisted, accepted: true, duplicate: true, pending: true });
  }
  const admission = turnGate.acquire(id, clientRequestId, persisted?.lastClientRequestId);
  if (admission === "duplicate") {
    if (clientRequestId) gatewayStore.releaseClientRequest(id, clientRequestId);
    return reply.code(202).send({ session: persisted, accepted: true, duplicate: true });
  }
  if (admission === "busy") {
    if (clientRequestId) gatewayStore.releaseClientRequest(id, clientRequestId);
    logInfo(`网页消息被拒绝：session=${id} 当前会话仍在执行`);
    return reply.code(409).send({ error: "turn_already_running", message: "当前会话已有任务正在执行，请等待完成或使用插话。" });
  }
  cancelledSessions.delete(id);
  const runGeneration = sessionRunState.begin(id);
  processLiveSessionIds.add(id);
  try {
    gatewayStore.upsertSession({
      ...session,
      status: "running",
      sessionPolicyMode: policy,
      activeTurnId: undefined,
      lastClientRequestId: clientRequestId ?? persisted?.lastClientRequestId,
      lastTurnStartedAt: new Date(receivedAt).toISOString(),
      lastUpdatedAt: new Date(receivedAt).toISOString()
    });
    if (clientRequestId) gatewayStore.rememberClientRequest(id, clientRequestId);
  } catch (error) {
    processLiveSessionIds.delete(id);
    turnGate.release(id);
    if (clientRequestId) gatewayStore.releaseClientRequest(id, clientRequestId);
    throw error;
  }
  // Do not make the browser wait for audit I/O or Codex/session lookups.
  void audit("turn.start", { threadId: id, textLength: body.prompt.length, attachmentCount: body.attachments?.length ?? 0, protocol: "gateway" }).catch((error) => app.log.warn({ err: error }, "turn audit failed"));
  const inputBroadcastAt = Date.now();
  broadcastGateway({
    type: "session-user-input",
    sessionId: id,
    timestamp: new Date().toISOString(),
    payload: {
      sessionId: id,
      prompt: body.prompt,
      attachments: body.attachments?.map(({ dataBase64: _data, ...metadata }) => metadata) ?? [],
      clientRequestId
    }
  });
  broadcastGateway({
    type: "session-status",
    sessionId: id,
    timestamp: new Date().toISOString(),
    payload: { sessionId: id, status: "running", session }
  });
  logInfo(`网页消息已接收：session=${id} 已广播到实时通道（${Date.now() - receivedAt}ms）`);
  void (async () => {
    try {
      await codexBridge.resumeThread(id, policy);
      if (!sessionRunState.isCurrent(id, runGeneration)) return;
      app.log.info({ threadId: id, phase: "resume_done", elapsedMs: Date.now() - inputBroadcastAt }, "Codex thread resumed");
      let cwd = session.workspacePath || process.cwd();
      if (!cwd || (body.attachments?.length ?? 0) > 0 && !persisted?.workspacePath) {
        const thread = await findThreadSummary(id);
        cwd = thread?.cwd || cwd;
      }
      const attachments = await storeAttachments({ cwd, threadId: id, attachments: body.attachments });
      if (!sessionRunState.isCurrent(id, runGeneration)) return;
      app.log.info({ threadId: id, phase: "attachments_done", elapsedMs: Date.now() - inputBroadcastAt, attachmentCount: attachments.length }, "Turn attachments prepared");
      const response = await codexBridge.startTurn(id, body.prompt, attachments, policy, { model: body.model, effort: body.effort, multiAgentMode: body.multiAgentMode });
      const turnId = extractTurnId(response);
      if (!sessionRunState.isCurrent(id, runGeneration)) {
        if (turnId) void codexBridge.interruptTurn(id, turnId).catch((error) => app.log.warn({ err: error, threadId: id, turnId }, "late Codex turn interrupt failed"));
        return;
      }
      if (turnId) gatewayStore.updateSession(id, (current) => ({ ...current, activeTurnId: turnId, lastUpdatedAt: new Date().toISOString() }));
      app.log.info({ threadId: id, phase: "turn_started", elapsedMs: Date.now() - inputBroadcastAt }, "Codex turn started");
    } catch (error) {
      if (!sessionRunState.isCurrent(id, runGeneration)) return;
      processLiveSessionIds.delete(id);
      turnGate.release(id);
      const timestamp = new Date().toISOString();
      gatewayStore.updateSession(id, (current) => ({ ...current, status: "failed", activeTurnId: undefined, finishedAt: timestamp, lastUpdatedAt: timestamp }));
      broadcastGateway({ type: "session-finished", sessionId: id, timestamp, payload: { sessionId: id, status: "failed", error: error instanceof Error ? error.message : String(error) } });
      logError(`Codex 任务准备失败：session=${id}（${error instanceof Error ? error.message : String(error)}）`);
    }
  })();
  return reply.code(202).send({ session, accepted: true });
});

app.post("/api/threads/:id/turns", { bodyLimit: maxAttachmentRequestBodyBytes }, async (request, reply) => {
  const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
  const body = z.object({
    text: z.string().max(80_000),
    attachments: z.array(attachmentSchema).max(maxAttachmentsPerTurn).optional(),
    requestId: z.string().min(1).max(120).optional(),
    expiresAt: z.string().datetime({ offset: true }).optional()
  }).superRefine((value, ctx) => {
    if (!value.text.trim() && (value.attachments?.length ?? 0) === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["text"], message: "text_or_attachment_required" });
    }
  }).parse(request.body);
  if (isRequestExpired(body.expiresAt)) return reply.code(400).send({ error: "request_expired" });
  const persisted = gatewayStore.getSession(id);
  const turnReservation = body.requestId ? gatewayStore.reserveClientRequest(id, body.requestId) : true;
  if (!turnReservation) {
    return reply.code(202).send({ session: persisted, accepted: true, duplicate: true, pending: true });
  }
  let thread: ThreadSummary | undefined;
  try {
    await audit("turn.start", { threadId: id, textLength: body.text.length, attachmentCount: body.attachments?.length ?? 0 });
    thread = await findThreadSummary(id);
  } catch (error) {
    if (body.requestId) gatewayStore.releaseClientRequest(id, body.requestId);
    throw error;
  }
  let workspacePath: string | null;
  try {
    workspacePath = await resolveAllowedWorkspace(thread?.cwd ?? "");
  } catch (error) {
    if (body.requestId) gatewayStore.releaseClientRequest(id, body.requestId);
    throw error;
  }
  if (!workspacePath) {
    if (body.requestId) gatewayStore.releaseClientRequest(id, body.requestId);
    return reply.code(403).send({ error: "forbidden", message: "工作区不在允许访问的范围内" });
  }
  const admission = turnGate.acquire(id, body.requestId, persisted?.lastClientRequestId);
  if (admission === "duplicate") {
    if (body.requestId) gatewayStore.releaseClientRequest(id, body.requestId);
    return reply.code(202).send({ session: persisted, accepted: true, duplicate: true });
  }
  if (admission === "busy") {
    if (body.requestId) gatewayStore.releaseClientRequest(id, body.requestId);
    return reply.code(409).send({ error: "turn_already_running" });
  }
  await codexBridge.resumeThread(id).catch((error) => {
    turnGate.release(id);
    if (body.requestId) gatewayStore.releaseClientRequest(id, body.requestId);
    throw error;
  });
  const attachments = await storeAttachments({
    cwd: workspacePath,
    threadId: id,
    attachments: body.attachments
  }).catch((error) => {
    turnGate.release(id);
    if (body.requestId) gatewayStore.releaseClientRequest(id, body.requestId);
    throw error;
  });
  const response = await codexBridge.startTurn(id, body.text, attachments).catch((error) => {
    turnGate.release(id);
    if (body.requestId) gatewayStore.releaseClientRequest(id, body.requestId);
    throw error;
  });
  const session = thread ? threadToSession(thread, "running") : minimalSession(id, body.text, "running");
  try {
    gatewayStore.upsertSession({
      ...session,
      status: "running",
      activeTurnId: extractTurnId(response),
      lastClientRequestId: body.requestId ?? persisted?.lastClientRequestId,
      lastTurnStartedAt: new Date().toISOString(),
      lastUpdatedAt: new Date().toISOString()
    });
    if (body.requestId) gatewayStore.rememberClientRequest(id, body.requestId);
  } catch (error) {
    turnGate.release(id);
    if (body.requestId) gatewayStore.releaseClientRequest(id, body.requestId);
    throw error;
  }
  processLiveSessionIds.add(id);
  broadcastGateway({
    type: "session-status",
    sessionId: id,
    timestamp: new Date().toISOString(),
    payload: { sessionId: id, threadId: id, status: "running", session }
  });
  broadcast({ method: "remote/turn/started", params: { threadId: id, response } });
  return response;
});

app.post("/api/threads/:id/interjections", { bodyLimit: maxAttachmentRequestBodyBytes }, async (request, reply) => {
  const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
  const body = z.object({
    text: z.string().min(1).max(80_000),
    turnId: z.string().min(1).optional(),
    attachments: z.array(attachmentSchema).max(maxAttachmentsPerTurn).optional(),
    requestId: z.string().min(1).max(120).optional(),
    expiresAt: z.string().datetime({ offset: true }).optional()
  }).parse(request.body ?? {});
  if (isRequestExpired(body.expiresAt)) return reply.code(400).send({ error: "request_expired" });
  // Authorize the session and workspace before resolving the active turn. The
  // latter may call Codex thread/read, so doing it first prevents random UUID
  // floods from turning into expensive app-server RPCs.
  const context = await authorizedThreadContext(id);
  if (!context) return reply.code(404).send({ error: "session_not_found", sessionId: id });
  if (!context.workspacePath) return reply.code(403).send({ error: "forbidden", message: "工作区不在允许访问的范围内" });
  const expectedTurnId = body.turnId ?? await resolveActiveTurnId(id);
  if (!expectedTurnId) {
    return reply.code(409).send({
      error: "no_active_turn",
      message: "当前任务没有运行中的 turn，不能插话；请改用发送。"
    });
  }
  if (body.requestId && gatewayStore.hasClientRequest(id, body.requestId)) {
    return reply.code(202).send({ accepted: true, duplicate: true });
  }
  const interjectionReservation = body.requestId ? gatewayStore.reserveClientRequest(id, body.requestId) : true;
  if (!interjectionReservation) {
    return reply.code(202).send({ accepted: true, duplicate: true, pending: true });
  }
  const thread = context.thread;
  const workspacePath = context.workspacePath;
  await audit("turn.steer", { threadId: id, turnId: expectedTurnId, textLength: body.text.length, attachmentCount: body.attachments?.length ?? 0 });
  let attachments: Awaited<ReturnType<typeof storeAttachments>>;
  try {
    attachments = await storeAttachments({
      cwd: workspacePath,
      threadId: id,
      attachments: body.attachments
    });
  } catch (error) {
    if (body.requestId) gatewayStore.releaseClientRequest(id, body.requestId);
    throw error;
  }
  try {
    const response = await codexBridge.steerTurn(id, expectedTurnId, body.text, attachments);
    const session = gatewayStore.getSession(id) ?? (thread ? threadToSession(thread, "running") : minimalSession(id, body.text, "running"));
    processLiveSessionIds.add(id);
    gatewayStore.upsertSession({
      ...session,
      status: "running",
      activeTurnId: expectedTurnId,
      lastUpdatedAt: new Date().toISOString()
    });
    if (body.requestId) gatewayStore.rememberClientRequest(id, body.requestId);
    broadcastGateway({
      type: "session-user-input",
      sessionId: id,
      timestamp: new Date().toISOString(),
      payload: { sessionId: id, threadId: id, prompt: body.text, kind: "interjection", attachments }
    });
    broadcast({ method: "remote/turn/steered", params: { threadId: id, turnId: expectedTurnId, response } });
    return response;
  } catch (error) {
    if (isActiveTurnNotSteerableError(error)) {
      if (body.requestId) gatewayStore.releaseClientRequest(id, body.requestId);
      return reply.code(409).send({
        error: "active_turn_not_steerable",
        message: "当前运行中的 turn 不支持插话，例如 review 或 compact。可以等待完成，或主动停止后重新发送。"
      });
    }
    if (body.requestId) gatewayStore.releaseClientRequest(id, body.requestId);
    throw error;
  }
});

app.addHook("onClose", async () => {
  // Fastify does not own upgraded WebSocket lifetimes. Stop heartbeat timers
  // and terminate clients explicitly so graceful shutdown can finish even
  // when a browser is half-disconnected.
  for (const client of clients) {
    clearInterval(client.heartbeatTimer);
    try {
      client.socket.terminate();
    } catch {
      // The socket may already be closed.
    }
  }
  clients.clear();
});

app.post("/sessions/:id/interrupt", async (request, reply) => {
  const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
  const body = z.object({ turnId: z.string().min(1).optional(), expiresAt: z.string().datetime({ offset: true }).optional() }).parse(request.body ?? {});
  if (isRequestExpired(body.expiresAt)) return reply.code(400).send({ error: "request_expired" });
  const context = await authorizedThreadContext(id);
  if (!context) return reply.code(404).send({ error: "session_not_found", sessionId: id });
  if (!context.workspacePath) return reply.code(403).send({ error: "forbidden", message: "工作区不在允许访问的范围内" });
  const turnId = body.turnId ?? context.session?.activeTurnId;
  logInfo(`收到网页停止请求：session=${id} turn=${turnId ?? "-"}`);
  await audit("turn.interrupt", { threadId: id, turnId, protocol: "gateway" });
  const session = settleInterruptedSession(id, context.session ?? threadToSession(context.thread!, "cancelled"), turnId);
  requestCodexInterrupt(id, turnId);
  return { ok: true, session, interruptRequested: Boolean(turnId) };
});

app.post("/api/threads/:id/interrupt", async (request) => {
  const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
  const body = z.object({ turnId: z.string().min(1).optional(), expiresAt: z.string().datetime({ offset: true }).optional() }).parse(request.body ?? {});
  if (isRequestExpired(body.expiresAt)) {
    const error = new Error("request_expired") as Error & { statusCode?: number; code?: string };
    error.statusCode = 400;
    error.code = "request_expired";
    throw error;
  }
  const context = await authorizedThreadContext(id);
  if (!context) {
    const error = new Error("session_not_found") as Error & { statusCode?: number; code?: string };
    error.statusCode = 404;
    error.code = "session_not_found";
    throw error;
  }
  if (!context.workspacePath) {
    const error = new Error("forbidden") as Error & { statusCode?: number; code?: string };
    error.statusCode = 403;
    error.code = "forbidden";
    throw error;
  }
  const turnId = body.turnId ?? context.session?.activeTurnId;
  await audit("turn.interrupt", { threadId: id, turnId });
  const session = settleInterruptedSession(id, context.session ?? threadToSession(context.thread!, "cancelled"), turnId);
  requestCodexInterrupt(id, turnId);
  broadcast({ method: "remote/turn/interrupted", params: { threadId: id, ...(turnId ? { turnId } : {}) } });
  return { ok: true, session, interruptRequested: Boolean(turnId) };
});

app.post("/sessions/:id/fork", async (request, reply) => {
  const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
  const body = z.object({
    sessionPolicyMode: z.enum(["confirm", "full-access"]).optional(),
    confirmFullAccess: z.boolean().optional(),
    threadSource: z.string().min(1).max(80).default("subagent"),
    expiresAt: z.string().datetime({ offset: true }).optional()
  }).parse(request.body ?? {});
  if (isRequestExpired(body.expiresAt)) return reply.code(400).send({ error: "request_expired" });
  const persistedParent = gatewayStore.getSession(id);
  const indexedParent = persistedParent ? undefined : await findTrustedThreadSummary(id);
  if (!persistedParent && !indexedParent) return reply.code(404).send({ error: "session_not_found", sessionId: id });
  const parentWorkspace = await resolveAllowedWorkspace(persistedParent?.workspacePath ?? indexedParent!.cwd);
  if (!parentWorkspace) return reply.code(403).send({ error: "forbidden", message: "工作区不在允许访问的范围内" });
  const mode = body.sessionPolicyMode ?? gatewayStore.getSession(id)?.sessionPolicyMode ?? "confirm";
  if (fullAccessConfirmationRequired(mode, body.confirmFullAccess)) {
    return reply.code(400).send({ error: "full_access_confirmation_required" });
  }
  await audit("thread.fork", { threadId: id, protocol: "gateway" });
  const response = await codexBridge.forkThread(id, mode, body.threadSource);
  const child = response && typeof response === "object" && "thread" in response
    ? (response as { thread?: ThreadSummary & { forkedFromId?: string | null } }).thread
    : undefined;
  const childId = child && typeof child.id === "string" ? child.id : undefined;
  if (childId && child) {
    const rawChild = child as ThreadSummary & { createdAt?: number; updatedAt?: number };
    const childSummary: ThreadSummary = {
      ...child,
      createdAtMs: rawChild.createdAtMs ?? (rawChild.createdAt ? rawChild.createdAt * 1000 : Date.now()),
      updatedAtMs: rawChild.updatedAtMs ?? (rawChild.updatedAt ? rawChild.updatedAt * 1000 : Date.now())
    };
    const session = threadToSession(childSummary, "starting");
    gatewayStore.upsertSession({ ...session, sessionPolicyMode: mode, lastUpdatedAt: new Date().toISOString() });
    broadcastGateway({
      type: "session-forked",
      sessionId: childId,
      timestamp: new Date().toISOString(),
      payload: { sessionId: childId, parentSessionId: id, forkedFromId: child.forkedFromId ?? id, session }
    });
  }
  return reply.code(201).send({ session: childId ? gatewayStore.getSession(childId) : undefined, thread: response });
});

app.post("/sessions/:id/approvals/:requestId", async (request, reply) => {
  const { id, requestId } = z.object({ id: z.string().uuid(), requestId: z.string().min(1).max(200) }).parse(request.params);
  const body = z.object({ decision: z.enum(["approve", "deny"]), requestId: z.string().max(200).optional(), turnId: z.string().min(1).max(200).optional(), execpolicyAmendment: z.array(z.string().min(1).max(300)).max(50).optional(), expiresAt: z.string().datetime({ offset: true }).optional() }).parse(request.body ?? {});
  if (isRequestExpired(body.expiresAt)) return reply.code(400).send({ error: "request_expired" });
  if (body.requestId && body.requestId !== requestId) return reply.code(400).send({ error: "request_id_mismatch" });
  const context = await authorizedThreadContext(id);
  if (!context) return reply.code(404).send({ error: "session_not_found", sessionId: id });
  if (!context.workspacePath) return reply.code(403).send({ error: "forbidden", message: "工作区不在允许访问的范围内" });
  app.log.info({ threadId: id, requestId, decision: body.decision, hasTurnId: Boolean(body.turnId) }, "approval resolve request received");
  // Approval is irreversible from the Gateway's perspective. Require the
  // audit record before consuming the pending request so a disk failure
  // cannot produce an unaudited Codex decision.
  await audit("approval.resolve", { threadId: id, requestId, decision: body.decision });
  const resolved = codexBridge.resolveApproval(requestId, body.decision, id, body.turnId, body.execpolicyAmendment);
  if (!resolved) {
    app.log.warn({ threadId: id, requestId, hasTurnId: Boolean(body.turnId) }, "approval resolve rejected: pending request not found or turn mismatch");
    return reply.code(404).send({ error: "approval_not_found" });
  }
  app.log.info({ threadId: id, requestId, decision: body.decision }, "approval resolve accepted");
  const payload = { sessionId: id, requestId, decision: body.decision };
  broadcastGateway({ type: "approval-resolved", sessionId: id, timestamp: new Date().toISOString(), payload });
  return { ok: true, ...payload };
});

app.post("/api/threads/:id/stop", async (request) => {
  const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
  const body = z.object({ turnId: z.string().min(1).optional() }).parse(request.body ?? {});
  const context = await authorizedThreadContext(id);
  if (!context) {
    const error = new Error("session_not_found") as Error & { statusCode?: number; code?: string };
    error.statusCode = 404;
    error.code = "session_not_found";
    throw error;
  }
  if (!context.workspacePath) {
    const error = new Error("forbidden") as Error & { statusCode?: number; code?: string };
    error.statusCode = 403;
    error.code = "forbidden";
    throw error;
  }
  const turnId = body.turnId ?? context.session?.activeTurnId;
  await audit("turn.interrupt", { threadId: id, turnId, action: "stop" });
  const session = settleInterruptedSession(id, context.session ?? threadToSession(context.thread!, "cancelled"), turnId);
  requestCodexInterrupt(id, turnId);
  broadcast({ method: "remote/turn/interrupted", params: { threadId: id, ...(turnId ? { turnId } : {}) } });
  return { ok: true, session, interruptRequested: Boolean(turnId) };
});

app.get("/diagnostics", async () => {
  const { data } = await listThreadsPortable(100);
  const sessions = gatewayStore.listSessions();
  return {
    gatewayName: config.gatewayName,
    gatewayVersion: config.gatewayVersion,
    timestamp: new Date().toISOString(),
    allowedFilesystemRoots: config.allowedFilesystemRoots,
    sessionCount: Math.max(data.length, sessions.length),
    runningCount: sessions.filter((session) => session.status === "running" || session.status === "starting").length,
    pendingApprovalCount: sessions.filter((session) => session.status === "waiting-approval").length,
    agentProviders: {
      codex: {
        enabled: true,
        command: config.codexBin,
        appServerPort: config.codexAppServerPort
      },
      claudeCode: {
        enabled: false,
        available: false
      }
    },
    codex: codexBridge.status
  };
});

app.get("/api/widget", async () => {
  const sessions = gatewayStore.listSessions();
  const threads = (await filterAllowedThreads((await listThreadsPortable(60).catch(() => ({ data: [] as ThreadSummary[] }))).data)).map(withGatewayThreadStatus);
  const threadSessions = threads.map((thread) => threadToSession(thread, mapThreadStatus(thread.status)));
  const liveSessions = (await filterAllowedSessions(sessions)).filter(isLiveWidgetSession);
  const mergedSessions = mergeWidgetSessions(liveSessions, threadSessions);
  const running = mergedSessions.filter((session) => session.status === "running" || session.status === "starting");
  const pendingApproval = mergedSessions.filter((session) => session.status === "waiting-approval");
  const current = running[0] ?? mergedSessions[0];
  const recentEvents = current ? gatewayStore.listEvents(current.id).slice(-20) : [];
  const latestOutput = latestWidgetFeedback(recentEvents.map((entry) => entry.message));
  return {
    app: "aCode",
    timestamp: new Date().toISOString(),
    status: running.length > 0 ? "running" : pendingApproval.length > 0 ? "waiting-approval" : "idle",
    currentTask: current
      ? {
          id: current.id,
          title: current.title,
          prompt: current.prompt,
          workspacePath: current.workspacePath,
          status: current.status,
          updatedAt: current.lastUpdatedAt
        }
      : null,
    feedback: latestOutput ?? "暂无实时反馈",
    stats: {
      total: mergedSessions.length,
      running: running.length,
      pendingApproval: pendingApproval.length,
      pendingInput: 0
    },
    trend: mergedSessions.slice(0, 10).map((session) => Math.max(1, Math.min(9, Math.round((Date.parse(session.lastUpdatedAt) || Date.now()) / 60000) % 10)))
  };
});

function isLiveWidgetSession(session: RemoteSession) {
  if (session.status !== "running" && session.status !== "starting" && session.status !== "waiting-approval") return true;
  return Date.now() - (Date.parse(session.lastUpdatedAt) || 0) <= 10 * 60 * 1000;
}

function mergeWidgetSessions(primary: RemoteSession[], secondary: RemoteSession[]) {
  const merged = new Map<string, RemoteSession>();
  for (const session of secondary) merged.set(session.id, session);
  for (const session of primary) merged.set(session.id, session);
  return Array.from(merged.values()).sort((left, right) => right.lastUpdatedAt.localeCompare(left.lastUpdatedAt));
}

function latestWidgetFeedback(messages: GatewayMessage[]) {
  const completedAgentText = [...messages]
    .reverse()
    .map((message) => completedAgentFeedbackText(message))
    .find((text) => text.length > 0);
  if (completedAgentText) return completedAgentText;

  const agentDeltaText = messages
    .filter((message) => message.payload.eventType === "item/agentMessage/delta" && typeof message.payload.chunk === "string")
    .map((message) => String(message.payload.chunk))
    .join("");
  const compactDelta = compactWidgetText(agentDeltaText);
  if (compactDelta) return compactDelta;

  return [...messages]
    .reverse()
    .map((message) => promptFeedbackText(message))
    .find((text) => text.length > 0);
}

function completedAgentFeedbackText(message: GatewayMessage) {
  const payload = message.payload;
  const eventType = typeof payload.eventType === "string" ? payload.eventType : "";
  if (eventType !== "item/completed") return "";
  const jsonPayload = payload.jsonPayload;
  if (jsonPayload && typeof jsonPayload === "object") {
    const item = (jsonPayload as { item?: unknown }).item;
    if (item && typeof item === "object") {
      const record = item as { type?: unknown; text?: unknown };
      if (record.type === "agentMessage" && typeof record.text === "string") return compactWidgetText(record.text);
    }
  }
  return "";
}

function promptFeedbackText(message: GatewayMessage) {
  const payload = message.payload;
  if (typeof payload.prompt === "string") return compactWidgetText(payload.prompt);
  if (typeof payload.text === "string") return compactWidgetText(payload.text);
  if (typeof payload.message === "string") return compactWidgetText(payload.message);
  return "";
}

function compactWidgetText(value: string) {
  const text = value.replace(/\s+/g, " ").trim();
  if (!text || text.startsWith("{") || text.startsWith("diff --git ")) return "";
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

app.get("/filesystem/list", async (request, reply) => {
  const query = z.object({ path: z.string().default(process.cwd()) }).parse(request.query);
  const requestedPath = await resolveAllowedWorkspace(query.path);
  if (!requestedPath) {
    return reply.code(403).send({
      error: "forbidden",
      message: "当前目录不在允许访问的范围内"
    });
  }
  const allEntries = (await readdir(requestedPath, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  const truncated = allEntries.length > maxFilesystemEntries;
  const entries = await Promise.all(
    allEntries.slice(0, maxFilesystemEntries).map(async (entry) => {
      const entryPath = path.join(requestedPath, entry.name);
      const resolvedEntryPath = await realpath(entryPath).catch(() => null);
      if (!resolvedEntryPath || !isPathWithinAllowedRoots(resolvedEntryPath)) return null;
      const stats = await stat(entryPath).catch(() => undefined);
      return {
        name: entry.name,
        path: resolvedEntryPath,
        type: entry.isDirectory() ? "directory" : "file",
        size: stats?.isFile() ? stats.size : null,
        modifiedAt: stats ? stats.mtime.toISOString() : null
      };
    })
  );
  const parentCandidate = await realpath(path.dirname(requestedPath)).catch(() => null);
  const parentPath = parentCandidate && isPathWithinAllowedRoots(parentCandidate) ? parentCandidate : null;
  return {
    path: requestedPath,
    parentPath,
    entries: entries.filter((entry): entry is NonNullable<typeof entry> => entry !== null),
    truncated,
    maxEntries: maxFilesystemEntries
  };
});

app.get("/files/download", async (request, reply) => {
  const query = z.object({
    sessionId: z.string().uuid(),
    path: z.string().min(1).max(4096)
  }).parse(request.query);
  const persistedSession = gatewayStore.getSession(query.sessionId);
  const thread = persistedSession ? undefined : await findThreadSummary(query.sessionId);
  const workspacePath = persistedSession?.workspacePath ?? thread?.cwd;
  const trustedPersistedSession = Boolean(persistedSession);
  if (!workspacePath) {
    return reply.code(404).send({ error: "session_not_found" });
  }

  const workspace = await realpath(workspacePath).catch(() => null);
  if (!workspace) {
    return reply.code(404).send({ error: "workspace_not_found" });
  }
  const candidatePath = path.isAbsolute(query.path)
    ? path.resolve(query.path)
    : path.resolve(workspace, query.path);
  const requestedPath = await realpath(candidatePath).catch(() => null);
  if (!requestedPath || !isPathWithin(workspace, requestedPath) || (!trustedPersistedSession && !isPathWithinAllowedRoots(requestedPath))) {
    return reply.code(403).send({ error: "forbidden", message: "文件不在当前会话工作区内" });
  }

  const file = await stat(requestedPath).catch(() => null);
  if (!file?.isFile()) {
    return reply.code(404).send({ error: "file_not_found" });
  }
  if (file.size > maxFileDownloadBytes) {
    return reply.code(413).send({ error: "file_too_large", maxBytes: maxFileDownloadBytes });
  }

  await audit("file.download", { sessionId: query.sessionId, size: file.size, ip: request.ip });
  reply.header("content-type", "application/octet-stream");
  reply.header("content-length", String(file.size));
  reply.header("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(requestedPath))}`);
  return reply.send(createReadStream(requestedPath));
});

app.get("/importable-threads", async () => {
  const { data: rawData } = await listThreadsPortable(100);
  const data = await filterAllowedThreads(rawData);
  return {
    threads: data.map((thread) => ({
      id: thread.id,
      provider: "codex",
      title: thread.title,
      workspacePath: thread.cwd,
      prompt: thread.preview,
      createdAt: new Date(thread.createdAtMs).toISOString(),
      updatedAt: new Date(thread.updatedAtMs).toISOString(),
      modelLabel: thread.model,
      modelProvider: thread.modelProvider,
      canImport: true
    }))
  };
});

app.post("/sessions/import", async (request, reply) => {
  const body = z.object({ threadId: z.string().uuid(), title: z.string().max(200).optional() }).parse(request.body);
  const thread = await findThreadSummary(body.threadId);
  if (!thread) return reply.code(404).send({ error: "session_not_found", threadId: body.threadId });
  const workspacePath = await resolveAllowedWorkspace(thread.cwd);
  if (!workspacePath) return reply.code(403).send({ error: "forbidden", message: "工作区不在允许访问的范围内" });
  const session = gatewayStore.upsertSession(threadToSession({ ...thread, cwd: workspacePath, title: body.title || thread.title }));
  return { session };
});

app.get("/protocol", async () => ({
  protocolVersion: "codeharbor.gateway.v1",
  protocolRevision: 2,
  gatewayName: config.gatewayName,
  agentProviders: ["codex"],
  sessionPolicyModes: ["confirm", "full-access"],
  defaultSessionPolicyMode: "confirm",
  security: {
    fullAccessConfirmation: true,
    confirmationField: "confirmFullAccess"
  },
  rawCodexEvents: true,
  rawCodexEventTransport: "websocket:type=codex",
  eventDelivery: {
    sequence: "per-session-monotonic",
    field: "eventSeq",
    resumeMessage: "resume",
    completionEvent: "resume-complete",
    storage: "gateway-data/events/<session>.jsonl"
  },
  threading: {
    forkRoute: "/sessions/:id/fork",
    forkedFromField: "forkedFromId",
    childEvent: "session-forked"
  },
  approval: {
    requestEvent: "approval-requested",
    decisionRoute: "/sessions/:id/approvals/:requestId",
    decisions: ["approve", "deny"]
  },
  httpRoutes: [
    "/healthz",
  "/auth/login",
    "/sessions",
    "/sessions/import",
    "/diagnostics",
    "/importable-threads",
    "/sessions/:id",
    "/sessions/:id/policy",
    "/sessions/:id/events",
    "/sessions/:id/turns",
    "/sessions/:id/fork",
    "/sessions/:id/interrupt",
    "/sessions/:id/approvals/:requestId",
    "/filesystem/list",
    "/files/download",
    "/protocol"
  ],
  websocketPath: "/ws",
  supportedEvents: [
    "gateway-ready",
    "resume-complete",
    "pong",
    "session-started",
    "session-forked",
    "session-policy-changed",
    "subagent-started",
    "subagent-tool",
    "subagent-finished",
    "session-user-input",
    "session-status",
    "session-output",
    "session-finished",
    "approval-requested",
    "approval-resolved",
    "codex-event",
    "error"
  ]
}));

app.get("/api/models", async (_request, reply) => {
  try {
    const response = await codexBridge.listModels();
    return response;
  } catch (error) {
    return reply.code(503).send({ error: "model_list_unavailable", message: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/ws", { websocket: true }, (socket, request) => {
  const query = new URL(request.url, "http://localhost").searchParams;
  const queryTokens = query.getAll("token");
  const legacyQueryToken = process.env.NODE_ENV === "production" && process.env.CODEHARBOR_ALLOW_QUERY_TOKEN !== "true"
    ? undefined
    : queryTokens.length === 1 ? queryTokens[0] ?? undefined : undefined;
  const token = getWebSocketProtocolToken(request.headers["sec-websocket-protocol"])
    ?? legacyQueryToken;
  if (!verifySession(token)) {
    socket.close(1008, "unauthorized");
    return;
  }

  const client: Client = {
    socket: socket as unknown as WebSocket,
    authedAt: Date.now(),
    isAlive: true,
    lastResumeAt: 0,
    heartbeatTimer: setInterval(() => {
      if (client.socket.readyState !== WebSocket.OPEN) return;
      if (!client.isAlive) {
        client.socket.terminate();
        return;
      }
      client.isAlive = false;
      try {
        client.socket.ping();
      } catch {
        client.socket.terminate();
      }
    }, 30_000)
  };
  clients.add(client);
  void audit("ws.connect", { ip: request.ip });

  client.socket.on("pong", () => {
    client.isAlive = true;
  });

  sendClient(client, JSON.stringify({
      type: "gateway-ready",
      timestamp: new Date().toISOString(),
      payload: {
        gatewayName: config.gatewayName,
        supportedMessages: ["ping", "resume"],
        eventCursor: gatewayStore.latestCursors()
      },
      codex: codexBridge.status
    }));

  client.socket.on("message", (raw) => {
    let message: unknown;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (typeof message === "object" && message && "type" in message && message.type === "ping") {
      const requestId = "requestId" in message && typeof message.requestId === "string" ? message.requestId : undefined;
      const sessionId = "sessionId" in message && typeof message.sessionId === "string" ? message.sessionId : undefined;
      sendClient(client, JSON.stringify({
        type: "pong",
        requestId,
        sessionId,
        timestamp: new Date().toISOString(),
        payload: {
          gatewayName: config.gatewayName
        }
      }));
    }
    if (typeof message === "object" && message && "type" in message && message.type === "resume") {
      const now = Date.now();
      if (now - client.lastResumeAt < 1_000) {
        sendClient(client, JSON.stringify({ type: "resume-rate-limited", retryAfterMs: 1_000 }));
        return;
      }
      client.lastResumeAt = now;
      const cursors = "cursors" in message && message.cursors && typeof message.cursors === "object"
        ? message.cursors as Record<string, unknown> : {};
      const latest: Record<string, number> = {};
      let replayedEvents = 0;
      let replayedBytes = 0;
      let truncated = false;
      let processedSessions = 0;
      for (const [sessionId, rawCursor] of Object.entries(cursors)) {
        if (processedSessions >= maxResumeSessions) {
          truncated = true;
          break;
        }
        processedSessions += 1;
        if (!sessionId || sessionId.length > 256) {
          truncated = true;
          continue;
        }
        const cursor = typeof rawCursor === "number" && Number.isFinite(rawCursor) ? rawCursor : 0;
        latest[sessionId] = cursor;
        for (const entry of gatewayStore.listEventsAfter(sessionId, cursor)) {
          const text = JSON.stringify(entry.message);
          const bytes = Buffer.byteLength(text);
          if (replayedEvents >= maxResumeEvents || replayedBytes + bytes > maxResumeBytes) {
            truncated = true;
            break;
          }
          if (!sendClient(client, text)) break;
          replayedEvents += 1;
          replayedBytes += bytes;
          const seq = entry.message.eventSeq;
          if (typeof seq === "number" && seq > (latest[sessionId] ?? 0)) latest[sessionId] = seq;
        }
        if (truncated) break;
      }
      sendClient(client, JSON.stringify({
        type: "resume-complete",
        timestamp: new Date().toISOString(),
        payload: { cursors: latest, truncated }
      }));
    }
  });

  client.socket.on("close", () => {
    clearInterval(client.heartbeatTimer);
    clients.delete(client);
    void audit("ws.disconnect", { ip: request.ip, connectedMs: Date.now() - client.authedAt });
  });
});

codexBridge.on("event", (event: CodexEvent) => {
  broadcast({ type: "codex", ...event });
  const normalized = normalizeCodexEvent(event);
  if (normalized) {
    broadcastGateway(normalized);
  }
});

codexBridge.on("log", (log) => {
  app.log.info({ stream: log.stream, text: log.text }, "codex app-server log");
  broadcast({ type: "codex-log", ...log });
});

app.setErrorHandler((error, request, reply) => {
  app.log.error({ err: error, url: request.url }, "request failed");
  const maybeError = error as { statusCode?: unknown; code?: unknown };
  const validationError = error instanceof z.ZodError || (error as { name?: unknown })?.name === "ZodError";
  const statusCode = validationError ? 400 : maybeError.code === "model_not_available" ? 400 :
    typeof maybeError.statusCode === "number" && maybeError.statusCode >= 400 ? maybeError.statusCode : 500;
  const publicMessage = validationError
    ? "invalid_request"
    : statusCode >= 500
      ? "internal_error"
      : error instanceof Error ? error.message : "Request failed";
  reply.code(statusCode).send({
    error: publicMessage,
    code: validationError ? "invalid_request" : typeof maybeError.code === "string" ? maybeError.code : "internal_error"
  });
});

app.setNotFoundHandler((_request, reply) => {
  return reply.code(404).send({ error: "not found" });
});

function broadcast(payload: unknown) {
  const text = JSON.stringify(payload);
  for (const client of clients) {
    sendClient(client, text);
  }
}

function sendClient(client: Client, text: string) {
  if (client.socket.readyState !== WebSocket.OPEN) return false;
  const bytes = Buffer.byteLength(text);
  if (client.socket.bufferedAmount + bytes > maxClientBufferedBytes) {
    client.socket.close(1013, "slow consumer");
    return false;
  }
  try {
    client.socket.send(text);
    return true;
  } catch {
    client.socket.close();
    return false;
  }
}

function broadcastGateway(payload: unknown) {
  let outbound = payload;
  if (isGatewayMessage(payload)) {
    let persisted: GatewayMessage | undefined;
    try {
      persisted = gatewayStore.appendEvent(payload);
      for (const failure of gatewayStore.takeEventWriteErrors()) {
        app.log.error({ err: failure.error, filePath: failure.filePath }, "gateway event persistence failed");
      }
    } catch (error) {
      // Disk-full/permission failures must not escape the Codex event
      // listener and terminate the Gateway. The live event remains deliverable
      // while the error is surfaced in logs for operator action.
      app.log.error({ err: error, sessionId: payload.sessionId }, "gateway event persistence failed");
    }
    const gatewayPayload: GatewayMessage = persisted ?? payload;
    outbound = gatewayPayload;
    persistSubagentRelation(gatewayPayload);
    const session = extractSessionFromGatewayMessage(gatewayPayload);
    if (session) {
      if (cancelledSessions.has(session.id) && (session.status === "running" || session.status === "starting" || session.status === "waiting-approval")) {
        app.log.info({ threadId: session.id, status: session.status }, "ignored stale Codex status after local cancellation");
        return;
      }
      if (session.status === "running" || session.status === "starting" || session.status === "waiting-approval") {
        processLiveSessionIds.add(session.id);
      } else {
        processLiveSessionIds.delete(session.id);
        turnGate.release(session.id);
      }
      gatewayStore.upsertSession(session);
    } else if (gatewayPayload.sessionId && gatewayPayload.type === "session-finished") {
      processLiveSessionIds.delete(gatewayPayload.sessionId);
      turnGate.release(gatewayPayload.sessionId);
      gatewayStore.updateSession(gatewayPayload.sessionId, (existing) => ({
        ...existing,
        status: inferFinishedStatus(gatewayPayload),
        activeTurnId: undefined,
        finishedAt: gatewayPayload.timestamp,
        lastTurnFinishedAt: gatewayPayload.timestamp,
        lastUpdatedAt: gatewayPayload.timestamp
      }));
    } else if (gatewayPayload.sessionId && gatewayPayload.type === "session-status") {
      const status = typeof gatewayPayload.payload.status === "string" ? gatewayPayload.payload.status : undefined;
      if (status) {
        if (cancelledSessions.has(gatewayPayload.sessionId) && (status === "running" || status === "starting" || status === "waiting-approval")) {
          app.log.info({ threadId: gatewayPayload.sessionId, status }, "ignored stale Codex session status after local cancellation");
          return;
        }
        if (status === "running" || status === "starting" || status === "waiting-approval") {
        processLiveSessionIds.add(gatewayPayload.sessionId);
        } else {
          processLiveSessionIds.delete(gatewayPayload.sessionId);
          turnGate.release(gatewayPayload.sessionId);
        }
        gatewayStore.updateSession(gatewayPayload.sessionId, (existing) => ({
          ...existing,
          status: status as SessionStatus,
          lastUpdatedAt: gatewayPayload.timestamp
        }));
      }
    } else if (gatewayPayload.sessionId && gatewayPayload.type === "approval-requested") {
      gatewayStore.updateSession(gatewayPayload.sessionId, (existing) => ({
        ...existing,
        status: "waiting-approval",
        lastUpdatedAt: gatewayPayload.timestamp
      }));
    }
  }
  broadcast(outbound);
}

function persistSubagentRelation(payload: GatewayMessage) {
  if (payload.type !== "subagent-started" && payload.type !== "subagent-finished" && payload.type !== "session-forked") return;
  const body = payload.payload as Record<string, unknown>;
  const parentId = typeof body.parentSessionId === "string" ? body.parentSessionId
    : typeof body.threadId === "string" && payload.type === "subagent-started" ? body.threadId : undefined;
  const childId = typeof body.childThreadId === "string" ? body.childThreadId
    : typeof (body.activity as Record<string, unknown> | undefined)?.agentThreadId === "string"
      ? (body.activity as Record<string, string>).agentThreadId : payload.type === "session-forked" && typeof body.sessionId === "string" ? body.sessionId : undefined;
  if (!parentId || !childId || parentId === childId) return;
  gatewayStore.linkSubagent(parentId, childId);
}

function isGatewayMessage(value: unknown): value is GatewayMessage {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof (value as { type?: unknown }).type === "string" &&
    typeof (value as { timestamp?: unknown }).timestamp === "string" &&
    typeof (value as { payload?: unknown }).payload === "object"
  );
}

function extractSessionFromGatewayMessage(message: GatewayMessage) {
  const session = message.payload.session;
  if (session && typeof session === "object" && typeof (session as { id?: unknown }).id === "string") {
    return session as RemoteSession;
  }
  return undefined;
}

function inferFinishedStatus(message: GatewayMessage): SessionStatus {
  const turn = message.payload.turn;
  const status = typeof (turn as { status?: unknown } | undefined)?.status === "string" ? String((turn as { status: string }).status) : "";
  if (status === "failed" || status === "error") return "failed";
  if (status === "cancelled" || status === "interrupted") return "cancelled";
  if (turn && typeof turn === "object" && (turn as { status?: unknown }).status === "failed") return "failed";
  return "completed";
}

function isGatewayProtectedPath(url: string) {
  return [
    "/sessions",
    "/filesystem",
    "/files",
    "/approval-rules",
    "/diagnostics",
    "/widget",
    "/importable-threads",
    "/documents"
  ].some((prefix) => url.startsWith(prefix));
}

function extractThreadId(response: unknown) {
  if (!response || typeof response !== "object") return undefined;
  const record = response as Record<string, unknown>;
  const thread = record.thread;
  if (thread && typeof thread === "object" && typeof (thread as Record<string, unknown>).id === "string") {
    return (thread as Record<string, string>).id;
  }
  if (typeof record.threadId === "string") return record.threadId;
  if (typeof record.id === "string") return record.id;
  return undefined;
}

function threadToSession(thread: ThreadSummary, overrideStatus?: SessionStatus): RemoteSession {
  const status = overrideStatus ?? mapThreadStatus(thread.status);
  const createdAt = new Date(thread.createdAtMs).toISOString();
  const updatedAt = new Date(thread.updatedAtMs).toISOString();
  return {
    id: thread.id,
    provider: "codex",
    providerSessionId: thread.id,
    title: thread.title,
    workspacePath: thread.cwd,
    status,
    sessionPolicyMode: "confirm",
    canResume: true,
    resumeStatus: "resumable",
    command: `${config.codexBin} app-server`,
    args: ["thread/import", "history/replay"],
    prompt: thread.preview,
    modelLabel: thread.model ?? undefined,
    modelProvider: thread.modelProvider,
    createdAt,
    lastUpdatedAt: updatedAt,
    startedAt: createdAt,
    finishedAt: status === "completed" ? updatedAt : undefined,
    lastTurnFinishedAt: status === "completed" ? updatedAt : undefined
  };
}

async function findTrustedThreadSummary(id: string): Promise<ThreadSummary | null> {
  // Only an indexed or persisted summary is trusted for remote mutation. Do
  // not probe arbitrary UUIDs through app-server readThread: that turns an
  // unauthenticated-ID typo/flood into a 15-second RPC/CPU sink and cannot
  // establish the workspace boundary by itself.
  return (await findThreadSummary(id)) ?? null;
}

async function authorizedThreadContext(id: string) {
  const session = gatewayStore.getSession(id);
  const thread = session ? undefined : await findTrustedThreadSummary(id);
  if (!session && !thread) return null;
  const rawWorkspace = session?.workspacePath ?? thread?.cwd ?? "";
  const workspacePath = rawWorkspace ? await resolveAllowedWorkspace(rawWorkspace, Boolean(session)) : null;
  return { session, thread, workspacePath };
}

function minimalSession(id: string, prompt: string, status: SessionStatus): RemoteSession {
  const now = new Date().toISOString();
  return {
    id,
    provider: "codex",
    providerSessionId: id,
    title: prompt.slice(0, 32) || "Codex 会话",
    workspacePath: process.cwd(),
    status,
    sessionPolicyMode: "confirm",
    canResume: true,
    resumeStatus: "resumable",
    command: `${config.codexBin} app-server`,
    args: ["thread/start", "turn/start"],
    prompt,
    createdAt: now,
    lastUpdatedAt: now,
    startedAt: now
  };
}

function mapThreadStatus(status: string): SessionStatus {
  if (status === "running" || status === "inProgress" || status === "active") return "running";
  if (status === "failed" || status === "systemError") return "failed";
  if (status === "interrupted" || status === "cancelled") return "cancelled";
  return "completed";
}

function normalizeThreadStatus(status: unknown): SessionStatus {
  if (typeof status === "string") return mapThreadStatus(status);
  if (status && typeof status === "object") {
    const type = (status as { type?: unknown; status?: unknown }).type ?? (status as { type?: unknown; status?: unknown }).status;
    if (typeof type === "string") return mapThreadStatus(type);
  }
  return "running";
}

function withGatewayThreadStatus(thread: ThreadSummary): ThreadSummary {
  const existing = gatewayStore.getSession(thread.id);
  if (!existing) return thread;
  if ((existing.status === "running" || existing.status === "starting") && !processLiveSessionIds.has(thread.id)) {
    return thread;
  }
  if ((existing.status === "running" || existing.status === "starting") && Date.now() - (Date.parse(existing.lastUpdatedAt) || 0) > 10 * 60 * 1000) {
    processLiveSessionIds.delete(thread.id);
    turnGate.release(thread.id);
    return thread;
  }
  return {
    ...thread,
    status: existing.status,
    updatedAtMs: Math.max(thread.updatedAtMs, Date.parse(existing.lastUpdatedAt) || thread.updatedAtMs)
  };
}

function sessionToThreadSummary(session: RemoteSession): ThreadSummary {
  return {
    id: session.id,
    title: session.title,
    cwd: session.workspacePath,
    preview: session.prompt,
    model: session.modelLabel ?? null,
    modelProvider: session.modelProvider ?? "codex",
    source: "gateway",
    status: session.status,
    createdAtMs: Date.parse(session.createdAt) || Date.now(),
    updatedAtMs: Date.parse(session.lastUpdatedAt) || Date.now(),
    tokensUsed: 0,
    archived: false,
    gitBranch: null
  };
}

function latestIso(left: string | undefined, right: string) {
  if (!left) return right;
  return left > right ? left : right;
}

function extractTurnId(response: unknown) {
  if (!response || typeof response !== "object") return undefined;
  const record = response as Record<string, unknown>;
  const turn = record.turn;
  if (turn && typeof turn === "object" && typeof (turn as Record<string, unknown>).id === "string") {
    return (turn as Record<string, string>).id;
  }
  if (typeof record.turnId === "string") return record.turnId;
  return undefined;
}

function settleInterruptedSession(id: string, base: GatewaySession, turnId?: string) {
  sessionRunState.cancel(id);
  cancelledSessions.add(id);
  if (cancelledSessions.size > 10_000) {
    const oldest = cancelledSessions.values().next().value;
    if (typeof oldest === "string") cancelledSessions.delete(oldest);
  }
  processLiveSessionIds.delete(id);
  turnGate.release(id);
  const timestamp = new Date().toISOString();
  const session = gatewayStore.upsertSession({
    ...base,
    status: "cancelled",
    activeTurnId: undefined,
    finishedAt: timestamp,
    lastTurnFinishedAt: timestamp,
    lastUpdatedAt: timestamp
  });
  broadcastGateway({
    type: "session-finished",
    sessionId: id,
    timestamp,
    payload: { sessionId: id, status: "cancelled", ...(turnId ? { turnId } : {}) }
  });
  void relayClient.syncSessionsNow();
  return session;
}

function requestCodexInterrupt(threadId: string, turnId?: string) {
  if (!turnId) return;
  void codexBridge.interruptTurn(threadId, turnId).catch((error) => {
    app.log.warn({ err: error, threadId, turnId }, "Codex interrupt failed after local cancellation");
  });
}

async function resolveActiveTurnId(threadId: string) {
  const stored = gatewayStore.getSession(threadId)?.activeTurnId;
  if (stored) return stored;
  const detail = await readThreadDetail(threadId).catch(() => null);
  return findActiveTurnId(detail);
}

function findActiveTurnId(detail: unknown) {
  const thread = detail && typeof detail === "object" ? (detail as { thread?: unknown }).thread : null;
  const turns = thread && typeof thread === "object" && Array.isArray((thread as { turns?: unknown }).turns)
    ? (thread as { turns: unknown[] }).turns
    : [];
  for (const turn of [...turns].reverse()) {
    if (!turn || typeof turn !== "object") continue;
    const record = turn as Record<string, unknown>;
    if (typeof record.id !== "string") continue;
    const status = typeof record.status === "string" ? record.status : objectTypeField(record.status);
    if (status === "running" || status === "inProgress" || status === "active" || status === "starting") {
      return record.id;
    }
  }
  return undefined;
}

function isActiveTurnNotSteerableError(error: unknown) {
  if (!(error instanceof Error)) return false;
  const code = (error as Error & { code?: unknown }).code;
  return code === "activeTurnNotSteerable" || /activeTurnNotSteerable|not steerable/i.test(error.message);
}

async function findThreadSummary(threadId: string) {
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const response = await listThreadsPortable(100, cursor);
    const found = response.data.find((thread) => thread.id === threadId);
    if (found) return found;
    if (!response.nextCursor) return undefined;
    cursor = response.nextCursor;
  }
  return undefined;
}

async function listThreadsPortable(limit: number, cursor?: string) {
  // session_index.jsonl is the portable Codex history source and does not
  // require a platform-specific sqlite3 executable. Prefer it on every
  // client machine; use SQLite only when the index is unavailable or invalid.
  try {
    return listThreadsFromIndex(limit, cursor);
  } catch (indexError) {
    app.log.warn({ err: indexError }, "Codex session index unavailable, trying SQLite state");
    try {
      return await listThreads(limit, cursor);
    } catch (sqliteError) {
      if (!isSqliteFallbackError(sqliteError)) throw sqliteError;
      app.log.warn({ err: sqliteError }, "Codex SQLite state unavailable, using app-server thread/list");
      return mapCodexThreadList(await codexBridge.listThreads(limit, cursor));
    }
  }
}

function isSqliteFallbackError(error: unknown) {
  if (!(error instanceof Error)) return false;
  return /sqlite3.*ENOENT|spawn sqlite3 ENOENT|not found|unable to open database|database is locked|no such table|no such column|parse error/i.test(
    error.message
  );
}

function mapCodexThreadList(response: unknown) {
  const record = response && typeof response === "object" ? response as Record<string, unknown> : {};
  const rawThreads = Array.isArray(record.data) ? record.data : Array.isArray(record.threads) ? record.threads : [];
  const data = rawThreads.map(mapCodexThreadSummary).filter((thread): thread is ThreadSummary => thread !== null);
  const nextCursor = typeof record.nextCursor === "string" ? record.nextCursor : typeof record.cursor === "string" ? record.cursor : null;
  return { data, nextCursor };
}

function mapCodexThreadSummary(raw: unknown): ThreadSummary | null {
  if (!raw || typeof raw !== "object") return null;
  const thread = raw as Record<string, unknown>;
  const id = stringField(thread, "id") ?? stringField(thread, "threadId");
  if (!id) return null;
  const status = stringField(thread, "status") ?? objectTypeField(thread.status) ?? "notLoaded";
  const createdAtMs = numberOrDateMs(thread.createdAtMs ?? thread.created_at_ms ?? thread.createdAt ?? thread.created_at) ?? Date.now();
  const updatedAtMs = numberOrDateMs(thread.updatedAtMs ?? thread.updated_at_ms ?? thread.updatedAt ?? thread.updated_at) ?? createdAtMs;
  return {
    id,
    title: stringField(thread, "title") ?? stringField(thread, "name") ?? stringField(thread, "preview") ?? "Untitled",
    cwd: stringField(thread, "cwd") ?? stringField(thread, "workspacePath") ?? "",
    preview: stringField(thread, "preview") ?? stringField(thread, "lastMessage") ?? "",
    model: stringField(thread, "model"),
    modelProvider: stringField(thread, "modelProvider") ?? stringField(thread, "model_provider") ?? "codex",
    source: stringField(thread, "source") ?? "codex-app-server",
    status,
    createdAtMs,
    updatedAtMs,
    tokensUsed: numberField(thread, "tokensUsed") ?? numberField(thread, "tokens_used") ?? 0,
    archived: Boolean(thread.archived),
    gitBranch: stringField(thread, "gitBranch") ?? stringField(thread, "git_branch")
  };
}

function stringField(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function numberField(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function objectTypeField(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const type = (value as { type?: unknown; status?: unknown }).type ?? (value as { type?: unknown; status?: unknown }).status;
  return typeof type === "string" ? type : null;
}

function numberOrDateMs(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 10_000_000_000 ? value : value * 1000;
  }
  if (typeof value === "string") {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric > 10_000_000_000 ? numeric : numeric * 1000;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

async function readThreadDetail(threadId: string) {
  try {
    return await codexBridge.readThread(threadId);
  } catch (error) {
    app.log.warn({ err: error, threadId }, "thread/read failed, using local fallback");
    try {
      return await readThreadFallback(threadId);
    } catch (fallbackError) {
      app.log.warn({ err: fallbackError, threadId }, "local thread fallback failed, using gateway session snapshot");
      const session = gatewayStore.getSession(threadId);
      if (session) return gatewaySessionToThreadDetail(session);
      throw fallbackError;
    }
  }
}

function gatewaySessionToThreadDetail(session: RemoteSession) {
  const createdAt = Math.floor((Date.parse(session.createdAt) || Date.now()) / 1000);
  const updatedAt = Math.floor((Date.parse(session.lastUpdatedAt) || Date.now()) / 1000);
  return {
    fallback: true,
    degraded: true,
    thread: {
      id: session.id,
      name: session.title || session.prompt || "Codex 会话",
      preview: session.prompt || "",
      ephemeral: false,
      modelProvider: session.modelProvider ?? "codex",
      createdAt,
      updatedAt,
      status: { type: session.status },
      path: "",
      cwd: session.workspacePath,
      cliVersion: null,
      source: "gateway",
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      turns: [
        {
          id: `${session.id}:gateway`,
          status: session.status,
          error: null,
          startedAt: createdAt,
          completedAt: updatedAt,
          durationMs: null,
          items: gatewayStore.listEvents(session.id).map(gatewayEventToTimelineItem)
        }
      ]
    }
  };
}

function gatewayEventToTimelineItem(entry: { message: GatewayMessage }) {
  const payload = entry.message.payload ?? {};
  const eventType = typeof payload.eventType === "string" ? payload.eventType : entry.message.type;
  const text =
    typeof payload.chunk === "string"
      ? payload.chunk
      : typeof payload.prompt === "string"
        ? payload.prompt
        : JSON.stringify(payload);
  return {
    id: `${entry.message.timestamp}:${eventType}`,
    type: eventType,
    text,
    raw: entry.message
  };
}

function threadDetailToGatewayEvents(detail: unknown): Array<{ message: GatewayMessage }> {
  const thread = (detail as { thread?: { id?: string; turns?: Array<{ items?: unknown[] }> } }).thread;
  const sessionId = thread?.id ?? "";
  const events: Array<{ message: GatewayMessage }> = [];
  const turns = thread?.turns ?? [];
  for (const turn of turns) {
    for (const item of turn.items ?? []) {
      const record = item as Record<string, unknown>;
      const text = timelineItemText(record);
      events.push({
        message: {
          type: "session-output",
          sessionId,
          timestamp: new Date().toISOString(),
          eventSeq: events.length + 1,
          payload: {
            sessionId,
            stream: record.type === "commandExecution" ? "stdout" : "event",
            chunk: text,
            format: "jsonl",
            eventType: record.type,
            jsonPayload: compactUnknown(record)
          }
        }
      });
    }
  }
  return events;
}

function timelineItemText(record: Record<string, unknown>) {
  if (typeof record.text === "string") return record.text;
  if (Array.isArray(record.content)) {
    return record.content
      .map((part) => (typeof part === "object" && part && "text" in part ? String((part as { text?: unknown }).text ?? "") : ""))
      .filter(Boolean)
      .join("\n");
  }
  if (typeof record.command === "string") return record.command;
  if (typeof record.aggregatedOutput === "string") return record.aggregatedOutput;
  return "";
}

function isPathWithinAllowedRoots(targetPath: string) {
  const resolvedTarget = path.resolve(targetPath);
  return config.allowedFilesystemRoots.some((root) => {
    return isPathWithin(path.resolve(root), resolvedTarget);
  });
}

async function filterAllowedThreads(threads: ThreadSummary[]) {
  const result: ThreadSummary[] = [];
  for (const thread of threads.slice(0, 10_000)) {
    if (thread.cwd?.trim() && await resolveAllowedWorkspace(thread.cwd)) result.push(thread);
  }
  return result;
}

async function filterAllowedSessions(sessions: RemoteSession[]) {
  const result: RemoteSession[] = [];
  for (const session of sessions.slice(0, 10_000)) {
    if (session.workspacePath?.trim() && await resolveAllowedWorkspace(session.workspacePath, true)) result.push(session);
  }
  return result;
}

/** Resolve and authorize a workspace before passing it to Codex. Lexical
 * path checks are insufficient because a directory inside an allowed root can
 * be a symlink to an outside tree. */
async function resolveAllowedWorkspace(rawPath: string, allowTrustedOutsideRoots = false) {
  if (!rawPath || !rawPath.trim()) return null;
  const check = resolveAllowedWorkspaceUnbounded(rawPath, allowTrustedOutsideRoots);
  let timer: NodeJS.Timeout | undefined;
  return await Promise.race([
    check,
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), workspaceCheckTimeoutMs);
    })
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function resolveAllowedWorkspaceUnbounded(rawPath: string, allowTrustedOutsideRoots: boolean) {
  const workspace = await realpath(path.resolve(rawPath)).catch(() => null);
  if (!workspace) return null;
  const details = await stat(workspace).catch(() => null);
  if (!details?.isDirectory()) return null;
  if (allowTrustedOutsideRoots) return workspace;
  for (const rootPath of config.allowedFilesystemRoots) {
    const root = await realpath(path.resolve(rootPath)).catch(() => null);
    if (root && isPathWithin(root, workspace)) return workspace;
  }
  return null;
}

function isPathWithin(rootPath: string, targetPath: string) {
  const resolvedRoot = path.resolve(rootPath);
  const resolvedTarget = path.resolve(targetPath);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizeCodexEvent(event: CodexEvent) {
  const params = event.params;
  if (!params || typeof params !== "object") return null;
  const record = params as Record<string, unknown>;
  if (event.method === "gateway/codex/serverRequest") {
    const nestedParams = record.params && typeof record.params === "object" ? record.params as Record<string, unknown> : {};
    const threadId = typeof nestedParams.threadId === "string" ? nestedParams.threadId : undefined;
    if (!threadId) return null;
    const requestMethod = typeof record.requestMethod === "string" ? record.requestMethod : "approval";
    const approval = {
      id: String(record.backendRequestId ?? `${Date.now()}`),
      sessionId: threadId,
      threadId,
      turnId: typeof nestedParams.turnId === "string" ? nestedParams.turnId : undefined,
      itemId: typeof nestedParams.itemId === "string" ? nestedParams.itemId : undefined,
      backendRequestId: record.backendRequestId,
      status: "approved",
      summary: requestMethod,
      reason: String(nestedParams.reason ?? nestedParams.message ?? "自动授权"),
      source: "event",
      requestMethod,
      command: typeof nestedParams.command === "string" ? nestedParams.command : undefined,
      cwd: typeof nestedParams.cwd === "string" ? nestedParams.cwd : undefined,
      rawEvent: JSON.stringify(compactUnknown(nestedParams)),
      autoApproved: true,
      createdAt: new Date().toISOString(),
      resolvedAt: new Date().toISOString(),
      decisionNote: "auto-approved-by-remote-gateway"
    };
    return {
      type: "approval-resolved",
      sessionId: threadId,
      timestamp: new Date().toISOString(),
      payload: {
        sessionId: threadId,
        approval,
        decision: "approved"
      }
    };
  }
  if (event.method === "gateway/codex/approvalRequested") {
    const threadId = typeof record.threadId === "string" ? record.threadId : undefined;
    if (!threadId) return null;
    const nestedParams = record.params && typeof record.params === "object" ? record.params as Record<string, unknown> : {};
    const turnId = typeof record.turnId === "string"
      ? record.turnId
      : typeof nestedParams.turnId === "string" ? nestedParams.turnId : undefined;
    return {
      type: "approval-requested",
      sessionId: threadId,
      requestId: typeof record.requestId === "string" ? record.requestId : undefined,
      timestamp: new Date().toISOString(),
      payload: {
        sessionId: threadId,
        requestId: record.requestId,
        requestMethod: record.requestMethod ?? nestedParams.requestMethod,
        turnId,
        itemId: record.itemId ?? nestedParams.itemId,
        summary: record.summary ?? nestedParams.summary,
        command: record.command ?? nestedParams.command,
        cwd: record.cwd ?? nestedParams.cwd,
        proposedExecpolicyAmendment: record.proposedExecpolicyAmendment ?? nestedParams.proposedExecpolicyAmendment,
        expiresAt: record.expiresAt ?? nestedParams.expiresAt,
        params: record.params,
        status: "pending"
      }
    };
  }
  if (event.method === "gateway/codex/approvalExpired") {
    const threadId = typeof record.threadId === "string" ? record.threadId : undefined;
    const requestId = typeof record.requestId === "string" ? record.requestId : undefined;
    if (!threadId || !requestId) return null;
    return {
      type: "approval-expired",
      sessionId: threadId,
      requestId,
      timestamp: new Date().toISOString(),
      payload: { sessionId: threadId, requestId, requestMethod: record.requestMethod }
    };
  }
  const threadId = typeof record.threadId === "string" ? record.threadId : undefined;
  if (!threadId) return null;
  const turnId = typeof record.turnId === "string" ? record.turnId : undefined;
  if (event.method === "item/completed" && record.item && typeof record.item === "object") {
    const item = record.item as Record<string, unknown>;
    if (item.type === "subAgentActivity") {
      if (item.kind === "started" && typeof item.agentThreadId === "string") {
        subagentParents.set(item.agentThreadId, threadId);
      }
      const kind = item.kind === "completed" || item.kind === "stopped" || item.kind === "failed" ? "subagent-finished" : "subagent-started";
      return {
        type: kind,
        sessionId: threadId,
        timestamp: new Date().toISOString(),
        payload: { threadId, turnId, activity: compactUnknown(item) }
      };
    }
    if (item.type === "collabAgentToolCall") {
      return {
        type: "subagent-tool",
        sessionId: threadId,
        timestamp: new Date().toISOString(),
        payload: { threadId, turnId, toolCall: compactUnknown(item) }
      };
    }
  }
  if (event.method === "thread/status/changed") {
    const status = normalizeThreadStatus(record.status);
    const parentThreadId = subagentParents.get(threadId) ?? gatewayStore.getSubagentParent(threadId);
    if (parentThreadId && (status === "completed" || status === "failed" || status === "cancelled")) {
      subagentParents.delete(threadId);
      return {
        type: "subagent-finished",
        sessionId: parentThreadId,
        timestamp: new Date().toISOString(),
        payload: { threadId: parentThreadId, childThreadId: threadId, status }
      };
    }
    return {
      type: status === "completed" || status === "failed" || status === "cancelled" ? "session-finished" : "session-status",
      sessionId: threadId,
      timestamp: new Date().toISOString(),
      payload: {
        threadId,
        status,
        turn: { status }
      }
    };
  }
  if (event.method === "turn/completed") {
    return {
      type: "session-finished",
      sessionId: threadId,
      timestamp: new Date().toISOString(),
      payload: {
        threadId,
        turn: record.turn
      }
    };
  }
  if (event.method === "item/agentMessage/delta" || event.method === "item/commandExecution/outputDelta") {
    return {
      type: "session-output",
      sessionId: threadId,
      timestamp: new Date().toISOString(),
      payload: {
        threadId,
        turnId,
        stream: event.method === "item/agentMessage/delta" ? "event" : "stdout",
        eventType: event.method,
        itemId: typeof record.itemId === "string" ? record.itemId : undefined,
        chunk: typeof record.delta === "string" ? record.delta : "",
        jsonPayload: compactEventParams(record)
      }
    };
  }
  if (event.method === "item/completed" || event.method === "turn/diff/updated" || event.method === "thread/tokenUsage/updated") {
    return {
      type: "session-output",
      sessionId: threadId,
      timestamp: new Date().toISOString(),
      payload: {
        threadId,
        turnId,
        stream: "event",
        eventType: event.method,
        chunk: JSON.stringify(compactEventParams(record)),
        jsonPayload: compactEventParams(record)
      }
    };
  }
  return null;
}

function compactEventParams(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).slice(0, 40).map(([key, current]) => [key, compactUnknown(current)])
  );
}

function compactUnknown(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > 2000 ? `${value.slice(0, 2000)}...` : value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map(compactUnknown);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).slice(0, 40).map(([key, current]) => [key, compactUnknown(current)])
    );
  }
  return value;
}

export async function startServer() {
  await app.listen({ host: config.host, port: config.port });
  relayClient.start();
  logInfo(`本地服务已启动: http://${config.host}:${config.port}`);
  logInfo(`审计日志: ${path.join(config.auditDir, "audit.jsonl")}`);
  if (config.relayUrl) {
    let lastPrintedPairCode = "";
    logInfo("官方中转已启用，正在连接...");
    relayClient.on("status", (status) => {
      if (status.connected && status.deviceId) {
        logInfo(`中转已连接: ${status.deviceName ?? status.deviceId}`);
      }
      if (status.pairCode && status.pairCode !== lastPrintedPairCode) {
        lastPrintedPairCode = status.pairCode;
        logInfo("");
        logInfo("手机 App 输入下面的配对码：");
        logInfo(`  ${status.pairCode}`);
        logInfo("");
        logInfo("这个配对码会固定保存在服务器，后续重启仍可继续使用。");
      }
      if (status.lastError) {
        logError(`中转连接错误: ${status.lastError}`);
      }
    });
  }
  return app;
}

function logInfo(message: string) {
  if (friendlyLogs) {
    console.log(message);
    return;
  }
  app.log.info(message);
}

function logError(message: string) {
  if (friendlyLogs) {
    console.error(message);
    return;
  }
  app.log.error(message);
}
