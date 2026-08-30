import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PassThrough } from "node:stream";
import { AppServerClient, type AppServerProcess } from "../src/core/app-server-client.js";
import { InventoryMutationError, InventoryService } from "../src/core/inventory-service.js";
import { OrganizerDatabase, type LogicalSkill } from "../src/v2/index.js";
import { writeSkill } from "./helpers.js";

const NOW = "2026-08-30T00:00:00.000Z";
const localPathLocationProbe = async (): Promise<"local"> => "local";

function logicalSkill(id: string): LogicalSkill {
  return {
    logicalSkillId: id,
    sourceType: "codex-home",
    normalizedSource: "fixture/source",
    packageId: `package-${id}`,
    pluginId: null,
    relativeSkillPath: `${id}/SKILL.md`,
    name: id,
    description: "Safe undo fixture",
    existingCategory: null,
    automaticCategoryId: "development",
    automaticTaxonomyVersion: 1,
    lastSeenAt: NOW,
  };
}

test("classification undo is recorded in the same batch transaction and is offered only while every after-state still matches", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cso-classification-undo-"));
  const store = await OrganizerDatabase.open(path.join(directory, "organizer.db"), { now: () => new Date(NOW) });
  try {
    await store.upsertLogicalSkill(logicalSkill("one"));
    await store.upsertLogicalSkill(logicalSkill("two"));
    await store.applyUserStatePatches([
      {
        logicalSkillId: "one",
        patch: { classification: { mode: "manual", primaryCategoryId: "quality" }, tags: ["user:review"], favorite: true },
      },
      {
        logicalSkillId: "two",
        patch: { classification: { mode: "manual", primaryCategoryId: "security" }, locked: true },
      },
    ]);

    const [action] = store.listUndoActions();
    assert.equal(action?.kind, "classification");
    assert.equal(action?.available, true);
    assert.equal(action?.targetIds.length, 2);
    assert.equal(store.listOperationRecords().filter((record) => record.action === "user-state-batch-patch").length, 1);

    await store.undoClassification(action!.operationId);
    assert.equal(store.getUserState("one").classificationMode, "automatic");
    assert.equal(store.getUserState("one").favorite, false);
    assert.deepEqual(store.getUserState("one").tags, []);
    assert.equal(store.getUserState("two").locked, false, "undo may restore a locked after-state only after exact precondition matching");
    assert.equal(store.listUndoActions().find((item) => item.operationId === action!.operationId)?.available, false);

    await store.applyUserStatePatches([{ logicalSkillId: "one", patch: { favorite: true } }]);
    const staleAction = store.listUndoActions().find((item) => item.available)!;
    await store.setFavorite("one", false);
    assert.equal(store.listUndoActions().find((item) => item.operationId === staleAction.operationId)?.available, false);
    await assert.rejects(() => store.undoClassification(staleAction.operationId), /前置状态/u);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

class UndoFakeProcess extends EventEmitter implements AppServerProcess {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  readonly states = new Map<string, boolean>();
  failurePath: string | null = null;
  scope: "user" | "system" = "user";
  #buffer = "";

  constructor(paths: string[]) {
    super();
    for (const skillPath of paths) this.states.set(skillPath, true);
    this.stdin.setEncoding("utf8");
    this.stdin.on("data", (chunk) => this.#handle(String(chunk)));
  }

  kill(): boolean { return true; }

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
              skills: [...this.states].map(([skillPath, enabled]) => ({
                name: path.basename(path.dirname(skillPath)), description: "Undo fixture", path: skillPath,
                scope: this.scope, enabled, pluginId: null,
              })),
              errors: [],
            }],
          },
        })}\n`);
      } else if (request.method === "skills/config/write") {
        const params = request.params as { path: string; enabled: boolean };
        if (params.path === this.failurePath) {
          this.stdout.write(`${JSON.stringify({ id: request.id, error: { code: -32000, message: "simulated runtime failure" } })}\n`);
        } else {
          this.states.set(params.path, params.enabled);
          this.stdout.write(`${JSON.stringify({ id: request.id, result: { effectiveEnabled: params.enabled } })}\n`);
        }
      }
    }
  }
}

test("runtime writes audit succeeded, failed, and not-executed exact instances; safe undo stops when the after-state is stale", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cso-runtime-undo-"));
  const root = path.join(directory, "skills");
  try {
    const paths = await Promise.all(["first", "second", "third"].map((name) => writeSkill(root, name, {
      name,
      description: "Runtime undo fixture",
    })));
    const fake = new UndoFakeProcess(paths);
    fake.failurePath = paths[1]!;
    const appServer = new AppServerClient({ command: "fake", spawnFactory: () => fake, requestTimeoutMs: 1_000 });
    const service = new InventoryService({
      roots: [{ id: "fixture", label: "Fixture", path: root, kind: "fixture" }],
      statePath: path.join(directory, "organizer.db"),
      appServer,
      now: () => new Date(NOW),
      pathLocationProbe: localPathLocationProbe,
    });
    const initial = await service.initialize();
    const instanceIds = paths.map((skillPath) => initial.skills.find((skill) => skill.absolutePath === skillPath)!.instances![0]!.instanceId);
    const managed = await service.setManagementMode(true);
    const result = await service.setSkillEnabled(instanceIds, false, managed.revision);
    assert.deepEqual(result.succeeded, [instanceIds[0]]);
    assert.equal(result.failed[0]?.skillId, instanceIds[1]);
    assert.deepEqual(result.notExecuted, [instanceIds[2]]);

    const audits = service.store.listOperationRecords().filter((record) => record.action === "runtime-enabled-set");
    assert.equal(audits.find((record) => record.targetId === instanceIds[0])?.status, "succeeded");
    assert.equal(audits.find((record) => record.targetId === instanceIds[1])?.status, "failed");
    assert.equal(audits.find((record) => record.targetId === instanceIds[2])?.status, "not-executed");
    assert.ok(audits.every((record) => !JSON.stringify(record).includes(directory)), "runtime audit must not retain absolute paths");

    const action = service.listUndoActions().find((item) => item.targetIds[0] === instanceIds[0]);
    assert.equal(action?.available, true);
    fake.states.set(paths[0]!, true);
    await service.refresh(true);
    assert.equal(service.listUndoActions().find((item) => item.operationId === action!.operationId)?.available, false);
    await assert.rejects(
      () => service.undoOperations([action!.operationId], service.snapshot.revision, false),
      InventoryMutationError,
    );
    await service.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("runtime undo requires management and sensitive confirmation, targets exact instances, and stops the batch on first failure", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cso-runtime-undo-success-"));
  const root = path.join(directory, "skills");
  let service: InventoryService | null = null;
  try {
    const paths = await Promise.all(["sensitive-one", "sensitive-two"].map((name) => writeSkill(root, name, {
      name,
      description: "Sensitive runtime undo fixture",
    })));
    const fake = new UndoFakeProcess(paths);
    fake.scope = "system";
    const appServer = new AppServerClient({ command: "fake", spawnFactory: () => fake, requestTimeoutMs: 1_000 });
    service = new InventoryService({
      roots: [{ id: "fixture", label: "Fixture", path: root, kind: "fixture" }],
      statePath: path.join(directory, "organizer.db"),
      appServer,
      now: () => new Date(NOW),
      pathLocationProbe: localPathLocationProbe,
    });
    const initial = await service.initialize();
    const instanceIds = paths.map((skillPath) => initial.skills.find((skill) => skill.absolutePath === skillPath)!.instances![0]!.instanceId);
    let snapshot = await service.setManagementMode(true);
    await service.setSkillEnabled(instanceIds, false, snapshot.revision, true);
    let actions = service.listUndoActions().filter((action) => action.kind === "runtime-enabled" && action.available);
    assert.equal(actions.length, 2);
    assert.ok(actions.every((action) => action.sensitive === true));

    snapshot = await service.setManagementMode(false);
    await assert.rejects(() => service!.undoOperations([actions[0]!.operationId], snapshot.revision, true), /管理模式/u);
    snapshot = await service.setManagementMode(true);
    await assert.rejects(() => service!.undoOperations([actions[0]!.operationId], snapshot.revision, false), /二次确认/u);

    actions = service.listUndoActions().filter((action) => action.kind === "runtime-enabled" && action.available);
    const firstTarget = actions[0]!.targetIds[0]!;
    const firstPath = initial.skills.flatMap((skill) => skill.instances ?? []).find((instance) => instance.instanceId === firstTarget)!.absolutePath;
    fake.failurePath = firstPath;
    const stopped = await service.undoOperations(actions.map((action) => action.operationId), service.snapshot.revision, true);
    assert.deepEqual(stopped.succeeded, []);
    assert.deepEqual(stopped.failed.map((item) => item.operationId), [actions[0]!.operationId]);
    assert.deepEqual(stopped.notExecuted, [actions[1]!.operationId]);
    const undoAudits = service.store.listOperationRecords().filter((record) => record.action === "runtime-enabled-undo");
    assert.equal(undoAudits.some((record) => record.status === "failed" && record.targetId === firstTarget), true);
    assert.equal(undoAudits.some((record) => record.status === "not-executed"), true);

    fake.failurePath = null;
    const completed = await service.undoOperations([actions[0]!.operationId], service.snapshot.revision, true);
    assert.deepEqual(completed.failed, []);
    assert.equal(completed.snapshot.skills.flatMap((skill) => skill.instances ?? []).find((instance) => instance.instanceId === firstTarget)?.runtimeEnabled, true);
    assert.equal(service.listUndoActions().find((action) => action.operationId === actions[0]!.operationId)?.available, false);
  } finally {
    await service?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
