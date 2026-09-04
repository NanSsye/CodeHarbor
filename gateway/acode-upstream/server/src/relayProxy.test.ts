import assert from "node:assert/strict";
import test from "node:test";
import { proxyLocalRequest } from "./relayProxy.js";

test("relay proxy rejects oversized encoded request before decoding", async () => {
  const sent: string[] = [];
  await proxyLocalRequest({
    message: {
      requestId: "oversized",
      method: "POST",
      path: "/sessions",
      bodyBase64: "A".repeat(23 * 1024 * 1024)
    },
    localOrigin: "http://127.0.0.1:1",
    gatewayAuthToken: "test-token",
    send: (text) => sent.push(text)
  });
  assert.equal(sent.length, 1);
  assert.equal(JSON.parse(sent[0]!).status, 413);
});
