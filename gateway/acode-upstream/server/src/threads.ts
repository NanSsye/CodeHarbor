import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { sqliteJson } from "./sqlite.js";

export type ThreadSummary = {
  id: string;
  title: string;
  cwd: string;
  preview: string;
  model: string | null;
  modelProvider: string;
  source: string;
  status: string;
  createdAtMs: number;
  updatedAtMs: number;
  tokensUsed: number;
  archived: boolean;
  gitBranch: string | null;
};

type ThreadRow = {
  id: string;
  title: string;
  cwd: string;
  preview: string;
  model: string | null;
  model_provider: string;
  source: string;
  created_at_ms: number | null;
  updated_at_ms: number | null;
  created_at: number;
  updated_at: number;
  tokens_used: number;
  archived: number;
  git_branch: string | null;
};

type ThreadDetailRow = ThreadRow & {
  rollout_path: string;
  cli_version: string;
};

type TableInfoRow = {
  name: string;
};

type TimelineItem = {
  id: string;
  type: string;
  text?: string;
  command?: string;
  aggregatedOutput?: string | null;
  status?: string;
  content?: Array<{ type: string; text?: string }>;
  raw?: unknown;
};

let rolloutPathCache: { expiresAt: number; value: Map<string, string> } | null = null;

export function stateDbPath() {
  return path.join(config.codexHome, "state_5.sqlite");
}

export async function listThreads(limit: number, cursor?: string) {
  const dbPath = stateDbPath();
  if (!existsSync(dbPath)) {
    throw new Error(`Codex state database not found: ${dbPath}`);
  }

  const safeLimit = Math.min(Math.max(limit || 40, 1), 100);
  const schema = await readThreadSchema(dbPath);
  const select = buildThreadSelect(schema);
  const updatedAtMsExpr = threadUpdatedAtMsExpr(schema);
  const archivedExpr = schema.has("archived") ? "coalesce(archived, 0)" : "0";
  const cursorMs = cursor ? Number(cursor) : null;
  const cursorClause = cursorMs && Number.isFinite(cursorMs) ? `and (${updatedAtMsExpr}) < ${cursorMs}` : "";
  const rows = await sqliteJson<ThreadRow>(
    dbPath,
    `select ${select}
       from threads
      where (${archivedExpr}) = 0 ${cursorClause}
      order by updated_at_ms desc, id desc
      limit ${safeLimit + 1};`
  );

  const hasMore = rows.length > safeLimit;
  const page = rows.slice(0, safeLimit);
  const data = page.map(mapThreadRow);
  return {
    data,
    nextCursor: hasMore ? String(data.at(-1)?.updatedAtMs ?? "") : null
  };
}

