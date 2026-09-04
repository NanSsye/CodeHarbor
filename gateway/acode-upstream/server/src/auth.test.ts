import assert from "node:assert/strict";
import test from "node:test";

test("Gateway login limiter blocks repeated failures and resets after success", async () => {
  process.env.ADMIN_TOKEN ??= "test-admin-token-123456";
  process.env.SESSION_SECRET ??= "test-session-secret-123456";
  const { allowLoginAttempt, clearLoginFailures, recordLoginFailure } = await import("./auth.js");
  const ip = `auth-test-${Date.now()}-${Math.random()}`;
  assert.equal(allowLoginAttempt(ip), true);
  for (let index = 0; index < 8; index += 1) recordLoginFailure(ip);
  assert.equal(allowLoginAttempt(ip), false);
  clearLoginFailures(ip);
  assert.equal(allowLoginAttempt(ip), true);
});

test("Gateway WebSocket token parser prefers the CodeHarbor subprotocol", async () => {
  const { getWebSocketProtocolToken } = await import("./auth.js");
  assert.equal(getWebSocketProtocolToken("chat, codeharbor-v1.secret-token"), "secret-token");
  assert.equal(getWebSocketProtocolToken(["other", "codeharbor-v1.second-token"]), "second-token");
  assert.equal(getWebSocketProtocolToken("codeharbor-v1."), undefined);
});

test("Gateway request token ignores repeated query values instead of throwing", async () => {
  const { getRequestToken } = await import("./auth.js");
  const request = { headers: {}, query: { token: ["first", "second"] } } as any;
  assert.equal(getRequestToken(request), undefined);
});
