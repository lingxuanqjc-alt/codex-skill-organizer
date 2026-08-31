import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { FSWatcher } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { AppServerClient, type AppServerProcess } from "../src/core/app-server-client.js";
import { InventoryMutationError, InventoryService, StaleInventoryError } from "../src/core/inventory-service.js";
import { UpdateService, type UpdateCheckOptions, type UpdateCheckResult, type UpdateSubject } from "../src/core/update-service.js";
import type { PathLocation } from "../src/core/windows-path-probe.js";
import { PassThrough } from "node:stream";
import { writeSkill } from "./helpers.js";
import {
  defaultDurableFileOperations,
  type DurableFileOperations,
} from "../src/core/durable-file.js";
import { DatabaseRecoveryError } from "../src/core/database-recovery.js";
import type { DirectoryIdentityOperations, DirectoryIdentityStats } from "../src/core/path-identity.js";
import { scanSkillRoots, type ScanResult } from "../src/core/scanner.js";
import type { RootDefinition } from "../src/shared/types.js";
import {
  OrganizerDatabase,
  SQLITE_SCHEMA_VERSION,
  UnsupportedSchemaVersionError,
} from "../src/v2/index.js";

const localPathLocationProbe = async (): Promise<"local"> => "local";

async function waitUntil(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for inventory background refresh");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function fakeWatcher(): FSWatcher {
  const emitter = new EventEmitter() as EventEmitter & {
    close(): void;
    ref(): FSWatcher;
    unref(): FSWatcher;
  };
  emitter.close = () => undefined;
  emitter.ref = () => emitter as unknown as FSWatcher;
  emitter.unref = () => emitter as unknown as FSWatcher;
  return emitter as unknown as FSWatcher;
}

function observeDurableFileOperations(onOperation: (operation: string) => void): DurableFileOperations {
  return {
    copyFile: async (sourcePath, destinationPath) => {
      onOperation("copyFile");
      await defaultDurableFileOperations.copyFile(sourcePath, destinationPath);
    },
    open: async (filePath, flags, mode) => {
      onOperation("open");
      return defaultDurableFileOperations.open(filePath, flags, mode);
    },
    readFile: async (filePath) => {
      onOperation("readFile");
      return defaultDurableFileOperations.readFile(filePath);
    },
    rename: async (sourcePath, destinationPath) => {
      onOperation("rename");
      await defaultDurableFileOperations.rename(sourcePath, destinationPath);
    },
    unlink: async (filePath) => {
      onOperation("unlink");
      await defaultDurableFileOperations.unlink(filePath);
    },
  };
}

class InventoryFakeProcess extends EventEmitter implements AppServerProcess {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  enabled = true;
  #buffer = "";

  constructor(private readonly skillPath: string) {
    super();
    this.stdin.setEncoding("utf8");
    this.stdin.on("data", (chunk) => this.#handle(String(chunk)));
  }

  kill(): boolean {
    return true;
  }

  #handle(chunk: string): void {
    this.#buffer += chunk;
    while (this.#buffer.includes("\n")) {
      const end = this.#buffer.indexOf("\n");
      const line = this.#buffer.slice(0, end).trim();
      this.#buffer = this.#buffer.slice(end + 1);
      if (!line) continue;
      const request = JSON.parse(line) as Record<string, unknown>;
      if (request.method === "initialize") {
        this.stdout.write(`${JSON.stringify({ id: request.id, result: { userAgent: "fake" } })}\n`);
      } else if (request.method === "skills/list") {
        this.stdout.write(`${JSON.stringify({
          id: request.id,
          result: {
            data: [{
              cwd: "fixture",
              skills: [{
                name: "fixture-skill",
                description: "Fixture",
                path: this.skillPath,
                scope: "user",
                enabled: this.enabled,
                pluginId: null,
              }],
              errors: [],
            }],
          },
        })}\n`);
      } else if (request.method === "skills/config/write") {
        this.enabled = Boolean((request.params as { enabled: boolean }).enabled);
        this.stdout.write(`${JSON.stringify({ id: request.id, result: { effectiveEnabled: this.enabled } })}\n`);
      }
    }
  }
}

class CapturingUpdateService extends UpdateService {
  readonly subjects: UpdateSubject[] = [];

  override async check(subject: UpdateSubject, _options?: UpdateCheckOptions): Promise<UpdateCheckResult> {
    this.subjects.push(structuredClone(subject));
    return {
      logicalSkillId: subject.logicalSkillId,
      status: "unavailable",
      checkedAt: "2026-08-30T00:00:00.000Z",
      evidenceKind: "none",
      overwriteUpdateAllowed: false,
      summary: "fixture",
    };
  }
}

class CountingRuntimeAppServer extends AppServerClient {
  listCalls = 0;
  listCwds: string[][] = [];

  constructor() {
    super({ command: "unused" });
  }

  override get isRunning(): boolean {
    return true;
  }

  override async start(): Promise<void> {}

  override async stop(): Promise<void> {}

  override async listSkills(cwds: string[]): Promise<[]> {
    this.listCalls += 1;
    this.listCwds.push([...cwds]);
    return [];
  }

  signalSkillsChanged(): void {
    this.emit("skillsChanged");
  }
}

class PluginRuntimeAppServer extends AppServerClient {
  constructor(
    private readonly skillPath: string,
    private readonly runtimePluginId: string,
  ) {
    super({ command: "unused" });
  }

  override get isRunning(): boolean {
    return true;
  }

  override async start(): Promise<void> {}

  override async stop(): Promise<void> {}

  override async listSkills(): Promise<Array<{
    cwd: string;
    skills: Array<{
      name: string;
      description: string;
      path: string;
      scope: "user";
      enabled: boolean;
      pluginId: string;
    }>;
    errors: [];
  }>> {
    return [{
      cwd: "fixture",
      skills: [{
        name: "artifact-template-analytics-dashboard",
        description: "Plugin identity fixture",
        path: this.skillPath,
        scope: "user",
        enabled: true,
        pluginId: this.runtimePluginId,
      }],
      errors: [],
    }];
  }
}

