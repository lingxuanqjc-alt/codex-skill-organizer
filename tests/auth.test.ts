import assert from "node:assert/strict";
import test from "node:test";
import type { IncomingMessage } from "node:http";
import { SessionManager } from "../src/server/auth.js";

function bearerRequest(token: string): IncomingMessage {
  return { headers: { authorization: `Bearer ${token}` } } as IncomingMessage;
}

test("bearer authentication checks the absolute credential TTL on every request", () => {
  let now = 1_000_000;
  const manager = new SessionManager(1_000, () => now);
  const request = bearerRequest(manager.bootstrapToken);
  assert.deepEqual(manager.authenticate(request), { mode: "bearer" });
  now += 999;
  assert.deepEqual(manager.authenticate(request), { mode: "bearer" });
  now += 1;
  assert.equal(manager.credentialsExpired, true);
  assert.equal(manager.authenticate(request), null);
});

test("an expired bootstrap credential cannot be exchanged for a fresh cookie session", () => {
  let now = 2_000_000;
  const manager = new SessionManager(1_000, () => now);
  now += 1_000;
  assert.equal(manager.exchangeBootstrapToken(manager.bootstrapToken), null);
});

test("cookie authentication checks session TTL on every request", () => {
  let now = 1_000_000;
  const manager = new SessionManager(1_000, () => now);
  const session = manager.exchangeBootstrapToken(manager.bootstrapToken);
  assert.ok(session);
  const request = { headers: { cookie: `cso_session=${session.id}` } } as IncomingMessage;
  assert.ok(manager.authenticate(request));
  now += 1_000;
  assert.equal(manager.authenticate(request), null);
});
