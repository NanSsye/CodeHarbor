import type { GatewaySession } from "./gatewayStore.js";

export type SessionSyncMetadata = {
  id: string;
  title: string;
  workspacePath: string;
  status: string;
  updatedAt: string;
  sessionPolicyMode: "confirm" | "full-access";
};

export type SessionSyncPayload = {
  type: "session-sync";
  requestId: string;
  sessions: SessionSyncMetadata[];
  cursors: Record<string, number>;
};

export async function loadSessionSyncPayload(options: {
  localUrl: string;
  gatewayAuthToken: string;
  fallback: readonly GatewaySession[];
  cursors: Record<string, number>;
  requestId: string;
}): Promise<{ payload: SessionSyncPayload; listingError?: string }> {
  let response: unknown;
  let listingError: string | undefined;
  try {
    const localResponse = await fetch(options.localUrl, {
      headers: {
        authorization: `Bearer ${options.gatewayAuthToken}`,
        accept: "application/json"
      },
      redirect: "error",
      signal: AbortSignal.timeout(60_000)
    });
    const body = await readResponseBody(localResponse);
    if (!localResponse.ok) {
      const code = typeof body.error === "string" ? `: ${body.error}` : "";
      throw new Error(`local session listing failed (${localResponse.status})${code}`);
    }
    response = body;
  } catch (error) {
    listingError = error instanceof Error ? error.message : String(error);
  }
  return {
    payload: buildSessionSyncPayload(response, options.fallback, options.cursors, options.requestId),
    ...(listingError ? { listingError } : {})
  };
}

export async function sendSessionSync(options: {
  localUrl: string;
  gatewayAuthToken: string;
  fallback: readonly GatewaySession[];
  cursors: Record<string, number>;
  requestId: string;
  isOpen: () => boolean;
  send: (text: string) => void;
}) {
  const result = await loadSessionSyncPayload(options);
  if (options.isOpen()) options.send(JSON.stringify(result.payload));
  return result;
}

/**
 * Convert a local `/sessions` response into the intentionally small metadata
 * contract sent to the cloud relay. Prompts, command arguments and turn
 * details stay on the user's computer; the cloud only needs enough data to
 * render the list and route later events.
 */
export function buildSessionSyncPayload(
  response: unknown,
  fallback: readonly GatewaySession[],
  cursors: Record<string, number>,
  requestId: string
): SessionSyncPayload {
  const responseSessions = extractResponseSessions(response);
  // A successful empty listing is authoritative. Falling back to the old
  // snapshot here would make deleted local sessions reappear in the cloud.
  const source = responseSessions ?? fallback;
  const byId = new Map<string, SessionSyncMetadata>();
  for (const value of source) {
    const session = normalizeSession(value);
    if (session) byId.set(session.id, session);
  }

  return {
    type: "session-sync",
    requestId,
    sessions: Array.from(byId.values()),
    cursors: normalizeCursors(cursors)
  };
}

function extractResponseSessions(value: unknown): unknown[] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const sessions = (value as Record<string, unknown>).sessions;
  return Array.isArray(sessions) ? sessions : undefined;
}

async function readResponseBody(response: Response): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await response.json();
    return value && typeof value === "object" ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function normalizeSession(value: unknown): SessionSyncMetadata | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  if (!id) return undefined;
  return {
    id,
    title: stringOr(record.title, "Codex 会话"),
    workspacePath: stringOr(record.workspacePath, ""),
    status: stringOr(record.status, "completed"),
    updatedAt: stringOr(record.updatedAt ?? record.lastUpdatedAt, new Date(0).toISOString()),
    sessionPolicyMode: record.sessionPolicyMode === "full-access" ? "full-access" : "confirm"
  };
}

function stringOr(value: unknown, fallback: string) {
  return typeof value === "string" ? value : fallback;
}

function normalizeCursors(value: Record<string, number>) {
  const result: Record<string, number> = {};
  for (const [sessionId, cursor] of Object.entries(value)) {
    if (!sessionId || !Number.isSafeInteger(cursor) || cursor < 0) continue;
    result[sessionId] = cursor;
  }
  return result;
}