test("clearing a selected project removes it from subsequent app-server runtime requests", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cso-project-runtime-clear-"));
  let service: InventoryService | undefined;
  try {
    const baseCwd = path.join(directory, "base");
    const selected = path.join(directory, "selected");
    await mkdir(baseCwd, { recursive: true });
    await mkdir(selected, { recursive: true });
    const appServer = new CountingRuntimeAppServer();
    service = new InventoryService({
      roots: [],
      cwd: baseCwd,
      statePath: path.join(directory, "organizer.db"),
      appServer,
      pathLocationProbe: async () => "local",
      watchRoot: () => fakeWatcher(),
    });
    let snapshot = await service.initialize();
    snapshot = await service.selectProject(selected, snapshot.revision);
    assert.ok(appServer.listCwds.at(-1)?.includes(await realpath(selected)));
    snapshot = await service.selectProject(null, snapshot.revision);
    assert.deepEqual(appServer.listCwds.at(-1), [baseCwd]);
  } finally {
    await service?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("inventory overlays runtime state and persists manual classification without touching skill files", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cso-inventory-"));
  const root = path.join(directory, "skills");
  const statePath = path.join(directory, "state", "organizer.db");
  try {
    const skillPath = await writeSkill(root, "fixture-skill", {
      name: "fixture-skill",
      description: "Unclear fixture",
    });
    const fake = new InventoryFakeProcess(skillPath);
    const appServer = new AppServerClient({ command: "fake", spawnFactory: () => fake, requestTimeoutMs: 1_000 });
    const service = new InventoryService({
      roots: [{ id: "fixture", label: "Fixture", path: root, kind: "fixture" }],
      cwd: directory,
      statePath,
      appServer,
      now: () => new Date("2026-08-29T00:00:00.000Z"),
      pathLocationProbe: localPathLocationProbe,
    });

    const initial = await service.initialize();
    assert.equal(initial.skills.length, 1);
    assert.equal(initial.skills[0]?.runtimeEnabled, true);
    const firstRevision = initial.revision;
    const skillId = initial.skills[0]!.skillId;

    const updated = await service.applyClassification({
      skillIds: [skillId],
      expectedRevision: firstRevision,
      primaryCategoryId: "development",
      addTagIds: ["user:重点"],
      favorite: true,
      locked: true,
      reason: "人工确认",
    });
    assert.equal(updated.skills[0]?.categoryId, "development");
    assert.equal(updated.skills[0]?.favorite, true);
    assert.ok(updated.skills[0]?.tags.includes("user:重点"));
    await assert.rejects(
      () => service.applyClassification({ skillIds: [skillId], expectedRevision: firstRevision, favorite: false }),
      StaleInventoryError,
    );

    const withManagement = await service.setManagementMode(true);
    const operation = await service.setSkillEnabled([skillId], false, withManagement.revision);
    assert.deepEqual(operation.failed, []);
    assert.deepEqual(operation.succeeded, [skillId]);
    assert.equal(service.snapshot.skills[0]?.runtimeEnabled, false);
    await service.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("plugin cache upgrades and runtime-qualified plugin IDs preserve one logical identity", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cso-plugin-identity-"));
  const pluginRoot = path.join(directory, "plugin-cache");
  const statePath = path.join(directory, "state", "organizer.db");
  const root: RootDefinition = {
    id: "plugins",
    label: "Plugins",
    path: pluginRoot,
    kind: "plugin-cache",
    readonly: true,
  };
  try {
    const oldVersionDirectory = path.join(pluginRoot, "openai-curated-remote", "openai-templates", "0.1.1");
    await writeSkill(oldVersionDirectory, "skills/artifact-template-analytics-dashboard", {
      name: "artifact-template-analytics-dashboard",
      description: "Plugin identity fixture",
    });
    const firstService = new InventoryService({
      roots: [root],
      statePath,
      appServer: null,
      pathLocationProbe: localPathLocationProbe,
      watchRoot: () => fakeWatcher(),
    });
    const first = await firstService.initialize();
    const logicalSkillId = first.skills[0]!.skillId;
    await firstService.applyClassification({
      skillIds: [logicalSkillId],
      expectedRevision: first.revision,
      favorite: true,
    });
    await firstService.close();

    await rm(oldVersionDirectory, { recursive: true, force: true });
    const newSkillPath = await writeSkill(
      path.join(pluginRoot, "openai-curated-remote", "openai-templates", "0.1.2"),
      "skills/artifact-template-analytics-dashboard",
      {
        name: "artifact-template-analytics-dashboard",
        description: "Plugin identity fixture",
      },
    );
    const secondService = new InventoryService({
      roots: [root],
      statePath,
      appServer: new PluginRuntimeAppServer(
        newSkillPath,
        "openai-templates@openai-curated-remote",
      ),
      pathLocationProbe: localPathLocationProbe,
      watchRoot: () => fakeWatcher(),
    });
    try {
      const second = await secondService.initialize();
      assert.equal(second.skills.length, 1);
      assert.equal(second.skills[0]?.skillId, logicalSkillId, "a cache upgrade must retain the portable logical ID");
      assert.equal(second.skills[0]?.runtimeDiscovered, true);
      assert.equal(second.skills[0]?.favorite, true, "personal state remains attached to the stable logical ID");
      const persisted = secondService.store.listLogicalSkills()[0]!;
      assert.equal(persisted.pluginId, "openai-templates", "runtime namespace is instance evidence, not logical identity");
      assert.equal(persisted.relativeSkillPath, "skills/artifact-template-analytics-dashboard/skill.md");
    } finally {
      await secondService.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("ordinary SKILL.md version metadata is display-only and never becomes installation evidence", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cso-version-boundary-"));
  try {
    const root = path.join(directory, "skills");
    await writeSkill(root, "self-versioned", {
      name: "self-versioned",
      description: "A skill-authored version is not an installer receipt",
      version: "v99.0.0",
      origin: "https://github.com/owner/repository",
    });
    const updateService = new CapturingUpdateService();
    const service = new InventoryService({
      roots: [{ id: "fixture", label: "Fixture", path: root, kind: "fixture" }],
      statePath: path.join(directory, "organizer.db"),
      appServer: null,
      updateService,
      pathLocationProbe: localPathLocationProbe,
    });
    const snapshot = await service.initialize();
    assert.equal((await service.refresh(true)).revision, snapshot.revision, "a no-op rescan must not make safe-write preconditions stale");
    const instance = snapshot.skills[0]!.instances![0]!;
    assert.equal(instance.version, "v99.0.0", "frontmatter version remains available for display");
    await service.checkSkillUpdates({ instanceIds: [instance.instanceId], expectedRevision: snapshot.revision, forceRefresh: true });
    assert.equal(updateService.subjects[0]?.installedTag, undefined);
    assert.equal(updateService.subjects[0]?.installedCommit, undefined);
    await service.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("filesystem events rescan only the changed root while manual refresh rescans every root", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cso-incremental-roots-"));
  try {
    const rootA = path.join(directory, "root-a");
    const rootB = path.join(directory, "root-b");
    await writeSkill(rootA, "alpha", { name: "duplicate", description: "Root A" });
    await writeSkill(rootB, "beta", { name: "duplicate", description: "Root B" });
    const calls: string[] = [];
    const listeners = new Map<string, (eventType: string, fileName: string | Buffer | null) => void>();
    const scanRoots = async (roots: RootDefinition[]): Promise<ScanResult> => {
      assert.equal(roots.length, 1, "inventory scans and caches each root independently");
      calls.push(roots[0]!.id);
      return scanSkillRoots(roots);
    };
    const service = new InventoryService({
      roots: [
        { id: "a", label: "A", path: rootA, kind: "fixture" },
        { id: "b", label: "B", path: rootB, kind: "fixture" },
      ],
      statePath: path.join(directory, "organizer.db"),
      appServer: null,
      scanRoots,
      pathLocationProbe: localPathLocationProbe,
      watchRoot: (rootPath, listener) => {
        listeners.set(rootPath, listener);
        return fakeWatcher();
      },
    });
    const initial = await service.initialize();
    assert.deepEqual(calls, ["a", "b"]);
    assert.equal(initial.skills.length, 2);
    assert.ok(initial.skills.every((skill) => skill.diagnostics.some((item) => item.code === "DUPLICATE_NAME")));

    await writeSkill(rootA, "new-skill", { name: "new-skill", description: "Changed root" });
    listeners.get(rootA)!("rename", path.join("new-skill", "SKILL.md"));
    await waitUntil(() => calls.length === 3 && service.snapshot.skills.some((skill) => skill.name === "new-skill"));
    assert.deepEqual(calls, ["a", "b", "a"], "the unchanged root must reuse its cached result");

    listeners.get(rootB)!("change", path.join(".git", "refs", "heads", "main"));
    await waitUntil(() => calls.length === 4);
    assert.deepEqual(calls, ["a", "b", "a", "b"], "Git provenance metadata invalidates only its owning root");

    await service.refresh(false);
    assert.deepEqual(calls, ["a", "b", "a", "b", "a", "b"], "manual refresh is a force-full disk rescan");
    await service.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("watcher creation and background incremental failures remain visible in scan diagnostics", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cso-watch-diagnostics-"));
  try {
    const root = path.join(directory, "skills");
    await writeSkill(root, "stable", { name: "stable", description: "Stable cached item" });
    const watcherFailure = new InventoryService({
      roots: [{ id: "watch-failure", label: "Watch failure", path: root, kind: "fixture" }],
      statePath: path.join(directory, "watcher.db"),
      appServer: null,
      pathLocationProbe: localPathLocationProbe,
      watchRoot: () => {
        throw new Error("recursive watch unavailable");
      },
    });
    const watcherSnapshot = await watcherFailure.initialize();
    assert.ok(watcherSnapshot.scanErrors.some((error) => /无法创建文件监听.*recursive watch unavailable/u.test(error.message)));
    await watcherFailure.close();

    let listener: ((eventType: string, fileName: string | Buffer | null) => void) | null = null;
    let scanCalls = 0;
    let rejectNextIncrement = true;
    const incrementalFailure = new InventoryService({
      roots: [{ id: "incremental", label: "Incremental", path: root, kind: "fixture" }],
      statePath: path.join(directory, "incremental.db"),
      appServer: null,
      pathLocationProbe: localPathLocationProbe,
      scanRoots: async (roots) => {
        scanCalls += 1;
        if (scanCalls > 1 && rejectNextIncrement) {
          rejectNextIncrement = false;
          throw new Error("simulated incremental read failure");
        }
        return scanSkillRoots(roots);
      },
      watchRoot: (_rootPath, callback) => {
        listener = callback;
        return fakeWatcher();
      },
    });
    await incrementalFailure.initialize();
    listener!("change", path.join("stable", "SKILL.md"));
    await waitUntil(() => incrementalFailure.snapshot.scanErrors.some((error) => /后台增量扫描失败.*simulated incremental read failure/u.test(error.message)));
    assert.equal(incrementalFailure.snapshot.skills.length, 1, "a failed incremental scan retains the last known-good root result");

    listener!("change", path.join("stable", "SKILL.md"));
    await waitUntil(() => scanCalls >= 3 && !incrementalFailure.snapshot.scanErrors.some((error) => error.message.includes("simulated incremental")));
    await incrementalFailure.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a post-scan database rejection rolls back the candidate root cache", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cso-refresh-cache-rollback-"));
  try {
    const root = path.join(directory, "skills");
    await writeSkill(root, "stable", { name: "stable", description: "Stable cached item" });
    let listener: ((eventType: string, fileName: string | Buffer | null) => void) | null = null;
    let scanMode: "good" | "bad-identity" | "read-failure" = "good";
    let scanCalls = 0;
    const service = new InventoryService({
      roots: [{ id: "rollback", label: "Rollback", path: root, kind: "fixture" }],
      statePath: path.join(directory, "organizer.db"),
      appServer: null,
      pathLocationProbe: localPathLocationProbe,
      scanRoots: async (roots) => {
        scanCalls += 1;
        if (scanMode === "read-failure") throw new Error("simulated follow-up read failure");
        const result = await scanSkillRoots(roots);
        if (scanMode !== "bad-identity") return result;
        return {
          ...result,
          skills: result.skills.map((skill) => ({
            ...skill,
            sourceId: "fixture:conflicting-source",
          })),
        };
      },
      watchRoot: (_rootPath, callback) => {
        listener = callback;
        return fakeWatcher();
      },
    });
    await service.initialize();

    scanMode = "bad-identity";
    listener!("change", path.join("stable", "SKILL.md"));
    await waitUntil(() => service.snapshot.scanErrors.some((error) => error.message.includes("身份冲突")));
    assert.equal(service.snapshot.skills[0]?.sourceId, "fixture:rollback");

    scanMode = "read-failure";
    listener!("change", path.join("stable", "SKILL.md"));
    await waitUntil(() => scanCalls >= 3 && service.snapshot.scanErrors.some(
      (error) => error.message.includes("simulated follow-up read failure"),
    ));
    assert.ok(
      !service.snapshot.scanErrors.some((error) => error.message.includes("身份冲突")),
      "a later scan failure must rebuild from the last committed cache, not the rejected candidate",
    );
    assert.equal(service.snapshot.skills[0]?.sourceId, "fixture:rollback");
    await service.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("app-server skillsChanged refreshes runtime state without rescanning disk roots", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cso-runtime-only-refresh-"));
  try {
    const root = path.join(directory, "skills");
    await writeSkill(root, "runtime", { name: "runtime", description: "Runtime refresh fixture" });
    let diskScans = 0;
    const appServer = new CountingRuntimeAppServer();
    const service = new InventoryService({
      roots: [{ id: "fixture", label: "Fixture", path: root, kind: "fixture" }],
      statePath: path.join(directory, "organizer.db"),
      appServer,
      pathLocationProbe: localPathLocationProbe,
      scanRoots: async (roots) => {
        diskScans += 1;
        return scanSkillRoots(roots);
      },
      watchRoot: () => fakeWatcher(),
    });
    await service.initialize();
    assert.equal(diskScans, 1);
    assert.equal(appServer.listCalls, 1);
    appServer.signalSkillsChanged();
    await waitUntil(() => appServer.listCalls === 2);
    assert.equal(diskScans, 1, "runtime invalidation must not touch disk inventory");
    await service.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("root add, authorization, removal, and project selection invalidate only live cache identities", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cso-root-cache-lifecycle-"));
  try {
    const customRoot = path.join(directory, "custom");
    const projectRoot = path.join(directory, "project");
    await writeSkill(customRoot, "custom-skill", { name: "custom-skill", description: "Custom" });
    await writeSkill(path.join(projectRoot, ".codex", "skills"), "repo-skill", { name: "repo-skill", description: "Repo" });
    const calls: string[] = [];
    const service = new InventoryService({
      roots: [],
      statePath: path.join(directory, "organizer.db"),
      appServer: null,
      pathLocationProbe: async () => "local",
      scanRoots: async (roots) => {
        calls.push(roots[0]!.id);
        return scanSkillRoots(roots);
      },
      watchRoot: () => fakeWatcher(),
    });
    let snapshot = await service.initialize();
    assert.equal(snapshot.skills.length, 0);

    snapshot = await service.addCustomRoot(customRoot, "Custom", snapshot.revision);
    const customId = snapshot.configuredRoots![0]!.rootId;
    assert.deepEqual(snapshot.skills.map((skill) => skill.name), ["custom-skill"]);
    const scansAfterAdd = calls.length;

    snapshot = await service.setCustomRootManagement(customId, true, snapshot.revision);
    assert.ok(calls.length > scansAfterAdd, "authorization changes the root signature and forces a fresh result");
    snapshot = await service.selectProject(projectRoot, snapshot.revision);
    assert.deepEqual(snapshot.skills.map((skill) => skill.name).sort(), ["custom-skill", "repo-skill"]);
    snapshot = await service.selectProject(null, snapshot.revision);
    assert.deepEqual(snapshot.skills.map((skill) => skill.name), ["custom-skill"], "removed project roots cannot leak cached rows");
    snapshot = await service.removeCustomRoot(customId, snapshot.revision);
    assert.equal(snapshot.skills.length, 0, "removed custom roots cannot leak cached rows");
    await service.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("custom-root management cannot be authorized when a Windows drive is network or unverifiable", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cso-root-location-"));
  let location: PathLocation = "local";
  try {
    const customRoot = path.join(directory, "custom-skills");
    await mkdir(customRoot, { recursive: true });
    const service = new InventoryService({
      roots: [],
      statePath: path.join(directory, "organizer.db"),
      appServer: null,
      pathLocationProbe: async () => location,
    });
    let snapshot = await service.initialize();
    snapshot = await service.addCustomRoot(customRoot, "Custom", snapshot.revision);
    const rootId = snapshot.configuredRoots![0]!.rootId;

    location = "unknown";
    await assert.rejects(
      () => service.setCustomRootManagement(rootId, true, snapshot.revision),
      /拒绝授权管理/u,
    );
    assert.equal(service.snapshot.configuredRoots![0]!.managementAuthorized, false);

    location = "network";
    await assert.rejects(
      () => service.setCustomRootManagement(rootId, true, snapshot.revision),
      /映射网络盘/u,
    );
    assert.equal(service.snapshot.configuredRoots![0]!.managementAuthorized, false);
    await service.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("low-confidence model classification is surfaced as pending", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cso-confidence-"));
  try {
    const root = path.join(directory, "skills");
    await writeSkill(root, "mystery", { name: "mystery", description: "Unknown" });
    const service = new InventoryService({
      roots: [{ id: "fixture", label: "Fixture", path: root, kind: "fixture" }],
      statePath: path.join(directory, "organizer.db"),
      appServer: null,
      pathLocationProbe: localPathLocationProbe,
    });
    const initial = await service.initialize();
    const updated = await service.applyClassification({
      skillIds: [initial.skills[0]!.skillId],
      expectedRevision: initial.revision,
      primaryCategoryId: "development",
      confidence: 0.6,
      reason: "不确定",
    });
    assert.equal(updated.skills[0]?.categoryId, null);
    assert.equal(service.store.getUserState(initial.skills[0]!.skillId).classificationMode, "manual");
    await service.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("inventory suggestion acceptance is all-or-nothing when any selected skill becomes locked", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cso-suggestion-batch-"));
  try {
    const root = path.join(directory, "skills");
    await Promise.all([
      writeSkill(root, "open-suggestion", { name: "open-suggestion", description: "Open suggestion fixture" }),
      writeSkill(root, "locked-suggestion", { name: "locked-suggestion", description: "Locked suggestion fixture" }),
    ]);
    const service = new InventoryService({
      roots: [{ id: "fixture", label: "Fixture", path: root, kind: "fixture" }],
      statePath: path.join(directory, "organizer.db"),
      appServer: null,
      pathLocationProbe: localPathLocationProbe,
    });
    const initial = await service.initialize();
    const openId = initial.skills.find((skill) => skill.name === "open-suggestion")!.skillId;
    const lockedId = initial.skills.find((skill) => skill.name === "locked-suggestion")!.skillId;
    const { staged } = await service.submitClassificationSuggestions(initial.revision, [
      { skillId: openId, categoryId: "quality", confidence: 0.95, reason: "Quality suggestion" },
      { skillId: lockedId, categoryId: "security", confidence: 0.95, reason: "Security suggestion" },
    ]);
    const lockedSnapshot = await service.applyClassification({
      skillIds: [lockedId],
      expectedRevision: initial.revision,
      locked: true,
    });

    await assert.rejects(
      () => service.resolveClassificationSuggestions(
        staged.map((suggestion) => suggestion.suggestionId),
        "accepted",
        lockedSnapshot.revision,
      ),
      InventoryMutationError,
    );
    assert.equal(service.store.getUserState(openId).classificationMode, "automatic");
    assert.equal(service.store.getUserState(openId).primaryCategoryId, service.snapshot.skills.find((skill) => skill.skillId === openId)!.automaticClassification.categoryId);
    assert.equal(service.listClassificationSuggestions().length, 2, "the HTTP-facing service must leave the entire batch staged");
    await service.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

class PartialFailureAppServer extends AppServerClient {
  readonly #states = new Map<string, boolean>();
  readonly #failurePath: string;

  constructor(skillPaths: string[], failurePath: string) {
    super({ command: "unused" });
    for (const skillPath of skillPaths) this.#states.set(skillPath, true);
    this.#failurePath = failurePath;
  }

  override get isRunning(): boolean {
    return true;
  }

  override async start(): Promise<void> {}

  override async stop(): Promise<void> {}

  override async listSkills(): Promise<Array<{
    cwd: string;
    skills: Array<{
      name: string;
      description: string;
      path: string;
      scope: "user";
      enabled: boolean;
      pluginId: null;
    }>;
    errors: [];
  }>> {
    return [{
      cwd: "fixture",
      skills: [...this.#states].map(([skillPath, enabled]) => ({
        name: path.basename(path.dirname(skillPath)),
        description: "Partial failure fixture",
        path: skillPath,
        scope: "user" as const,
        enabled,
        pluginId: null,
      })),
      errors: [],
    }];
  }

  override async setSkillEnabled(skillPath: string, enabled: boolean): Promise<boolean> {
    if (skillPath === this.#failurePath) throw new Error("simulated write failure");
    this.#states.set(skillPath, enabled);
    return enabled;
  }
}

test("batch enablement stops after a failure and reports success, failure, and not-executed IDs", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cso-partial-"));
  try {
    const root = path.join(directory, "skills");
    const paths = await Promise.all(["first", "second", "third"].map((name) => writeSkill(root, name, {
      name,
      description: `${name} batch fixture`,
    })));
    const appServer = new PartialFailureAppServer(paths, paths[1]!);
    const service = new InventoryService({
      roots: [{ id: "fixture", label: "Fixture", path: root, kind: "fixture" }],
      statePath: path.join(directory, "organizer.db"),
      appServer,
      pathLocationProbe: localPathLocationProbe,
    });
    const initial = await service.initialize();
    const ids = paths.map((skillPath) => initial.skills.find((skill) => skill.absolutePath === skillPath)!.skillId);
    const withManagement = await service.setManagementMode(true);
    const result = await service.setSkillEnabled(ids, false, withManagement.revision);
    assert.deepEqual(result.succeeded, [ids[0]]);
    assert.deepEqual(result.failed, [{ skillId: ids[1], message: "simulated write failure" }]);
    assert.deepEqual(result.notExecuted, [ids[2]]);
    assert.equal(service.snapshot.skills.find((skill) => skill.skillId === ids[0])?.runtimeEnabled, false);
    assert.equal(service.snapshot.skills.find((skill) => skill.skillId === ids[1])?.runtimeEnabled, true);
    assert.equal(service.snapshot.skills.find((skill) => skill.skillId === ids[2])?.runtimeEnabled, true);
    await service.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a future database schema fails closed without installing an older supported snapshot", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cso-future-schema-"));
  const statePath = path.join(directory, "state", "organizer.db");
  const snapshotDirectory = `${statePath}.snapshots`;
  const snapshotPath = path.join(snapshotDirectory, "supported-schema-6.sqlite");
  try {
    const supportedSnapshot = await OrganizerDatabase.open(snapshotPath);
    assert.equal(supportedSnapshot.schemaVersion, SQLITE_SCHEMA_VERSION);
    await supportedSnapshot.close();

    const futureDatabase = new DatabaseSync(statePath);
    futureDatabase.exec("PRAGMA user_version = 999;");
    futureDatabase.close();

    const recoveryOperations: string[] = [];
    const service = new InventoryService({
      roots: [],
      statePath,
      appServer: null,
      pathLocationProbe: localPathLocationProbe,
      databaseRecoveryOperations: observeDurableFileOperations((operation) => recoveryOperations.push(operation)),
    });
    let initializationError: unknown;
    try {
      await service.initialize();
      await service.close();
    } catch (error) {
      initializationError = error;
    }

    assert.ok(
      initializationError instanceof UnsupportedSchemaVersionError,
      "a newer database must be surfaced instead of silently downgraded",
    );
    assert.equal(initializationError.actualVersion, 999);
    assert.equal(initializationError.supportedVersion, SQLITE_SCHEMA_VERSION);
    assert.deepEqual(recoveryOperations, [], "no recovery file operation may run for a future schema");
    const preserved = new DatabaseSync(statePath, { readOnly: true });
    try {
      const version = preserved.prepare("PRAGMA user_version").get() as { user_version: number };
      assert.equal(version.user_version, 999, "the future database must remain installed byte-for-byte logically");
    } finally {
      preserved.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a non-corruption SQLite I/O failure is rethrown without attempting snapshot recovery", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cso-non-corruption-recovery-"));
  const statePath = path.join(directory, "state", "organizer.db");
  const snapshotPath = path.join(`${statePath}.snapshots`, "supported-schema-6.sqlite");
  try {
    const supportedSnapshot = await OrganizerDatabase.open(snapshotPath);
    assert.equal(supportedSnapshot.schemaVersion, SQLITE_SCHEMA_VERSION);
    await supportedSnapshot.close();
    await mkdir(statePath);

    const recoveryOperations: string[] = [];
    const service = new InventoryService({
      roots: [],
      statePath,
      appServer: null,
      pathLocationProbe: localPathLocationProbe,
      databaseRecoveryOperations: observeDurableFileOperations((operation) => recoveryOperations.push(operation)),
    });
    let initializationError: unknown;
    try {
      await service.initialize();
      await service.close();
    } catch (error) {
      initializationError = error;
    }

    assert.equal((initializationError as { code?: unknown } | undefined)?.code, "ERR_SQLITE_ERROR");
    assert.equal(
      Number((initializationError as { errcode?: unknown } | undefined)?.errcode) & 0xff,
      14,
      "SQLITE_CANTOPEN is an I/O failure, not corruption",
    );
    assert.deepEqual(recoveryOperations, [], "no recovery file operation may run for an I/O failure");
    assert.deepEqual(await readdir(statePath), [], "the database path directory must remain untouched");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a corrupt SQLite database is preserved and recovered from the newest write-before snapshot", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cso-recovery-"));
  const statePath = path.join(directory, "state", "organizer.db");
  const root = path.join(directory, "skills");
  try {
    await writeSkill(root, "recoverable", { name: "recoverable", description: "Recovery fixture" });
    const first = new InventoryService({
      roots: [{ id: "fixture", label: "Fixture", path: root, kind: "fixture" }],
      statePath,
      appServer: null,
      now: () => new Date("2026-08-30T00:00:00.000Z"),
      pathLocationProbe: localPathLocationProbe,
    });
    const initial = await first.initialize();
    await first.applyClassification({
      skillIds: [initial.skills[0]!.skillId],
      expectedRevision: initial.revision,
      favorite: true,
    });
    await first.refresh();
    await first.close();

    const corruptContents = new Map([["", "not a sqlite database"]]);
    for (const [extension, contents] of corruptContents) {
      await writeFile(`${statePath}${extension}`, contents, "utf8");
    }
    const recoveryOperations: DurableFileOperations = {
      ...defaultDurableFileOperations,
      rename: async (sourcePath, destinationPath) => {
        if (destinationPath === statePath) {
          throw Object.assign(new Error("simulated EFS rename"), { code: "EXDEV" });
        }
        await defaultDurableFileOperations.rename(sourcePath, destinationPath);
      },
    };
    const recovered = new InventoryService({
      roots: [{ id: "fixture", label: "Fixture", path: root, kind: "fixture" }],
      statePath,
      appServer: null,
      databaseRecoveryOperations: recoveryOperations,
      now: () => new Date("2026-08-30T00:01:00.000Z"),
      pathLocationProbe: localPathLocationProbe,
    });
    const snapshot = await recovered.initialize();
    assert.equal(snapshot.skills[0]?.favorite, true);
    const corruptDirectory = path.join(directory, "state", "corrupt-databases");
    const preservedGroups = await readdir(corruptDirectory, { withFileTypes: true });
    const preservedGroup = preservedGroups.find((entry) => entry.isDirectory() && entry.name.includes("organizer.db"));
    assert.ok(preservedGroup, "the recovered open must retain one complete corrupt database group");
    for (const [extension, contents] of corruptContents) {
      assert.equal(
        await readFile(path.join(corruptDirectory, preservedGroup.name, `organizer.db${extension}`), "utf8"),
        contents,
      );
    }
    await recovered.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a snapshot that still cannot open rolls back the archived database group", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cso-recovery-open-failure-"));
  const statePath = path.join(directory, "state", "organizer.db");
  const root = path.join(directory, "skills");
  try {
    await writeSkill(root, "recoverable", { name: "recoverable", description: "Recovery rollback fixture" });
    const first = new InventoryService({
      roots: [{ id: "fixture", label: "Fixture", path: root, kind: "fixture" }],
      statePath,
      appServer: null,
      now: () => new Date("2026-08-30T00:00:00.000Z"),
      pathLocationProbe: localPathLocationProbe,
    });
    const initial = await first.initialize();
    await first.applyClassification({
      skillIds: [initial.skills[0]!.skillId],
      expectedRevision: initial.revision,
      favorite: true,
    });
    await first.close();

    const snapshotDirectory = `${statePath}.snapshots`;
    const invalidSnapshotPath = path.join(snapshotDirectory, "zzzz-invalid.sqlite");
    const unsupportedSnapshot = new DatabaseSync(invalidSnapshotPath);
    unsupportedSnapshot.exec("PRAGMA user_version = 999;");
    unsupportedSnapshot.close();
    const originals = new Map([["", "original-corrupt-db"]]);
    for (const [extension, contents] of originals) {
      await writeFile(`${statePath}${extension}`, contents, "utf8");
    }
    const recoveryOperations: DurableFileOperations = {
      ...defaultDurableFileOperations,
      rename: async (sourcePath, destinationPath) => {
        if (destinationPath === statePath) {
          throw Object.assign(new Error("simulated EFS rename"), { code: "EXDEV" });
        }
        await defaultDurableFileOperations.rename(sourcePath, destinationPath);
      },
    };
    const recovered = new InventoryService({
      roots: [{ id: "fixture", label: "Fixture", path: root, kind: "fixture" }],
      statePath,
      appServer: null,
      databaseRecoveryOperations: recoveryOperations,
      now: () => new Date("2026-08-30T00:01:00.000Z"),
      pathLocationProbe: localPathLocationProbe,
    });
    await assert.rejects(
      () => recovered.initialize(),
      (error: DatabaseRecoveryError) => error.phase === "snapshot-open",
    );
    for (const [extension, contents] of originals) {
      assert.equal(await readFile(`${statePath}${extension}`, "utf8"), contents);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("portable workspace settings persist in SQLite while custom roots stay read-only until separately authorized", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cso-portable-settings-"));
  const statePath = path.join(directory, "state", "organizer.db");
  const customRoot = path.join(directory, "synced skills");
  const projectRoot = path.join(directory, "项目 Alpha");
  await mkdir(customRoot, { recursive: true });
  await writeSkill(path.join(projectRoot, ".codex", "skills"), "repo-helper", {
    name: "repo-helper",
    description: "Project scoped helper",
  });
  let first: InventoryService | undefined;
  let reopened: InventoryService | undefined;
  try {
    first = new InventoryService({
      roots: [],
      statePath,
      appServer: null,
      pathLocationProbe: localPathLocationProbe,
    });
    let snapshot = await first.initialize();
    snapshot = await first.addCustomRoot(customRoot, "同步盘 Skills", snapshot.revision);
    const configured = snapshot.configuredRoots?.[0];
    assert.equal(configured?.readonly, true);
    assert.equal(configured?.managementAuthorized, false);

    snapshot = await first.setCustomRootManagement(configured!.rootId, true, snapshot.revision);
    assert.equal(snapshot.configuredRoots?.[0]?.managementAuthorized, true);
    snapshot = await first.selectProject(projectRoot, snapshot.revision);
    const physicalProjectRoot = await realpath(projectRoot);
    assert.equal(snapshot.selectedProjectPath, physicalProjectRoot);
    assert.ok(snapshot.skills.some((skill) => skill.scope === "repo" && skill.name === "repo-helper"));

    snapshot = await first.createCustomCategory({
      categoryId: "custom:personal-tools",
      label: { zhCN: "个人工具", enUS: "Personal tools" },
      sortOrder: 120,
      hidden: false,
    }, snapshot.revision);
    snapshot = await first.setCategoryPreference({
      categoryId: "development",
      display: { zhCN: "我的工程" },
      sortOrder: 3,
      hidden: false,
    }, snapshot.revision);
    snapshot = await first.saveView({
      viewId: "favorites",
      name: "收藏",
      filters: { favoritesOnly: true, query: "" },
    }, snapshot.revision);
    assert.equal(snapshot.customCategories?.[0]?.categoryId, "custom:personal-tools");
    assert.equal(snapshot.categoryPreferences?.[0]?.display.zhCN, "我的工程");
    assert.equal(snapshot.savedViews?.[0]?.viewId, "favorites");
    await first.close();
    first = undefined;

    reopened = new InventoryService({
      roots: [],
      statePath,
      appServer: null,
      pathLocationProbe: localPathLocationProbe,
    });
    const persisted = await reopened.initialize();
    assert.equal(persisted.configuredRoots?.[0]?.managementAuthorized, true);
    assert.equal(persisted.selectedProjectPath, physicalProjectRoot);
    assert.equal(persisted.customCategories?.[0]?.categoryId, "custom:personal-tools");
    assert.equal(persisted.savedViews?.[0]?.viewId, "favorites");
    await reopened.close();
    reopened = undefined;
  } finally {
    await reopened?.close();
    await first?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a not-yet-created MCP project root stays retryable and session replacement removes stale roots", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cso-session-root-retry-"));
  const projectRoot = path.join(directory, "project-created-later");
  const inventory = new InventoryService({
    roots: [],
    statePath: path.join(directory, "organizer.db"),
    appServer: null,
    pathLocationProbe: async () => "local",
    watchRoot: () => fakeWatcher(),
  });
  try {
    await inventory.initialize();
    await assert.rejects(
      inventory.replaceSessionProjects("mcp-session-fixture", [projectRoot]),
      /不存在或不可读取/u,
    );
    assert.equal(inventory.snapshot.skills.some((skill) => skill.scope === "repo"), false);

    await writeSkill(path.join(projectRoot, ".codex", "skills"), "created-later", {
      name: "created-later",
      description: "This root becomes available after the first registration attempt.",
    });
    let snapshot = await inventory.replaceSessionProjects("mcp-session-fixture", [projectRoot]);
    assert.ok(snapshot.skills.some((skill) => skill.scope === "repo" && skill.name === "created-later"));

    snapshot = await inventory.replaceSessionProjects("mcp-session-fixture", []);
    assert.equal(snapshot.skills.some((skill) => skill.name === "created-later"), false);
  } finally {
    await inventory.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an MCP project root supplied through a DOS 8.3 alias is stored and scanned by its canonical path", {
  skip: process.platform !== "win32",
}, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cso-session-short-root-"));
  const declaredProject = "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\project";
  const canonicalize = (candidate: string): string => candidate.replace(
    /\\RUNNER~1(?=\\|$)/iu,
    "\\runneradmin",
  );
  const identities = new Map<string, number>();
  const operations: DirectoryIdentityOperations = {
    lstat: async (candidate): Promise<DirectoryIdentityStats> => {
      const canonical = canonicalize(candidate).toLocaleLowerCase("en-US");
      const identity = identities.get(canonical) ?? identities.size + 1;
      identities.set(canonical, identity);
      return {
        dev: 9,
        ino: identity,
        isDirectory: () => true,
        isSymbolicLink: () => false,
      };
    },
    realpath: async (candidate) => canonicalize(candidate),
  };
  const appServer = new CountingRuntimeAppServer();
  const inventory = new InventoryService({
    roots: [],
    statePath: path.join(directory, "organizer.db"),
    appServer,
    pathLocationProbe: async () => "local",
    pathIdentityOperations: operations,
    watchRoot: () => fakeWatcher(),
  });
  try {
    await inventory.initialize();
    await inventory.replaceSessionProjects("mcp-short-root", [declaredProject]);
    assert.ok(
      appServer.listCwds.at(-1)?.includes(canonicalize(declaredProject)),
      "the app-server must receive the canonical long path instead of rejecting a safe short-name alias",
    );
  } finally {
    await inventory.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("clearing one MCP session removes only that session's project roots", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cso-session-root-isolation-"));
  const firstProject = path.join(directory, "first-project");
  const secondProject = path.join(directory, "second-project");
  const inventory = new InventoryService({
    roots: [],
    statePath: path.join(directory, "organizer.db"),
    appServer: null,
    pathLocationProbe: async () => "local",
    watchRoot: () => fakeWatcher(),
  });
  try {
    await writeSkill(path.join(firstProject, ".codex", "skills"), "first-session-skill", {
      name: "first-session-skill",
      description: "Visible only through the first MCP session root.",
    });
    await writeSkill(path.join(secondProject, ".codex", "skills"), "second-session-skill", {
      name: "second-session-skill",
      description: "Visible only through the second MCP session root.",
    });
    await inventory.initialize();
    await inventory.replaceSessionProjects("mcp-session-one", [firstProject]);
    let snapshot = await inventory.replaceSessionProjects("mcp-session-two", [secondProject]);
    assert.ok(snapshot.skills.some((skill) => skill.name === "first-session-skill"));
    assert.ok(snapshot.skills.some((skill) => skill.name === "second-session-skill"));

    snapshot = await inventory.replaceSessionProjects("mcp-session-one", []);
    assert.equal(snapshot.skills.some((skill) => skill.name === "first-session-skill"), false);
    assert.ok(
      snapshot.skills.some((skill) => skill.name === "second-session-skill"),
      "clearing one sidecar session must not remove another active session's roots",
    );
  } finally {
    await inventory.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("expired MCP session roots are removed while renewed and unrelated sessions remain", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cso-session-root-ttl-"));
  const expiredProject = path.join(directory, "expired-project");
  const renewedProject = path.join(directory, "renewed-project");
  let now = new Date("2026-08-30T00:00:00.000Z");
  const inventory = new InventoryService({
    roots: [],
    statePath: path.join(directory, "organizer.db"),
    appServer: null,
    now: () => now,
    pathLocationProbe: async () => "local",
    watchRoot: () => fakeWatcher(),
  });
  try {
    await writeSkill(path.join(expiredProject, ".codex", "skills"), "expired-session-skill", {
      name: "expired-session-skill",
      description: "Removed when its MCP process exits without a graceful clear.",
    });
    await writeSkill(path.join(renewedProject, ".codex", "skills"), "renewed-session-skill", {
      name: "renewed-session-skill",
      description: "Preserved because tool activity renews this session lease.",
    });
    await inventory.initialize();
    await inventory.replaceSessionProjects("mcp-expired-session", [expiredProject]);
    await inventory.replaceSessionProjects("mcp-renewed-session", [renewedProject]);

    now = new Date("2026-08-30T00:04:00.000Z");
    await inventory.replaceSessionProjects("mcp-renewed-session", [renewedProject]);
    now = new Date("2026-08-30T00:06:00.000Z");
    const snapshot = await inventory.pruneExpiredSessionProjects(5 * 60_000);

    assert.equal(snapshot.skills.some((skill) => skill.name === "expired-session-skill"), false);
    assert.ok(
      snapshot.skills.some((skill) => skill.name === "renewed-session-skill"),
      "pruning one crashed session must retain a renewed independent session",
    );
  } finally {
    await inventory.close();
    await rm(directory, { recursive: true, force: true });
  }
});
