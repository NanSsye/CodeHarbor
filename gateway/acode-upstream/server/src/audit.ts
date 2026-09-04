import { mkdir, appendFile } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";

export type AuditAction =
  | "login.success"
  | "login.failed"
  | "threads.list"
  | "threads.list.degraded"
  | "thread.start"
  | "thread.read"
  | "thread.resume"
  | "thread.policy.update"
  | "thread.fork"
  | "turn.start"
  | "turn.steer"
  | "turn.interrupt"
  | "ws.connect"
  | "ws.disconnect"
  | "codex.server_request"
  | "approval.request"
  | "approval.resolve"
  | "file.download";

export async function audit(action: AuditAction, details: Record<string, unknown> = {}) {
  const entry = {
    ts: new Date().toISOString(),
    action,
    ...details
  };
  await mkdir(config.auditDir, { recursive: true });
  await appendFile(path.join(config.auditDir, "audit.jsonl"), `${JSON.stringify(entry)}\n`, "utf8");
}
