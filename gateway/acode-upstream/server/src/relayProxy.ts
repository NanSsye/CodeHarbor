type ProxyRequest = {
  requestId: string;
  method: string;
  path: string;
  headers?: Record<string, string>;
  bodyBase64?: string;
};

const proxyTimeoutMs = 60_000;
const maxProxyBodyBytes = 16 * 1024 * 1024;
const maxProxyBodyBase64Chars = Math.ceil(maxProxyBodyBytes * 4 / 3) + 512;

export async function proxyLocalRequest(options: {
  message: ProxyRequest;
  localOrigin: string;
  gatewayAuthToken: string;
  send: (text: string) => void;
}) {
  const { message } = options;
  try {
    if (!message || typeof message.requestId !== "string" || message.requestId.length > 120 || typeof message.path !== "string" || !message.path.startsWith("/") || message.path.length > 4096 || typeof message.method !== "string") {
      throw new Error("invalid_proxy_request");
    }
    const headers = new Headers(message.headers ?? {});
    headers.set("authorization", `Bearer ${options.gatewayAuthToken}`);
    if (message.bodyBase64 !== undefined && typeof message.bodyBase64 !== "string") throw new Error("invalid_proxy_body");
    if (message.bodyBase64 && (message.bodyBase64.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(message.bodyBase64))) throw new Error("invalid_proxy_body");
    if (message.bodyBase64 && message.bodyBase64.length > maxProxyBodyBase64Chars) {
      options.send(JSON.stringify({ type: "proxy-response", requestId: message.requestId, status: 413, headers: { "content-type": "application/json" }, bodyBase64: Buffer.from(JSON.stringify({ error: "request_too_large" })).toString("base64") }));
      return;
    }
    const body = message.bodyBase64 ? Buffer.from(message.bodyBase64, "base64") : undefined;
    if (body && body.byteLength > maxProxyBodyBytes) {
      options.send(JSON.stringify({ type: "proxy-response", requestId: message.requestId, status: 413, headers: { "content-type": "application/json" }, bodyBase64: Buffer.from(JSON.stringify({ error: "request_too_large" })).toString("base64") }));
      return;
    }
    const response = await fetch(`${options.localOrigin}${message.path}`, {
      method: message.method,
      headers,
      body: ["GET", "HEAD"].includes(message.method.toUpperCase()) ? undefined : body,
      signal: AbortSignal.timeout(proxyTimeoutMs)
    });
    const buffer = await readBodyWithLimit(response, maxProxyBodyBytes);
    options.send(JSON.stringify({
      type: "proxy-response",
      requestId: message.requestId,
      status: response.status,
      headers: filterResponseHeaders(response.headers),
      bodyBase64: buffer.toString("base64")
    }));
  } catch (error) {
    options.send(JSON.stringify({
      type: "proxy-response",
      requestId: message.requestId,
      status: 502,
      headers: { "content-type": "application/json" },
      bodyBase64: Buffer.from(JSON.stringify({ error: errorMessage(error) })).toString("base64")
    }));
  }
}

async function readBodyWithLimit(response: Response, limit: number) {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) throw new Error("proxy_response_too_large");
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function filterResponseHeaders(headers: Headers) {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    if (["transfer-encoding", "content-encoding", "connection"].includes(key.toLowerCase())) return;
    result[key] = value;
  });
  return result;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
