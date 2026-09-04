import { spawn } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
const entry = path.join(process.env.APPDATA, "npm", "node_modules", "@openai", "codex", "bin", "codex.js");
const child = spawn(process.execPath, [entry, "app-server", "--listen", "stdio://"], { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] });
const lines = readline.createInterface({ input: child.stdout });
const send = (v) => child.stdin.write(`${JSON.stringify(v)}\n`);
let tid;
lines.on("line", (line) => {
  if (!line.trim()) return;
  try {
    const m = JSON.parse(line);
    if (m.id === 2) {
      tid = m.result?.thread?.id;
      send({ id: 3, method: "turn/start", params: { threadId: tid, input: [{ type: "text", text: "请明确委派一个子代理执行一个独立子任务：只回复 child-ok。等待子代理完成后再回复 parent-ok。" }], approvalPolicy: "never", sandboxPolicy: { type: "readOnly" }, collaborationMode: { mode: "default" } } });
    }
    if (typeof m.method === "string" && (m.method.toLowerCase().includes("agent") || m.method.toLowerCase().includes("collab") || m.method.includes("thread/started"))) console.log(line);
    if (m.method === "turn/completed") setTimeout(() => child.kill(), 500);
  } catch {}
});
child.stderr.on("data", (d) => process.stderr.write(d));
send({ id: 1, method: "initialize", params: { clientInfo: { name: "subagent-turn-probe", version: "0.1" }, capabilities: { experimentalApi: true } } });
send({ method: "initialized" });
send({ id: 2, method: "thread/start", params: { cwd: process.cwd(), approvalPolicy: "never", sandboxPolicy: { type: "readOnly" }, ephemeral: true, multiAgentMode: "v2" } });
setTimeout(() => child.kill(), 120000);