export function listThreadsFromIndex(limit: number, cursor?: string) {
  const indexPath = path.join(config.codexHome, "session_index.jsonl");
  if (!existsSync(indexPath)) {
    throw new Error(`Codex session index not found: ${indexPath}`);
  }

  const safeLimit = Math.min(Math.max(limit || 40, 1), 100);
  const cursorMs = cursor ? Number(cursor) || 0 : null;
  const rolloutPaths = buildRolloutPathIndex();
  const rows = readFileSync(indexPath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map(parseIndexLine)
    .filter((row): row is IndexRow => row !== null)
    .map((row) => indexRowToThreadSummary(row, rolloutPaths.get(row.id)))
    .filter((thread) => !cursorMs || thread.updatedAtMs < cursorMs)
    .sort((left, right) => right.updatedAtMs - left.updatedAtMs || right.id.localeCompare(left.id));

  const page = rows.slice(0, safeLimit + 1);
  const data = page.slice(0, safeLimit);
  return {
    data,
    nextCursor: page.length > safeLimit ? String(data.at(-1)?.updatedAtMs ?? "") : null
  };
}

export async function readThreadFallback(threadId: string) {
  let rows: ThreadDetailRow[];
  try {
    const dbPath = stateDbPath();
    const schema = await readThreadSchema(dbPath);
    rows = await sqliteJson<ThreadDetailRow>(
      dbPath,
      `select ${buildThreadSelect(schema, true)}
         from threads
        where id = '${escapeSql(threadId)}'
        limit 1;`
    );
  } catch (error) {
    return readThreadFallbackFromRollout(threadId);
  }
  const row = rows[0];
  if (!row) {
    return readThreadFallbackFromRollout(threadId);
  }

  const rolloutPath = row.rollout_path || findRolloutPath(row.id) || "";
  const items = rolloutPath && existsSync(rolloutPath) ? readRolloutItems(rolloutPath) : [];
  return {
    fallback: true,
    thread: {
      id: row.id,
      name: row.title || row.preview || "Untitled",
      preview: row.preview,
      ephemeral: false,
      modelProvider: row.model_provider,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      status: { type: "notLoaded" },
      path: rolloutPath,
      cwd: row.cwd,
      cliVersion: row.cli_version,
      source: row.source,
      agentNickname: null,
      agentRole: null,
      gitInfo: row.git_branch ? { branch: row.git_branch } : null,
      turns: [
        {
          id: `${row.id}:rollout`,
          status: "completed",
          error: null,
          startedAt: row.created_at,
          completedAt: row.updated_at,
          durationMs: null,
          items
        }
      ]
    }
  };
}

export function readThreadFallbackFromRollout(threadId: string) {
  const rolloutPath = findRolloutPath(threadId);
  if (!rolloutPath) {
    throw new Error(`Thread rollout not found: ${threadId}`);
  }
  const metadata = readRolloutMetadata(rolloutPath);
  const createdAt = Math.floor((metadata.createdAtMs ?? Date.now()) / 1000);
  const updatedAt = Math.floor((metadata.updatedAtMs ?? metadata.createdAtMs ?? Date.now()) / 1000);
  const items = readRolloutItems(rolloutPath);
  return {
    fallback: true,
    thread: {
      id: threadId,
      name: metadata.preview || "Untitled",
      preview: metadata.preview ?? "",
      ephemeral: false,
      modelProvider: metadata.modelProvider ?? "codex",
      createdAt,
      updatedAt,
      status: { type: "notLoaded" },
      path: rolloutPath,
      cwd: metadata.cwd ?? "",
      cliVersion: null,
      source: metadata.source ?? "rollout",
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      turns: [
        {
          id: `${threadId}:rollout`,
          status: "completed",
          error: null,
          startedAt: createdAt,
          completedAt: updatedAt,
          durationMs: null,
          items
        }
      ]
    }
  };
}

function mapThreadRow(row: ThreadRow): ThreadSummary {
  return {
    id: row.id,
    title: row.title || row.preview || "Untitled",
    cwd: row.cwd,
    preview: row.preview,
    model: row.model,
    modelProvider: row.model_provider,
    source: row.source,
    status: "notLoaded",
    createdAtMs: row.created_at_ms ?? row.created_at * 1000,
    updatedAtMs: row.updated_at_ms ?? row.updated_at * 1000,
    tokensUsed: row.tokens_used,
    archived: row.archived === 1,
    gitBranch: row.git_branch
  };
}

async function readThreadSchema(dbPath: string) {
  const rows = await sqliteJson<TableInfoRow>(dbPath, "pragma table_info(threads);");
  const names = new Set(rows.map((row) => row.name).filter(Boolean));
  if (!names.has("id")) throw new Error("Codex threads table is missing required id column");
  return names;
}

function buildThreadSelect(schema: Set<string>, includeDetail = false) {
  const columns = [
    `${columnOr(schema, "id", "''")} as id`,
    `${columnOr(schema, "title", "''")} as title`,
    `${columnOr(schema, "cwd", "''")} as cwd`,
    `${threadPreviewExpr(schema)} as preview`,
    `${columnOr(schema, "model", "null")} as model`,
    `${columnOr(schema, "model_provider", "'codex'")} as model_provider`,
    `${threadSourceExpr(schema)} as source`,
    `${threadCreatedAtMsExpr(schema)} as created_at_ms`,
    `${threadUpdatedAtMsExpr(schema)} as updated_at_ms`,
    `${threadCreatedAtExpr(schema)} as created_at`,
    `${threadUpdatedAtExpr(schema)} as updated_at`,
    `${columnOr(schema, "tokens_used", "0")} as tokens_used`,
    `${columnOr(schema, "archived", "0")} as archived`,
    `${columnOr(schema, "git_branch", "null")} as git_branch`
  ];
  if (includeDetail) {
    columns.splice(1, 0, `${columnOr(schema, "rollout_path", "''")} as rollout_path`);
    columns.push(`${columnOr(schema, "cli_version", "''")} as cli_version`);
  }
  return columns.join(",\n            ");
}

function threadPreviewExpr(schema: Set<string>) {
  if (schema.has("preview") && schema.has("first_user_message")) return "coalesce(nullif(preview, ''), first_user_message, '')";
  if (schema.has("preview")) return "coalesce(preview, '')";
  if (schema.has("first_user_message")) return "coalesce(first_user_message, '')";
  return "''";
}

function threadSourceExpr(schema: Set<string>) {
  if (schema.has("source")) return "source";
  if (schema.has("thread_source")) return "thread_source";
  return "'codex'";
}

function threadCreatedAtMsExpr(schema: Set<string>) {
  if (schema.has("created_at_ms") && schema.has("created_at")) return "coalesce(created_at_ms, created_at * 1000)";
  if (schema.has("created_at_ms")) return "created_at_ms";
  if (schema.has("created_at")) return "created_at * 1000";
  return "0";
}

function threadUpdatedAtMsExpr(schema: Set<string>) {
  if (schema.has("updated_at_ms") && schema.has("updated_at")) return "coalesce(updated_at_ms, updated_at * 1000)";
  if (schema.has("updated_at_ms")) return "updated_at_ms";
  if (schema.has("updated_at")) return "updated_at * 1000";
  return threadCreatedAtMsExpr(schema);
}

function threadCreatedAtExpr(schema: Set<string>) {
  if (schema.has("created_at")) return "created_at";
  return `cast((${threadCreatedAtMsExpr(schema)}) / 1000 as integer)`;
}

function threadUpdatedAtExpr(schema: Set<string>) {
  if (schema.has("updated_at")) return "updated_at";
  return `cast((${threadUpdatedAtMsExpr(schema)}) / 1000 as integer)`;
}

function columnOr(schema: Set<string>, column: string, fallback: string) {
  return schema.has(column) ? column : fallback;
}

type IndexRow = {
  id: string;
  thread_name?: string;
  updated_at?: string;
};

function parseIndexLine(line: string): IndexRow | null {
  try {
    const row = JSON.parse(line) as IndexRow;
    return typeof row.id === "string" ? row : null;
  } catch {
    return null;
  }
}

function indexRowToThreadSummary(row: IndexRow, knownRolloutPath?: string): ThreadSummary {
  const rolloutPath = knownRolloutPath ?? findRolloutPath(row.id);
  const metadata = rolloutPath ? readRolloutMetadata(rolloutPath) : {};
  const updatedAtMs = Date.parse(row.updated_at ?? "") || metadata.updatedAtMs || Date.now();
  const createdAtMs = metadata.createdAtMs || updatedAtMs;
  return {
    id: row.id,
    title: row.thread_name || metadata.preview || "Untitled",
    cwd: metadata.cwd ?? "",
    preview: metadata.preview ?? "",
    model: metadata.model ?? null,
    modelProvider: metadata.modelProvider ?? "codex",
    source: metadata.source ?? "session_index",
    status: "notLoaded",
    createdAtMs,
    updatedAtMs,
    tokensUsed: 0,
    archived: false,
    gitBranch: null
  };
}

function buildRolloutPathIndex() {
  const now = Date.now();
  if (rolloutPathCache && rolloutPathCache.expiresAt > now) return rolloutPathCache.value;
  const result = new Map<string, string>();
  const sessionsDir = path.join(config.codexHome, "sessions");
  if (!existsSync(sessionsDir)) return result;
  const stack = [sessionsDir];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.name.endsWith(".jsonl")) {
        const match = entry.name.match(/[0-9a-f]{8}-[0-9a-f-]{27,}/i);
        if (match) result.set(match[0], fullPath);
      }
    }
  }
  // Session files can be created while the Gateway is running. A short TTL
  // avoids rescanning the full rollout tree on every sync while still making
  // newly-created threads visible without a process restart.
  rolloutPathCache = { expiresAt: now + 10_000, value: result };
  return result;
}

