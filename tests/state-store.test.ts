import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { StateStore, StateValidationError } from "../src/core/state-store.js";

const SKILL_ID = "a".repeat(64);

test("state store persists overrides and restores a versioned backup", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cso-state-"));
  const filePath = path.join(directory, "state.v1.json");
  try {
    const store = new StateStore(filePath);
    await store.load();
    await store.update((draft) => {
      draft.overrides[SKILL_ID] = {
        primaryCategoryId: "development",
        addedTagIds: ["user:重点"],
        removedTagIds: [],
        favorite: true,
        locked: true,
        updatedAt: new Date().toISOString(),
        taxonomyVersion: 1,
      };
    });
    const persisted = JSON.parse(await readFile(filePath, "utf8"));
    assert.equal(persisted.revision, 1);
    assert.equal(persisted.overrides[SKILL_ID].favorite, true);

    const backup = store.exportBackup();
    await store.clear();
    assert.equal(Object.keys(store.snapshot().overrides).length, 0);
    await store.importBackup(backup, "replace");
    assert.equal(store.snapshot().overrides[SKILL_ID]?.primaryCategoryId, "development");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("invalid backup is rejected before current data changes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cso-state-"));
  try {
    const store = new StateStore(path.join(directory, "state.v1.json"));
    await store.load();
    const before = store.snapshot();
    await assert.rejects(
      () => store.importBackup({ format: "wrong", version: 1 }, "replace"),
      StateValidationError,
    );
    assert.deepEqual(store.snapshot(), before);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("EFS-style EXDEV replacement uses a durable journal and remains reloadable", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cso-state-exdev-"));
  const filePath = path.join(temporary, "state.v1.json");
  const simulatedExdev = Object.assign(new Error("simulated encrypted-directory rename failure"), { code: "EXDEV" });
  const store = new StateStore(filePath, {
    moveFile: async () => { throw simulatedExdev; },
  });
  await store.load();
  await store.update((draft) => {
    draft.overrides["c".repeat(64)] = {
      primaryCategoryId: "research-analysis",
      addedTagIds: ["user:recovery"],
      removedTagIds: [],
      favorite: false,
      locked: true,
      updatedAt: new Date().toISOString(),
      taxonomyVersion: 1,
    };
  });

  const reloaded = new StateStore(filePath);
  const state = await reloaded.load();
  assert.equal(state.revision, 1);
  assert.equal(state.overrides["c".repeat(64)]?.primaryCategoryId, "research-analysis");
  await assert.rejects(readFile(`${filePath}.next`, "utf8"), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  await rm(temporary, { recursive: true, force: true });
});
