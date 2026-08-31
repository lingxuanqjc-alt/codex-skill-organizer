import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  LockedSkillError,
  isConfirmedSqliteCorruptionError,
  OrganizerDatabase,
  OrganizerDatabaseError,
  SQLITE_MIGRATIONS,
  SQLITE_SCHEMA_VERSION,
  UnknownCategoryError,
  type LogicalSkill,
} from "../src/v2/index.js";

const NOW = "2026-08-30T00:00:00.000Z";

test("automatic recovery accepts only confirmed SQLite corruption result codes", () => {
  const sqliteError = (errcode: number): Error & { code: string; errcode: number } => Object.assign(
    new Error("fixture SQLite error"),
    { code: "ERR_SQLITE_ERROR", errcode },
  );

  assert.equal(isConfirmedSqliteCorruptionError(sqliteError(11)), true, "SQLITE_CORRUPT is recoverable");
  assert.equal(isConfirmedSqliteCorruptionError(sqliteError(11 | (3 << 8))), true, "extended corruption codes retain primary code 11");
  assert.equal(isConfirmedSqliteCorruptionError(sqliteError(26)), true, "SQLITE_NOTADB is recoverable");
  for (const errcode of [5, 6, 8, 10, 14]) {
    assert.equal(
      isConfirmedSqliteCorruptionError(sqliteError(errcode)),
      false,
      `SQLite result code ${errcode} must fail without snapshot recovery`,
    );
  }
  assert.equal(
    isConfirmedSqliteCorruptionError(Object.assign(new Error("wrong binding"), { code: "EACCES", errcode: 26 })),
    false,
    "an unrelated error may not impersonate SQLite corruption",
  );
});

function logicalSkill(id: string, automaticCategoryId: LogicalSkill["automaticCategoryId"] = "development"): LogicalSkill {
  return {
    logicalSkillId: id,
    sourceType: "codex-home",
    normalizedSource: "example/source",
    packageId: `package-${id}`,
    pluginId: null,
    relativeSkillPath: `skills/${id}/SKILL.md`,
    name: `skill-${id}`,
    description: "Fixture logical skill",
    existingCategory: null,
    automaticCategoryId,
    automaticTaxonomyVersion: 1,
    lastSeenAt: NOW,
  };
}

