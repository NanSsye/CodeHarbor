import { spawn } from "node:child_process";
import path from "node:path";
import readline from "node:readline";

const entry = path.join(process.env.APPDATA, "npm", "node_modules", "@openai", "codex", "bin", "codex.js");
const child = spawn(process.execPath, [entry, "app-server", "--listen", "stdio://"], { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] });
const lines = readline.createInterface({ input: child.stdout });
const send = (v) => child.stdin.write(`${JSON.stringify(v)}\n`);
lines.on("line", (line) => {
  if (!line.trim()) return;
  console.log(line);
  try {
    const m = JSON.parse(line);
    if (m.id === 2 && m.result?.thread?.id) {
      const tid = m.result.thread.id;
      globalThis.tid = tid;
      send({ id: 3, method: "turn/start", params: { threadId: tid, input: [{ type: "text", text: "只回复 parent-ok" }], approvalPolicy: "never", sandboxPolicy: { type: "readOnly" } } });
      send({ id: 11, method: "collaborationMode/list", params: {} });
      send({ id: 12, method: "experimentalFeature/list", params: {} });
    }
    if (m.method === "turn/completed" || m.method === "turn/ended") send({ id: 10, method: "thread/fork", params: { threadId: globalThis.tid } });
  } catch {}
});
child.stderr.on("data", (d) => process.stderr.write(d));
send({ id: 1, method: "initialize", params: { clientInfo: { name: "subagent-probe", version: "0.1" }, capabilities: { experimentalApi: true } } });
send({ method: "initialized" });
send({ id: 20, method: "experimentalFeature/enablement/set", params: { featureName: "multi_agent_v2", enabled: true } });
send({ id: 2, method: "thread/start", params: { cwd: process.cwd(), approvalPolicy: "never", sandboxPolicy: { type: "readOnly" }, ephemeral: false, threadSource: "subagent", agentRole: "explorer", agentNickname: "probe-child" } });
setTimeout(() => child.kill(), 10000);
