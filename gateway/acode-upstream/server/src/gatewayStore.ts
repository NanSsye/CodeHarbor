import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, renameSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";

export type GatewaySessionStatus = "starting" | "running" | "waiting-approval" | "completed" | "failed" | "cancelled";

export type GatewaySession = {
  id: string;
  provider: "codex";
  providerSessionId: string;
  title: string;
  workspacePath: string;
  status: GatewaySessionStatus;
  sessionPolicyMode: "confirm" | "full-access";
  activeTurnId?: string;
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
  lastTurnStartedAt?: string;
  lastTurnFinishedAt?: string;
  lastClientRequestId?: string;
  /** Bounded durable idempotency ledger for retried client turn requests. */
  recentClientRequestIds?: string[];
  exitCode?: number | null;
  parentSessionId?: string;
  childSessionIds?: string[];
  threadSource?: string;
  agentNickname?: string;
  agentRole?: string;
  agentPath?: string;
};

export type GatewayMessage = {
  type: string;
  requestId?: string;
  sessionId?: string;
  timestamp: string;
  payload: Record<string, unknown>;
  /** Monotonic, per-session cursor used for reconnect replay. */
  eventSeq?: number;
};

export type SessionTimelineEntry = {
  message: GatewayMessage;
};

type CreateRequestRecord = {
  sessionId: string;
  createdAt: number;
};

type CachedEvents = {
  entries: SessionTimelineEntry[];
  /** True only when the cache contains the complete durable timeline. */
  complete: boolean;
};

const EVENT_CACHE_MAX_SESSIONS = 64;
const EVENT_CACHE_MAX_ENTRIES = 512;
const REQUEST_RESERVATION_TTL_MS = 10 * 60 * 1000;
const REQUEST_RESERVATION_MAX = 10_000;

function ensureDirectory(targetPath: string) {
  mkdirSync(targetPath, { recursive: true });
}

function safeFileName(sessionId: string) {
  return encodeURIComponent(sessionId);
}

function readJson<T>(filePath: string, fallback: T): T {
  try {
    if (!existsSync(filePath)) return fallback;
    const raw = readFileSync(filePath, "utf8").trim();
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    // Preserve a corrupt snapshot for manual recovery instead of silently
    // replacing the only copy with an empty state on the next startup.
    try {
      if (existsSync(filePath)) renameSync(filePath, `${filePath}.corrupt-${Date.now()}`);
    } catch {
      // Best effort; startup can still continue with an empty in-memory view.
    }
    return fallback;
  }
}

function writeJsonAtomic(filePath: string, value: unknown) {
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  try {
    ensureDirectory(path.dirname(filePath));
    const serialized = JSON.stringify(value, null, 2);
    writeFileSync(temporaryPath, serialized, { encoding: "utf8", mode: 0o600 });
    try {
      renameSync(temporaryPath, filePath);
    } catch {
      // Windows may reject replacing an existing file with renameSync. Keep
      // the same permission hardening and complete the write instead of
      // allowing a debounced persistence callback to throw asynchronously.
      writeFileSync(filePath, serialized, { encoding: "utf8", mode: 0o600 });
      try { rmSync(temporaryPath, { force: true }); } catch { /* best effort */ }
    }
  } catch {
    // Persistence is a durability signal, not a reason to crash the live
    // Gateway event loop. The next write retries the snapshot; operators can
    // still detect the condition from the missing/old snapshot on disk.
    try { rmSync(temporaryPath, { force: true }); } catch { /* best effort */ }
  }
}

export class GatewayStore {
  private readonly sessionsFilePath = path.join(config.gatewayDataDir, "sessions.json");
  private readonly relationsFilePath = path.join(config.gatewayDataDir, "subagent-relations.json");
  private readonly createRequestsFilePath = path.join(config.gatewayDataDir, "create-requests.json");
  private readonly eventsDirectoryPath = path.join(config.gatewayDataDir, "events");
  private readonly sessions = new Map<string, GatewaySession>();
  private readonly subagentRelations = new Map<string, string>();
  private readonly createRequests = new Map<string, CreateRequestRecord>();
  private readonly latestSeqBySession = new Map<string, number>();
  // Keep only a small LRU tail in memory. Durable JSONL files remain the
  // source of truth when a timeline has been truncated from this cache.
  private readonly eventCache = new Map<string, CachedEvents>();
  private readonly eventWriteChains = new Map<string, Promise<void>>();
  private readonly eventWriteErrors = new Map<string, Error>();
  private readonly deletedSessions = new Set<string>();
  private readonly clientRequestReservations = new Map<string, number>();
  private readonly createRequestReservations = new Map<string, number>();
  private sessionPersistTimer: NodeJS.Timeout | null = null;
  private sessionPersistDirty = false;

