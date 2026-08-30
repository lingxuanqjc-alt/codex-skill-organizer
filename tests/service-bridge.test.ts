import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  OrganizerServiceBridge,
  isReusableRuntimeCredential,
  modelSafeServiceStartFailure,
  resolveTrustedServiceLauncher,
  RUNTIME_CREDENTIAL_REUSE_MARGIN_MS,
  SERVICE_START_FAILED_MESSAGE,
} from "../src/plugin/service-bridge.js";
import type { InventorySnapshot } from "../src/shared/types.js";

test("expired and near-expiry descriptors are rejected before an MCP retry can reuse their bearer", () => {
  const now = 10_000_000;
  assert.equal(isReusableRuntimeCredential(undefined, now), false);
  assert.equal(isReusableRuntimeCredential(now, now), false);
  assert.equal(isReusableRuntimeCredential(now + RUNTIME_CREDENTIAL_REUSE_MARGIN_MS, now), false);
  assert.equal(isReusableRuntimeCredential(now + RUNTIME_CREDENTIAL_REUSE_MARGIN_MS + 1, now), true);
});

test("service startup faults discard launcher output, private paths, and credential-like details at the MCP boundary", () => {
  const privateDetail = "spawn C:\\Users\\private-user\\AppData\\Local\\launcher.exe failed; token=super-secret";
  const safeError = modelSafeServiceStartFailure(new Error(privateDetail));
  assert.equal(safeError.message, SERVICE_START_FAILED_MESSAGE);
  assert.equal(safeError.cause, undefined);
  assert.ok(!safeError.message.includes("private-user"));
  assert.ok(!safeError.message.includes("super-secret"));
});

test("service launcher ignores arbitrary environment-style paths and probes only stable or payload-owned locations", () => {
  const home = "C:\\Users\\fixture";
  const stable = path.join(home, "AppData", "Local", "Programs", "SkillOrganizerForCodex", "SkillOrganizerForCodex.exe");
  const attacker = "C:\\attacker\\SkillOrganizerForCodex.exe";
  const probes: string[] = [];
  const result = resolveTrustedServiceLauncher({
    platform: "win32",
    homedir: () => home,
    packageRoot: "C:\\unrelated\\plugin-cache",
    exists: (candidate) => {
      probes.push(candidate);
      return candidate === attacker;
    },
  });
  assert.equal(result, null);
  assert.deepEqual(probes, [stable]);
  assert.ok(!probes.includes(attacker));
});

test("portable service launcher is accepted only when derived from a complete current payload", () => {
  const packageRoot = "D:\\Portable Organizer\\versions\\0.2.0\\app";
  const payloadRoot = path.dirname(packageRoot);
  const launcher = path.join(payloadRoot, "SkillOrganizerForCodex.exe");
  const required = new Set([
    launcher,
    path.join(payloadRoot, "runtime", "node.exe"),
    path.join(packageRoot, "dist", "server.mjs"),
  ]);
  const result = resolveTrustedServiceLauncher({
    platform: "win32",
    homedir: () => "C:\\Users\\fixture",
    packageRoot,
    exists: (candidate) => required.has(candidate),
  });
  assert.equal(result, launcher);
});

test("every MCP tool request renews its session project lease at the shared bridge boundary", async () => {
  const events: string[] = [];
  const descriptor = {
    service: "codex-skill-organizer" as const,
    version: "0.2.0",
    protocolVersion: "2.0",
    protocolMin: "2.0",
    protocolMax: "2.x",
    pid: 1234,
    port: 49152,
    host: "127.0.0.1" as const,
    token: "fixture-token-that-is-longer-than-thirty-two-characters",
    credentialExpiresAt: Date.now() + 60_000,
    installRoot: path.resolve("fixture-install"),
  };
  const snapshot = {
    revision: "fixture-revision",
    generatedAt: new Date(0).toISOString(),
    skills: [],
    summary: {
      total: 0,
      runtimeVisible: 0,
      cacheOnly: 0,
      pending: 0,
      favorites: 0,
      duplicateNames: 0,
      byScope: { user: 0, agents: 0, system: 0, plugin: 0, repo: 0, custom: 0 },
      byCategory: { pending: 0 },
    },
    scanErrors: [],
    orphanOverrideIds: [],
    runtimeAvailable: false,
    runtimeError: null,
    managementMode: false,
    protocolVersion: "2.0",
  } as unknown as InventorySnapshot;
  const bridge = new OrganizerServiceBridge({
    sessionId: "mcp-renew-fixture",
    readHealthyDescriptor: async () => descriptor,
    launchService: async () => assert.fail("an already healthy fixture must be reused"),
    fetchImpl: async (input) => {
      const pathname = new URL(String(input)).pathname;
      events.push(pathname);
      return Response.json(pathname === "/api/inventory" ? snapshot : {});
    },
  });
  bridge.setSessionProjectRootsProvider(async () => [path.resolve("fixture-project")]);

  await bridge.getInventory();
  await bridge.getInventory();

  const inventoryIndexes = events
    .map((event, index) => event === "/api/inventory" ? index : -1)
    .filter((index) => index >= 0);
  assert.equal(inventoryIndexes.length, 2);
  for (const index of inventoryIndexes) {
    assert.equal(
      events[index - 1],
      "/api/session-project",
      "the bridge must renew immediately before each model-visible tool request",
    );
  }
});
