import { spawn, type ChildProcessByStdio } from "node:child_process";
import { EventEmitter } from "node:events";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Readable, Writable } from "node:stream";
import { audit } from "./audit.js";
import { buildCodexInput, type StoredAttachment } from "./attachments.js";
import { config } from "./config.js";
import { resolveCodexCommand } from "./codexPath.js";

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export type SessionPolicyMode = "confirm" | "full-access";
export type CodexRunOptions = {
  model?: string;
  effort?: string;
  threadSource?: string;
  multiAgentMode?: string;
};
type ApprovalDecision = { decision: "approve" | "deny"; execpolicyAmendment?: string[] };

type PendingApproval = {
  threadId: string;
  turnId?: string;
  method: string;
  resolve: (decision: ApprovalDecision) => void;
  timer: NodeJS.Timeout;
};

const maxPendingApprovals = 256;
const maxPendingRequests = 1024;
const maxStdoutBufferBytes = 32 * 1024 * 1024;
const maxPolicyEntries = 10_000;

export type CodexEvent = {
  method: string;
  params?: unknown;
};

function messageError(message: unknown) {
  if (typeof message === "object" && message && "error" in message) {
    const error = (message as { error: unknown }).error;
    const parsed: { code?: string; message: string } = typeof error === "string" ? { message: error } : errorMessageParts(error);
    const err = new Error(parsed.message);
    if (parsed.code) {
      (err as Error & { code?: string }).code = parsed.code;
    }
    return err;
  }
  return undefined;
}

function errorMessageParts(error: unknown) {
  if (!error || typeof error !== "object") {
    return { message: JSON.stringify(error) };
  }
  const record = error as Record<string, unknown>;
  const code = typeof record.code === "string" ? record.code : typeof record.type === "string" ? record.type : undefined;
  const message =
    typeof record.message === "string"
      ? record.message
      : typeof record.error === "string"
        ? record.error
        : JSON.stringify(error);
  return { code, message };
}

function shouldUseShell(command: string) {
  if (process.platform !== "win32") return false;
  return !command.includes("\\") && !command.includes("/") || /\.(cmd|bat)$/i.test(command);
}

function processEnvWithToolPath() {
  const extraPath = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin"
  ];
  const existingPath = process.env.PATH ?? "";
  const childEnv = { ...process.env };
  for (const key of Object.keys(childEnv)) {
    if (
      key.startsWith("CODEHARBOR_") ||
      key.startsWith("RELAY_") ||
      key.startsWith("GATEWAY_AUTH_") ||
      key === "ADMIN_TOKEN" ||
      key === "SESSION_SECRET" ||
      key === "DATABASE_URL" ||
      key === "REDIS_URL" ||
      key.startsWith("POSTGRES_") ||
      key.startsWith("PG") ||
      /(?:^|_)(?:API_KEY|TOKEN|SECRET|PASSWORD|PRIVATE_KEY|ACCESS_KEY)$/.test(key)
    ) {
      delete childEnv[key];
    }
  }
  return {
    ...childEnv,
    PATH: [...extraPath, existingPath].filter(Boolean).join(path.delimiter)
  };
}

export class CodexBridge extends EventEmitter {
  private child: ChildProcessByStdio<Writable, Readable, Readable> | null = null;
  private nextId = 1;
  private pending = new Map<string | number, PendingRequest>();
  private pendingApprovals = new Map<string, PendingApproval>();
  private policyByThread = new Map<string, SessionPolicyMode>();
  private modelCache: { expiresAt: number; ids: Set<string> } | null = null;
  private connecting: Promise<void> | null = null;
  private ready = false;
  private stdoutBuffer = "";
  private stdoutDecoder = new StringDecoder("utf8");

  get endpoint() {
    return "stdio://";
  }

  get status() {
    return {
      endpoint: this.endpoint,
      childRunning: this.child !== null && !this.child.killed,
      connected: this.child !== null && !this.child.killed,
      ready: this.ready
    };
  }

  shutdown() {
    this.ready = false;
    this.rejectAll(new Error("Codex app-server shutting down"));
    const child = this.child;
    this.child = null;
    if (child && !child.killed) child.kill();
  }

