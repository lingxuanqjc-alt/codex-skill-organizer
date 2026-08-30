import assert from "node:assert/strict";
import test from "node:test";
import { probePathLocation } from "../src/core/windows-path-probe.js";

test("Windows mapped network drives and probe failures fail closed", async () => {
  assert.equal(await probePathLocation("\\\\server\\share\\skills", {
    platform: "win32",
    resolveWindowsDriveType: async () => { throw new Error("UNC must not invoke a drive probe"); },
  }), "network");
  assert.equal(await probePathLocation("Z:\\skills", {
    platform: "win32",
    resolveWindowsDriveType: async (root) => {
      assert.equal(root, "Z:\\");
      return "Network";
    },
  }), "network");
  assert.equal(await probePathLocation("Z:\\skills", {
    platform: "win32",
    resolveWindowsDriveType: async () => { throw new Error("probe unavailable"); },
  }), "unknown");
  assert.equal(await probePathLocation("C:\\skills", {
    platform: "win32",
    resolveWindowsDriveType: async () => "Fixed",
  }), "local");
});

test("Windows drive probe reserves 15 seconds for cold PowerShell startup", async () => {
  let observedTimeoutMs: number | undefined;
  const location = await probePathLocation("C:\\skills", {
    platform: "win32",
    resolveWindowsDriveType: async (_root, timeoutMs) => {
      observedTimeoutMs = timeoutMs;
      return "Fixed";
    },
  });

  assert.equal(location, "local");
  assert.equal(observedTimeoutMs, 15_000);
});