  constructor() {
    ensureDirectory(config.gatewayDataDir);
    ensureDirectory(this.eventsDirectoryPath);
    for (const session of readJson<GatewaySession[]>(this.sessionsFilePath, [])) {
      this.sessions.set(session.id, this.normalizePersistedSession(session));
    }
    for (const [childId, parentId] of Object.entries(readJson<Record<string, string>>(this.relationsFilePath, {}))) {
      this.subagentRelations.set(childId, parentId);
    }
    for (const [requestId, value] of Object.entries(readJson<Record<string, CreateRequestRecord>>(this.createRequestsFilePath, {}))) {
      if (value && typeof value.sessionId === "string" && typeof value.createdAt === "number" && this.sessions.has(value.sessionId)) {
        this.createRequests.set(requestId, value);
      }
    }
    this.persistSessions();
  }

  listSessions() {
    return Array.from(this.sessions.values()).sort((left, right) => right.lastUpdatedAt.localeCompare(left.lastUpdatedAt));
  }

  getSession(sessionId: string) {
    return this.sessions.get(sessionId);
  }

  saveSession(session: GatewaySession) {
    this.deletedSessions.delete(session.id);
    this.sessions.set(session.id, session);
    this.persistSessions();
    return session;
  }

  upsertSession(session: GatewaySession) {
    const existing = this.sessions.get(session.id);
    return this.saveSession(existing ? { ...existing, ...session, lastUpdatedAt: session.lastUpdatedAt } : session);
  }

  upsertSessions(sessions: GatewaySession[]) {
    for (const session of sessions) {
      const existing = this.sessions.get(session.id);
      this.sessions.set(session.id, existing ? { ...existing, ...session, lastUpdatedAt: session.lastUpdatedAt } : session);
    }
    this.persistSessions();
    return this.listSessions();
  }

  updateSession(sessionId: string, updater: (session: GatewaySession) => GatewaySession) {
    const existing = this.sessions.get(sessionId);
    if (!existing) return undefined;
    return this.saveSession(updater(existing));
  }

  appendEvent(message: GatewayMessage) {
    if (!message.sessionId || this.deletedSessions.has(message.sessionId)) return;
    const currentSeq = this.latestSeqBySession.get(message.sessionId) ?? this.listEvents(message.sessionId).at(-1)?.message.eventSeq ?? 0;
    const suppliedSeq = message.eventSeq;
    const eventSeq = typeof suppliedSeq === "number" && Number.isSafeInteger(suppliedSeq) && suppliedSeq > currentSeq
      ? suppliedSeq
      : currentSeq + 1;
    const persistedMessage = { ...message, eventSeq };
    const entry: SessionTimelineEntry = { message };
    const filePath = path.join(this.eventsDirectoryPath, `${safeFileName(message.sessionId)}.jsonl`);
    ensureDirectory(path.dirname(filePath));
    entry.message = persistedMessage;
    const cached = this.getCachedEvents(message.sessionId);
    const entries = cached
      ? [...cached.entries, entry]
      : [...this.readEventsFromDisk(message.sessionId), entry];
    this.cacheEvents(message.sessionId, entries, cached?.complete ?? true);
    this.queueEventWrite(filePath, `${JSON.stringify(entry)}\n`);
    this.latestSeqBySession.set(message.sessionId, eventSeq);
    return persistedMessage;
  }

  listEvents(sessionId: string) {
    const cached = this.getCachedEvents(sessionId);
    const entries = cached?.complete
      ? cached.entries
      : this.mergeEvents(this.readEventsFromDisk(sessionId), cached?.entries ?? []);
    this.cacheEvents(sessionId, entries, cached ? cached.complete : true);
    const latest = entries.at(-1)?.message.eventSeq;
    if (latest) this.latestSeqBySession.set(sessionId, latest);
    return entries;
  }