function findRolloutPath(threadId: string) {
  const sessionsDir = path.join(config.codexHome, "sessions");
  if (!existsSync(sessionsDir)) return null;
  const stack = [sessionsDir];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir)) {
      const fullPath = path.join(dir, entry);
      const stats = statSync(fullPath);
      if (stats.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (entry.includes(threadId) && entry.endsWith(".jsonl")) return fullPath;
    }
  }
  return null;
}

function readRolloutMetadata(rolloutPath: string) {
  const metadata: {
    cwd?: string;
    preview?: string;
    model?: string;
    modelProvider?: string;
    source?: string;
    createdAtMs?: number;
    updatedAtMs?: number;
  } = {};
  const lines = readFileSync(rolloutPath, "utf8").split(/\r?\n/).filter(Boolean);
  for (const [index, line] of lines.entries()) {
    let entry: { timestamp?: string; type?: string; payload?: any };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const timestampMs = Date.parse(entry.timestamp ?? "");
    if (Number.isFinite(timestampMs)) {
      metadata.createdAtMs ??= timestampMs;
      metadata.updatedAtMs = timestampMs;
    }
    const payload = entry.payload;
    if (entry.type === "session_meta") {
      metadata.cwd = payload?.cwd ?? metadata.cwd;
      metadata.model = payload?.model ?? metadata.model;
      metadata.modelProvider = payload?.model_provider ?? metadata.modelProvider;
      metadata.source = payload?.source ?? metadata.source;
    }
    if (!metadata.preview && entry.type === "event_msg" && payload?.type === "user_message") {
      metadata.preview = String(payload.message ?? "").slice(0, 240);
    }
    if (index > 80 && metadata.preview && metadata.cwd) break;
  }
  return metadata;
}

