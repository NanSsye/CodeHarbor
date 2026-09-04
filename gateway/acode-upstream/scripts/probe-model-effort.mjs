import { spawn } from "node:child_process";
import path from "node:path";
import readline from "node:readline";

const entry = path.join(process.env.APPDATA, "npm", "node_modules", "@openai", "codex", "bin", "codex.js");
const child = spawn(process.execPath, [entry, "app-server", "--listen", "stdio://"], {
  cwd: process.cwd(),
  stdio: ["pipe", "pipe", "pipe"]
});
const lines = readline.createInterface({ input: child.stdout });
let settings = null;
let finished = false;

function send(value) {
  child.stdin.write(`${JSON.stringify(value)}\n`);
}

function finish(exitCode = 0) {
  if (finished) return;
  finished = true;
  console.log(JSON.stringify(settings));
  child.kill();
  process.exit(exitCode);
}

lines.on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.id === 10) {
    send({
      id: 11,
      method: "turn/start",
      params: {
        threadId: message.result?.thread?.id,
        input: [{ type: "text", text: "只回复 model-ok，不调用工具。" }],
        model: "gpt-5.6-luna",
        effort: "low",
        approvalPolicy: "never",
        sandboxPolicy: { type: "readOnly" }
      }
    });
  }
  if (message.method === "thread/settings/updated") {
    settings = message.params?.threadSettings ?? null;
    if (settings?.model === "gpt-5.6-luna") setTimeout(() => finish(0), 500);
  }
});

send({
  id: 1,
  method: "initialize",
  params: { clientInfo: { name: "model-effort-test", version: "0.1" }, capabilities: { experimentalApi: true } }
});
send({ method: "initialized" });
send({
  id: 10,
  method: "thread/start",
  params: {
    cwd: process.cwd(),
    model: "gpt-5.6-luna",
    effort: "low",
    approvalPolicy: "never",
    sandboxPolicy: { type: "readOnly" },
    ephemeral: true
  }
});
setTimeout(() => finish(settings ? 0 : 1), 30_000);