  async flush() {
    if (this.sessionPersistTimer) {
      clearTimeout(this.sessionPersistTimer);
      this.sessionPersistTimer = null;
    }
    if (this.sessionPersistDirty) {
      this.sessionPersistDirty = false;
      this.persistSessionsNow();
    }
    await Promise.all(this.eventWriteChains.values());
  }

  getEventWriteErrors() {
    return Array.from(this.eventWriteErrors.entries()).map(([filePath, error]) => ({ filePath, error }));
  }

  takeEventWriteErrors() {
    const errors = this.getEventWriteErrors();
    this.eventWriteErrors.clear();
    return errors;
  }

  listEventsAfter(sessionId: string, cursor: number) {
    return this.listEvents(sessionId).filter((entry) => (entry.message.eventSeq ?? 0) > cursor);
  }

  hasEvents(sessionId: string) {
    return existsSync(path.join(this.eventsDirectoryPath, `${safeFileName(sessionId)}.jsonl`));
  }

  listEventsAfterLimited(sessionId: string, cursor: number, limit: number) {
    const safeLimit = Math.max(1, Math.min(5_000, Math.floor(limit) || 1));
    const entries = this.listEventsAfter(sessionId, cursor);
    const truncated = entries.length > safeLimit;
    const page = truncated ? entries.slice(0, safeLimit) : entries;
    const nextCursor = page.at(-1)?.message.eventSeq ?? cursor;
    return { entries: page, nextCursor, truncated };
  }

  latestCursors() {
    const cursors: Record<string, number> = {};
    for (const session of this.sessions.values()) {
      const last = this.latestSeqBySession.get(session.id) ?? this.listEvents(session.id).at(-1)?.message.eventSeq;
      if (last) cursors[session.id] = last;
    }
    return cursors;
  }

  linkSubagent(parentId: string, childId: string) {
    if (!parentId || !childId || parentId === childId) return;
    this.subagentRelations.set(childId, parentId);
    writeJsonAtomic(this.relationsFilePath, Object.fromEntries(this.subagentRelations));
    if (this.sessions.has(parentId)) this.updateSession(parentId, (session) => ({
      ...session, childSessionIds: Array.from(new Set([...(session.childSessionIds ?? []), childId]))
    }));
    if (this.sessions.has(childId)) this.updateSession(childId, (session) => ({ ...session, parentSessionId: parentId }));
  }

  getSubagentParent(childId: string) { return this.subagentRelations.get(childId); }

  private nextEventSeq(sessionId: string) {
    const current = this.latestSeqBySession.get(sessionId) ?? this.listEvents(sessionId).at(-1)?.message.eventSeq ?? 0;
    return current + 1;
  }

  deleteSession(sessionId: string) {
    this.deletedSessions.add(sessionId);
    const deleted = this.sessions.delete(sessionId);
    if (deleted) this.persistSessions();
    const parentId = this.subagentRelations.get(sessionId);
    this.subagentRelations.delete(sessionId);
    for (const [childId, linkedParentId] of this.subagentRelations) {
      if (linkedParentId === sessionId) this.subagentRelations.delete(childId);
    }
    if (parentId && this.sessions.has(parentId)) {
      this.updateSession(parentId, (session) => ({
        ...session,
        childSessionIds: (session.childSessionIds ?? []).filter((childId) => childId !== sessionId)
      }));
    }
    writeJsonAtomic(this.relationsFilePath, Object.fromEntries(this.subagentRelations));
    let createRequestsChanged = false;
    for (const [requestId, record] of this.createRequests) {
      if (record.sessionId === sessionId) {
        this.createRequests.delete(requestId);
        createRequestsChanged = true;
      }
    }
    if (createRequestsChanged) writeJsonAtomic(this.createRequestsFilePath, Object.fromEntries(this.createRequests));
    const filePath = path.join(this.eventsDirectoryPath, `${safeFileName(sessionId)}.jsonl`);
    const removeFile = () => {
      if (existsSync(filePath)) rmSync(filePath, { force: true });
      this.eventWriteChains.delete(filePath);
    };
    const pendingWrite = this.eventWriteChains.get(filePath);
    if (pendingWrite) void pendingWrite.then(removeFile, removeFile);
    else removeFile();
    this.latestSeqBySession.delete(sessionId);
    this.eventCache.delete(sessionId);
    for (const key of this.clientRequestReservations.keys()) {
      if (key.startsWith(`${sessionId}\u0000`)) this.clientRequestReservations.delete(key);
    }
    return deleted;
  }

