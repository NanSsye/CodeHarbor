import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import WebSocket from "ws";

const root = process.cwd();
const port = 8902;
const work = path.join(root, ".tmp-amend-work");
fs.mkdirSync(work, { recursive: true });
const env = {
  ...process.env,
  HOST: "127.0.0.1",
  PORT: String(port),
  PUBLIC_ORIGIN: `http://127.0.0.1:${port}`,
  ADMIN_TOKEN: "test-admin-token-1234567890",
  SESSION_SECRET: "test-session-secret-1234567890",
  GATEWAY_DATA_DIR: path.join(root, ".tmp-amend-data"),
  AUDIT_DIR: path.join(root, ".tmp-amend-audit"),
  CODEX_BIN: path.join(process.env.APPDATA, "npm", "codex.cmd"),
  CODEX_HOME: path.join(process.env.USERPROFILE, ".codex"),
  GATEWAY_ALLOWED_PATHS: work,
  ACODE_CONFIG: path.join(root, ".missing-amend-config")
};
const server = spawn(process.execPath, ["server/dist/main.js"], { cwd: root, env, stdio: ["ignore", "ignore", "ignore"] });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  for (let i = 0; i < 50; i += 1) {
    try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) break; } catch {}
    await sleep(250);
  }
  const loginResponse = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: env.ADMIN_TOKEN })
  });
  const token = (await loginResponse.json()).token;
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`);
  const result = await new Promise((resolve) => {
    let sessionId; let finished = false;
    const details = {};
    const timer = setTimeout(() => resolve({ timeout: true }), 70_000);
    const done = (value) => { if (finished) return; finished = true; clearTimeout(timer); resolve(value); };
    socket.on("message", async (raw) => {
      let message; try { message = JSON.parse(raw.toString()); } catch { return; }
      if (message.type === "approval-requested") {
        const amendment = message.payload?.params?.proposedExecpolicyAmendment ?? [];
        const turnId = message.payload?.params?.turnId;
        const response = await fetch(`http://127.0.0.1:${port}/sessions/${message.sessionId}/approvals/${message.requestId}`, {
          method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ decision: "approve", requestId: message.requestId, turnId, execpolicyAmendment: amendment })
        });
        details.approvalStatus = response.status;
        details.approvalBody = await response.json();
        details.amendment = amendment;
      }
      if (message.type === "session-finished" && message.sessionId === sessionId) done({ ...details, finished: true });
    });
    socket.on("open", async () => {
      const response = await fetch(`http://127.0.0.1:${port}/sessions`, {
        method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ workspacePath: work, prompt: "请在当前工作目录创建 amend.txt，内容只写 amendment-ok。必须实际执行文件创建。", sessionPolicyMode: "confirm" })
      });
      const body = await response.json(); sessionId = body.session?.id;
    });
  });
  result.file = fs.existsSync(path.join(work, "amend.txt"));
  console.log(JSON.stringify(result)); socket.close(); server.kill();
}

try { await main(); } finally {
  for (const name of [".tmp-amend-work", ".tmp-amend-data", ".tmp-amend-audit"]) {
    const target = path.join(root, name); if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
  }
}
