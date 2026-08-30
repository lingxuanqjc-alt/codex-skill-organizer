import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AppServerClient } from "../src/core/app-server-client.js";
import { InventoryService } from "../src/core/inventory-service.js";
import { SessionManager } from "../src/server/auth.js";
import { startOrganizerHttpServer } from "../src/server/http-server.js";
import { ServiceLifecycle } from "../src/server/service-lifecycle.js";
import { isFetchBlockedPort } from "../src/server/safe-listen.js";
import { writeSkill } from "./helpers.js";

async function createPublicDirectory(root: string): Promise<string> {
  const directory = path.join(root, "public");
  await mkdir(directory, { recursive: true });
  await Promise.all([
    writeFile(path.join(directory, "index.html"), "<!doctype html><title>fixture</title>", "utf8"),
    writeFile(path.join(directory, "app.js"), "export {};", "utf8"),
    writeFile(path.join(directory, "styles.css"), ":root {}", "utf8"),
    writeFile(path.join(directory, "premium-minimal.css"), ":root {}", "utf8"),
  ]);
  return directory;
}

class RuntimeFixtureAppServer extends AppServerClient {
  #enabled = true;

  constructor(readonly skillPath: string) {
    super({ command: "unused" });
  }

  override get isRunning(): boolean { return true; }
  override async start(): Promise<void> {}
  override async stop(): Promise<void> {}
  override async listSkills() {
    return [{
      cwd: "fixture",
      skills: [{
        name: path.basename(path.dirname(this.skillPath)),
        description: "Ordinary runtime bearer boundary fixture",
        path: this.skillPath,
        scope: "user" as const,
        enabled: this.#enabled,
        pluginId: null,
      }],
      errors: [],
    }];
  }
  override async setSkillEnabled(_skillPath: string, enabled: boolean): Promise<boolean> {
    this.#enabled = enabled;
    return enabled;
  }
}

