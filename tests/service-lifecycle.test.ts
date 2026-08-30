import assert from "node:assert/strict";
import test from "node:test";
import { ServiceLifecycle } from "../src/server/service-lifecycle.js";

test("a hidden desktop cannot retire a shared service while MCP requests remain active", () => {
  let now = 1_000_000;
  const lifecycle = new ServiceLifecycle({
    idleTimeoutMs: 30 * 60_000,
    desktopLeaseTtlMs: 90_000,
    now: () => now,
  });

  lifecycle.updateDesktopLease("desktop-fixture", true, 1);
  now += 60_000;
  lifecycle.updateDesktopLease("desktop-fixture", false, 2);

  now += 29 * 60_000;
  lifecycle.recordRequest(); // An MCP tool request while the window is hidden.
  now += 2 * 60_000;
  assert.equal(
    lifecycle.shouldShutdown(),
    false,
    "MCP activity must restart the server-side idle window instead of letting the desktop kill the process",
  );

  now += 28 * 60_000;
  assert.equal(lifecycle.shouldShutdown(), true);
});

test("desktop lease generations reject a delayed hidden continuation after wake-up", () => {
  let now = 5_000_000;
  const lifecycle = new ServiceLifecycle({
    idleTimeoutMs: 30 * 60_000,
    desktopLeaseTtlMs: 90_000,
    now: () => now,
  });

  lifecycle.updateDesktopLease("desktop-fixture", false, 4);
  const wake = lifecycle.updateDesktopLease("desktop-fixture", true, 5);
  const delayedHide = lifecycle.updateDesktopLease("desktop-fixture", false, 4);
  assert.equal(wake.accepted, true);
  assert.equal(delayedHide.accepted, false);

  now += 60_000;
  assert.equal(
    lifecycle.shouldShutdown(),
    false,
    "a stale release must not cancel the newer visible-window lease",
  );

  now += 29 * 60_000 + 1_000;
  assert.equal(
    lifecycle.shouldShutdown(),
    true,
    "a crashed desktop must not keep the service alive after its lease and idle deadlines",
  );
});