  async ensureReady() {
    if (this.ready && this.child && !this.child.killed) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.connect();
    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  async request<T = unknown>(method: string, params: unknown, timeoutMs = 120_000): Promise<T> {
    await this.ensureReady();
    return this.sendRequest<T>(method, params, timeoutMs);
  }

  private sendRequest<T = unknown>(method: string, params: unknown, timeoutMs = 120_000): Promise<T> {
    if (!this.child || this.child.killed || !this.child.stdin.writable) {
      throw new Error("Codex app-server stdio is not open");
    }
    if (this.pending.size >= maxPendingRequests) {
      throw new Error("too_many_pending_requests");
    }

    const id = this.nextId++;
    const payload = { id, method, params };
    const promise = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer
      });
    });

    this.writeMessage(payload);
    return promise;
  }

  async initialize() {
    await this.sendRequest("initialize", {
      clientInfo: {
        name: "codex-remote-control",
        title: "Codex Remote Control",
        version: "0.1.0"
      },
      capabilities: {
        experimentalApi: true
      }
    });
    this.writeMessage({ method: "initialized" });
  }

  async listThreads(limit: number, cursor?: string) {
    return this.request("thread/list", {
      limit,
      cursor: cursor ?? null,
      sortKey: "updated_at",
      sortDirection: "desc",
      archived: false,
      useStateDbOnly: true
    });
  }

  async readThread(threadId: string) {
    return this.request("thread/read", {
      threadId,
      includeTurns: true
    }, 15_000);
  }

  async resumeThread(threadId: string, mode: SessionPolicyMode = this.policyByThread.get(threadId) ?? "confirm") {
    this.rememberPolicy(threadId, mode);
    return this.request("thread/resume", {
      threadId,
      approvalPolicy: mode === "full-access" ? "never" : "on-request",
      sandbox: mode === "full-access" ? "danger-full-access" : "read-only",
      excludeTurns: false
    });
  }

  async listModels() {
    return this.request("model/list", {} , 15_000);
  }

  /** Persist the policy choice for the next turn without interrupting an active turn. */
  setPolicyMode(threadId: string, mode: SessionPolicyMode) {
    this.rememberPolicy(threadId, mode);
  }

  async forkThread(threadId: string, mode: SessionPolicyMode = this.policyByThread.get(threadId) ?? "confirm", threadSource = "subagent") {
    this.rememberPolicy(threadId, mode);
    return this.request("thread/fork", { threadId, threadSource });
  }

  async startThread(cwd: string, mode: SessionPolicyMode = "confirm", options: CodexRunOptions = {}) {
    await this.ensureModelAvailable(options.model);
    return this.request("thread/start", {
      cwd,
      ...(options.model ? { model: options.model } : {}),
      ...(options.effort ? { effort: options.effort } : {}),
      ...(options.threadSource ? { threadSource: options.threadSource } : {}),
      ...(options.multiAgentMode ? { multiAgentMode: options.multiAgentMode } : {}),
      approvalPolicy: mode === "full-access" ? "never" : "on-request",
      sandboxPolicy: {
        type: mode === "full-access" ? "dangerFullAccess" : "readOnly"
      },
      ephemeral: false
    });
  }

  async startTurn(threadId: string, text: string, attachments: StoredAttachment[] = [], mode?: SessionPolicyMode, options: CodexRunOptions = {}) {
    await this.ensureModelAvailable(options.model);
    const policyMode = mode ?? this.policyByThread.get(threadId) ?? "confirm";
    this.rememberPolicy(threadId, policyMode);
    return this.request("turn/start", {
      threadId,
      ...(options.model ? { model: options.model } : {}),
      ...(options.effort ? { effort: options.effort } : {}),
      ...(options.multiAgentMode ? { multiAgentMode: options.multiAgentMode } : {}),
      input: buildCodexInput(text, attachments),
      approvalPolicy: policyMode === "full-access" ? "never" : "on-request",
      sandboxPolicy: {
        type: policyMode === "full-access" ? "dangerFullAccess" : "readOnly"
      }
    }, 600_000);
  }

  private async ensureModelAvailable(model?: string) {
    if (!model) return;
    const now = Date.now();
    if (!this.modelCache || this.modelCache.expiresAt <= now) {
      const response = await this.listModels();
      const body = response as any;
      const entries = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : Array.isArray(body) ? body : [];
      const ids = new Set<string>();
      for (const entry of entries) {
        const id = typeof entry === "string" ? entry : entry?.id || entry?.model || entry?.slug;
        if (typeof id === "string" && id.length > 0 && entry?.hidden !== true) ids.add(id);
      }
      this.modelCache = { expiresAt: now + 60_000, ids };
    }
    if (!this.modelCache.ids.has(model)) {
      const error = new Error(`model_not_available: ${model}`) as Error & { code?: string };
      error.code = "model_not_available";
      throw error;
    }
  }

  private rememberPolicy(threadId: string, mode: SessionPolicyMode) {
    this.policyByThread.delete(threadId);
    this.policyByThread.set(threadId, mode);
    while (this.policyByThread.size > maxPolicyEntries) {
      const oldest = this.policyByThread.keys().next().value;
      if (typeof oldest !== "string") break;
      this.policyByThread.delete(oldest);
    }
  }

  resolveApproval(requestId: string, decision: "approve" | "deny", threadId?: string, turnId?: string, execpolicyAmendment?: string[]) {
    const pending = this.pendingApprovals.get(requestId);
    if (!pending) return false;
    if (threadId && pending.threadId !== threadId) return false;
    // Approval decisions are turn-scoped. Fail closed when either side is
    // missing the turn id instead of allowing an unbound request to resolve.
    if (!pending.turnId || !turnId || pending.turnId !== turnId) return false;
    clearTimeout(pending.timer);
    this.pendingApprovals.delete(requestId);
    pending.resolve({ decision, execpolicyAmendment });
    return true;
  }

  async steerTurn(threadId: string, expectedTurnId: string, text: string, attachments: StoredAttachment[] = []) {
    return this.request("turn/steer", {
      threadId,
      expectedTurnId,
      input: buildCodexInput(text, attachments),
      responsesapiClientMetadata: null
    }, 600_000);
  }

  async interruptTurn(threadId: string, turnId: string) {
    return this.request("turn/interrupt", { threadId, turnId });
  }

  private async connect() {
    this.ready = false;
    await this.ensureServerProcess();
    await this.initialize();
    this.ready = true;
  }

  private async ensureServerProcess() {
    if (this.child && !this.child.killed) return;
    this.stdoutBuffer = "";
    this.stdoutDecoder = new StringDecoder("utf8");
    const command = resolveCodexCommand(config.codexBin) ?? config.codexBin;
    this.child = spawn(command, ["app-server", "--listen", "stdio://"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: processEnvWithToolPath(),
      shell: shouldUseShell(command)
    });
    const child = this.child;
    child.stdin.on("error", (error) => {
      // A crashed app-server can surface EPIPE asynchronously on stdin;
      // consume it and reject pending RPCs instead of letting it terminate
      // the Gateway process as an unhandled stream error.
      this.ready = false;
      this.rejectAll(error);
      this.emit("log", { stream: "stderr", text: `Codex app-server stdin failed: ${error.message}` });
    });
    child.stdout.on("data", (chunk) => {
      // Readable chunks are Buffers. Decode incrementally so a multi-byte
      // UTF-8 character split across chunks cannot become U+FFFD and corrupt
      // an otherwise valid JSON event.
      this.handleStdoutChunk(this.stdoutDecoder.write(chunk as Buffer));
    });
    child.stderr.on("data", (chunk) => {
      this.emit("log", { stream: "stderr", text: String(chunk) });
    });
    child.on("error", (error) => {
      this.ready = false;
      this.child = null;
      this.rejectAll(error);
      this.emit("log", { stream: "stderr", text: `Failed to start Codex app-server: ${error.message}` });
      this.emit("event", {
        method: "codex/app-server/error",
        params: { message: error.message, command }
      } satisfies CodexEvent);
    });
    child.on("exit", (code, signal) => {
      this.ready = false;
      this.child = null;
      this.rejectAll(new Error(`Codex app-server exited with code ${code ?? "null"} signal ${signal ?? "null"}`));
      this.emit("event", {
        method: "codex/app-server/exited",
        params: { code, signal }
      } satisfies CodexEvent);
    });
  }

  private writeMessage(payload: unknown) {
    if (!this.child || this.child.killed || !this.child.stdin.writable) {
      throw new Error("Codex app-server stdio is not open");
    }
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private handleStdoutChunk(chunk: string) {
    this.stdoutBuffer += chunk;
    if (Buffer.byteLength(this.stdoutBuffer, "utf8") > maxStdoutBufferBytes) {
      this.stdoutBuffer = "";
      const error = new Error("Codex app-server output exceeded the safety limit");
      this.rejectAll(error);
      if (this.child && !this.child.killed) this.child.kill();
      this.emit("event", {
        method: "codex/app-server/output-limit",
        params: { maxBytes: maxStdoutBufferBytes }
      } satisfies CodexEvent);
      return;
    }
    while (true) {
      const newlineIndex = this.stdoutBuffer.indexOf("\n");
      if (newlineIndex < 0) return;
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line) this.handleMessage(line);
    }
  }

  private handleMessage(raw: string) {
    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      this.emit("event", { method: "codex/unparseable", params: { raw } } satisfies CodexEvent);
      return;
    }

    if (typeof message !== "object" || !message) return;
    const record = message as Record<string, unknown>;
    const id = record.id as string | number | undefined;

    if (id !== undefined && this.pending.has(id)) {
      const pending = this.pending.get(id)!;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      const error = messageError(message);
      if (error) pending.reject(error);
      else pending.resolve(record.result ?? record);
      return;
    }

    if (id !== undefined && typeof record.method === "string") {
      void this.handleServerRequest(id, record.method, record.params).catch((error) => {
        this.emit("event", {
          method: "codex/app-server/request-error",
          params: { requestId: id, method: record.method, message: error instanceof Error ? error.message : String(error) }
        } satisfies CodexEvent);
        try {
          this.writeMessage({ id, error: { code: "internal_error", message: "request handling failed" } });
        } catch {
          // The child may have exited between handling and writing the error.
        }
      });
      return;
    }

    if (typeof record.method === "string") {
      this.emit("event", {
        method: record.method,
        params: record.params
      } satisfies CodexEvent);
    }
  }

  private async handleServerRequest(id: string | number, method: string, params: unknown) {
    await audit("codex.server_request", { method, params: summarizeParams(params) });
    const record = params && typeof params === "object" ? params as Record<string, unknown> : {};
    const threadId = typeof record.threadId === "string" ? record.threadId : undefined;
    const mode = threadId ? this.policyByThread.get(threadId) ?? "confirm" : "confirm";
    let result: unknown;
    if (mode === "confirm" && this.isApprovalRequest(method)) {
      if (!threadId) {
        // Approval without a bound thread cannot be safely attributed. Fail
        // closed instead of silently granting command/file execution.
        result = this.approvalResult(method, { decision: "deny" });
      } else {
      const requestId = String(id);
      const turnId = typeof record.turnId === "string" ? record.turnId : undefined;
      await audit("approval.request", { threadId, requestId, requestMethod: method });
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      this.emit("event", {
        method: "gateway/codex/approvalRequested",
        params: { requestId, threadId, turnId, requestMethod: method, expiresAt, params: summarizeParams(params) }
      } satisfies CodexEvent);
      const decision = this.pendingApprovals.size >= maxPendingApprovals
        ? { decision: "deny" as const }
        : await new Promise<ApprovalDecision>((resolve) => {
          const timer = setTimeout(() => {
            this.pendingApprovals.delete(requestId);
            this.emit("event", {
              method: "gateway/codex/approvalExpired",
              params: { requestId, threadId, requestMethod: method, expiresAt }
            } satisfies CodexEvent);
            resolve({ decision: "deny" });
          }, 10 * 60 * 1000);
          this.pendingApprovals.set(requestId, { threadId, turnId, method, resolve, timer });
        });
      result = this.approvalResult(method, decision);
      }
    } else if (method === "item/commandExecution/requestApproval") {
      this.emit("event", {
        method: "gateway/codex/serverRequest",
        params: { backendRequestId: id, requestMethod: method, params: summarizeParams(params) }
      } satisfies CodexEvent);
      result = { decision: "accept" };
    } else if (method === "item/fileChange/requestApproval") {
      result = { decision: "accept" };
    } else if (method === "execCommandApproval") {
      result = { decision: "approved_for_session" };
    } else if (method === "applyPatchApproval") {
      result = { decision: "approved_for_session" };
    } else if (method === "item/tool/requestUserInput") {
      result = { answers: {} };
    } else {
      result = null;
    }

    this.writeMessage({ id, result });
  }

  private isApprovalRequest(method: string) {
    return [
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
      "execCommandApproval",
      "applyPatchApproval",
      "item/tool/requestUserInput"
    ].includes(method);
  }

  private approvalResult(method: string, decision: ApprovalDecision) {
    if (method === "item/tool/requestUserInput") return { answers: decision.decision === "approve" ? {} : null };
    if (decision.decision === "approve" && decision.execpolicyAmendment?.length) {
      return { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: decision.execpolicyAmendment } } };
    }
    if (method === "execCommandApproval" || method === "applyPatchApproval") {
      return { decision: decision.decision === "approve" ? "approved_for_session" : "cancel" };
    }
    return { decision: decision.decision === "approve" ? "accept" : "cancel" };
  }

  private rejectAll(error: Error) {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
    for (const [requestId, pending] of this.pendingApprovals.entries()) {
      clearTimeout(pending.timer);
      pending.resolve({ decision: "deny" });
      this.pendingApprovals.delete(requestId);
    }
  }
}

function summarizeParams(params: unknown) {
  const text = JSON.stringify(params);
  if (!text) return params;
  return text.length > 2000 ? `${text.slice(0, 2000)}...` : params;
}

export const codexBridge = new CodexBridge();
