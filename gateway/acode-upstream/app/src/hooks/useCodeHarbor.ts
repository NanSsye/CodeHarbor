import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { aggregateEventsToTurns, applyLiveEventToTurns } from "../aggregator";
import type {
  Attachment,
  Device,
  EventMessage,
  Session,
  ModelOption,
  TurnMessage
} from "../types";
import { base64ToBytes, base64Utf8, cfg, utf8Base64 } from "../utils";

const TOKEN_KEY = "codeharbor.sessionToken";
const USER_KEY = "codeharbor.username";
const CURSORS_KEY = "codeharbor.eventCursors";
const TOKEN_REFRESH_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

function normalizeModelOptions(body: any): ModelOption[] {
  const list = Array.isArray(body?.models) ? body.models : Array.isArray(body) ? body : [];
  return list.map((item: any) => {
    if (typeof item === "object" && item?.hidden === true) return null;
    const id = typeof item === "string" ? item : item?.id || item?.model || item?.slug;
    return id ? { id: String(id), name: item?.name, model: item?.model, supportedReasoningEfforts: item?.supportedReasoningEfforts } : null;
  }).filter((item: ModelOption | null): item is ModelOption => item !== null);
}

function tokenExpiryMs(token: string) {
  try {
    const payload = token.split(".", 1)[0];
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const decoded = atob(base64.padEnd(base64.length + ((4 - base64.length % 4) % 4), "="));
    try {
      const structured = JSON.parse(decoded) as { e?: unknown };
      if (typeof structured.e === "string") {
        const structuredExpiry = Date.parse(structured.e);
        if (Number.isFinite(structuredExpiry)) return structuredExpiry;
      }
    } catch {
      // Fall through to the legacy user|expiry payload format.
    }
    const separator = decoded.lastIndexOf("|");
    if (separator < 1) return null;
    const expiry = Date.parse(decoded.slice(separator + 1));
    return Number.isFinite(expiry) ? expiry : null;
  } catch {
    return null;
  }
}