function readRolloutItems(rolloutPath: string): TimelineItem[] {
  const lines = readFileSync(rolloutPath, "utf8").split(/\r?\n/).filter(Boolean);
  const items: TimelineItem[] = [];

  lines.forEach((line, index) => {
    let entry: { timestamp?: string; type?: string; payload?: any };
    try {
      entry = JSON.parse(line);
    } catch {
      return;
    }
    const id = `${entry.timestamp ?? index}:${index}`;
    const payload = entry.payload;

    if (entry.type === "event_msg" && payload?.type === "user_message") {
      items.push({
        id,
        type: "userMessage",
        content: [{ type: "text", text: payload.message ?? "" }]
      });
      return;
    }

    if (entry.type !== "response_item" || !payload) return;

    if (payload.type === "message") {
      const text = Array.isArray(payload.content)
        ? payload.content.map((part: any) => part.text ?? part.output_text ?? "").filter(Boolean).join("\n")
        : "";
      items.push({
        id,
        type: payload.role === "user" ? "userMessage" : "agentMessage",
        text,
        content: payload.role === "user" ? [{ type: "text", text }] : undefined
      });
      return;
    }

    if (payload.type === "function_call") {
      items.push({
        id,
        type: "commandExecution",
        command: `${payload.name} ${payload.arguments ?? ""}`,
        status: "completed",
        aggregatedOutput: null
      });
      return;
    }

    if (payload.type === "function_call_output") {
      items.push({
        id,
        type: "commandExecution",
        command: `output for ${payload.call_id ?? "call"}`,
        status: "completed",
        aggregatedOutput: typeof payload.output === "string" ? payload.output : JSON.stringify(payload.output)
      });
      return;
    }

    if (payload.type === "reasoning") {
      const summary = Array.isArray(payload.summary) ? payload.summary.join("\n") : "";
      if (summary) {
        items.push({
          id,
          type: "reasoning",
          text: summary
        });
      }
    }
  });

  return items;
}

function escapeSql(value: string) {
  return value.replaceAll("'", "''");
}