test("HTTP boundary enforces loopback sessions, Origin, CSRF, and stale revisions", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cso-http-"));
  const skillRoot = path.join(temporary, "skills");
  const statePath = path.join(temporary, "organizer.db");
  await writeSkill(skillRoot, "fixture-skill", {
    name: "fixture-skill",
    description: "Test the authenticated mutation boundary.",
  });
  const inventory = new InventoryService({
    roots: [{ id: "fixture", label: "Fixture", path: skillRoot, kind: "codex" }],
    statePath,
    appServer: null,
  });
  await inventory.initialize();
  const running = await startOrganizerHttpServer({
    inventory,
    publicDirectory: await createPublicDirectory(temporary),
  });

  try {
    assert.equal(isFetchBlockedPort(running.port), false, "the published loopback URL must be fetchable by Chromium");
    const page = await fetch(running.baseUrl);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
    assert.match(page.headers.get("content-security-policy") ?? "", /object-src 'none'/);

    const unauthorized = await fetch(`${running.baseUrl}/api/inventory`);
    assert.equal(unauthorized.status, 401);

    const foreignOrigin = await fetch(`${running.baseUrl}/api/health`, {
      headers: { Origin: "https://example.com" },
    });
    assert.equal(foreignOrigin.status, 403);

    const exchange = await fetch(`${running.baseUrl}/api/session`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${running.bootstrapToken}`,
        Origin: running.baseUrl,
      },
    });
    assert.equal(exchange.status, 200);
    const cookie = (exchange.headers.get("set-cookie") ?? "").split(";", 1)[0];
    const { csrf } = await exchange.json() as { csrf: string };
    assert.ok(cookie.startsWith("cso_session="));
    assert.ok(csrf.length >= 24);

    const withoutCsrf = await fetch(`${running.baseUrl}/api/classification`, {
      method: "PATCH",
      headers: { Cookie: cookie, "Content-Type": "application/json", Origin: running.baseUrl },
      body: JSON.stringify({ skillIds: [inventory.snapshot.skills[0]!.skillId], expectedRevision: inventory.snapshot.revision }),
    });
    assert.equal(withoutCsrf.status, 403);

    const stale = await fetch(`${running.baseUrl}/api/classification`, {
      method: "PATCH",
      headers: {
        Cookie: cookie,
        "Content-Type": "application/json",
        Origin: running.baseUrl,
        "X-CSO-CSRF": csrf,
      },
      body: JSON.stringify({
        skillIds: [inventory.snapshot.skills[0]!.skillId],
        expectedRevision: "stale-revision",
        favorite: true,
      }),
    });
    assert.equal(stale.status, 409);
    assert.equal(inventory.snapshot.summary.favorites, 0);
  } finally {
    await running.close();
    await inventory.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("an MCP bearer cannot self-confirm sensitive runtime writes, while ordinary runtime writes remain available", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cso-runtime-bearer-"));
  const skillRoot = path.join(temporary, "skills");
  const skillPath = await writeSkill(skillRoot, "runtime-fixture", {
    name: "runtime-fixture",
    description: "Verify the MCP bearer confirmation boundary.",
  });
  const appServer = new RuntimeFixtureAppServer(skillPath);
  const inventory = new InventoryService({
    roots: [{ id: "fixture", label: "Fixture", path: skillRoot, kind: "codex" }],
    statePath: path.join(temporary, "organizer.db"),
    appServer,
  });
  await inventory.initialize();
  await inventory.setManagementMode(true);
  const running = await startOrganizerHttpServer({
    inventory,
    publicDirectory: await createPublicDirectory(temporary),
  });
  try {
    const instanceId = inventory.snapshot.skills[0]!.instances![0]!.instanceId;
    const claimedConfirmation = await fetch(`${running.baseUrl}/api/runtime-enabled`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${running.bootstrapToken}`,
        "Content-Type": "application/json",
        Origin: running.baseUrl,
      },
      body: JSON.stringify({
        skillIds: [instanceId],
        enabled: false,
        expectedRevision: inventory.snapshot.revision,
        confirmedSensitive: true,
      }),
    });
    assert.equal(claimedConfirmation.status, 403);
    assert.equal(inventory.snapshot.skills[0]?.runtimeEnabled, true);

    const ordinaryWrite = await fetch(`${running.baseUrl}/api/runtime-enabled`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${running.bootstrapToken}`,
        "Content-Type": "application/json",
        Origin: running.baseUrl,
      },
      body: JSON.stringify({
        skillIds: [instanceId],
        enabled: false,
        expectedRevision: inventory.snapshot.revision,
      }),
    });
    assert.equal(ordinaryWrite.status, 200);
    assert.equal(inventory.snapshot.skills[0]?.runtimeEnabled, false);
  } finally {
    await running.close();
    await inventory.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("management mode cannot be enabled by an MCP bearer session", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cso-management-"));
  const skillRoot = path.join(temporary, "skills");
  await writeSkill(skillRoot, "fixture-skill", {
    name: "fixture-skill",
    description: "Preserve the current state when an import is malformed.",
  });
  const sessionProject = path.join(temporary, "session-project");
  await writeSkill(path.join(sessionProject, ".codex", "skills"), "repo-context", {
    name: "repo-context",
    description: "Codex session project context",
  });
  const inventory = new InventoryService({
    roots: [{ id: "fixture", label: "Fixture", path: skillRoot, kind: "codex" }],
    statePath: path.join(temporary, "organizer.db"),
    appServer: null,
  });
  await inventory.initialize();
  const running = await startOrganizerHttpServer({
    inventory,
    publicDirectory: await createPublicDirectory(temporary),
  });

  try {
    const response = await fetch(`${running.baseUrl}/api/management-mode`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${running.bootstrapToken}`,
        "Content-Type": "application/json",
        Origin: running.baseUrl,
      },
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(response.status, 403);
    assert.equal(inventory.managementMode, false);

    const projectContext = await fetch(`${running.baseUrl}/api/session-project`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${running.bootstrapToken}`,
        "Content-Type": "application/json",
        Origin: running.baseUrl,
      },
      body: JSON.stringify({ sessionId: "mcp-session-http-fixture", projectPaths: [sessionProject] }),
    });
    assert.equal(projectContext.status, 200, await projectContext.clone().text());
    assert.ok(inventory.snapshot.skills.some((skill) => skill.name === "repo-context" && skill.scope === "repo"));

    const clearProjectContext = await fetch(`${running.baseUrl}/api/session-project`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${running.bootstrapToken}`,
        "Content-Type": "application/json",
        Origin: running.baseUrl,
      },
      body: JSON.stringify({ sessionId: "mcp-session-http-fixture", projectPaths: [] }),
    });
    assert.equal(clearProjectContext.status, 200);
    assert.equal(inventory.snapshot.skills.some((skill) => skill.name === "repo-context"), false);
  } finally {
    await running.close();
    await inventory.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("HTTP server refuses non-loopback bindings", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cso-host-"));
  const inventory = new InventoryService({ roots: [], statePath: path.join(temporary, "organizer.db"), appServer: null });
  await inventory.initialize();
  await assert.rejects(
    startOrganizerHttpServer({ inventory, publicDirectory: await createPublicDirectory(temporary), host: "0.0.0.0" }),
    /只能绑定 127\.0\.0\.1/,
  );
  await inventory.close();
  await rm(temporary, { recursive: true, force: true });
});