export function useCodeHarbor() {
  const [user, setUser] = useState(() => {
    const saved = localStorage.getItem(USER_KEY)?.trim() || "";
    // Older builds prefilled the fixed migration account. Do not carry that
    // value into the account form; users must explicitly enter their account.
    if (saved.toLowerCase() === "admin") {
      localStorage.removeItem(USER_KEY);
      return "";
    }
    return saved;
  });
  const [password, setPassword] = useState("");
  // Account authentication is cookie-backed. Keep the signed token only in
  // memory for the WebSocket subprotocol; migrate any legacy localStorage
  // token once, then remove it from persistent browser storage.
  const [token, setToken] = useState("");

  const [devices, setDevices] = useState<Device[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>("");

  const [sessions, setSessions] = useState<Session[]>([]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string>("");

  const [connectionStatus, setConnectionStatus] = useState<"已连接" | "连接中" | "已断开" | "重连中">("已断开");
  const [error, setError] = useState<string>("");

  const [rawEvents, setRawEvents] = useState<EventMessage[]>([]);
  const [turns, setTurns] = useState<TurnMessage[]>([]);

  // Persistent cursors for resume
  const cursorsRef = useRef<Record<string, number>>({});
  useEffect(() => {
    try {
      const saved = localStorage.getItem(CURSORS_KEY);
      if (saved) {
        const parsed: unknown = JSON.parse(saved);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          const entries = Object.entries(parsed as Record<string, unknown>)
            .filter(([sessionId, value]) => sessionId.length <= 256 && typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
            .slice(-8_000);
          cursorsRef.current = Object.fromEntries(entries) as Record<string, number>;
        }
      }
    } catch {}
  }, []);

  const socketRef = useRef<WebSocket | null>(null);
  const activeTokenRef = useRef(token);
  activeTokenRef.current = token;
  const reconnectTimerRef = useRef<number | null>(null);
  const heartbeatTimerRef = useRef<number | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const resumeAttemptsRef = useRef(0);
  const liveRevisionRef = useRef(0);
  const seenEventKeysRef = useRef<Set<string>>(new Set());
  const gapRecoveryRef = useRef(new Map<string, { expectedSeq: number; attempt: number; timer: number }>());
  const loadSessionEventsRef = useRef<((sessionId: string, token: string) => Promise<void>) | null>(null);

  // Pending RPC promises for gateway-proxy
  const pendingRequests = useRef<
    Map<
      string,
      {
        resolve: (val: any) => void;
        reject: (err: any) => void;
        timer: number;
        socket: WebSocket;
        raw?: boolean;
      }
    >
  >(new Map());

  const selectedSession = useMemo(
    () => sessions.find((s) => s.id === selectedSessionId),
    [sessions, selectedSessionId]
  );

  const selectedDevice = useMemo(
    () => devices.find((d) => d.deviceId === selectedDeviceId),
    [devices, selectedDeviceId]
  );

  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  const selectedSessionIdRef = useRef(selectedSessionId);
  const selectedSessionRef = useRef(selectedSession);
  const selectedDeviceIdRef = useRef(selectedDeviceId);
  selectedSessionIdRef.current = selectedSessionId;
  selectedSessionRef.current = selectedSession;
  selectedDeviceIdRef.current = selectedDeviceId;

  const isStreaming = useMemo(() => {
    if (!turns.length) return selectedSession?.status === "running";
    const lastTurn = turns[turns.length - 1];
    return lastTurn.assistantStatus === "streaming" || selectedSession?.status === "running";
  }, [turns, selectedSession]);

  const saveCursor = useCallback((sessionId: string, seq: number) => {
    if (!sessionId || !seq) return;
    const current = cursorsRef.current[sessionId] || 0;
    if (seq > current) {
      cursorsRef.current[sessionId] = seq;
      // Keep the browser's durable resume map bounded. Old sessions remain
      // recoverable from the authoritative session list/history APIs, while a
      // compromised or long-lived account cannot exhaust localStorage.
      const cursorEntries = Object.entries(cursorsRef.current);
      if (cursorEntries.length > 10_000) {
        const keep = cursorEntries.slice(-8_000);
        cursorsRef.current = Object.fromEntries(keep);
      }
      try {
        localStorage.setItem(CURSORS_KEY, JSON.stringify(cursorsRef.current));
      } catch {}
    }
  }, []);

  const resetCursor = useCallback((sessionId: string, seq: number) => {
    if (!sessionId || !Number.isSafeInteger(seq) || seq < 0) return;
    cursorsRef.current[sessionId] = seq;
    try {
      localStorage.setItem(CURSORS_KEY, JSON.stringify(cursorsRef.current));
    } catch {}
  }, []);

  const scheduleGapRecovery = useCallback((sessionId: string, t: string, expectedSeq: number) => {
    const current = gapRecoveryRef.current.get(sessionId);
    if (current?.expectedSeq && current.expectedSeq >= expectedSeq) return;
    if (current?.timer) window.clearTimeout(current.timer);
    const attempt = Math.min((current?.attempt ?? 0) + 1, 5);
    const delay = Math.min(2_000, 100 * 2 ** (attempt - 1));
    const timer = window.setTimeout(() => {
      const pending = gapRecoveryRef.current.get(sessionId);
      if (pending) gapRecoveryRef.current.set(sessionId, { ...pending, timer: 0 });
      void loadSessionEventsRef.current?.(sessionId, t);
    }, delay);
    gapRecoveryRef.current.set(sessionId, { expectedSeq, attempt, timer });
  }, []);

  // Proxy request through Cloud Relay WebSocket to target device's Gateway
  const sendGatewayProxy = useCallback(
    (method: string, path: string, body?: any, options?: { raw?: boolean }): Promise<any> => {
      return new Promise((resolve, reject) => {
        const ws = socketRef.current;
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          return reject(new Error("实时连接未就绪"));
        }
        const deviceId = selectedDeviceIdRef.current;
        if (!deviceId) {
          return reject(new Error("未选择目标设备"));
        }

        const requestId = crypto.randomUUID();
        const timer = window.setTimeout(() => {
          pendingRequests.current.delete(requestId);
          reject(new Error(`请求超时 (${method} ${path})`));
        }, 30000);

        pendingRequests.current.set(requestId, { resolve, reject, timer, socket: ws, raw: options?.raw });

        const payload: any = {
          type: "gateway-proxy",
          deviceId,
          requestId,
          method,
          path,
          headers: { "content-type": "application/json" }
        };

        if (body !== undefined) {
          payload.bodyBase64 = base64Utf8(typeof body === "string" ? body : JSON.stringify(body));
        }

        try {
          ws.send(JSON.stringify(payload));
        } catch (error) {
          clearTimeout(timer);
          pendingRequests.current.delete(requestId);
          reject(error instanceof Error ? error : new Error("发送请求失败"));
        }
      });
    },
    []
  );

  // Load devices and sessions via HTTP
  const loadData = useCallback(
    async (t: string) => {
      if (!t) return;
      try {
        const h = { Authorization: `Bearer ${t}` };
        const [devRes, sessRes] = await Promise.all([
          fetch(`${cfg().api}/devices`, { headers: h, credentials: "include" }).catch(() => null),
          fetch(`${cfg().api}/sessions`, { headers: h, credentials: "include" }).catch(() => null)
        ]);

        if (devRes?.status === 401 || sessRes?.status === 401) {
          localStorage.removeItem(TOKEN_KEY);
          setToken("");
          setSelectedDeviceId("");
          setSelectedSessionId("");
          throw new Error("登录已过期，请重新登录");
        }

        if (devRes?.ok) {
          const dj = await devRes.json();
          const devList: Device[] = dj.devices || [];
          setDevices(devList);
          if (!selectedDeviceId && devList.length > 0) {
            const onlineDev = devList.find((d) => d.connected) || devList[0];
            setSelectedDeviceId(onlineDev.deviceId);
          }
        }

        if (sessRes?.ok) {
          const sj = await sessRes.json();
          const sessList: Session[] = sj.sessions || [];
          setSessions(sessList);
          if (!selectedSessionId && sessList.length > 0) {
            setSelectedSessionId(sessList[0].id);
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "加载数据失败");
      }
    },
    [selectedDeviceId, selectedSessionId]
  );

  // Load history events for the selected session
  const loadSessionEvents = useCallback(
    async (sessId: string, t: string) => {
      if (!sessId || !t) return;
      const revisionAtStart = liveRevisionRef.current;
      try {
        const list: EventMessage[] = [];
        let after = 0;
        let truncated = true;
        for (let page = 0; page < 100 && truncated; page += 1) {
          const query = new URLSearchParams({ after: String(after), limit: "1000" });
          const res = await fetch(`${cfg().api}/sessions/${encodeURIComponent(sessId)}/events?${query.toString()}`, {
            headers: { Authorization: `Bearer ${t}` },
            credentials: "include"
          }).catch(() => null);
          if (!res || !res.ok) {
            if (page === 0) throw new Error("历史事件加载失败");
            break;
          }
          const data = await res.json();
          const pageEvents: EventMessage[] = Array.isArray(data.events) ? data.events : [];
          if (data.historyGap === true && typeof data.availableFrom === "number" && Number.isSafeInteger(data.availableFrom) && data.availableFrom > 0) {
            // Retention can remove the prefix of a timeline. The server has
            // identified the first retained sequence; advance just before it
            // so replay can continue without retrying an impossible gap.
            const resetTo = data.availableFrom - 1;
            if (resetTo > after) after = resetTo;
          }
          list.push(...pageEvents);
          const nextCursor = typeof data.nextCursor === "number" && Number.isFinite(data.nextCursor)
            ? data.nextCursor
            : Math.max(after, ...pageEvents.map((event) => typeof event.eventSeq === "number" ? event.eventSeq : 0));
          truncated = data.truncated === true && nextCursor > after;
          after = nextCursor;
          if (pageEvents.length === 0) break;
        }

        if (selectedSessionIdRef.current !== sessId || liveRevisionRef.current !== revisionAtStart) return;
        let maxSeq = 0;
        if (list.length > 0) {
            setRawEvents((prev) => {
              const others = prev.filter((e) => e.sessionId !== sessId);
              return [...others, ...list].slice(-500);
            });
            const sess = sessionsRef.current.find((s) => s.id === sessId);
            setTurns(aggregateEventsToTurns(list, sess));

            maxSeq = Math.max(
              ...list.map((e) => (typeof e.eventSeq === "number" ? e.eventSeq : 0)),
              0
            );
            if (maxSeq > 0) saveCursor(sessId, maxSeq);
        } else {
          const sess = sessionsRef.current.find((s) => s.id === sessId);
          setTurns(aggregateEventsToTurns([], sess));
        }
        const recovery = gapRecoveryRef.current.get(sessId);
        if (recovery) {
          if (maxSeq >= recovery.expectedSeq || recovery.attempt >= 5) {
            if (recovery.timer) window.clearTimeout(recovery.timer);
            gapRecoveryRef.current.delete(sessId);
          } else {
            scheduleGapRecovery(sessId, t, recovery.expectedSeq);
          }
        }
      } catch {
        if (selectedSessionIdRef.current !== sessId || liveRevisionRef.current !== revisionAtStart) return;
        const sess = sessionsRef.current.find((s) => s.id === sessId);
        setTurns(aggregateEventsToTurns([], sess));
      }
    },
    [saveCursor, scheduleGapRecovery]
  );

  loadSessionEventsRef.current = loadSessionEvents;

  // When selectedSessionId changes, load its events
  useEffect(() => {
    if (selectedSessionId && token) {
      loadSessionEvents(selectedSessionId, token);
    } else {
      setTurns([]);
    }
  }, [selectedSessionId, token, loadSessionEvents]);

  // Connect WebSocket
  const connectWs = useCallback(
    (t: string) => {
      if (!t) return;
      if (socketRef.current) {
        socketRef.current.close();
      }

      setConnectionStatus("连接中");
      const url = new URL(cfg().ws);
      // Keep the bearer out of the URL so reverse-proxy access logs cannot
      // capture it. Relay accepts this subprotocol and retains query-token
      // parsing only for older clients during migration.
      const ws = new WebSocket(url.toString(), [`codeharbor-v1.${t}`]);
      socketRef.current = ws;

      ws.onopen = () => {
        reconnectAttemptsRef.current = 0;
        resumeAttemptsRef.current = 0;
        setConnectionStatus("已连接");
        setError("");

        if (selectedDeviceIdRef.current) {
          ws.send(JSON.stringify({ type: "subscribe", deviceId: selectedDeviceIdRef.current, replace: true }));
        }

        const cursors = cursorsRef.current;
        if (Object.keys(cursors).length > 0) {
          ws.send(JSON.stringify({ type: "resume", cursors }));
        }
        if (selectedSessionIdRef.current) {
          void loadSessionEvents(selectedSessionIdRef.current, t);
        }
        if (selectedDeviceIdRef.current) {
          void sendGatewayProxy("GET", "/api/models").then((body) => {
            setModels(normalizeModelOptions(body));
          }).catch(() => undefined);
        }
        if (heartbeatTimerRef.current) clearInterval(heartbeatTimerRef.current);
        heartbeatTimerRef.current = window.setInterval(() => {
          if (ws.readyState !== WebSocket.OPEN) return;
          try {
            ws.send(JSON.stringify({ type: "ping" }));
          } catch {
            // The close event owns reconnect and pending-request cleanup.
          }
        }, 25_000);
      };

      ws.onclose = () => {
        for (const [requestId, pending] of pendingRequests.current) {
          if (pending.socket !== ws) continue;
          clearTimeout(pending.timer);
          pendingRequests.current.delete(requestId);
          pending.reject(new Error("实时连接已关闭，请确认操作状态后再试"));
        }
        if (socketRef.current !== ws) return;
        if (heartbeatTimerRef.current) clearInterval(heartbeatTimerRef.current);
        heartbeatTimerRef.current = null;
        for (const [requestId, pending] of pendingRequests.current.entries()) {
          clearTimeout(pending.timer);
          pending.reject(new Error("实时连接已断开，请重试"));
          pendingRequests.current.delete(requestId);
        }
        setConnectionStatus("重连中");
        if (activeTokenRef.current === t) {
          if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
          const attempt = reconnectAttemptsRef.current++;
          const delay = Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5)) + Math.floor(Math.random() * 250);
          reconnectTimerRef.current = window.setTimeout(() => connectWs(t), delay);
        }
      };

      ws.onerror = () => {
        setConnectionStatus("已断开");
      };

      ws.onmessage = (e) => {
        try {
          const rawMsg = JSON.parse(e.data);
          // Accept both direct Gateway messages and relays that wrap the
          // message as { type: "gateway-event", payload }.
          const msg = rawMsg?.type === "gateway-event" && rawMsg.payload ? rawMsg.payload : rawMsg;

          if (msg.type === "gateway-proxy-response") {
            const reqId = msg.requestId;
            const pending = pendingRequests.current.get(reqId);
            if (pending) {
              clearTimeout(pending.timer);
              pendingRequests.current.delete(reqId);
              if (msg.status >= 400 || msg.error) {
                let responseError = "";
                if (msg.bodyBase64) {
                  try {
                    const decoded = JSON.parse(utf8Base64(msg.bodyBase64));
                    responseError = typeof decoded?.message === "string"
                      ? decoded.message
                      : typeof decoded?.error === "string" ? decoded.error : "";
                  } catch {
                    // Fall back to the transport status below.
                  }
                }
                pending.reject(new Error(msg.error || responseError || `请求错误 ${msg.status}`));
              } else {
                let body: any = null;
                if (pending.raw) {
                  pending.resolve({
                    status: msg.status,
                    headers: msg.headers || {},
                    bodyBase64: msg.bodyBase64 || ""
                  });
                  return;
                }
                if (msg.bodyBase64) {
                  try {
                    const text = utf8Base64(msg.bodyBase64);
                    body = JSON.parse(text);
                  } catch {
                    body = msg.bodyBase64;
                  }
                }
                pending.resolve(body);
              }
            }
            return;
          }

          // Transport control frames are not timeline events and must not
          // invalidate an in-flight history load or pollute the raw event log.
          if (msg.type === "resume-complete") {
            if (msg.payload?.truncated && ws.readyState === WebSocket.OPEN && resumeAttemptsRef.current < 10) {
              const before = { ...cursorsRef.current };
              const returned = msg.payload?.cursors;
              if (returned && typeof returned === "object" && !Array.isArray(returned)) {
                for (const [sessionId, value] of Object.entries(returned as Record<string, unknown>)) {
                  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value > (cursorsRef.current[sessionId] || 0)) {
                    saveCursor(sessionId, value);
                  }
                }
              }
              const advanced = Object.entries(cursorsRef.current).some(([sessionId, value]) => value > (before[sessionId] || 0));
              // A truncated response may only indicate that the server hit
              // its fan-out cap. Retry only when cursors advanced, otherwise
              // the same frame would create an infinite resume loop.
              if (advanced) {
                resumeAttemptsRef.current += 1;
                ws.send(JSON.stringify({ type: "resume", cursors: cursorsRef.current }));
              }
            }
            return;
          }
          if (msg.type === "history-gap") {
            const sessionId = typeof msg.payload?.sessionId === "string" ? msg.payload.sessionId : "";
            const availableFrom = msg.payload?.availableFrom;
            if (sessionId && typeof availableFrom === "number" && Number.isSafeInteger(availableFrom) && availableFrom > 0) {
              resetCursor(sessionId, availableFrom - 1);
            }
            return;
          }
          if (msg.type === "pong" || msg.type === "cloud-ready") return;

          const eventSessionId = msg.sessionId || msg.payload?.sessionId || msg.payload?.threadId;
          if (typeof msg.eventSeq === "number" && eventSessionId) {
            const cursor = cursorsRef.current[eventSessionId] || 0;
            if (msg.eventSeq <= cursor) return;
            if (msg.eventSeq > cursor + 1) {
              // Do not advance over a missing sequence. Ask the Gateway for a
              // durable snapshot so a reordered/lost WebSocket frame cannot
              // permanently create a cursor hole.
              scheduleGapRecovery(eventSessionId, t, msg.eventSeq);
              return;
            }
          }
          const requestId = msg.payload?.clientRequestId;
          const requestKey = typeof requestId === "string" ? `request:${requestId}` : "";
          // The optimistic user row is keyed by clientRequestId, while the
          // authoritative echo also carries an eventSeq. Check the request
          // key first; otherwise the same prompt is rendered twice when the
          // event is persisted before it reaches this socket.
          if (requestKey && seenEventKeysRef.current.has(requestKey)) {
            // An optimistic user-input row may already occupy this key. The
            // authoritative Gateway event is still useful for advancing the
            // durable cursor, but must not append a second visible message.
            if (eventSessionId && typeof msg.eventSeq === "number") {
              saveCursor(eventSessionId, msg.eventSeq);
            }
            return;
          }
          const eventKey = typeof msg.eventSeq === "number" && eventSessionId
            ? `${eventSessionId}:${msg.eventSeq}`
            : requestKey;
          if (eventKey && seenEventKeysRef.current.has(eventKey)) {
            if (eventSessionId && typeof msg.eventSeq === "number") {
              saveCursor(eventSessionId, msg.eventSeq);
            }
            return;
          }
          if (eventKey) {
            seenEventKeysRef.current.add(eventKey);
            if (seenEventKeysRef.current.size > 2000) {
              seenEventKeysRef.current = new Set(Array.from(seenEventKeysRef.current).slice(-1000));
            }
          }
          liveRevisionRef.current += 1;

          setRawEvents((prev) => [...prev.slice(-499), msg]);

          if (typeof eventSessionId === "string" && typeof msg.eventSeq === "number") {
            saveCursor(eventSessionId, msg.eventSeq);
          }

          if (msg.type === "session-started" && msg.payload?.session) {
            const newSess: Session = msg.payload.session;
            setSessions((prev) => {
              const idx = prev.findIndex((s) => s.id === newSess.id);
              if (idx >= 0) {
                const copy = [...prev];
                copy[idx] = { ...copy[idx], ...newSess };
                return copy;
              }
              return [newSess, ...prev];
            });
          }

          if (msg.type === "session-policy-changed" && msg.payload?.sessionPolicyMode) {
            const sessId = msg.sessionId || msg.payload.sessionId;
            const mode = msg.payload.sessionPolicyMode;
            if (sessId && (mode === "confirm" || mode === "full-access")) {
              setSessions((prev) => prev.map((s) => (
                s.id === sessId ? { ...s, sessionPolicyMode: mode } : s
              )));
            }
          }

          if (msg.type === "session-status" || msg.type === "session-finished") {
            const sessId = msg.sessionId || msg.payload?.threadId;
            const status = msg.payload?.status || msg.payload?.turn?.status;
            if (sessId && status) {
              setSessions((prev) =>
                prev.map((s) => (s.id === sessId ? { ...s, status } : s))
              );
            }
          }

          if (msg.type === "session-forked" && msg.payload?.session) {
            const forkedSess = msg.payload.session;
            setSessions((prev) => {
              const index = prev.findIndex((session) => session.id === forkedSess.id);
              if (index < 0) return [forkedSess, ...prev];
              const next = [...prev];
              next[index] = { ...next[index], ...forkedSess };
              return next;
            });
          }

          const eventSessId = msg.sessionId || msg.payload?.sessionId || msg.payload?.threadId;
          if (!eventSessId || eventSessId === selectedSessionIdRef.current) {
            setTurns((prev) => applyLiveEventToTurns(prev, msg, selectedSessionRef.current));
          }
        } catch {}
      };
    },
    [loadSessionEvents, resetCursor, saveCursor, scheduleGapRecovery, sendGatewayProxy]
  );

  useEffect(() => {
    let cancelled = false;
    const legacyToken = localStorage.getItem(TOKEN_KEY);
    if (legacyToken) {
      localStorage.removeItem(TOKEN_KEY);
      setToken(legacyToken);
      return () => { cancelled = true; };
    }
    void fetch(`${cfg().api}/auth/session-token`, {
      credentials: "include",
      headers: { accept: "application/json" }
    }).then(async (response) => {
      if (!response.ok || cancelled) return;
      const body = await response.json();
      if (typeof body.token === "string" && body.token.length > 16 && !cancelled) {
        setToken(body.token);
      }
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (socketRef.current?.readyState === WebSocket.OPEN && selectedDeviceId) {
      socketRef.current.send(
        JSON.stringify({ type: "subscribe", deviceId: selectedDeviceId, replace: true })
      );
      void sendGatewayProxy("GET", "/api/models").then((body) => {
        setModels(normalizeModelOptions(body));
      }).catch(() => undefined);
    }
  }, [selectedDeviceId, sendGatewayProxy]);

  useEffect(() => {
    let cancelled = false;
    if (token) {
      const bootstrap = async () => {
        let activeToken = token;
        const expiry = tokenExpiryMs(token);
        if (expiry !== null && expiry - Date.now() < TOKEN_REFRESH_WINDOW_MS) {
          try {
            const response = await fetch(`${cfg().api}/auth/refresh`, {
              method: "POST",
              headers: { Authorization: `Bearer ${token}` },
              credentials: "include"
            });
            if (response.ok) {
              const refreshed = await response.json();
              if (typeof refreshed.token === "string" && refreshed.token.length > 16) {
                activeToken = refreshed.token;
                if (!cancelled) {
                  setToken(activeToken);
                  return;
                }
              }
            }
          } catch {
            // The regular authenticated requests below provide the definitive
            // result and will clear an actually expired token.
          }
          // An expired legacy token cannot be refreshed because the relay
          // correctly rejects it. Clear it before opening a socket; otherwise
          // the close handler reconnects the same invalid token forever.
          if (expiry <= Date.now()) {
            localStorage.removeItem(TOKEN_KEY);
            if (!cancelled) {
              setToken("");
              setConnectionStatus("已断开");
              setError("登录已过期，请重新登录");
            }
            return;
          }
        }
        if (!cancelled) {
          void loadData(activeToken);
          connectWs(activeToken);
        }
      };
      void bootstrap();
    } else {
      setConnectionStatus("已断开");
      setDevices([]);
      setSessions([]);
      setModels([]);
      setSelectedDeviceId("");
      setSelectedSessionId("");
      setTurns([]);
      setRawEvents([]);
    }

    return () => {
      cancelled = true;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (heartbeatTimerRef.current) clearInterval(heartbeatTimerRef.current);
      for (const recovery of gapRecoveryRef.current.values()) {
        if (recovery.timer) window.clearTimeout(recovery.timer);
      }
      gapRecoveryRef.current.clear();
      const socket = socketRef.current;
      socketRef.current = null;
      socket?.close();
    };
  // The socket lifecycle follows authentication only. Session/device changes
  // are sent over the existing socket; reconnecting on every event would
  // close the stream while the current turn is still producing output.
  }, [token]);

  const login = async (options?: { pairCode?: string }) => {
    setError("");
    try {
      const pairCode = options?.pairCode?.trim().toUpperCase();
      const res = await fetch(`${cfg().api}/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify(pairCode ? { token: pairCode } : { username: user, password })
      });
      if (!res.ok) {
        throw new Error("账号或访问密码错误");
      }
      const data = await res.json();
      const t = data.token;
      if (!t) throw new Error("登录未返回有效凭证");

      localStorage.setItem(USER_KEY, typeof data.username === "string" ? data.username : user);
      // Cursors and event de-duplication keys are account-scoped. Never let
      // a subsequent login inherit another account's replay state.
      cursorsRef.current = {};
      seenEventKeysRef.current.clear();
      localStorage.removeItem(CURSORS_KEY);
      if (typeof data.deviceId === "string" && data.deviceId) {
        setSelectedDeviceId(data.deviceId);
      }
      setToken(t);
      setPassword("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "登录失败");
    }
  };

  const registerAccount = async (username: string, registrationPassword: string) => {
    setError("");
    try {
      const res = await fetch(`${cfg().api}/auth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ username, password: registrationPassword })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const messages: Record<string, string> = { account_exists: "该账号已存在", invalid_account: "账号需 3–64 位字母、数字、点、下划线或短横线；密码至少 12 位" };
        throw new Error(messages[data?.error] || "注册失败，请稍后重试");
      }
      const registeredUser = typeof data.username === "string" ? data.username : username.trim().toLowerCase();
      const registeredToken = typeof data.token === "string" ? data.token : "";
      if (!registeredToken) throw new Error("注册成功但未返回登录凭证");
      localStorage.setItem(USER_KEY, registeredUser);
      cursorsRef.current = {};
      seenEventKeysRef.current.clear();
      localStorage.removeItem(CURSORS_KEY);
      setUser(registeredUser);
      setToken(registeredToken);
      setPassword("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "注册失败");
      throw err;
    }
  };

  const logout = () => {
    if (token) {
      void fetch(`${cfg().api}/auth/logout`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        credentials: "include"
      }).catch(() => undefined);
    }
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(CURSORS_KEY);
    cursorsRef.current = {};
    seenEventKeysRef.current.clear();
    activeTokenRef.current = "";
    setToken("");
    setSessions([]);
    setDevices([]);
    setSelectedDeviceId("");
    setSelectedSessionId("");
    setTurns([]);
    setRawEvents([]);
    for (const recovery of gapRecoveryRef.current.values()) {
      if (recovery.timer) window.clearTimeout(recovery.timer);
    }
    gapRecoveryRef.current.clear();
    socketRef.current?.close();
  };

  const sendPrompt = async (
    promptText: string,
    attachments: Attachment[] = [],
    options?: { model?: string; effort?: string; multiAgentMode?: string; sessionPolicyMode?: "confirm" | "full-access" }
  ) => {
    if (!selectedSessionId) {
      throw new Error("请先选择一个会话");
    }
    if (!promptText.trim() && attachments.length === 0) {
      throw new Error("请输入消息内容或添加附件");
    }

    const clientRequestId = crypto.randomUUID();
    const payloadBody = {
      clientRequestId,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      prompt: promptText,
      attachments: attachments.length > 0 ? attachments : undefined,
      model: options?.model || undefined,
      effort: options?.effort || undefined,
      multiAgentMode: options?.multiAgentMode || undefined,
      sessionPolicyMode: options?.sessionPolicyMode ?? selectedSessionRef.current?.sessionPolicyMode ?? "confirm"
    };

    const syntheticEvent: EventMessage = {
      type: "session-user-input",
      sessionId: selectedSessionId,
      timestamp: new Date().toISOString(),
      payload: {
        sessionId: selectedSessionId,
        clientRequestId,
        prompt: promptText,
        attachments
      }
    };
    // Reserve the client request key before rendering the optimistic row so
    // the same user-input event echoed by Gateway/replay is deduplicated.
    seenEventKeysRef.current.add(`request:${clientRequestId}`);
    setTurns((prev) => applyLiveEventToTurns(prev, syntheticEvent, selectedSession));

    try {
      await sendGatewayProxy(
        "POST",
        `/sessions/${encodeURIComponent(selectedSessionId)}/turns`,
        payloadBody
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "发送失败");
      throw err;
    }
  };

  const downloadFile = useCallback(async (filePath: string) => {
    if (!selectedSessionId) throw new Error("请先选择一个会话");
    const query = `/files/download?sessionId=${encodeURIComponent(selectedSessionId)}&path=${encodeURIComponent(filePath)}`;
    const response = await sendGatewayProxy("GET", query, undefined, { raw: true });
    if (!response?.bodyBase64) throw new Error("文件下载响应为空");
    const bytes = base64ToBytes(response.bodyBase64);
    const contentType = response.headers?.["content-type"] || "application/octet-stream";
    const disposition = response.headers?.["content-disposition"] || "";
    const encodedName = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
    const fileName = encodedName ? decodeURIComponent(encodedName) : filePath.split(/[\\/]/).pop() || "download";
    const blobUrl = URL.createObjectURL(new Blob([bytes], { type: contentType }));
    const anchor = document.createElement("a");
    anchor.href = blobUrl;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(blobUrl);
  }, [selectedSessionId, sendGatewayProxy]);

  const sendApprovalDecision = async (
    requestId: string,
    decision: "approve" | "deny",
    execpolicyAmendment?: string[],
    approvalTurnId?: string
  ) => {
    if (!selectedSessionId) return;

    try {
      // App-server request ids are process-local and can restart at "0".
      // Prefer the turn id carried by the card, then the newest pending
      // approval, so an old historical card cannot consume the current one.
      const approval = [...turns].reverse()
        .flatMap((turn) => [...turn.approvals].reverse())
        .find((item) => item.requestId === requestId && item.status === "pending")
        ?? [...turns].reverse()
          .flatMap((turn) => [...turn.approvals].reverse())
          .find((item) => item.requestId === requestId);
      await sendGatewayProxy(
        "POST",
        `/sessions/${encodeURIComponent(selectedSessionId)}/approvals/${encodeURIComponent(requestId)}`,
        {
          decision,
          requestId,
          turnId: approvalTurnId ?? approval?.turnId,
          // Send the server-issued deadline. Replacing it with a new client
          // deadline made a stale approval card look actionable after a
          // reconnect or Gateway restart.
          expiresAt: approval?.expiresAt,
          execpolicyAmendment: execpolicyAmendment && execpolicyAmendment.length > 0 ? execpolicyAmendment : undefined
        }
      );

      const resolvedEvent: EventMessage = {
        type: "approval-resolved",
        sessionId: selectedSessionId,
        timestamp: new Date().toISOString(),
        payload: {
          requestId,
          decision
        }
      };
      setTurns((prev) => applyLiveEventToTurns(prev, resolvedEvent, selectedSession));
    } catch (err) {
      const message = err instanceof Error && err.message === "approval_not_found"
        ? "该审批已失效，请重新执行该操作"
        : err instanceof Error ? err.message : "审批操作失败";
      setError(message);
      throw new Error(message);
    }
  };

  const interruptTask = async () => {
    if (!selectedSessionId) return;
    try {
      const activeTurnId = selectedSessionRef.current?.activeTurnId
        ?? [...turns].reverse().find((turn) => turn.assistantStatus === "streaming")?.turnId;
      await sendGatewayProxy(
        "POST",
        `/sessions/${encodeURIComponent(selectedSessionId)}/interrupt`,
        { turnId: activeTurnId, expiresAt: new Date(Date.now() + 2 * 60 * 1000).toISOString() }
      );
      setSessions((prev) =>
        prev.map((s) => (s.id === selectedSessionId ? { ...s, status: "cancelled" } : s))
      );
      if (turns.length > 0) {
        setTurns((prev) => {
          const copy = [...prev];
          copy[copy.length - 1] = {
            ...copy[copy.length - 1],
            assistantStatus: "cancelled"
          };
          return copy;
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "中断任务失败");
    }
  };

  const resumeTask = async () => {
    if (!selectedSessionId) return;
    try {
      await sendGatewayProxy(
        "POST",
        `/api/threads/${encodeURIComponent(selectedSessionId)}/resume`,
        { expiresAt: new Date(Date.now() + 2 * 60 * 1000).toISOString() }
      );
      setSessions((prev) =>
        prev.map((s) => (s.id === selectedSessionId ? { ...s, status: "running" } : s))
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "恢复任务失败");
    }
  };

  const setSessionPolicyMode = async (mode: "confirm" | "full-access", confirmFullAccess = false) => {
    if (!selectedSessionId) throw new Error("请先选择一个会话");
    const response = await sendGatewayProxy(
      "PATCH",
      `/sessions/${encodeURIComponent(selectedSessionId)}/policy`,
      { sessionPolicyMode: mode, confirmFullAccess: confirmFullAccess || undefined, expiresAt: new Date(Date.now() + 2 * 60 * 1000).toISOString() }
    );
    const updated = response?.session as Session | undefined;
    setSessions((prev) => prev.map((session) => (
      session.id === selectedSessionId
        ? { ...session, ...(updated ?? {}), sessionPolicyMode: mode }
        : session
    )));
  };

  const revokeDevice = async (deviceId = selectedDeviceIdRef.current) => {
    if (!deviceId || !token) throw new Error("未选择设备");
    const response = await fetch(`${cfg().api}/devices/${encodeURIComponent(deviceId)}/revoke`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      credentials: "include"
    });
    if (!response.ok) throw new Error(response.status === 404 ? "设备不存在或无权操作" : "撤销设备失败");
    setDevices((prev) => prev.filter((device) => device.deviceId !== deviceId));
    if (selectedDeviceIdRef.current === deviceId) {
      setSelectedDeviceId("");
      setSelectedSessionId("");
      setTurns([]);
    }
  };

  const createNewSession = async (params: {
    workspacePath: string;
    prompt: string;
    title?: string;
    sessionPolicyMode?: "confirm" | "full-access";
    confirmFullAccess?: boolean;
    model?: string;
    effort?: string;
    multiAgentMode?: string;
  }) => {
    try {
      const resp = await sendGatewayProxy("POST", "/sessions", {
        clientRequestId: crypto.randomUUID(),
        workspacePath: params.workspacePath,
        prompt: params.prompt,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        title: params.title || params.prompt.slice(0, 30),
        sessionPolicyMode: params.sessionPolicyMode || "confirm",
        confirmFullAccess: params.confirmFullAccess || undefined,
        model: params.model || undefined,
        effort: params.effort || undefined,
        multiAgentMode: params.multiAgentMode || undefined
      });

      if (resp?.session?.id) {
        const newSess: Session = resp.session;
        setSessions((prev) => {
          const existingIndex = prev.findIndex((session) => session.id === newSess.id);
          if (existingIndex < 0) return [newSess, ...prev];
          const next = [...prev];
          next[existingIndex] = { ...next[existingIndex], ...newSess };
          return next;
        });
        setSelectedSessionId(newSess.id);
        return newSess;
      }
      throw new Error("创建会话失败，返回数据异常");
    } catch (err) {
      setError(err instanceof Error ? err.message : "创建会话失败");
      throw err;
    }
  };

  const forkSession = async (sourceSessionId: string) => {
    try {
      const resp = await sendGatewayProxy(
        "POST",
        `/sessions/${encodeURIComponent(sourceSessionId)}/fork`,
        { threadSource: "subagent", sessionPolicyMode: "confirm", expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString() }
      );
      if (resp?.session?.id) {
        const child: Session = resp.session;
        setSessions((prev) => {
          const existingIndex = prev.findIndex((session) => session.id === child.id);
          if (existingIndex < 0) return [child, ...prev];
          const next = [...prev];
          next[existingIndex] = { ...next[existingIndex], ...child };
          return next;
        });
        setSelectedSessionId(child.id);
        return child;
      }
      throw new Error("分叉会话失败");
    } catch (err) {
      setError(err instanceof Error ? err.message : "分叉会话失败");
      throw err;
    }
  };

  return {
    user,
    setUser,
    password,
    setPassword,
    token,
    login,
    registerAccount,
    logout,
    devices,
    selectedDeviceId,
    setSelectedDeviceId,
    selectedDevice,
    sessions,
    models,
    selectedSessionId,
    setSelectedSessionId,
    selectedSession,
    turns,
    rawEvents,
    connectionStatus,
    error,
    clearError: () => setError(""),
    isStreaming,
    sendPrompt,
    downloadFile,
    sendApprovalDecision,
    interruptTask,
    resumeTask,
    setSessionPolicyMode,
    revokeDevice,
    createNewSession,
    forkSession,
    refreshData: () => token && loadData(token)
  };
}