async function withDatabase(
  callback: (store: OrganizerDatabase, directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cso-v2-"));
  const store = await OrganizerDatabase.open(path.join(directory, "state.sqlite"), {
    now: () => new Date(NOW),
  });
  try {
    await callback(store, directory);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test("opening a v1 database snapshots it, migrates explicitly to the current schema, and enables WAL", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cso-v2-migration-"));
  const filePath = path.join(directory, "state.sqlite");
  const legacy = new DatabaseSync(filePath);
  legacy.exec(SQLITE_MIGRATIONS[0]!.sql);
  legacy.exec("PRAGMA user_version = 1");
  legacy.prepare(`
    INSERT INTO logical_skills(
      logical_skill_id, source_type, normalized_source, package_id, plugin_id,
      relative_skill_path, name, description, existing_category, automatic_category_id,
      automatic_taxonomy_version, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("legacy", "codex-home", "example/source", "legacy-package", null, "legacy/SKILL.md",
    "legacy", "preserved", null, "development", 1, NOW);
  legacy.close();

  const store = await OrganizerDatabase.open(filePath, { now: () => new Date(NOW) });
  try {
    assert.equal(store.schemaVersion, SQLITE_SCHEMA_VERSION);
    assert.equal(store.journalMode, "wal");
    assert.equal(store.getUserState("legacy").primaryCategoryId, "development");
    assert.equal((await store.listSnapshotFiles()).length, 1, "migration must preserve the pre-migration image");
    const staged = await store.stageClassificationSuggestions([{
      logicalSkillId: "legacy",
      categoryId: "quality",
      confidence: 0.9,
      reason: "The v2 table is available after migration",
    }]);
    assert.equal(staged[0]?.status, "pending");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("the v4 migration treats every existing user state as touched and freezes its automatic category", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cso-v4-touch-migration-"));
  const filePath = path.join(directory, "state.sqlite");
  const legacy = new DatabaseSync(filePath);
  for (const migration of SQLITE_MIGRATIONS.filter((migration) => migration.version <= 4)) {
    legacy.exec(migration.sql);
    legacy.exec(`PRAGMA user_version = ${migration.version}`);
  }
  legacy.prepare(`
    INSERT INTO logical_skills(
      logical_skill_id, source_type, normalized_source, package_id, plugin_id,
      relative_skill_path, name, description, existing_category, automatic_category_id,
      automatic_taxonomy_version, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("v4-touched", "codex-home", "example/source", "legacy-package", null, "legacy/SKILL.md",
    "legacy", "preserved", null, "development", 1, NOW);
  legacy.prepare(`
    INSERT INTO user_skill_state(
      logical_skill_id, classification_mode, primary_category_id, favorite, locked, updated_at
    ) VALUES (?, 'automatic', NULL, 1, 0, ?)
  `).run("v4-touched", NOW);
  legacy.close();

  const store = await OrganizerDatabase.open(filePath, { now: () => new Date(NOW) });
  try {
    assert.equal(store.schemaVersion, SQLITE_SCHEMA_VERSION);
    assert.equal(store.getUserState("v4-touched").automaticClassificationFrozen, true);
    await store.upsertLogicalSkill({
      ...logicalSkill("v4-touched", "quality"),
      packageId: "legacy-package",
      relativeSkillPath: "legacy/SKILL.md",
      name: "legacy",
      automaticTaxonomyVersion: 2,
    });
    const persisted = store.listLogicalSkills().find((skill) => skill.logicalSkillId === "v4-touched")!;
    assert.equal(persisted.automaticCategoryId, "development");
    assert.equal(persisted.automaticTaxonomyVersion, 1);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("the schema 6 identity migration preserves logical IDs and personal state while canonicalizing plugin identity", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cso-v6-identity-migration-"));
  const filePath = path.join(directory, "state.sqlite");
  const legacy = new DatabaseSync(filePath);
  for (const migration of SQLITE_MIGRATIONS.filter((migration) => migration.version <= 6)) {
    legacy.exec(migration.sql);
    legacy.exec(`PRAGMA user_version = ${migration.version}`);
  }
  const logicalSkillId = "stable-plugin-logical-id";
  legacy.prepare(`
    INSERT INTO logical_skills(
      logical_skill_id, source_type, normalized_source, package_id, plugin_id,
      relative_skill_path, name, description, existing_category, automatic_category_id,
      automatic_taxonomy_version, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    logicalSkillId,
    "codex-plugin",
    "plugin:openai-curated-remote/openai-templates",
    "openai-templates",
    "openai-templates@openai-curated-remote",
    "openai-curated-remote/openai-templates/0.1.1/skills/Artifact-Template-Analytics-Dashboard/SKILL.md",
    "artifact-template-analytics-dashboard",
    "Plugin identity fixture",
    null,
    "data-automation",
    1,
    NOW,
  );
  legacy.prepare(`
    INSERT INTO user_skill_state(
      logical_skill_id, classification_mode, primary_category_id, favorite, locked,
      updated_at, automatic_classification_frozen
    ) VALUES (?, 'manual', 'research-analysis', 1, 1, ?, 1)
  `).run(logicalSkillId, NOW);
  legacy.prepare(`
    INSERT INTO tags(tag_id, display_name, created_at, updated_at)
    VALUES ('user:reviewed', 'user:reviewed', ?, ?)
  `).run(NOW, NOW);
  legacy.prepare(`
    INSERT INTO skill_tags(logical_skill_id, tag_id) VALUES (?, 'user:reviewed')
  `).run(logicalSkillId);
  legacy.close();

  const store = await OrganizerDatabase.open(filePath, { now: () => new Date(NOW) });
  try {
    assert.equal(store.schemaVersion, SQLITE_SCHEMA_VERSION);
    assert.ok(SQLITE_SCHEMA_VERSION > 6, "schema 6 needs an explicit compatibility migration");
    const logical = store.listLogicalSkills()[0]!;
    assert.equal(logical.logicalSkillId, logicalSkillId);
    assert.equal(logical.pluginId, "openai-templates");
    assert.equal(
      logical.relativeSkillPath,
      "skills/artifact-template-analytics-dashboard/skill.md",
      "the migration removes cache marketplace/plugin/version components and canonicalizes case",
    );
    assert.deepEqual(store.getUserState(logicalSkillId), {
      logicalSkillId,
      classificationMode: "manual",
      primaryCategoryId: "research-analysis",
      tags: ["user:reviewed"],
      favorite: true,
      locked: true,
      automaticClassificationFrozen: true,
      updatedAt: NOW,
    });
    assert.equal((await store.listSnapshotFiles()).length, 1, "schema 6 is snapshotted before identity migration");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("taxonomy upgrades recalculate only untouched skills and every personal action freezes the current automatic category", async () => {
  await withDatabase(async (store) => {
    const ids = ["untouched", "tagged", "favorited", "locked-upgrade", "restored"];
    for (const id of ids) await store.upsertLogicalSkill(logicalSkill(id, "development"));

    await store.replaceTags("tagged", ["reviewed"]);
    await store.setFavorite("favorited", false);
    await store.setLocked("locked-upgrade", true);
    await store.setManualClassification("restored", "quality");
    await store.restoreAutomaticClassification("restored");
    assert.equal(store.getUserState("restored").primaryCategoryId, "development", "restore uses the currently stored automatic category");

    for (const id of ids) {
      await store.upsertLogicalSkill({
        ...logicalSkill(id, "security"),
        automaticTaxonomyVersion: 2,
      });
    }

    const logical = new Map(store.listLogicalSkills().map((skill) => [skill.logicalSkillId, skill]));
    assert.equal(logical.get("untouched")?.automaticCategoryId, "security");
    assert.equal(logical.get("untouched")?.automaticTaxonomyVersion, 2);
    assert.equal(store.getUserState("untouched").automaticClassificationFrozen, false);

    for (const id of ids.slice(1)) {
      assert.equal(logical.get(id)?.automaticCategoryId, "development", `${id} keeps the category visible when touched`);
      assert.equal(logical.get(id)?.automaticTaxonomyVersion, 1, `${id} keeps the matching taxonomy version`);
      assert.equal(store.getUserState(id).automaticClassificationFrozen, true);
    }
    assert.equal(store.getUserState("locked-upgrade").locked, true, "a taxonomy upgrade never mutates a locked item");
    assert.equal(store.getUserState("restored").classificationMode, "automatic");
    assert.equal(store.getUserState("restored").primaryCategoryId, "development");
  });
});

test("custom roots, category preferences, and saved views persist without machine paths in logical identity", async () => {
  await withDatabase(async (store) => {
    await store.upsertConfiguredRoot({
      rootId: "custom-fixture",
      label: "Synced Skills",
      absolutePath: "C:\\fixture\\synced-skills",
      readonly: true,
      managementAuthorized: false,
      createdAt: NOW,
      updatedAt: NOW,
    });
    assert.equal(store.listConfiguredRoots()[0]?.readonly, true);
    assert.equal(store.listConfiguredRoots()[0]?.managementAuthorized, false);

    await store.setCategoryPreference({
      categoryId: "development",
      display: { zhCN: "我的工程" },
      sortOrder: 2,
      hidden: false,
      updatedAt: NOW,
    });
    assert.equal(store.listCategoryPreferences()[0]?.display.zhCN, "我的工程");

    await store.upsertSavedView({
      viewId: "favorites",
      name: "Favorites",
      filters: { favorite: true, scopes: ["user", "custom"] },
      createdAt: NOW,
      updatedAt: NOW,
    });
    assert.deepEqual(store.listSavedViews()[0]?.filters, { favorite: true, scopes: ["user", "custom"] });
    await store.deleteSavedView("favorites");
    await store.deleteConfiguredRoot("custom-fixture");
    assert.equal(store.listSavedViews().length, 0);
    assert.equal(store.listConfiguredRoots().length, 0);
  });
});

test("every committed state change has a pre-write backup and only the newest ten survive", async () => {
  await withDatabase(async (store) => {
    await store.upsertLogicalSkill(logicalSkill("snapshot"));
    for (let index = 0; index < 12; index += 1) {
      await store.setFavorite("snapshot", index % 2 === 0);
    }
    const snapshots = await store.listSnapshotFiles();
    assert.equal(snapshots.length, 10);
    assert.equal(store.journalMode, "wal");
    assert.equal(store.getUserState("snapshot").favorite, false);
  });
});

test("concurrent database connections preserve distinct readable pre-write snapshots", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cso-v2-concurrent-snapshots-"));
  const filePath = path.join(directory, "state.sqlite");
  const options = { now: () => new Date(NOW) };
  const first = await OrganizerDatabase.open(filePath, options);
  const second = await OrganizerDatabase.open(filePath, options);
  try {
    await Promise.all([
      first.setManagementMode(true),
      second.setManagementMode(false),
    ]);

    const snapshots = await first.listSnapshotFiles();
    assert.equal(snapshots.length, 2, "each connection must retain its own recovery point even at the same timestamp");
    assert.equal(new Set(snapshots).size, 2, "snapshot paths must be unique across connections");
    for (const snapshotPath of snapshots) {
      const snapshot = new DatabaseSync(snapshotPath, { readOnly: true });
      try {
        const integrity = snapshot.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
        assert.equal(integrity.integrity_check, "ok", `${path.basename(snapshotPath)} must be independently readable`);
      } finally {
        snapshot.close();
      }
    }
  } finally {
    await first.close();
    await second.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("live discovery syncs logical skills and instances in one snapshot without deleting user state", async () => {
  await withDatabase(async (store) => {
    const skills = [logicalSkill("sync-one"), logicalSkill("sync-two")];
    await store.syncInventory(skills, skills.map((skill, index) => ({
      instanceId: `instance-${index}`,
      logicalSkillId: skill.logicalSkillId,
      rootId: "codex",
      absolutePath: `C:\\fixture\\${skill.logicalSkillId}\\SKILL.md`,
      physicalFingerprint: `fingerprint-${index}`,
      version: null,
      pluginCacheVersion: null,
      runtimeScope: "user" as const,
      runtimeEnabled: true,
      readonly: false,
      lastSeenAt: NOW,
    })));
    assert.equal((await store.listSnapshotFiles()).length, 1, "one inventory generation has one backup");
    assert.equal(store.listLogicalSkills().length, 2);
    assert.equal(store.listSkillInstances("sync-one").length, 1);
    await store.setFavorite("sync-one", true);

    await store.syncInventory([logicalSkill("sync-two")], []);
    assert.equal(store.listLogicalSkills().length, 2, "stale logical rows remain available");
    assert.equal(store.getUserState("sync-one").favorite, true, "discovery never deletes user decisions");
  });
});

test("locking is a hard boundary for classification, tags, favorites, and AI suggestions", async () => {
  await withDatabase(async (store) => {
    await store.upsertLogicalSkill(logicalSkill("locked"));
    await store.setLocked("locked", true);

    await assert.rejects(() => store.setManualClassification("locked", "quality"), LockedSkillError);
    await assert.rejects(() => store.replaceTags("locked", ["review"]), LockedSkillError);
    await assert.rejects(() => store.setFavorite("locked", true), LockedSkillError);
    await assert.rejects(() => store.stageClassificationSuggestions([{
      logicalSkillId: "locked",
      categoryId: "quality",
      confidence: 0.95,
      reason: "Should never bypass a lock",
    }]), LockedSkillError);

    await store.setLocked("locked", false);
    const changed = await store.setManualClassification("locked", "quality");
    assert.equal(changed.primaryCategoryId, "quality");
  });
});

test("tag merge and category deletion are atomic and refuse to mutate locked members", async () => {
  await withDatabase(async (store) => {
    await store.upsertLogicalSkill(logicalSkill("one"));
    await store.upsertLogicalSkill(logicalSkill("two"));
    await store.replaceTags("one", ["Review"]);
    await store.replaceTags("two", ["review", "Keep"]);
    assert.equal(await store.mergeTags("review", "verified"), 2);
    assert.deepEqual(store.getUserState("one").tags, ["verified"]);
    assert.deepEqual(store.getUserState("two").tags, ["Keep", "verified"]);

    await store.createCustomCategory({
      categoryId: "custom:legacy",
      label: { zhCN: "旧分类", enUS: "Legacy" },
      sortOrder: 12,
      hidden: false,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await store.setManualClassification("one", "custom:legacy");
    await store.setManualClassification("two", "custom:legacy");
    await store.setLocked("two", true);
    await assert.rejects(
      () => store.migrateAndDeleteCustomCategory("custom:legacy", "research-analysis"),
      LockedSkillError,
    );
    assert.equal(store.getUserState("one").primaryCategoryId, "custom:legacy", "failed migration rolls back all rows");

    await store.setLocked("two", false);
    assert.equal(await store.migrateAndDeleteCustomCategory("custom:legacy", "research-analysis"), 2);
    assert.equal(store.getUserState("one").primaryCategoryId, "research-analysis");
    assert.equal(store.getUserState("two").primaryCategoryId, "research-analysis");
  });
});

test("classification suggestions remain staged until the user accepts them", async () => {
  await withDatabase(async (store) => {
    await store.upsertLogicalSkill(logicalSkill("suggestion", "development"));
    const [suggestion] = await store.stageClassificationSuggestions([{
      suggestionId: "suggestion-1",
      logicalSkillId: "suggestion",
      categoryId: "research-analysis",
      tags: ["AI Suggested"],
      confidence: 0.91,
      reason: "Research-oriented metadata",
    }]);
    assert.equal(store.getUserState("suggestion").classificationMode, "automatic");
    assert.equal(store.getUserState("suggestion").primaryCategoryId, "development");
    assert.equal(store.listClassificationSuggestions("pending").length, 1);

    const accepted = await store.resolveClassificationSuggestion(suggestion!.suggestionId, "accepted");
    assert.equal(accepted.status, "accepted");
    const finalState = store.getUserState("suggestion");
    assert.equal(finalState.classificationMode, "manual");
    assert.equal(finalState.primaryCategoryId, "research-analysis");
    assert.deepEqual(finalState.tags, ["AI Suggested"]);
    const undo = store.listUndoActions().find((action) => action.kind === "classification" && action.available);
    assert.ok(undo, "an accepted suggestion remains a classification decision that the desktop can safely undo");
    await store.undoClassification(undo.operationId);
    assert.equal(store.getUserState("suggestion").classificationMode, "automatic");
    assert.deepEqual(store.getUserState("suggestion").tags, []);
  });
});

test("batch suggestion resolution validates every lock before committing one transaction", async () => {
  await withDatabase(async (store) => {
    await store.upsertLogicalSkill(logicalSkill("suggestion-open", "development"));
    await store.upsertLogicalSkill(logicalSkill("suggestion-locked", "development"));
    const staged = await store.stageClassificationSuggestions([
      {
        suggestionId: "batch-open",
        logicalSkillId: "suggestion-open",
        categoryId: "quality",
        tags: ["Reviewed"],
        confidence: 0.94,
        reason: "Quality metadata",
      },
      {
        suggestionId: "batch-locked",
        logicalSkillId: "suggestion-locked",
        categoryId: "security",
        tags: ["Protected"],
        confidence: 0.96,
        reason: "Security metadata",
      },
    ]);
    await store.setLocked("suggestion-locked", true);

    const snapshotsBeforeFailure = (await store.listSnapshotFiles()).length;
    await assert.rejects(
      () => store.resolveClassificationSuggestions(staged.map((item) => item.suggestionId), "accepted"),
      LockedSkillError,
    );
    assert.equal(store.getUserState("suggestion-open").classificationMode, "automatic");
    assert.deepEqual(store.getUserState("suggestion-open").tags, []);
    assert.deepEqual(
      store.listClassificationSuggestions("pending").map((item) => item.suggestionId).sort(),
      ["batch-locked", "batch-open"],
      "a later locked target must leave every earlier suggestion staged",
    );
    assert.equal((await store.listSnapshotFiles()).length, snapshotsBeforeFailure + 1);
    assert.equal(
      store.listOperationRecords().filter((record) => record.action === "classification-suggestions-accepted").length,
      0,
      "a rolled-back batch must not claim a successful audit record",
    );

    await store.setLocked("suggestion-locked", false);
    const snapshotsBeforeSuccess = (await store.listSnapshotFiles()).length;
    const resolved = await store.resolveClassificationSuggestions(staged.map((item) => item.suggestionId), "accepted");
    assert.deepEqual(resolved.map((item) => item.status), ["accepted", "accepted"]);
    assert.equal(store.getUserState("suggestion-open").primaryCategoryId, "quality");
    assert.deepEqual(store.getUserState("suggestion-open").tags, ["Reviewed"]);
    assert.equal(store.getUserState("suggestion-locked").primaryCategoryId, "security");
    assert.equal((await store.listSnapshotFiles()).length, snapshotsBeforeSuccess + 1, "one batch creates one recovery snapshot");
    const audits = store.listOperationRecords().filter((record) => record.action === "classification-suggestions-accepted");
    assert.equal(audits.length, 1, "one accepted batch creates one audit record");
    assert.equal(audits[0]?.summary.count, 2);
  });
});

test("batch suggestion resolution fails closed on an unknown ID, resolved state, or invalid category", async () => {
  await withDatabase(async (store, directory) => {
    await store.upsertLogicalSkill(logicalSkill("preflight-one"));
    await store.upsertLogicalSkill(logicalSkill("preflight-two"));
    await store.stageClassificationSuggestions([
      {
        suggestionId: "preflight-one",
        logicalSkillId: "preflight-one",
        categoryId: "quality",
        confidence: 0.9,
        reason: "First valid suggestion",
      },
      {
        suggestionId: "preflight-two",
        logicalSkillId: "preflight-two",
        categoryId: "security",
        confidence: 0.9,
        reason: "Second valid suggestion",
      },
    ]);

    await assert.rejects(
      () => store.resolveClassificationSuggestions(["preflight-one", "missing"], "accepted"),
      OrganizerDatabaseError,
    );
    assert.equal(store.listClassificationSuggestions("pending").some((item) => item.suggestionId === "preflight-one"), true);

    await store.resolveClassificationSuggestion("preflight-two", "rejected");
    assert.equal(
      store.getUserState("preflight-two").automaticClassificationFrozen,
      true,
      "rejecting a staged suggestion is still an explicit personal decision",
    );
    await assert.rejects(
      () => store.resolveClassificationSuggestions(["preflight-one", "preflight-two"], "accepted"),
      OrganizerDatabaseError,
    );
    assert.equal(store.listClassificationSuggestions("pending").some((item) => item.suggestionId === "preflight-one"), true);

    const raw = new DatabaseSync(path.join(directory, "state.sqlite"));
    try {
      raw.prepare("UPDATE classification_suggestions SET category_id = ? WHERE suggestion_id = ?")
        .run("custom:missing", "preflight-one");
    } finally {
      raw.close();
    }
    await assert.rejects(
      () => store.resolveClassificationSuggestions(["preflight-one"], "accepted"),
      UnknownCategoryError,
    );
    assert.equal(store.getUserState("preflight-one").classificationMode, "automatic");
    assert.equal(store.listClassificationSuggestions("pending")[0]?.suggestionId, "preflight-one");
  });
});

test("a combined user-state decision is one protected transaction and one audit record", async () => {
  await withDatabase(async (store) => {
    await store.upsertLogicalSkill(logicalSkill("patch"));
    const snapshotsBefore = (await store.listSnapshotFiles()).length;
    const state = await store.applyUserStatePatch("patch", {
      classification: { mode: "manual", primaryCategoryId: "quality" },
      tags: ["Reviewed", "verified"],
      favorite: true,
      locked: true,
    });
    assert.equal((await store.listSnapshotFiles()).length, snapshotsBefore + 1);
    assert.equal(state.primaryCategoryId, "quality");
    assert.deepEqual(state.tags, ["Reviewed", "verified"]);
    assert.equal(state.favorite, true);
    assert.equal(state.locked, true);
    assert.equal(store.listUserStates().length, 1);
    assert.equal(store.listOperationRecords().filter((record) => record.action === "user-state-patch").length, 1);

    await assert.rejects(
      () => store.applyUserStatePatch("patch", { locked: false, favorite: false }),
      LockedSkillError,
    );
    await store.applyUserStatePatch("patch", { locked: false });
    assert.equal(store.getUserState("patch").locked, false);
  });
});

test("a bulk classification edit is all-or-nothing when any selected skill is locked", async () => {
  await withDatabase(async (store) => {
    await store.upsertLogicalSkill(logicalSkill("bulk-open"));
    await store.upsertLogicalSkill(logicalSkill("bulk-locked"));
    await store.setLocked("bulk-locked", true);
    const snapshotsBefore = (await store.listSnapshotFiles()).length;

    await assert.rejects(() => store.applyUserStatePatches([
      { logicalSkillId: "bulk-open", patch: { favorite: true } },
      { logicalSkillId: "bulk-locked", patch: { favorite: true } },
    ]), LockedSkillError);

    assert.equal(store.getUserState("bulk-open").favorite, false, "the first row must roll back with the locked row");
    assert.equal(store.getUserState("bulk-locked").favorite, false);
    assert.equal((await store.listSnapshotFiles()).length, snapshotsBefore + 1, "the rejected attempt still has one recovery snapshot");
  });
});

test("installation, update, and quarantine read APIs retain exact opaque identities", async () => {
  await withDatabase(async (store) => {
    await store.upsertLogicalSkill(logicalSkill("managed"));
    await store.upsertSkillInstance({
      instanceId: "instance-managed",
      logicalSkillId: "managed",
      rootId: "codex",
      absolutePath: "C:\\fixture\\managed\\SKILL.md",
      physicalFingerprint: "fingerprint",
      version: "1.0.0",
      pluginCacheVersion: null,
      runtimeScope: "user",
      runtimeEnabled: true,
      readonly: false,
      lastSeenAt: NOW,
    });
    await store.upsertInstallationUnit({
      installationUnitId: "unit-managed",
      kind: "skill",
      rootId: "codex",
      absolutePath: "C:\\fixture\\managed",
      sourceType: "codex-home",
      sourceReference: "example/source",
      confirmed: true,
      managementAuthorized: true,
      containsLink: false,
      insideGitWorktree: false,
      sizeBytes: 1024,
      updatedAt: NOW,
    });
    await store.saveUpdateEvidence({
      evidenceId: "evidence-managed",
      instanceId: "instance-managed",
      sourceKind: "github",
      installedReference: "v1.0.0",
      availableReference: "v1.1.0",
      evidenceKind: "release",
      comparisonUrl: "https://github.com/example/source/compare/v1.0.0...v1.1.0",
      locallyModified: false,
      checkedAt: NOW,
      expiresAt: null,
    });
    await store.saveQuarantineEntry({
      quarantineEntryId: "quarantine-managed",
      installationUnitId: "unit-managed",
      originalPath: "C:\\fixture\\managed",
      quarantinePath: "C:\\quarantine\\managed",
      contentFingerprint: "fingerprint",
      status: "quarantined",
      quarantinedAt: NOW,
      restoredAt: null,
      restoredPath: null,
    });
    assert.equal(store.getInstallationUnit("unit-managed")?.installationUnitId, "unit-managed");
    assert.equal(store.listInstallationUnits().length, 1);
    assert.equal(store.listUpdateEvidence("instance-managed")[0]?.evidenceId, "evidence-managed");
    assert.equal(store.getQuarantineEntry("quarantine-managed")?.status, "quarantined");
    assert.equal(store.listQuarantineEntries().length, 1);
  });
});

test("management mode persists and each write prunes path-redacted audit records older than thirty days", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cso-v2-audit-"));
  let now = new Date("2026-01-01T00:00:00.000Z");
  const store = await OrganizerDatabase.open(path.join(directory, "state.sqlite"), { now: () => now });
  try {
    await store.recordOperation({
      operationId: "old",
      action: "fixture",
      targetType: "settings",
      targetId: "fixture",
      status: "succeeded",
      summary: { path: "C:\\Users\\example\\secret" },
      occurredAt: now.toISOString(),
    });
    assert.equal(store.listOperationRecords()[0]?.summary.path, "[redacted]");

    now = new Date("2026-02-01T00:00:00.000Z");
    await store.setManagementMode(true);
    assert.equal(store.getManagementMode(), true);
    const operations = store.listOperationRecords();
    assert.equal(operations.some((record) => record.operationId === "old"), false);
    assert.equal(operations.some((record) => record.action === "management-mode-set"), true);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("thirty-day audit pruning cascades to undo payloads so stale before/after state is not retained", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cso-v2-undo-retention-"));
  let now = new Date("2026-01-01T00:00:00.000Z");
  const store = await OrganizerDatabase.open(path.join(directory, "state.sqlite"), { now: () => now });
  try {
    await store.upsertLogicalSkill(logicalSkill("retained"));
    await store.applyUserStatePatches([{ logicalSkillId: "retained", patch: { favorite: true } }]);
    assert.equal(store.listUndoActions().length, 1);
    now = new Date("2026-02-01T00:00:00.000Z");
    await store.setManagementMode(true);
    assert.equal(store.listUndoActions().length, 0);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
