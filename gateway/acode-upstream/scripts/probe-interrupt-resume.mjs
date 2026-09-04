import { spawn } from "node:child_process";
import readline from "node:readline";
import path from "node:path";

const cwd = process.argv[2] ?? process.cwd();
const entry = path.join(process.env.APPDATA, "npm", "node_modules", "@openai", "codex", "bin", "codex.js");
const child = spawn(process.execPath, [entry, "app-server", "--listen", "stdio://"], { cwd, stdio: ["pipe", "pipe", "pipe"] });
const lines = readline.createInterface({ input: child.stdout });
let threadId;
let turnId;
let interrupted = false;
let resumed = false;
const events = [];
let finished = false;

const send = (value) => child.stdin.write(`${JSON.stringify(value)}\n`);
const finish = (code = 0) => {
  if (finished) return;
  finished = true;
  console.log(JSON.stringify({ threadId, turnId, interrupted, resumed, events }));
  child.kill();
  process.exit(code);
};

lines.on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.method) events.push(message.method);
  if (message.id === 10) {
    threadId = message.result?.thread?.id;
    send({ id: 11, method: "turn/start", params: {
      threadId,
      input: [{ type: "text", text: "请持续输出一段很长的中文说明，至少持续 20 秒，不要调用工具。" }],
      approvalPolicy: "never", sandboxPolicy: { type: "readOnly" }
    }});
  }
  if (message.method === "turn/started" && !interrupted) {
    turnId = message.params?.turn?.id;
    interrupted = true;
    send({ id: 12, method: "turn/interrupt", params: { threadId, turnId } });
  }
  if (message.id === 12 && interrupted && !resumed) {
    send({ id: 13, method: "thread/resume", params: { threadId, approvalPolicy: "never", sandbox: "read-only", excludeTurns: false } });
  }
  if (message.id === 13 && !resumed) {
    resumed = true;
    send({ id: 14, method: "turn/start", params: { threadId, input: [{ type: "text", text: "只回复 resumed-ok，不调用工具。" }], approvalPolicy: "never", sandboxPolicy: { type: "readOnly" } } });
  }
  if (message.method === "turn/completed" && resumed) setTimeout(() => finish(), 500);
});

send({ id: 1, method: "initialize", params: { clientInfo: { name: "interrupt-resume-test", version: "0.1" }, capabilities: { experimentalApi: true } } });
send({ method: "initialized" });
send({ id: 10, method: "thread/start", params: { cwd, approvalPolicy: "never", sandboxPolicy: { type: "readOnly" }, ephemeral: true } });
setTimeout(() => finish(1), 60_000);
