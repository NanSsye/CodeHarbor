import type {
  ApprovalRequest,
  EventMessage,
  Session,
  ToolCommandExecution,
  ToolFileChange,
  ToolItem,
  TurnMessage
} from "./types";

const tryParseJson = (value: any) => {
  if (!value || typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

type EventRecord = Record<string, any>;

function asRecord(value: unknown): EventRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as EventRecord;
}

/**
 * Resolve a timeline owner from direct Gateway events and nested transport
 * envelopes. Unknown events intentionally return undefined so callers can
 * apply a strict session filter instead of leaking global events.
 */
export function getEventSessionId(value: unknown, depth = 0): string | undefined {
  if (depth > 3) return undefined;
  const record = asRecord(value);
  if (!record) return undefined;

  for (const key of ["sessionId", "threadId"]) {
    const id = record[key];
    if (typeof id === "string" && id.length > 0) return id;
  }

  for (const key of ["payload", "params"]) {
    const nested = getEventSessionId(record[key], depth + 1);
    if (nested) return nested;
  }
  return undefined;
}

/**
 * Gateway approval notifications have had two wire shapes in the wild:
 * fields either live directly on `payload`, or inside the Codex envelope at
 * `payload.params.params`.  Keep the UI tolerant of both shapes while the
 * protocol migration is in progress.  The lookup is intentionally bounded to
 * the envelope levels we own, rather than recursively walking arbitrary user
 * data.
 */
function approvalEnvelope(payload: EventRecord) {
  const nested = asRecord(payload.params) || asRecord(tryParseJson(payload.params));
  const inner = nested
    ? asRecord(nested.params) || asRecord(tryParseJson(nested.params))
    : undefined;
  const sources = [payload, nested, inner].filter((source): source is EventRecord => Boolean(source));
  const read = (key: string) => sources.find((source) => source[key] !== undefined)?.[key];
  return {
    read,
    params: nested,
    inner,
    requestId: read("requestId"),
    sessionId: read("sessionId") || read("threadId"),
    turnId: read("turnId"),
    itemId: read("itemId"),
    requestMethod: read("requestMethod"),
    summary: read("summary"),
    command: read("command"),
    cwd: read("cwd"),
    expiresAt: read("expiresAt"),
    amendment: read("proposedExecpolicyAmendment") ?? read("execpolicyAmendment")
  };
}

function normalizedApprovalDecision(value: unknown): "approve" | "deny" {
  const decision = typeof value === "string" ? value.toLowerCase() : "";
  return ["approve", "approved", "accept", "accepted", "allow", "allowed", "approved_for_session"].includes(decision)
    ? "approve"
    : "deny";
}

export function createEmptyTurn(turnId: string, sessionId: string, prompt = ""): TurnMessage {
  return {
    turnId,
    sessionId,
    userPrompt: prompt,
    userAttachments: [],
    assistantStatus: "idle",
    reasoning: "",
    reasoningSummary: [],
    reasoningCompleted: false,
    text: "",
    tools: [],
    diffs: [],
    approvals: [],
    startedAt: new Date().toISOString()
  };
}

export function aggregateEventsToTurns(events: EventMessage[], session?: Session): TurnMessage[] {
  let turns: TurnMessage[] = [];

  const sessionPrompt = (session as any)?.prompt;
  const hasUserInputEvent = events.some((event) =>
    event.type === "session-user-input" ||
    (event.type === "session-output" && event.payload?.eventType === "item/completed" && event.payload?.jsonPayload?.item?.type === "userMessage")
  );
  if (session && sessionPrompt && !hasUserInputEvent) {
    const initialTurn = createEmptyTurn("initial-turn", session.id, sessionPrompt);
    initialTurn.userTime = session.createdAt || session.startedAt;
    initialTurn.assistantStatus = session.status === "running" ? "streaming" : (session.status === "cancelled" ? "cancelled" : "completed");
    turns.push(initialTurn);
  }

  for (const event of events) {
    turns = applyLiveEventToTurns(turns, event, session);
  }

  return turns;
}

export function applyLiveEventToTurns(
  currentTurns: TurnMessage[],
  event: EventMessage,
  session?: Session
): TurnMessage[] {
  // Clone nested state before applying a streaming event. Mutating objects
  // from the previous React state leaves memoized rows with stale references,
  // making output appear only after a refresh or session switch.
  const turns: TurnMessage[] = currentTurns.map((turn) => ({
    ...turn,
    userAttachments: turn.userAttachments ? [...turn.userAttachments] : [],
    reasoningSummary: turn.reasoningSummary ? [...turn.reasoningSummary] : [],
    tools: turn.tools.map((tool) => ({ ...tool })),
    diffs: [...turn.diffs],
    approvals: turn.approvals.map((approval) => ({ ...approval }))
  }));
  const payload = event.payload || {};
  const payloadParams = asRecord(payload.params) || asRecord(tryParseJson(payload.params));
  const payloadInnerParams = payloadParams
    ? asRecord(payloadParams.params) || asRecord(tryParseJson(payloadParams.params))
    : undefined;
  const currentSessionId = event.sessionId || payload.sessionId || payload.threadId ||
    payloadParams?.sessionId || payloadParams?.threadId || payloadInnerParams?.sessionId ||
    payloadInnerParams?.threadId || session?.id || "";

  const getOrCreateTurn = (targetTurnId?: string, fallbackPrompt = ""): TurnMessage => {
    const tid = targetTurnId || (turns.length > 0 ? turns[turns.length - 1].turnId : `turn-${Date.now()}`);

    // If we only have an initial placeholder turn without outputs, adopt the real turnId
    if (
      turns.length === 1 &&
      (turns[0].turnId === "turn-0" || turns[0].turnId === "initial-turn") &&
      !turns[0].text &&
      turns[0].tools.length === 0
    ) {
      turns[0].turnId = tid;
      if (fallbackPrompt && !turns[0].userPrompt) turns[0].userPrompt = fallbackPrompt;
      return turns[0];
    }

    const existingIndex = turns.findIndex((t) => t.turnId === tid);
    if (existingIndex >= 0) {
      return turns[existingIndex];
    }

    // The Gateway accepts a prompt before Codex assigns its real turnId.  The
    // optimistic `session-user-input` therefore has a temporary id, while the
    // first Codex event carries the real id.  Reuse that empty in-flight turn
    // instead of creating a second row for the same user message.
    let pendingIndex = -1;
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      const candidate = turns[index];
      if (
        candidate.sessionId === currentSessionId &&
        (candidate.assistantStatus === "streaming" || candidate.assistantStatus === "waiting-approval") &&
        !candidate.text &&
        candidate.tools.length === 0 &&
        (!!candidate.userPrompt || !!fallbackPrompt)
      ) {
        pendingIndex = index;
        break;
      }
    }
    if (pendingIndex >= 0) {
      const pending = turns[pendingIndex];
      pending.turnId = tid;
      if (fallbackPrompt && !pending.userPrompt) pending.userPrompt = fallbackPrompt;
      return pending;
    }

    const newTurn = createEmptyTurn(tid, currentSessionId, fallbackPrompt);
    turns.push(newTurn);
    return newTurn;
  };

  switch (event.type) {
    case "session-started": {
      const sess = payload.session || {};
      if (sess.prompt && turns.length === 0) {
        const turn = getOrCreateTurn("turn-0", sess.prompt);
        turn.userTime = event.timestamp || sess.createdAt;
        turn.assistantStatus = "streaming";
      }
      break;
    }

    case "session-user-input": {
      const clientRequestId = typeof payload.clientRequestId === "string" ? payload.clientRequestId : undefined;
      const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
      const duplicate = turns.find((candidate) =>
        (clientRequestId && candidate.clientRequestId === clientRequestId) ||
        (!clientRequestId && candidate.userPrompt === prompt && candidate.assistantStatus === "streaming" && candidate.sessionId === currentSessionId)
      );
      if (duplicate) {
        if (clientRequestId) duplicate.clientRequestId = clientRequestId;
        if (!duplicate.userPrompt && prompt) duplicate.userPrompt = prompt;
        if (Array.isArray(payload.attachments) && (duplicate.userAttachments?.length ?? 0) === 0) duplicate.userAttachments = payload.attachments;
        break;
      }
      const turnId = payload.turnId || `turn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const turn = createEmptyTurn(turnId, currentSessionId, prompt);
      turn.clientRequestId = clientRequestId;
      turn.userAttachments = payload.attachments || [];
      turn.userTime = event.timestamp || new Date().toISOString();
      turn.isInterjection = payload.kind === "interjection";
      turn.assistantStatus = "streaming";
      turns.push(turn);
      break;
    }

    case "session-status": {
      const st = payload.status || payload.turn?.status;
      if (turns.length > 0) {
        const last = turns[turns.length - 1];
        if (st === "running") {
          if (last.assistantStatus === "idle") last.assistantStatus = "streaming";
        } else if (st === "waiting-approval") {
          last.assistantStatus = "waiting-approval";
        } else if (st === "completed") {
          last.assistantStatus = "completed";
          last.completedAt = event.timestamp || new Date().toISOString();
        } else if (st === "cancelled") {
          last.assistantStatus = "cancelled";
          last.completedAt = event.timestamp || new Date().toISOString();
        } else if (st === "failed") {
          last.assistantStatus = "failed";
          last.completedAt = event.timestamp || new Date().toISOString();
        }
      }
      break;
    }

    case "session-finished": {
      if (turns.length > 0) {
        const last = turns[turns.length - 1];
        const status = payload.turn?.status || payload.status;
        last.assistantStatus = status === "cancelled" ? "cancelled" : (status === "failed" ? "failed" : "completed");
        last.completedAt = event.timestamp || new Date().toISOString();

        if (payload.turn?.items && Array.isArray(payload.turn.items)) {
          for (const item of payload.turn.items) {
            if (item.type === "agentMessage" && item.text && !last.text) {
              last.text = item.text;
            }
          }
        }
      }
      break;
    }

    case "approval-requested": {
      const approval = approvalEnvelope(payload);
      const turnId = typeof approval.turnId === "string" ? approval.turnId : undefined;
      const turn = getOrCreateTurn(turnId);
      const reqId = event.requestId || (typeof approval.requestId === "string" ? approval.requestId : String(Date.now()));
      const existingReq = turn.approvals.find((a) => a.requestId === reqId);
      const amendmentValue = typeof approval.amendment === "string" ? tryParseJson(approval.amendment) : approval.amendment;
      const amendment = Array.isArray(amendmentValue)
        ? amendmentValue.filter((rule): rule is string => typeof rule === "string")
        : undefined;

      const approvalReq: ApprovalRequest = {
        requestId: reqId,
        sessionId: currentSessionId,
        requestMethod: typeof approval.requestMethod === "string" ? approval.requestMethod : "item/commandExecution/requestApproval",
        turnId,
        itemId: typeof approval.itemId === "string" ? approval.itemId : undefined,
        summary: typeof approval.summary === "string" ? approval.summary : undefined,
        command: typeof approval.command === "string" ? approval.command : undefined,
        cwd: typeof approval.cwd === "string" ? approval.cwd : undefined,
        expiresAt: typeof approval.expiresAt === "string" ? approval.expiresAt : undefined,
        proposedExecpolicyAmendment: amendment,
        status: "pending",
        createdAt: event.timestamp || new Date().toISOString(),
        rawParams: approval.params || payload
      };

      if (!existingReq) {
        turn.approvals.push(approvalReq);
      } else {
        Object.assign(existingReq, approvalReq);
      }
      turn.assistantStatus = "waiting-approval";
      break;
    }

    case "approval-resolved": {
      const approval = approvalEnvelope(payload);
      const approvalRecord = asRecord(payload.approval);
      const reqId = typeof approval.requestId === "string"
        ? approval.requestId
        : typeof approvalRecord?.requestId === "string"
        ? approvalRecord.requestId
        : typeof approvalRecord?.id === "string"
        ? approvalRecord.id
        : undefined;
      if (!reqId) break;
      const decision = normalizedApprovalDecision(payload.decision ?? approval.read("decision") ?? approvalRecord?.decision);
      for (const turn of turns) {
        const req = turn.approvals.find((a) => a.requestId === reqId);
        if (req) {
          req.status = decision === "approve" ? "approved" : "denied";
          req.decision = decision;
          req.resolvedAt = event.timestamp || new Date().toISOString();
          if (turn.assistantStatus === "waiting-approval") {
            turn.assistantStatus = "streaming";
          }
        }
      }
      break;
    }

    case "approval-expired": {
      const approval = approvalEnvelope(payload);
      const reqId = event.requestId || (typeof approval.requestId === "string" ? approval.requestId : undefined);
      if (typeof reqId !== "string") break;
      for (const turn of turns) {
        const req = turn.approvals.find((a) => a.requestId === reqId);
        if (req) {
          req.status = "expired";
          req.resolvedAt = event.timestamp || new Date().toISOString();
          if (turn.assistantStatus === "waiting-approval") turn.assistantStatus = "streaming";
        }
      }
      break;
    }

    case "subagent-started": {
      const turn = getOrCreateTurn(payload.turnId);
      const activity = payload.activity || {};
      const agentThreadId = activity.agentThreadId || payload.threadId;
      const existing = turn.tools.find((tool) => tool.type === "subAgentActivity" && tool.agentThreadId === agentThreadId);
      if (existing && existing.type === "subAgentActivity") {
        existing.agentPath = activity.agentPath || existing.agentPath;
        existing.kind = "started";
        existing.status = "running";
      } else {
        turn.tools.push({
          type: "subAgentActivity",
          agentThreadId,
          agentPath: activity.agentPath,
          kind: "started",
          status: "running"
        });
      }
      break;
    }

    case "subagent-tool": {
      const turn = getOrCreateTurn(payload.turnId);
      const toolCall = payload.toolCall || {};
      const agentThreadId = toolCall.senderThreadId || payload.threadId;
      const toolCallId = toolCall.id || toolCall.callId;
      const existing = turn.tools.find((tool) => tool.type === "subAgentActivity" && tool.agentThreadId === agentThreadId && toolCallId && (tool.toolCall?.id === toolCallId || tool.toolCall?.callId === toolCallId));
      if (existing && existing.type === "subAgentActivity") {
        existing.toolCall = toolCall;
        existing.status = toolCall.status || existing.status;
      } else {
        turn.tools.push({
          type: "subAgentActivity",
          agentThreadId,
          kind: "toolCall",
          status: "running",
          toolCall
        });
      }
      break;
    }

    case "subagent-finished": {
      const turn = getOrCreateTurn(payload.turnId);
      const childThreadId = payload.childThreadId || payload.activity?.agentThreadId;
      for (const t of turn.tools) {
        if (t.type === "subAgentActivity" && t.agentThreadId === childThreadId) {
          t.kind = "completed";
          t.status = payload.status || "completed";
        }
      }
      break;
    }

    case "session-output": {
      const turn = getOrCreateTurn(payload.turnId);
      const eventType = payload.eventType;
      const jsonPayload = payload.jsonPayload || tryParseJson(payload.chunk) || {};

      if (eventType === "item/agentMessage/delta") {
        if (typeof payload.chunk === "string") {
          turn.text += payload.chunk;
          turn.assistantStatus = "streaming";
        }
      } else if (eventType === "item/commandExecution/outputDelta") {
        const chunk = typeof payload.chunk === "string" ? payload.chunk : "";
        const itemId = typeof payload.itemId === "string" ? payload.itemId : typeof jsonPayload.itemId === "string" ? jsonPayload.itemId : undefined;
        let lastCmd = itemId
          ? turn.tools.find((t): t is ToolCommandExecution => t.type === "commandExecution" && t.id === itemId)
          : undefined;
        if (!lastCmd) lastCmd = [...turn.tools].reverse().find((t): t is ToolCommandExecution => t.type === "commandExecution" && t.status === "running");
        if (!lastCmd) {
          lastCmd = {
            type: "commandExecution",
            id: typeof payload.itemId === "string" ? payload.itemId : (typeof jsonPayload.item?.id === "string" ? jsonPayload.item.id : `cmd-${Date.now()}`),
            command: "正在执行命令...",
            aggregatedOutput: chunk,
            status: "running"
          };
          turn.tools.push(lastCmd);
        } else {
          lastCmd.aggregatedOutput = (lastCmd.aggregatedOutput || "") + chunk;
          lastCmd.status = "running";
        }
      } else if (eventType === "item/completed") {
        const item = jsonPayload.item || {};

        if (item.type === "userMessage") {
          const userText = Array.isArray(item.content)
            ? item.content
                .map((c: any) => (typeof c === "string" ? c : c?.text || ""))
                .filter(Boolean)
                .join("\n")
            : typeof item.text === "string"
            ? item.text
            : "";
          if (userText && !turn.userPrompt) {
            turn.userPrompt = userText;
          }
        } else if (item.type === "reasoning") {
          turn.reasoningCompleted = true;
          if (Array.isArray(item.summary)) {
            turn.reasoningSummary = item.summary.map((s: any) => typeof s === "string" ? s : s?.text || "").filter(Boolean);
          }
          if (Array.isArray(item.content)) {
            const contentText = item.content.map((c: any) => typeof c === "string" ? c : c?.text || "").filter(Boolean).join("\n");
            if (contentText) turn.reasoning = contentText;
          }
        } else if (item.type === "commandExecution") {
          const existing = turn.tools.find((t): t is ToolCommandExecution => t.type === "commandExecution" && t.id === item.id)
            ?? (!item.id ? [...turn.tools].reverse().find((t): t is ToolCommandExecution => t.type === "commandExecution" && t.status === "running") : undefined);
          if (existing) {
            existing.command = item.command || existing.command;
            existing.cwd = item.cwd || existing.cwd;
            existing.aggregatedOutput = item.aggregatedOutput ?? existing.aggregatedOutput;
            existing.exitCode = item.exitCode;
            existing.status = item.status || (item.exitCode === 0 ? "completed" : "failed");
            existing.durationMs = item.durationMs;
          } else {
            turn.tools.push({
              type: "commandExecution",
              id: item.id || `cmd-${Date.now()}`,
              command: item.command || "",
              cwd: item.cwd,
              aggregatedOutput: item.aggregatedOutput || "",
              exitCode: item.exitCode,
              status: item.status || (item.exitCode === 0 ? "completed" : "failed"),
              durationMs: item.durationMs
            });
          }
        } else if (item.type === "fileChange") {
          if (Array.isArray(item.changes)) {
            for (const [changeIndex, ch] of item.changes.entries()) {
              const id = `${item.id || `file-${Date.now()}`}:${changeIndex}`;
              const existing = turn.tools.find((tool) => tool.type === "fileChange" && tool.id === id);
              const next = {
                type: "fileChange" as const,
                id,
                path: ch.path || "",
                kind: typeof ch.kind === "object" ? ch.kind?.type || "modify" : (ch.kind || "modify"),
                diff: ch.diff || "",
                status: item.status || "completed"
              };
              if (existing && existing.type === "fileChange") Object.assign(existing, next);
              else turn.tools.push(next);
            }
          }
        } else if (item.type === "agentMessage") {
          if (item.text && !turn.text) {
            turn.text = item.text;
          }
        }
      } else if (eventType === "turn/diff/updated") {
        const diffText = jsonPayload.diff;
        if (typeof diffText === "string" && diffText.trim() && !turn.diffs.includes(diffText)) {
          turn.diffs.push(diffText);
        }
      } else if (eventType === "thread/tokenUsage/updated") {
        if (jsonPayload.tokenUsage) {
          turn.tokenUsage = {
            totalTokens: jsonPayload.tokenUsage.total?.totalTokens,
            inputTokens: jsonPayload.tokenUsage.total?.inputTokens,
            outputTokens: jsonPayload.tokenUsage.total?.outputTokens,
            reasoningOutputTokens: jsonPayload.tokenUsage.total?.reasoningOutputTokens
          };
        }
      }
      break;
    }
  }

  return turns;
}
