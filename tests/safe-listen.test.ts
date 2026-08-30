import assert from "node:assert/strict";
import test from "node:test";
import {
  isFetchBlockedPort,
  selectFetchSafeListeningEndpoint,
  type ListeningEndpoint,
} from "../src/server/safe-listen.js";

interface FakeListener {
  port: number;
  listening: boolean;
  closeCalls: number;
}

function fakeEndpoint(listener: FakeListener): ListeningEndpoint<FakeListener> {
  return {
    resource: listener,
    port: listener.port,
    close: async () => {
      listener.closeCalls += 1;
      listener.listening = false;
    },
  };
}

test("a Fetch-blocked OS-selected port is closed before a safe listener is accepted", async () => {
  const listeners: FakeListener[] = [
    { port: 6_667, listening: true, closeCalls: 0 },
    { port: 49_152, listening: true, closeCalls: 0 },
  ];
  let next = 0;

  const selected = await selectFetchSafeListeningEndpoint(async () => fakeEndpoint(listeners[next++]!), 2);

  assert.equal(selected.resource, listeners[1]);
  assert.equal(listeners[0]!.listening, false, "the forbidden listener must not remain bound");
  assert.equal(listeners[0]!.closeCalls, 1);
  assert.equal(listeners[1]!.listening, true, "the accepted safe listener remains available");
  assert.equal(listeners[1]!.closeCalls, 0);
  await selected.close();
});

test("a safe OS-selected port is accepted without a redundant close or retry", async () => {
  const listener: FakeListener = { port: 49_153, listening: true, closeCalls: 0 };
  let attempts = 0;

  const selected = await selectFetchSafeListeningEndpoint(async () => {
    attempts += 1;
    return fakeEndpoint(listener);
  });

  assert.equal(attempts, 1);
  assert.equal(selected.port, 49_153);
  assert.equal(listener.listening, true);
  assert.equal(listener.closeCalls, 0);
  await selected.close();
});

test("retry exhaustion fails explicitly and leaves no rejected listener bound", async () => {
  const listeners: FakeListener[] = [
    { port: 6_000, listening: true, closeCalls: 0 },
    { port: 6_665, listening: true, closeCalls: 0 },
    { port: 10_080, listening: true, closeCalls: 0 },
  ];
  let next = 0;

  await assert.rejects(
    selectFetchSafeListeningEndpoint(async () => fakeEndpoint(listeners[next++]!), listeners.length),
    /连续 3 次被分配到浏览器禁止端口.*6000, 6665, 10080.*未留下监听器/u,
  );

  assert.equal(next, listeners.length, "the retry limit must be strict");
  for (const listener of listeners) {
    assert.equal(listener.listening, false);
    assert.equal(listener.closeCalls, 1);
  }
});

test("the blocked-port predicate includes the current Fetch bad-port boundary", () => {
  assert.equal(isFetchBlockedPort(0), true);
  assert.equal(isFetchBlockedPort(6_000), true);
  assert.equal(isFetchBlockedPort(10_080), true);
  assert.equal(isFetchBlockedPort(49_152), false);
});