  /** Atomically reserve a turn idempotency key before doing asynchronous work. */
  reserveClientRequest(sessionId: string, requestId: string) {
    if (!sessionId || !requestId) return true;
    if (this.hasClientRequest(sessionId, requestId)) return false;
    this.pruneReservations(this.clientRequestReservations);
    const key = `${sessionId}\u0000${requestId}`;
    if (this.clientRequestReservations.has(key)) return false;
    this.clientRequestReservations.set(key, Date.now());
    return true;
  }

  releaseClientRequest(sessionId: string, requestId: string) {
    if (!sessionId || !requestId) return;
    this.clientRequestReservations.delete(`${sessionId}\u0000${requestId}`);
  }

  /**
   * Reserve a create request before starting a Codex thread. A second
   * concurrent caller gets `pending` until the first caller records its
   * resulting session in the durable create-request ledger.
   */
  reserveCreateRequest(requestId: string) {
    if (!requestId) return { reserved: true as const };
    const existingSessionId = this.getCreateRequestSession(requestId);
    if (existingSessionId) return { reserved: false as const, sessionId: existingSessionId };
    this.pruneReservations(this.createRequestReservations);
    if (this.createRequestReservations.has(requestId)) {
      return { reserved: false as const, pending: true as const };
    }
    this.createRequestReservations.set(requestId, Date.now());
    return { reserved: true as const };
  }

  releaseCreateRequest(requestId: string) {
    if (!requestId) return;
    this.createRequestReservations.delete(requestId);
  }

