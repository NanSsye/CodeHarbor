import assert from "node:assert/strict";
import test from "node:test";
import { SessionRunState } from "./sessionRunState.js";

test("cancelling invalidates in-flight work without invalidating a later run", () => {
  const state = new SessionRunState();
  const first = state.begin("session-a");
  assert.equal(state.isCurrent("session-a", first), true);

  state.cancel("session-a");
  assert.equal(state.isCurrent("session-a", first), false);

  const second = state.begin("session-a");
  assert.equal(state.isCurrent("session-a", second), true);
  assert.equal(state.isCurrent("session-a", first), false);
});