test("authenticated desktop leases are generation-safe and MCP requests refresh shared idle activity", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cso-service-lease-"));
  let now = 10_000_000;
  const lifecycle = new ServiceLifecycle({
    idleTimeoutMs: 30 * 60_000,
    desktopLeaseTtlMs: 90_000,
    now: () => now,
  });
  const inventory = new InventoryService({ roots: [], statePath: path.join(temporary, "organizer.db"), appServer: null });
  await inventory.initialize();
  const running = await startOrganizerHttpServer({
    inventory,
    serviceLifecycle: lifecycle,
    publicDirectory: await createPublicDirectory(temporary),
  });
  try {
    const updateLease = (active: boolean, generation: number) => fetch(`${running.baseUrl}/api/desktop-lease`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${running.bootstrapToken}`,
        "Content-Type": "application/json",
        Origin: running.baseUrl,
      },
      body: JSON.stringify({ leaseId: "desktop-http-fixture", active, generation }),
    });
    assert.equal((await updateLease(true, 2)).status, 200);
    const staleRelease = await updateLease(false, 1);
    assert.equal(staleRelease.status, 200);
    assert.equal((await staleRelease.json() as { accepted: boolean }).accepted, false);

    now += 60_000;
    assert.equal(lifecycle.shouldShutdown(), false);
    assert.equal((await updateLease(false, 3)).status, 200);
    now += 29 * 60_000;
    assert.equal((await fetch(`${running.baseUrl}/api/inventory`, {
      headers: { Authorization: `Bearer ${running.bootstrapToken}` },
    })).status, 200);
    now += 2 * 60_000;
    assert.equal(lifecycle.shouldShutdown(), false, "an authenticated MCP request must postpone shared idle shutdown");
  } finally {
    await running.close();
    await inventory.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("expired shared credentials make health fail closed so MCP can launch a fresh service", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cso-expired-health-"));
  let now = 5_000_000;
  const sessions = new SessionManager(1_000, () => now);
  const inventory = new InventoryService({ roots: [], statePath: path.join(temporary, "organizer.db"), appServer: null });
  await inventory.initialize();
  const running = await startOrganizerHttpServer({
    inventory,
    sessionManager: sessions,
    publicDirectory: await createPublicDirectory(temporary),
  });
  try {
    assert.equal((await fetch(`${running.baseUrl}/api/health`)).status, 200);
    now += 1_000;
    assert.equal((await fetch(`${running.baseUrl}/api/health`)).status, 503);
    assert.equal((await fetch(`${running.baseUrl}/api/inventory`, {
      headers: { Authorization: `Bearer ${running.bootstrapToken}` },
    })).status, 401);
    assert.equal((await fetch(`${running.baseUrl}/api/session`, {
      method: "POST",
      headers: { Authorization: `Bearer ${running.bootstrapToken}`, Origin: running.baseUrl },
    })).status, 401);
  } finally {
    await running.close();
    await inventory.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("default diagnostics replace raw scan messages and absolute user paths with safe codes", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cso-diagnostics-"));
  const missingRoot = path.join(temporary, "private", "missing-skills");
  const inventory = new InventoryService({
    roots: [{ id: "missing", label: "Missing fixture", path: missingRoot, kind: "fixture" }],
    statePath: path.join(temporary, "organizer.db"),
    appServer: null,
  });
  await inventory.initialize();
  const running = await startOrganizerHttpServer({
    inventory,
    publicDirectory: await createPublicDirectory(temporary),
  });
  try {
    const exchange = await fetch(`${running.baseUrl}/api/session`, {
      method: "POST",
      headers: { Authorization: `Bearer ${running.bootstrapToken}`, Origin: running.baseUrl },
    });
    const cookie = (exchange.headers.get("set-cookie") ?? "").split(";", 1)[0];
    const response = await fetch(`${running.baseUrl}/api/diagnostics`, {
      headers: { Cookie: cookie, Origin: running.baseUrl },
    });
    assert.equal(response.status, 200);
    const diagnostics = await response.json() as {
      roots: Array<{ path: string }>;
      scanErrors: Array<{ path: string; code: string; message: string }>;
    };
    assert.ok(diagnostics.scanErrors.length > 0);
    assert.equal(diagnostics.scanErrors[0]?.code, "SCAN_PATH_MISSING");
    assert.equal(diagnostics.scanErrors[0]?.message, "扫描路径不存在或当前不可用");
    const serialized = JSON.stringify(diagnostics);
    assert.equal(serialized.includes(missingRoot), false);
    assert.equal(serialized.toLocaleLowerCase("en-US").includes(os.userInfo().username.toLocaleLowerCase("en-US")), false);
    assert.ok(diagnostics.roots[0]?.path.startsWith("%USERPROFILE%") || diagnostics.roots[0]?.path.startsWith("%LOCAL_PATH%"));
  } finally {
    await running.close();
    await inventory.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("a full support bundle requires desktop cookie, CSRF, and a second explicit sensitive-data confirmation", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cso-support-bundle-"));
  const skillRoot = path.join(temporary, "private skills");
  await writeSkill(skillRoot, "support-fixture", {
    name: "support-fixture",
    description: "THIS_DESCRIPTION_MUST_NOT_ENTER_THE_SUPPORT_BUNDLE",
  });
  const inventory = new InventoryService({
    roots: [{ id: "fixture", label: "Private fixture", path: skillRoot, kind: "fixture" }],
    statePath: path.join(temporary, "data", "organizer.db"),
    appServer: null,
  });
  await inventory.initialize();
  const protectedPaths: string[] = [];
  const running = await startOrganizerHttpServer({
    inventory,
    publicDirectory: await createPublicDirectory(temporary),
    supportFileProtector: async (targetPath) => { protectedPaths.push(targetPath); },
  });
  try {
    const bearer = await fetch(`${running.baseUrl}/api/support-bundle`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${running.bootstrapToken}`,
        "Content-Type": "application/json",
        Origin: running.baseUrl,
      },
      body: JSON.stringify({ confirmed: true, includeSensitiveDiagnostics: true }),
    });
    assert.equal(bearer.status, 403);

    const exchange = await fetch(`${running.baseUrl}/api/session`, {
      method: "POST",
      headers: { Authorization: `Bearer ${running.bootstrapToken}`, Origin: running.baseUrl },
    });
    const cookie = (exchange.headers.get("set-cookie") ?? "").split(";", 1)[0];
    const { csrf } = await exchange.json() as { csrf: string };
    const missingConfirmation = await fetch(`${running.baseUrl}/api/support-bundle`, {
      method: "POST",
      headers: { Cookie: cookie, "X-CSO-CSRF": csrf, "Content-Type": "application/json", Origin: running.baseUrl },
      body: JSON.stringify({ confirmed: true }),
    });
    assert.equal(missingConfirmation.status, 400);

    const bearerPluginLink = await fetch(`${running.baseUrl}/api/plugin-management-link`, {
      headers: { Authorization: `Bearer ${running.bootstrapToken}`, Origin: running.baseUrl },
    });
    assert.equal(bearerPluginLink.status, 403);
    const pluginLinkResponse = await fetch(`${running.baseUrl}/api/plugin-management-link`, {
      headers: { Cookie: cookie, Origin: running.baseUrl },
    });
    assert.equal(pluginLinkResponse.status, 200);
    const pluginLink = await pluginLinkResponse.json() as { href: string };
    const parsedPluginLink = new URL(pluginLink.href);
    assert.equal(parsedPluginLink.protocol, "codex:");
    assert.equal(parsedPluginLink.host, "plugins");
    assert.equal(parsedPluginLink.pathname, "/codex-skill-organizer");
    assert.equal(parsedPluginLink.searchParams.get("marketplacePath"), path.join(os.homedir(), ".agents", "plugins", "marketplace.json"));

    const created = await fetch(`${running.baseUrl}/api/support-bundle`, {
      method: "POST",
      headers: { Cookie: cookie, "X-CSO-CSRF": csrf, "Content-Type": "application/json", Origin: running.baseUrl },
      body: JSON.stringify({ confirmed: true, includeSensitiveDiagnostics: true }),
    });
    assert.equal(created.status, 201);
    const result = await created.json() as { path: string; sha256: string; sizeBytes: number };
    assert.equal(path.dirname(result.path), path.join(temporary, "data", "support-bundles"));
    assert.match(result.sha256, /^[a-f0-9]{64}$/u);
    assert.ok(result.sizeBytes > 0);
    assert.deepEqual(protectedPaths, [path.dirname(result.path), result.path]);
    const serialized = await readFile(result.path, "utf8");
    const supportPayload = JSON.parse(serialized) as {
      inventory: { roots: Array<{ path: string }> };
    };
    assert.ok(
      supportPayload.inventory.roots.some((root) => root.path === skillRoot),
      "the explicitly confirmed bundle contains exact raw paths",
    );
    assert.equal(serialized.includes("THIS_DESCRIPTION_MUST_NOT_ENTER_THE_SUPPORT_BUNDLE"), false);
    assert.equal(serialized.includes(running.bootstrapToken), false);
    assert.equal(serialized.includes(csrf), false);
    assert.equal(serialized.includes(cookie), false);
    assert.match(serialized, /SKILL\.md bodies and descriptions/u);
  } finally {
    await running.close();
    await inventory.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("installation boundaries and actual quarantine execution remain desktop-cookie-only", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cso-http-quarantine-"));
  const skillRoot = path.join(temporary, "skills");
  await writeSkill(skillRoot, "managed-fixture", {
    name: "managed-fixture",
    description: "A safe quarantine boundary fixture",
  });
  const inventory = new InventoryService({
    roots: [{ id: "fixture", label: "Fixture", path: skillRoot, kind: "codex" }],
    statePath: path.join(temporary, "data", "organizer.db"),
    appServer: null,
  });
  await inventory.initialize();
  const running = await startOrganizerHttpServer({
    inventory,
    publicDirectory: await createPublicDirectory(temporary),
  });
  try {
    const exchange = await fetch(`${running.baseUrl}/api/session`, {
      method: "POST",
      headers: { Authorization: `Bearer ${running.bootstrapToken}`, Origin: running.baseUrl },
    });
    const cookie = (exchange.headers.get("set-cookie") ?? "").split(";", 1)[0];
    const { csrf } = await exchange.json() as { csrf: string };
    const quarantine = await fetch(`${running.baseUrl}/api/quarantine`, {
      headers: { Cookie: cookie, Origin: running.baseUrl },
    });
    const payload = await quarantine.json() as { candidates: Array<{ installationUnitId: string; confirmed: boolean }> };
    assert.equal(payload.candidates.length, 1);
    assert.equal(payload.candidates[0]?.confirmed, false);

    const bearerConfirm = await fetch(`${running.baseUrl}/api/installation-units/confirm`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${running.bootstrapToken}`,
        "Content-Type": "application/json",
        Origin: running.baseUrl,
      },
      body: JSON.stringify({
        installationUnitIds: [payload.candidates[0]!.installationUnitId],
        expectedRevision: inventory.snapshot.revision,
      }),
    });
    assert.equal(bearerConfirm.status, 403);

    const confirmed = await fetch(`${running.baseUrl}/api/installation-units/confirm`, {
      method: "POST",
      headers: { Cookie: cookie, "X-CSO-CSRF": csrf, "Content-Type": "application/json", Origin: running.baseUrl },
      body: JSON.stringify({
        installationUnitIds: [payload.candidates[0]!.installationUnitId],
        expectedRevision: inventory.snapshot.revision,
      }),
    });
    assert.equal(confirmed.status, 200, await confirmed.clone().text());
    const confirmedPayload = await confirmed.json() as { snapshot: { revision: string } };

    const prepared = await fetch(`${running.baseUrl}/api/quarantine/prepare`, {
      method: "POST",
      headers: { Cookie: cookie, "X-CSO-CSRF": csrf, "Content-Type": "application/json", Origin: running.baseUrl },
      body: JSON.stringify({
        installationUnitIds: [payload.candidates[0]!.installationUnitId],
        expectedRevision: confirmedPayload.snapshot.revision,
      }),
    });
    assert.equal(prepared.status, 200);
    const planPayload = await prepared.json() as { plans: Array<{ planId: string }> };

    const bearerExecute = await fetch(`${running.baseUrl}/api/quarantine/execute`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${running.bootstrapToken}`,
        "Content-Type": "application/json",
        Origin: running.baseUrl,
      },
      body: JSON.stringify({
        planId: planPayload.plans[0]!.planId,
        confirmed: true,
        expectedRevision: confirmedPayload.snapshot.revision,
      }),
    });
    assert.equal(bearerExecute.status, 403);

    const bearerRestore = await fetch(`${running.baseUrl}/api/quarantine/restore`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${running.bootstrapToken}`,
        "Content-Type": "application/json",
        Origin: running.baseUrl,
      },
      body: JSON.stringify({ quarantineEntryIds: ["caller-controlled"], confirmed: true }),
    });
    assert.equal(bearerRestore.status, 403);
  } finally {
    await running.close();
    await inventory.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("safe undo can be listed and executed only by a desktop cookie session, never by an MCP bearer", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cso-http-undo-"));
  const skillRoot = path.join(temporary, "skills");
  await writeSkill(skillRoot, "undo-fixture", {
    name: "undo-fixture",
    description: "Authenticated safe undo fixture",
  });
  const inventory = new InventoryService({
    roots: [{ id: "fixture", label: "Fixture", path: skillRoot, kind: "fixture" }],
    statePath: path.join(temporary, "organizer.db"),
    appServer: null,
  });
  await inventory.initialize();
  const running = await startOrganizerHttpServer({
    inventory,
    publicDirectory: await createPublicDirectory(temporary),
  });
  try {
    const exchange = await fetch(`${running.baseUrl}/api/session`, {
      method: "POST",
      headers: { Authorization: `Bearer ${running.bootstrapToken}`, Origin: running.baseUrl },
    });
    const cookie = (exchange.headers.get("set-cookie") ?? "").split(";", 1)[0];
    const { csrf } = await exchange.json() as { csrf: string };
    const skillId = inventory.snapshot.skills[0]!.skillId;
    const classified = await fetch(`${running.baseUrl}/api/classification`, {
      method: "PATCH",
      headers: { Cookie: cookie, "X-CSO-CSRF": csrf, "Content-Type": "application/json", Origin: running.baseUrl },
      body: JSON.stringify({ skillIds: [skillId], expectedRevision: inventory.snapshot.revision, favorite: true }),
    });
    assert.equal(classified.status, 200);

    const bearerList = await fetch(`${running.baseUrl}/api/undo-actions`, {
      headers: { Authorization: `Bearer ${running.bootstrapToken}`, Origin: running.baseUrl },
    });
    assert.equal(bearerList.status, 403);
    const cookieList = await fetch(`${running.baseUrl}/api/undo-actions`, {
      headers: { Cookie: cookie, Origin: running.baseUrl },
    });
    assert.equal(cookieList.status, 200);
    const { actions } = await cookieList.json() as { actions: Array<{ operationId: string; available: boolean }> };
    assert.equal(actions[0]?.available, true);

    const bearerUndo = await fetch(`${running.baseUrl}/api/undo-actions/execute`, {
      method: "POST",
      headers: { Authorization: `Bearer ${running.bootstrapToken}`, "Content-Type": "application/json", Origin: running.baseUrl },
      body: JSON.stringify({ operationIds: [actions[0]!.operationId], expectedRevision: inventory.snapshot.revision }),
    });
    assert.equal(bearerUndo.status, 403);
    assert.equal(inventory.snapshot.skills[0]?.favorite, true);

    const cookieUndo = await fetch(`${running.baseUrl}/api/undo-actions/execute`, {
      method: "POST",
      headers: { Cookie: cookie, "X-CSO-CSRF": csrf, "Content-Type": "application/json", Origin: running.baseUrl },
      body: JSON.stringify({ operationIds: [actions[0]!.operationId], expectedRevision: inventory.snapshot.revision }),
    });
    assert.equal(cookieUndo.status, 200);
    assert.equal(inventory.snapshot.skills[0]?.favorite, false);
  } finally {
    await running.close();
    await inventory.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
