import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir, hostname } from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { config } from "./config.js";
import { gatewayStore } from "./gatewayStore.js";
import { sendSessionSync } from "./relaySessionSync.js";
import { proxyLocalRequest } from "./relayProxy.js";

type PersistedRelayIdentity = {
  deviceId?: string;
  deviceToken?: string;
  /** @deprecated Kept so clients can migrate from the old relay protocol. */
  deviceSecret?: string;
};

type RelayStatus = {
  enabled: boolean;
  relayUrl: string;
  connected: boolean;
  deviceId?: string;
  deviceName?: string;
  pairCode?: string;
  pairCodeExpiresAt?: string;
  lastError?: string;
};

type PendingRequest = {
  resolve: (value: { pairCode: string; pairCodeExpiresAt: string }) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

const maxRelayBufferedBytes = 32 * 1024 * 1024;

function safeRelaySend(socket: WebSocket, text: string) {
  if (socket.readyState !== WebSocket.OPEN) return false;
  if (socket.bufferedAmount + Buffer.byteLength(text) > maxRelayBufferedBytes) {
    try { socket.close(1013, "relay slow consumer"); } catch { /* already closed */ }
    return false;
  }
  try {
    socket.send(text);
    return true;
  } catch {
    try { socket.close(); } catch { /* already closed */ }
    return false;
  }
}

function relaySocketUrl() {
  const url = new URL(config.relayUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = relayPath(url.pathname, "/relay/device");
  url.search = "";
  url.hash = "";
  return url.toString();
}

function relayHttpUrl(pathname: string) {
  const url = new URL(config.relayUrl);
  url.pathname = relayPath(url.pathname, pathname);
  url.search = "";
  url.hash = "";
  return url.toString();
}

function relayPath(basePath: string, suffix: string) {
  const base = basePath.replace(/\/+$/, "");
  return `${base}${suffix.startsWith("/") ? suffix : `/${suffix}`}` || "/";
}

function relayOrigin() {
  return config.relayOrigin ? new URL(config.relayOrigin).origin : new URL(config.relayUrl).origin;
}

function localWsUrl() {
  return `ws://127.0.0.1:${config.port}/ws`;
}

function localHttpOrigin() {
  return `http://127.0.0.1:${config.port}`;
}

function identityPath() {
  return path.join(config.gatewayDataDir, "relay-device.json");
}

function readIdentity(): PersistedRelayIdentity {
  try {
    if (!existsSync(identityPath())) return stableFallbackIdentity();
    const value = JSON.parse(readFileSync(identityPath(), "utf8")) as Record<string, unknown>;
    return {
      deviceId: typeof value.deviceId === "string" ? value.deviceId : undefined,
      deviceToken: typeof value.deviceToken === "string" ? value.deviceToken : undefined,
      deviceSecret: typeof value.deviceSecret === "string" ? value.deviceSecret : undefined
    };
  } catch {
    return stableFallbackIdentity();
  }
}

function writeIdentity(identity: PersistedRelayIdentity) {
  const directory = path.dirname(identityPath());
  mkdirSync(directory, { recursive: true });
  const temporaryPath = `${identityPath()}.tmp-${process.pid}`;
  const serialized = JSON.stringify(identity, null, 2);
  writeFileSync(temporaryPath, serialized, { encoding: "utf8", mode: 0o600 });
  chmodSync(temporaryPath, 0o600);
  try {
    renameSync(temporaryPath, identityPath());
  } catch {
    // Windows can reject replacing an existing file with rename. Preserve the
    // same permissions and complete the update rather than losing enrollment.
    writeFileSync(identityPath(), serialized, { encoding: "utf8", mode: 0o600 });
    chmodSync(identityPath(), 0o600);
    unlinkSync(temporaryPath);
  }
}

function stableFallbackIdentity(): PersistedRelayIdentity {
  return {
    deviceId: stableUuid([
      "acode-official-relay",
      process.env.COMPUTERNAME,
      process.env.HOSTNAME,
      hostname(),
      process.env.USERDOMAIN,
      process.env.USERNAME,
      homedir()
    ].filter(Boolean).join("|"))
  };
}

function stableUuid(seed: string) {
  const hex = createHash("sha256").update(seed).digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8).join("")}-${hex.slice(8, 12).join("")}-${hex.slice(12, 16).join("")}-${hex.slice(16, 20).join("")}-${hex.slice(20, 32).join("")}`;
}

function deviceName() {
  return config.relayDeviceName || process.env.COMPUTERNAME || process.env.HOSTNAME || "aCode Gateway";
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function responseBody(response: Response) {
  try {
    const value: unknown = await response.json();
    return value && typeof value === "object" ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function responseError(response: Response, body: Record<string, unknown>) {
  const code = typeof body.error === "string" ? body.error : undefined;
  return new Error(code ? `relay request failed (${response.status}): ${code}` : `relay request failed (${response.status})`);
}

export class RelayClient extends EventEmitter {
  private relaySocket: WebSocket | null = null;
  private relayReadySocket: WebSocket | null = null;
  private gatewayEventSocket: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private relayHeartbeatTimer: NodeJS.Timeout | null = null;
  private gatewayHeartbeatTimer: NodeJS.Timeout | null = null;
  private enrollmentPromise: Promise<void> | null = null;
  private pending = new Map<string, PendingRequest>();
  private identity = readIdentity();
  private sessionSyncPromise: Promise<void> | null = null;
  private sessionSyncSocket: WebSocket | null = null;
  private sessionSyncAgain = false;
  private started = false;
  private connecting = false;
  private revoked = false;
  // A stale per-device credential can survive a Relay database restore. Retry
  // enrollment once per connection cycle, then fall back to normal backoff so
  // transient network failures cannot rotate credentials indefinitely.
  private credentialRecoveryAttempted = false;
  private status: RelayStatus = {
    enabled: Boolean(config.relayUrl),
    relayUrl: config.relayUrl,
    connected: false
  };

  start() {
    if (!config.relayUrl || this.started) return;
    if (process.env.NODE_ENV === "production") {
      const protocol = (() => {
        try { return new URL(config.relayUrl).protocol; } catch { return ""; }
      })();
      if (protocol !== "https:") {
        this.status.lastError = "production relay requires an https URL";
        this.emit("status", this.getStatus());
        return;
      }
    }
    this.started = true;
    void this.connectRelay();
  }

  getStatus() {
    return { ...this.status };
  }

  /** Push the current authoritative session metadata without waiting for a reconnect. */
  syncSessionsNow(): Promise<void> {
    if (!this.sessionSyncPromise) return this.syncSessions();
    // A connect-time or previous policy sync may still be reading the local
    // session list. Mark a follow-up so a newer policy cannot be overwritten
    // by that older snapshot when the browser refreshes immediately.
    this.sessionSyncAgain = true;
    const current = this.sessionSyncPromise;
    return current.then(() => {
      if (!this.sessionSyncAgain) return;
      this.sessionSyncAgain = false;
      return this.syncSessionsNow();
    });
  }

  async requestPairCode() {
    if (!this.relaySocket || this.relaySocket.readyState !== WebSocket.OPEN) {
      throw new Error("relay is not connected");
    }
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const result = await new Promise<{ pairCode: string; pairCodeExpiresAt: string }>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("pair code request timed out"));
      }, 20_000);
      this.pending.set(requestId, { resolve, reject, timer });
      if (!this.relaySocket || !safeRelaySend(this.relaySocket, JSON.stringify({ type: "pair-code:create", requestId }))) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(new Error("relay connection not writable"));
      }
    });
    this.status.pairCode = result.pairCode;
    this.status.pairCodeExpiresAt = result.pairCodeExpiresAt;
    return result;
  }

  private async connectRelay() {
    if (!this.started || this.revoked || this.connecting) return;
    if (this.relaySocket && (this.relaySocket.readyState === WebSocket.OPEN || this.relaySocket.readyState === WebSocket.CONNECTING)) return;
    this.connecting = true;
    try {
      await this.ensureDeviceCredential();
    } catch (error) {
      this.connecting = false;
      this.setError(error);
      this.scheduleReconnect(10_000);
      return;
    }
    this.connecting = false;
    if (!this.started || this.revoked) return;

    let socket: WebSocket;
    try {
      socket = new WebSocket(relaySocketUrl(), {
        // Go's production relay validates Origin. Use the relay's public
        // origin instead of the local Gateway origin used by HTTP metadata.
        headers: { Origin: relayOrigin() }
      });
    } catch (error) {
      this.setError(error);
      this.scheduleReconnect();
      return;
    }
    this.relaySocket = socket;

    socket.once("open", () => {
      if (this.relaySocket !== socket) return;
      // Upgrade success is not device authentication. Mark online only after
      // the relay returns the authenticated device-ready handshake.
      this.status.connected = false;
      this.emit("status", this.getStatus());
      safeRelaySend(socket, JSON.stringify(this.deviceHello()));
      if (this.relayHeartbeatTimer) clearInterval(this.relayHeartbeatTimer);
      this.relayHeartbeatTimer = setInterval(() => {
        safeRelaySend(socket, JSON.stringify({ type: "ping" }));
      }, 25_000);
      this.ensureGatewayEventSocket();
    });

    socket.on("message", (raw) => this.handleRelayMessage(String(raw)));
    socket.on("close", (code, reason) => this.handleRelayDisconnect(socket, code, reason.toString("utf8")));
    socket.on("error", (error) => {
      if (this.relaySocket === socket) this.setError(error);
    });
  }

  private deviceHello() {
    const message: Record<string, unknown> = {
      type: "device-hello",
      deviceId: this.identity.deviceId,
      deviceName: deviceName(),
      gatewayOrigin: config.publicOrigin
    };
    if (this.identity.deviceToken) {
      message.deviceToken = this.identity.deviceToken;
    } else if (this.identity.deviceSecret) {
      // Compatibility for identities issued by the old Node relay.
      message.deviceSecret = this.identity.deviceSecret;
    } else if (config.relayServerToken) {
      // Legacy mode must be explicitly configured; normal account enrollment
      // never requires or transmits a server-wide registration secret.
      message.serverToken = config.relayServerToken;
    }
    return message;
  }

  private async ensureDeviceCredential() {
    if (this.identity.deviceToken) return;
    // If account credentials are present, always enroll through the account
    // endpoint. This lets an old deviceSecret migrate instead of silently
    // falling back to a server-wide legacy secret.
    const hasAccountCredentials = Boolean(config.relayAccountToken || (config.relayAccountUsername && config.relayAccountPassword));
    if (this.identity.deviceSecret || config.relayServerToken) {
      if (!hasAccountCredentials) return;
      this.identity = { deviceId: this.identity.deviceId };
    }
    if (!hasAccountCredentials) {
      throw new Error("relay account credentials required: set RELAY_ACCOUNT_TOKEN or RELAY_ACCOUNT_USERNAME and RELAY_ACCOUNT_PASSWORD");
    }
    if (this.enrollmentPromise) return this.enrollmentPromise;
    this.enrollmentPromise = this.enrollDevice().finally(() => {
      this.enrollmentPromise = null;
    });
    return this.enrollmentPromise;
  }

  private async enrollDevice(allowDeviceRotation = true): Promise<void> {
    const accountToken = await this.authenticateAccount();
    const response = await fetch(relayHttpUrl("/api/v1/devices/enroll"), {
      method: "POST",
      headers: {
        authorization: `Bearer ${accountToken}`,
        "content-type": "application/json",
        accept: "application/json"
      },
      body: JSON.stringify({ deviceId: this.identity.deviceId, deviceName: deviceName() }),
      redirect: "error",
      signal: AbortSignal.timeout(20_000)
    });
    const body = await responseBody(response);
    if (!response.ok) {
      // A stable machine identity may already belong to another cloud
      // account (for example after switching accounts on this computer).
      // Keep the remote device untouched and enroll a new local identity once.
      if (allowDeviceRotation && response.status === 409 && body.error === "device_owned") {
        this.identity = { deviceId: randomUUID() };
        writeIdentity(this.identity);
        this.status.deviceId = this.identity.deviceId;
        this.emit("status", this.getStatus());
        return this.enrollDevice(false);
      }
      throw responseError(response, body);
    }
    const deviceToken = typeof body.deviceToken === "string" ? body.deviceToken : "";
    const deviceId = typeof body.deviceId === "string" ? body.deviceId : this.identity.deviceId;
    if (!deviceToken || !deviceId) throw new Error("relay enrollment returned no device credential");
    this.identity = { deviceId, deviceToken };
    writeIdentity(this.identity);
    this.status.deviceId = deviceId;
    this.status.deviceName = typeof body.deviceName === "string" ? body.deviceName : deviceName();
    this.emit("status", this.getStatus());
  }

  private async authenticateAccount() {
    if (config.relayAccountToken) return config.relayAccountToken;
    if (!config.relayAccountUsername || !config.relayAccountPassword) {
      throw new Error("relay account credentials required");
    }
    const response = await fetch(relayHttpUrl("/api/v1/auth/login"), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ username: config.relayAccountUsername, password: config.relayAccountPassword }),
      redirect: "error",
      signal: AbortSignal.timeout(20_000)
    });
    const body = await responseBody(response);
    if (!response.ok) throw responseError(response, body);
    const token = typeof body.token === "string" ? body.token : "";
    if (!token) throw new Error("relay account login returned no token");
    return token;
  }

  private ensureGatewayEventSocket() {
    // Reuse a socket while it is still handshaking as well as after it is
    // open.  Without the CONNECTING check, a relay reconnect can create a
    // second local event socket; the first socket's close handler could then
    // clear the second socket's heartbeat and schedule duplicate reconnects.
    if (this.gatewayEventSocket && (
      this.gatewayEventSocket.readyState === WebSocket.OPEN ||
      this.gatewayEventSocket.readyState === WebSocket.CONNECTING
    )) return;
    const socket = new WebSocket(localWsUrl(), [`codeharbor-v1.${config.gatewayAuthToken}`]);
    this.gatewayEventSocket = socket;
    if (this.gatewayHeartbeatTimer) clearInterval(this.gatewayHeartbeatTimer);
    this.gatewayHeartbeatTimer = setInterval(() => {
      safeRelaySend(socket, JSON.stringify({ type: "ping" }));
    }, 25_000);
    socket.on("message", (raw) => {
      if (!this.relaySocket || this.relaySocket.readyState !== WebSocket.OPEN) return;
      try {
        const payload = JSON.parse(String(raw));
      safeRelaySend(this.relaySocket, JSON.stringify({ type: "gateway-event", payload }));
      } catch {
        return;
      }
    });
    socket.on("error", () => {
      // The local Gateway may briefly restart independently of the relay.
      // Consume the error so it cannot terminate the process; the close
      // handler below will reconnect while the relay remains online.
    });
    socket.on("close", () => {
      // A stale socket must not tear down timers or state owned by a newer
      // socket created after a transient local Gateway restart.
      const isCurrent = this.gatewayEventSocket === socket;
      if (!isCurrent) return;
      if (this.gatewayHeartbeatTimer) clearInterval(this.gatewayHeartbeatTimer);
      this.gatewayHeartbeatTimer = null;
      this.gatewayEventSocket = null;
      if (this.started && !this.revoked && this.status.connected) {
        setTimeout(() => this.ensureGatewayEventSocket(), 1500);
      }
    });
  }

  private handleRelayDisconnect(socket: WebSocket, code = 1000, reason = "") {
    if (this.relaySocket !== socket) return;
    const handshakeIncomplete = this.relayReadySocket !== socket;
    let recoverCredential = false;
    if (this.relayHeartbeatTimer) clearInterval(this.relayHeartbeatTimer);
    this.relayHeartbeatTimer = null;
    this.status.connected = false;
    if (handshakeIncomplete) {
      const detail = reason.trim();
      this.status.lastError = `relay device handshake closed (${code}${detail ? `: ${detail}` : ""})`;
      if (code === 1006 && this.identity.deviceToken && !this.credentialRecoveryAttempted) {
        this.credentialRecoveryAttempted = true;
        recoverCredential = true;
        this.identity = { deviceId: this.identity.deviceId };
        writeIdentity(this.identity);
        this.status.lastError = "设备凭据已刷新，正在重新认证";
      }
    }
    this.relaySocket = null;
    this.relayReadySocket = null;
    if (this.gatewayEventSocket) {
      this.gatewayEventSocket.close();
      this.gatewayEventSocket = null;
    }
    for (const [requestId, pending] of this.pending.entries()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("relay connection closed"));
      this.pending.delete(requestId);
    }
    this.emit("status", this.getStatus());
    this.scheduleReconnect(recoverCredential ? 500 : 3_000);
  }

  private scheduleReconnect(delay = 3_000) {
    if (!this.started || this.revoked || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connectRelay();
    }, delay);
  }

  private setError(error: unknown) {
    this.status.connected = false;
    this.status.lastError = errorMessage(error);
    this.emit("status", this.getStatus());
  }

  private async handleRelayMessage(raw: string) {
    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (!message || typeof message !== "object") return;
    const record = message as Record<string, unknown>;

    if (record.type === "device-ready") {
      const deviceId = typeof record.deviceId === "string" ? record.deviceId : this.identity.deviceId;
      const deviceToken = typeof record.deviceToken === "string" ? record.deviceToken : this.identity.deviceToken;
      const deviceSecret = typeof record.deviceSecret === "string" ? record.deviceSecret : this.identity.deviceSecret;
      this.identity = { deviceId, deviceToken, deviceSecret };
      writeIdentity(this.identity);
      this.relayReadySocket = this.relaySocket;
      this.credentialRecoveryAttempted = false;
      this.status.connected = true;
      this.status.deviceId = deviceId;
      this.status.deviceName = typeof record.deviceName === "string" ? record.deviceName : this.status.deviceName;
      this.status.pairCode = typeof record.pairCode === "string" ? record.pairCode : this.status.pairCode;
      this.status.pairCodeExpiresAt = typeof record.pairCodeExpiresAt === "string" ? record.pairCodeExpiresAt : this.status.pairCodeExpiresAt;
      this.emit("status", this.getStatus());
      void this.syncSessions();
      return;
    }

    if (record.type === "device-credential") {
      const deviceToken = typeof record.deviceToken === "string" ? record.deviceToken : "";
      const deviceId = typeof record.deviceId === "string" ? record.deviceId : this.identity.deviceId;
      if (deviceToken && deviceId) {
        this.identity = { deviceId, deviceToken };
        writeIdentity(this.identity);
        this.status.deviceId = deviceId;
        this.status.lastError = undefined;
        this.emit("status", this.getStatus());
      }
      return;
    }

    if (record.type === "device-owner-bound") {
      // Pairing can complete after the initial unowned device handshake. The
      // first session sync is intentionally rejected while ownerUser is empty;
      // repeat it once ownership is established so existing local sessions
      // appear without requiring a Gateway restart.
      void this.syncSessions();
      return;
    }

    if (record.type === "device-revoked") {
      this.identity = { deviceId: this.identity.deviceId };
      writeIdentity(this.identity);
      this.revoked = true;
      this.status.connected = false;
      this.status.lastError = "relay device credential revoked; restart after re-enrollment";
      this.emit("status", this.getStatus());
      this.relaySocket?.close(4003, "device revoked");
      return;
    }

    if (record.type === "pair-code") {
      const requestId = typeof record.requestId === "string" ? record.requestId : undefined;
      if (typeof record.error === "string" && requestId && this.pending.has(requestId)) {
        const pending = this.pending.get(requestId)!;
        this.pending.delete(requestId);
        clearTimeout(pending.timer);
        pending.reject(new Error(record.error));
        this.status.lastError = `pairing failed: ${record.error}`;
        this.emit("status", this.getStatus());
        return;
      }
      const result = {
        pairCode: typeof record.pairCode === "string" ? record.pairCode : "",
        pairCodeExpiresAt: typeof record.pairCodeExpiresAt === "string" ? record.pairCodeExpiresAt : ""
      };
      this.status.pairCode = result.pairCode;
      this.status.pairCodeExpiresAt = result.pairCodeExpiresAt;
      if (requestId && this.pending.has(requestId)) {
        const pending = this.pending.get(requestId)!;
        this.pending.delete(requestId);
        clearTimeout(pending.timer);
        pending.resolve(result);
      }
      this.emit("status", this.getStatus());
      return;
    }

    if (record.type === "proxy-request") {
      await this.handleProxyRequest(record as {
        requestId: string;
        method: string;
        path: string;
        headers?: Record<string, string>;
        bodyBase64?: string;
      });
    }
  }

  private async syncSessions() {
    const socket = this.relaySocket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    if (this.sessionSyncPromise && this.sessionSyncSocket === socket) return this.sessionSyncPromise;
    this.sessionSyncSocket = socket;
    this.sessionSyncPromise = sendSessionSync({
      localUrl: `${localHttpOrigin()}/sessions`,
      gatewayAuthToken: config.gatewayAuthToken,
      fallback: gatewayStore.listSessions(),
      cursors: gatewayStore.latestCursors(),
      requestId: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      isOpen: () => socket === this.relaySocket && socket.readyState === WebSocket.OPEN,
      send: (text) => { safeRelaySend(socket, text); }
    }).then(({ listingError }) => {
      if (listingError) {
        this.status.lastError = `session sync local listing failed: ${listingError}`;
        this.emit("status", this.getStatus());
      } else if (this.status.lastError?.startsWith("session sync local listing failed:")) {
        this.status.lastError = undefined;
        this.emit("status", this.getStatus());
      }
    }).finally(() => {
      if (this.sessionSyncSocket === socket) {
        this.sessionSyncPromise = null;
        this.sessionSyncSocket = null;
      }
    });
    return this.sessionSyncPromise;
  }

  private async handleProxyRequest(message: { requestId: string; method: string; path: string; headers?: Record<string, string>; bodyBase64?: string }) {
    await proxyLocalRequest({
      message,
      localOrigin: localHttpOrigin(),
      gatewayAuthToken: config.gatewayAuthToken,
      send: (text) => { if (this.relaySocket) safeRelaySend(this.relaySocket, text); }
    });
  }
}

export const relayClient = new RelayClient();