  private readEventsFromDisk(sessionId: string) {
    const filePath = path.join(this.eventsDirectoryPath, `${safeFileName(sessionId)}.jsonl`);
    if (!existsSync(filePath)) return [];
    try {
      let fallbackSeq = 0;
      return readFileSync(filePath, "utf8")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as SessionTimelineEntry];
          } catch {
            return [];
          }
        })
        .filter((entry) => entry.message?.sessionId === sessionId)
        .map((entry) => {
          const explicitSeq = entry.message.eventSeq;
          const eventSeq = typeof explicitSeq === "number" && Number.isFinite(explicitSeq) && explicitSeq > fallbackSeq
            ? explicitSeq
            : fallbackSeq + 1;
          fallbackSeq = eventSeq;
          return { message: { ...entry.message, eventSeq } };
        });
    } catch {
      return [];
    }
  }

  private queueEventWrite(filePath: string, line: string) {
    const previous = this.eventWriteChains.get(filePath) ?? Promise.resolve();
    const next = previous
      .then(() => appendFile(filePath, line, "utf8"))
      .catch((error: unknown) => {
        this.eventWriteErrors.set(filePath, error instanceof Error ? error : new Error(String(error)));
      })
      .finally(() => {
        // Keep only active chains; completed writes otherwise retain one
        // Promise per session for the lifetime of the Gateway process.
        if (this.eventWriteChains.get(filePath) === next) this.eventWriteChains.delete(filePath);
      });
    this.eventWriteChains.set(filePath, next);
  }

  private persistSessions() {
    // Streaming Codex events can update session metadata many times per
    // second. Coalesce snapshot writes so synchronous fsync/rename work does
    // not block the event loop or delay WebSocket delivery. Shutdown flushes
    // the pending snapshot synchronously through flush().
    this.sessionPersistDirty = true;
    if (this.sessionPersistTimer) return;
    this.sessionPersistTimer = setTimeout(() => {
      this.sessionPersistTimer = null;
      if (!this.sessionPersistDirty) return;
      this.sessionPersistDirty = false;
      this.persistSessionsNow();
    }, 100);
  }

  private persistSessionsNow() {
    writeJsonAtomic(this.sessionsFilePath, this.listSessions());
  }

  private normalizePersistedSession(session: GatewaySession) {
    const recentClientRequestIds = Array.isArray(session.recentClientRequestIds)
      ? session.recentClientRequestIds.filter((value): value is string => typeof value === "string" && value.length > 0).slice(-128)
      : session.lastClientRequestId ? [session.lastClientRequestId] : [];
    const normalized = {
      ...session,
      sessionPolicyMode: session.sessionPolicyMode ?? "confirm",
      recentClientRequestIds
    };
    if (normalized.status !== "running" && normalized.status !== "starting") return normalized;
    const now = new Date().toISOString();
    return {
      ...normalized,
      status: "completed" as const,
      activeTurnId: undefined,
      finishedAt: normalized.finishedAt ?? now,
      lastTurnFinishedAt: normalized.lastTurnFinishedAt ?? now,
      lastUpdatedAt: normalized.lastUpdatedAt ?? now
    };
  }

  hasClientRequest(sessionId: string, requestId: string) {
    if (!requestId) return false;
    const session = this.sessions.get(sessionId);
    return Boolean(session?.recentClientRequestIds?.includes(requestId) || session?.lastClientRequestId === requestId);
  }

  getCreateRequestSession(requestId: string) {
    if (!requestId) return undefined;
    const record = this.createRequests.get(requestId);
    if (!record) return undefined;
    if (!this.sessions.has(record.sessionId)) {
      this.createRequests.delete(requestId);
      writeJsonAtomic(this.createRequestsFilePath, Object.fromEntries(this.createRequests));
      return undefined;
    }
    return record.sessionId;
  }

  rememberCreateRequest(requestId: string, sessionId: string) {
    if (!requestId || !sessionId) return;
    this.createRequestReservations.delete(requestId);
    this.createRequests.set(requestId, { sessionId, createdAt: Date.now() });
    const entries = Array.from(this.createRequests.entries()).slice(-512);
    this.createRequests.clear();
    for (const [id, record] of entries) this.createRequests.set(id, record);
    writeJsonAtomic(this.createRequestsFilePath, Object.fromEntries(this.createRequests));
  }

  rememberClientRequest(sessionId: string, requestId: string) {
    if (!requestId) return;
    this.releaseClientRequest(sessionId, requestId);
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const ids = [...(session.recentClientRequestIds ?? []), requestId]
      .filter((value, index, values) => value && values.indexOf(value) === index)
      .slice(-128);
    this.saveSession({ ...session, recentClientRequestIds: ids, lastClientRequestId: requestId });
  }

  private getCachedEvents(sessionId: string) {
    const cached = this.eventCache.get(sessionId);
    if (!cached) return undefined;
    // Map insertion order is used as a small LRU for active sessions.
    this.eventCache.delete(sessionId);
    this.eventCache.set(sessionId, cached);
    return cached;
  }

  private cacheEvents(sessionId: string, entries: SessionTimelineEntry[], complete: boolean) {
    const boundedEntries = entries.length > EVENT_CACHE_MAX_ENTRIES
      ? entries.slice(-EVENT_CACHE_MAX_ENTRIES)
      : entries;
    this.eventCache.delete(sessionId);
    this.eventCache.set(sessionId, {
      entries: boundedEntries,
      complete: complete && boundedEntries.length === entries.length
    });
    while (this.eventCache.size > EVENT_CACHE_MAX_SESSIONS) {
      const oldestSessionId = this.eventCache.keys().next().value;
      if (typeof oldestSessionId !== "string") break;
      this.eventCache.delete(oldestSessionId);
    }
  }

  private mergeEvents(diskEntries: SessionTimelineEntry[], cachedEntries: SessionTimelineEntry[]) {
    if (cachedEntries.length === 0) return diskEntries;
    const bySequence = new Map<number, SessionTimelineEntry>();
    for (const entry of diskEntries) {
      const eventSeq = entry.message.eventSeq;
      if (typeof eventSeq === "number" && Number.isFinite(eventSeq)) bySequence.set(eventSeq, entry);
    }
    for (const entry of cachedEntries) {
      const eventSeq = entry.message.eventSeq;
      if (typeof eventSeq === "number" && Number.isFinite(eventSeq)) bySequence.set(eventSeq, entry);
    }
    return Array.from(bySequence.values()).sort((left, right) => (left.message.eventSeq ?? 0) - (right.message.eventSeq ?? 0));
  }

  private pruneReservations(reservations: Map<string, number>) {
    const cutoff = Date.now() - REQUEST_RESERVATION_TTL_MS;
    for (const [key, createdAt] of reservations) {
      if (createdAt <= cutoff) reservations.delete(key);
    }
    while (reservations.size > REQUEST_RESERVATION_MAX) {
      const oldestKey = reservations.keys().next().value;
      if (typeof oldestKey !== "string") break;
      reservations.delete(oldestKey);
    }
  }
}

export const gatewayStore = new GatewayStore();
