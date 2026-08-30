import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createNodeQuarantineFileAdapter,
  QuarantineSafetyError,
  QuarantineService,
  type LiveQuarantineInventory,
  type QuarantineFileAdapter,
  type QuarantineSkillReference,
} from "../src/core/quarantine-service.js";
import type { ObservedSkill, RootDefinition } from "../src/shared/types.js";
import { OrganizerDatabase, type InstallationUnit } from "../src/v2/index.js";

const NOW = "2026-08-30T00:00:00.000Z";

interface Harness {
  temporary: string;
  rootPath: string;
  dataPath: string;
  root: RootDefinition;
  database: OrganizerDatabase;
}

async function createHarness(): Promise<Harness> {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cso-quarantine-"));
  const rootPath = path.join(temporary, "skills");
  const dataPath = path.join(temporary, "data");
  await Promise.all([mkdir(rootPath, { recursive: true }), mkdir(dataPath, { recursive: true })]);
  const database = await OrganizerDatabase.open(path.join(dataPath, "organizer.db"), {
    now: () => new Date(NOW),
  });
  return {
    temporary,
    rootPath,
    dataPath,
    database,
    root: {
      id: "fixture",
      label: "Fixture",
      path: rootPath,
      kind: "fixture",
      managementGranted: true,
    },
  };
}

async function closeHarness(harness: Harness): Promise<void> {
  await harness.database.close();
  await rm(harness.temporary, { recursive: true, force: true });
}

async function createUnit(
  harness: Harness,
  id: string,
  overrides: Partial<InstallationUnit> = {},
): Promise<{ unit: InstallationUnit; skill: QuarantineSkillReference; skillPath: string }> {
  const unitPath = overrides.absolutePath ?? path.join(harness.rootPath, id);
  await mkdir(unitPath, { recursive: true });
  const skillPath = path.join(unitPath, "SKILL.md");
  await writeFile(skillPath, `---\nname: ${id}\ndescription: fixture\n---\n\n# ${id}\n`, "utf8");
  const unit: InstallationUnit = {
    installationUnitId: id,
    kind: "skill",
    rootId: harness.root.id,
    absolutePath: unitPath,
    sourceType: "codex-home",
    sourceReference: "fixture/source",
    confirmed: true,
    managementAuthorized: true,
    containsLink: false,
    insideGitWorktree: false,
    sizeBytes: null,
    updatedAt: NOW,
    ...overrides,
  };
  const skill: QuarantineSkillReference = {
    logicalSkillId: `logical-${id}`,
    instanceId: `instance-${id}`,
    absolutePath: skillPath,
    rootId: unit.rootId,
    scope: "user",
    readonly: false,
    pluginId: null,
  };
  await harness.database.upsertInstallationUnit(unit);
  return { unit, skill, skillPath };
}

function inventory(units: InstallationUnit[], skills: QuarantineSkillReference[], revision = "revision-1"): LiveQuarantineInventory {
  return { revision, units, skills };
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

test("prepare is read-only, shows impact, and execution requires management mode plus a fresh revision", async () => {
  const harness = await createHarness();
  try {
    const { unit, skill, skillPath } = await createUnit(harness, "safe-skill");
    await writeFile(path.join(unit.absolutePath, ".env"), "SECRET=never-parsed", "utf8");
    const service = new QuarantineService({
      database: harness.database,
      dataDirectory: harness.dataPath,
      roots: [harness.root],
      now: () => new Date(NOW),
      fileAdapter: {
        hashFile: async () => { throw new Error("prepare must not hash file bodies"); },
      },
    });
    const plan = await service.prepare([unit.installationUnitId], inventory([unit], [skill]));
    assert.equal(plan.executable, true, JSON.stringify(plan.items));
    assert.equal(await exists(unit.absolutePath), true, "prepare never moves the source");
    assert.deepEqual(plan.items[0]?.affectedSkillIds, [skill.logicalSkillId]);
    assert.ok(plan.items[0]?.tree.some((entry) => entry.relativePath === ".env"));
    assert.ok(plan.items[0]?.tree.some((entry) => entry.relativePath === "SKILL.md"));
    assert.equal(await readFile(skillPath, "utf8").then((value) => value.includes("safe-skill")), true);

    await assert.rejects(
      () => service.quarantine(plan.planId, true, plan.inventoryRevision),
      /管理模式未开启/,
    );
    await harness.database.setManagementMode(true);
    await assert.rejects(
      () => service.quarantine(plan.planId, true, "stale-revision"),
      /revision 已变化/,
    );
    await writeFile(path.join(unit.absolutePath, "changed-after-plan.txt"), "changed", "utf8");
    const changed = await service.quarantine(plan.planId, true, plan.inventoryRevision);
    assert.equal(changed.failed[0]?.installationUnitId, unit.installationUnitId);
    assert.match(changed.failed[0]?.message ?? "", /发生变化/);
    assert.equal(await exists(unit.absolutePath), true);
  } finally {
    await closeHarness(harness);
  }
});

test("quarantine accepts a DOS 8.3 source alias only when it retains the same physical identity", async () => {
  const harness = await createHarness();
  try {
    const shortParent = path.join(harness.temporary, "RUNNER~1");
    const longParent = path.join(harness.temporary, "runneradmin");
    const rootPath = path.join(shortParent, "skills");
    const aliasHarness: Harness = {
      ...harness,
      rootPath,
      root: {
        id: "fixture-short-root",
        label: "Fixture short root",
        path: rootPath,
        kind: "fixture",
        managementGranted: true,
      },
    };
    const { unit, skill } = await createUnit(aliasHarness, "safe-short-alias");
    const base = createNodeQuarantineFileAdapter();
    const toLong = (candidate: string): string => candidate.replace(shortParent, longParent);
    const toShort = (candidate: string): string => candidate.replace(longParent, shortParent);
    const service = new QuarantineService({
      database: harness.database,
      dataDirectory: harness.dataPath,
      roots: [aliasHarness.root],
      now: () => new Date(NOW),
      fileAdapter: {
        lstat: (candidate) => base.lstat(toShort(candidate)),
        realpath: async (candidate) => toLong(await base.realpath(toShort(candidate))),
      },
    });
    await harness.database.setManagementMode(true);

    const plan = await service.prepare([unit.installationUnitId], inventory([unit], [skill]));
    assert.equal(plan.executable, true);
    const result = await service.quarantine(plan.planId, true, plan.inventoryRevision);

    assert.deepEqual(result.succeeded, [unit.installationUnitId]);
    assert.equal(await exists(unit.absolutePath), false);
    assert.equal(await exists(result.entries[0]!.quarantinePath), true);
  } finally {
    await closeHarness(harness);
  }
});

test("candidate discovery groups nested physical skills into one unconfirmed bundle boundary", async () => {
  const harness = await createHarness();
  try {
    const bundlePath = path.join(harness.rootPath, "bundle");
    const skillPaths = [
      path.join(bundlePath, "src", "skills", "one", "SKILL.md"),
      path.join(bundlePath, "src", "skills", "two", "SKILL.md"),
    ];
    await Promise.all(skillPaths.map(async (skillPath, index) => {
      await mkdir(path.dirname(skillPath), { recursive: true });
      await writeFile(skillPath, `---\nname: skill-${index}\ndescription: fixture\n---\n`, "utf8");
    }));
    const observed = skillPaths.map((skillPath, index): ObservedSkill => ({
      skillId: `logical-${index}`,
      physicalId: `physical-${index}`,
      instanceId: `instance-${index}`,
      name: `skill-${index}`,
      description: "fixture",
      scope: "user",
      sourceId: "fixture/source",
      sourceLabel: "Fixture",
      packageId: "bundle",
      pluginId: null,
      pluginVersion: null,
      rootId: harness.root.id,
      rootLabel: harness.root.label,
      absolutePath: skillPath,
      relativePath: path.relative(harness.rootPath, skillPath).replaceAll("\\", "/"),
      breadcrumb: `Fixture > skill-${index}`,
      readonly: false,
      aliases: [],
      diagnostics: [],
    }));
    const service = new QuarantineService({
      database: harness.database,
      dataDirectory: harness.dataPath,
      roots: [harness.root],
      now: () => new Date(NOW),
    });
    const candidates = await service.discoverCandidates(observed);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0]?.kind, "bundle");
    assert.equal(candidates[0]?.confirmed, false);
    assert.deepEqual(candidates[0]?.affectedSkillIds, ["logical-0", "logical-1"]);
    assert.equal(candidates[0]?.absolutePath, bundlePath);
  } finally {
    await closeHarness(harness);
  }
});

test("prepare rejects overlapping installation-unit boundaries before moving either unit", async () => {
  const harness = await createHarness();
  try {
    const parent = await createUnit(harness, "parent", { kind: "bundle" });
    const child = await createUnit(harness, "child", {
      absolutePath: path.join(parent.unit.absolutePath, "child"),
    });
    const service = new QuarantineService({
      database: harness.database,
      dataDirectory: harness.dataPath,
      roots: [harness.root],
      now: () => new Date(NOW),
    });
    const plan = await service.prepare(
      [parent.unit.installationUnitId, child.unit.installationUnitId],
      inventory([parent.unit, child.unit], [parent.skill, child.skill]),
    );
    assert.equal(plan.executable, false);
    assert.ok(plan.items.every((item) => item.blockers.some((entry) => entry.code === "UNKNOWN_BOUNDARY")));
    assert.equal(await exists(parent.unit.absolutePath), true);
    assert.equal(await exists(child.unit.absolutePath), true);
  } finally {
    await closeHarness(harness);
  }
});

test("safe unit can be quarantined and restored without overwriting any path", async () => {
  const harness = await createHarness();
  try {
    const { unit, skill, skillPath } = await createUnit(harness, "roundtrip");
    const expected = await readFile(skillPath, "utf8");
    const service = new QuarantineService({
      database: harness.database,
      dataDirectory: harness.dataPath,
      roots: [harness.root],
      now: () => new Date(NOW),
    });
    await harness.database.setManagementMode(true);
    const plan = await service.prepare([unit.installationUnitId], inventory([unit], [skill]));
    const result = await service.quarantine(plan.planId, true, plan.inventoryRevision);
    assert.deepEqual(result.succeeded, [unit.installationUnitId]);
    assert.deepEqual(result.failed, []);
    assert.equal(await exists(unit.absolutePath), false);
    assert.equal(await exists(result.entries[0]!.quarantinePath), true);
    assert.equal(harness.database.getQuarantineEntry(result.entries[0]!.quarantineEntryId)?.status, "quarantined");

    const restored = await service.restore(result.entries[0]!.quarantineEntryId, true);
    assert.equal(restored.status, "restored");
    assert.equal(await readFile(skillPath, "utf8"), expected);
    assert.equal(await exists(result.entries[0]!.quarantinePath), false);
  } finally {
    await closeHarness(harness);
  }
});

test("restore conflict stops without overwrite and purge removes only the quarantined copy", async () => {
  const harness = await createHarness();
  try {
    const { unit, skill } = await createUnit(harness, "conflict");
    const service = new QuarantineService({
      database: harness.database,
      dataDirectory: harness.dataPath,
      roots: [harness.root],
      now: () => new Date(NOW),
    });
    await harness.database.setManagementMode(true);
    const plan = await service.prepare([unit.installationUnitId], inventory([unit], [skill]));
    const result = await service.quarantine(plan.planId, true, plan.inventoryRevision);
    const entry = result.entries[0]!;
    await mkdir(unit.absolutePath, { recursive: true });
    const conflictFile = path.join(unit.absolutePath, "user-file.txt");
    await writeFile(conflictFile, "keep me", "utf8");

    await assert.rejects(() => service.restore(entry.quarantineEntryId, true), /不会覆盖/);
    assert.equal(await readFile(conflictFile, "utf8"), "keep me");
    assert.equal(await exists(entry.quarantinePath), true);

    const purged = await service.purge(entry.quarantineEntryId, true);
    assert.equal(purged.status, "purged");
    assert.equal(await exists(entry.quarantinePath), false);
    assert.equal(await readFile(conflictFile, "utf8"), "keep me", "purge never targets the restore conflict");
  } finally {
    await closeHarness(harness);
  }
});

test("an explicit same-parent restore choice preserves the conflict and records the actual destination", async () => {
  const harness = await createHarness();
  try {
    const { unit, skill } = await createUnit(harness, "restore-choice");
    const service = new QuarantineService({
      database: harness.database,
      dataDirectory: harness.dataPath,
      roots: [harness.root],
      now: () => new Date(NOW),
    });
    await harness.database.setManagementMode(true);
    const plan = await service.prepare([unit.installationUnitId], inventory([unit], [skill]));
    const result = await service.quarantine(plan.planId, true, plan.inventoryRevision);
    const entry = result.entries[0]!;
    await mkdir(unit.absolutePath, { recursive: true });
    const conflictFile = path.join(unit.absolutePath, "user-file.txt");
    await writeFile(conflictFile, "keep me", "utf8");
    const alternativePath = `${unit.absolutePath}.restored`;

    await assert.rejects(
      () => service.restore(entry.quarantineEntryId, true, path.join(harness.rootPath, "another-parent", "choice")),
      /同一父目录/u,
    );

    const restored = await service.restore(entry.quarantineEntryId, true, alternativePath);
    assert.equal(restored.status, "restored");
    assert.equal(restored.originalPath, unit.absolutePath, "the audit keeps the original location");
    assert.equal(restored.restoredPath, alternativePath, "the explicit alternative is recorded");
    assert.equal(await readFile(conflictFile, "utf8"), "keep me", "the conflicting directory is never overwritten");
    assert.match(await readFile(path.join(alternativePath, "SKILL.md"), "utf8"), /restore-choice/u);
    assert.equal(harness.database.getQuarantineEntry(entry.quarantineEntryId)?.restoredPath, alternativePath);

  } finally {
    await closeHarness(harness);
  }
});

test("prepare fail-closes unconfirmed, unauthorized, protected, outside-root, Git, size, and link units", async () => {
  const harness = await createHarness();
  try {
    const unconfirmed = await createUnit(harness, "unconfirmed", { confirmed: false, managementAuthorized: false });
    const protectedUnit = await createUnit(harness, "protected", { sourceType: "repo" });
    protectedUnit.skill.scope = "repo";
    const outsidePath = path.join(harness.temporary, "outside");
    const outside = await createUnit(harness, "outside", { absolutePath: outsidePath });
    const git = await createUnit(harness, "git-unit");
    await mkdir(path.join(git.unit.absolutePath, ".git"));
    const large = await createUnit(harness, "large");
    await writeFile(path.join(large.unit.absolutePath, "large.bin"), "01234567890123456789", "utf8");
    const linked = await createUnit(harness, "linked");
    const linkTarget = path.join(harness.temporary, "link-target");
    await mkdir(linkTarget);
    await symlink(linkTarget, path.join(linked.unit.absolutePath, "junction"), "junction");

    const units = [unconfirmed.unit, protectedUnit.unit, outside.unit, git.unit, large.unit, linked.unit];
    const skills = [unconfirmed.skill, protectedUnit.skill, outside.skill, git.skill, large.skill, linked.skill];
    const service = new QuarantineService({
      database: harness.database,
      dataDirectory: harness.dataPath,
      roots: [harness.root],
      now: () => new Date(NOW),
      sizeLimitBytes: 10,
    });
    const plan = await service.prepare(units.map((unit) => unit.installationUnitId), inventory(units, skills));
    const codes = new Map(plan.items.map((item) => [item.installationUnitId, new Set(item.blockers.map((entry) => entry.code))]));
    assert.ok(codes.get("unconfirmed")?.has("UNIT_NOT_CONFIRMED"));
    assert.ok(codes.get("unconfirmed")?.has("MANAGEMENT_NOT_AUTHORIZED"));
    assert.ok(codes.get("protected")?.has("PROTECTED_SCOPE"));
    assert.ok(codes.get("outside")?.has("OUTSIDE_ROOT"));
    assert.ok(codes.get("git-unit")?.has("GIT_WORKTREE"));
    assert.ok(codes.get("large")?.has("SIZE_LIMIT"));
    assert.ok(codes.get("linked")?.has("LINK_PRESENT"));
    assert.equal(plan.executable, false);
    await harness.database.setManagementMode(true);
    await assert.rejects(
      () => service.quarantine(plan.planId, true, plan.inventoryRevision),
      /安全阻断项/,
    );
    assert.equal(await exists(unconfirmed.unit.absolutePath), true);
  } finally {
    await closeHarness(harness);
  }
});

test("quarantine refuses mapped-network and unverifiable paths before filesystem mutation", async () => {
  const harness = await createHarness();
  try {
    const { unit, skill } = await createUnit(harness, "mapped-drive-fixture");
    for (const location of ["network", "unknown"] as const) {
      const service = new QuarantineService({
        database: harness.database,
        dataDirectory: harness.dataPath,
        roots: [harness.root],
        now: () => new Date(NOW),
        pathLocationProbe: async () => location,
      });
      const plan = await service.prepare([unit.installationUnitId], inventory([unit], [skill], `revision-${location}`));
      assert.equal(plan.executable, false);
      assert.ok(plan.items[0]?.blockers.some((entry) => entry.code === "NETWORK_PATH"));
      assert.equal(await exists(unit.absolutePath), true, "a failed location proof must never move the unit");
    }
  } finally {
    await closeHarness(harness);
  }
});

test("an EXDEV move uses copy plus per-file SHA-256 verification before deleting the source", async () => {
  const harness = await createHarness();
  try {
    const { unit, skill, skillPath } = await createUnit(harness, "cross-volume");
    const expected = await readFile(skillPath, "utf8");
    const base = createNodeQuarantineFileAdapter();
    let forcedExdev = false;
    const adapter: Partial<QuarantineFileAdapter> = {
      rename: async (sourcePath, destinationPath) => {
        if (!forcedExdev && sourcePath === unit.absolutePath) {
          forcedExdev = true;
          throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
        }
        await base.rename(sourcePath, destinationPath);
      },
    };
    const service = new QuarantineService({
      database: harness.database,
      dataDirectory: harness.dataPath,
      roots: [harness.root],
      now: () => new Date(NOW),
      fileAdapter: adapter,
    });
    await harness.database.setManagementMode(true);
    const plan = await service.prepare([unit.installationUnitId], inventory([unit], [skill]));
    const result = await service.quarantine(plan.planId, true, plan.inventoryRevision);
    assert.equal(forcedExdev, true);
    assert.deepEqual(result.succeeded, [unit.installationUnitId]);
    assert.equal(await exists(unit.absolutePath), false);
    assert.equal(await readFile(path.join(result.entries[0]!.quarantinePath, "SKILL.md"), "utf8"), expected);
  } finally {
    await closeHarness(harness);
  }
});

test("an EXDEV cleanup failure restores the frozen source and leaves no untracked final copy", async () => {
  const harness = await createHarness();
  try {
    const { unit, skill, skillPath } = await createUnit(harness, "cross-volume-cleanup-failure");
    const expected = await readFile(skillPath, "utf8");
    const base = createNodeQuarantineFileAdapter();
    let forcedExdev = false;
    let failedParkedCleanup = false;
    const adapter: Partial<QuarantineFileAdapter> = {
      rename: async (sourcePath, destinationPath) => {
        if (!forcedExdev && sourcePath === unit.absolutePath) {
          forcedExdev = true;
          throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
        }
        await base.rename(sourcePath, destinationPath);
      },
      rm: async (targetPath, options) => {
        if (!failedParkedCleanup && targetPath.startsWith(`${unit.absolutePath}.moving-`)) {
          failedParkedCleanup = true;
          throw Object.assign(new Error("simulated parked source cleanup failure"), { code: "EACCES" });
        }
        await base.rm(targetPath, options);
      },
    };
    const service = new QuarantineService({
      database: harness.database,
      dataDirectory: harness.dataPath,
      roots: [harness.root],
      now: () => new Date(NOW),
      fileAdapter: adapter,
    });
    await harness.database.setManagementMode(true);
    const plan = await service.prepare([unit.installationUnitId], inventory([unit], [skill]));
    const result = await service.quarantine(plan.planId, true, plan.inventoryRevision);

    assert.equal(forcedExdev, true);
    assert.equal(failedParkedCleanup, true);
    assert.deepEqual(result.succeeded, []);
    assert.equal(result.failed[0]?.installationUnitId, unit.installationUnitId);
    assert.deepEqual(result.entries, []);
    assert.equal(await readFile(skillPath, "utf8"), expected, "the exact source is restored after cleanup failure");
    assert.equal(await exists(plan.items[0]!.quarantinePath), false, "no final destination is left without a DB record");
    assert.equal(harness.database.listQuarantineEntries().length, 0);
    assert.equal(
      (await readdir(harness.rootPath)).some((entry) => entry.startsWith(`${path.basename(unit.absolutePath)}.moving-`)),
      false,
      "the same-volume frozen source is restored rather than orphaned",
    );
  } finally {
    await closeHarness(harness);
  }
});

test("an EXDEV destination mutation never overwrites the frozen original during rollback", async () => {
  const harness = await createHarness();
  try {
    const { unit, skill, skillPath } = await createUnit(harness, "cross-volume-destination-mutation");
    const expected = await readFile(skillPath, "utf8");
    const base = createNodeQuarantineFileAdapter();
    let forcedExdev = false;
    let mutatedDestination = false;
    const adapter: Partial<QuarantineFileAdapter> = {
      rename: async (sourcePath, destinationPath) => {
        if (!forcedExdev && sourcePath === unit.absolutePath) {
          forcedExdev = true;
          throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
        }
        await base.rename(sourcePath, destinationPath);
        if (!mutatedDestination && sourcePath.includes(".partial-")) {
          mutatedDestination = true;
          await writeFile(path.join(destinationPath, "SKILL.md"), "tampered destination", "utf8");
        }
      },
    };
    const service = new QuarantineService({
      database: harness.database,
      dataDirectory: harness.dataPath,
      roots: [harness.root],
      now: () => new Date(NOW),
      fileAdapter: adapter,
    });
    await harness.database.setManagementMode(true);
    const plan = await service.prepare([unit.installationUnitId], inventory([unit], [skill]));
    const result = await service.quarantine(plan.planId, true, plan.inventoryRevision);

    assert.equal(forcedExdev, true);
    assert.equal(mutatedDestination, true);
    assert.deepEqual(result.succeeded, []);
    assert.equal(result.failed[0]?.installationUnitId, unit.installationUnitId);
    assert.equal(await readFile(skillPath, "utf8"), expected, "rollback restores the original parked content");
    assert.equal(await exists(plan.items[0]!.quarantinePath), false);
    assert.equal(harness.database.listQuarantineEntries().length, 0);
  } finally {
    await closeHarness(harness);
  }
});

test("an EXDEV rollback preserves both divergent recovery copies when neither matches verified content", async () => {
  const harness = await createHarness();
  try {
    const { unit, skill } = await createUnit(harness, "cross-volume-divergent-copies");
    const base = createNodeQuarantineFileAdapter();
    let parkedSourcePath = "";
    const adapter: Partial<QuarantineFileAdapter> = {
      rename: async (sourcePath, destinationPath) => {
        if (sourcePath === unit.absolutePath && !destinationPath.includes(".moving-")) {
          throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
        }
        await base.rename(sourcePath, destinationPath);
        if (sourcePath === unit.absolutePath && destinationPath.includes(".moving-")) {
          parkedSourcePath = destinationPath;
        }
        if (sourcePath.includes(".partial-")) {
          await writeFile(path.join(parkedSourcePath, "SKILL.md"), "tampered parked source", "utf8");
          await writeFile(path.join(destinationPath, "SKILL.md"), "different tampered destination", "utf8");
        }
      },
    };
    const service = new QuarantineService({
      database: harness.database,
      dataDirectory: harness.dataPath,
      roots: [harness.root],
      now: () => new Date(NOW),
      fileAdapter: adapter,
    });
    await harness.database.setManagementMode(true);
    const plan = await service.prepare([unit.installationUnitId], inventory([unit], [skill]));
    const result = await service.quarantine(plan.planId, true, plan.inventoryRevision);

    assert.deepEqual(result.succeeded, []);
    assert.match(result.failed[0]?.message ?? "", /回滚不完整/);
    assert.equal(await exists(unit.absolutePath), false, "no divergent copy is allowed to overwrite the original path");
    assert.equal(await exists(parkedSourcePath), true, "the parked recovery copy is preserved for manual recovery");
    assert.equal(await exists(plan.items[0]!.quarantinePath), true, "the divergent destination is not destructively removed");
    assert.equal(harness.database.listQuarantineEntries().length, 0);
  } finally {
    await closeHarness(harness);
  }
});

test("batch execution stops on first filesystem failure and audits remaining units as not executed", async () => {
  const harness = await createHarness();
  try {
    const units = await Promise.all(["first", "second", "third"].map((id) => createUnit(harness, id)));
    const base = createNodeQuarantineFileAdapter();
    const service = new QuarantineService({
      database: harness.database,
      dataDirectory: harness.dataPath,
      roots: [harness.root],
      now: () => new Date(NOW),
      fileAdapter: {
        rename: async (sourcePath, destinationPath) => {
          if (sourcePath === units[1]!.unit.absolutePath) throw Object.assign(new Error("simulated move failure"), { code: "EACCES" });
          await base.rename(sourcePath, destinationPath);
        },
      },
    });
    await harness.database.setManagementMode(true);
    const live = inventory(units.map((item) => item.unit), units.map((item) => item.skill));
    const plan = await service.prepare(units.map((item) => item.unit.installationUnitId), live);
    const result = await service.quarantine(plan.planId, true, plan.inventoryRevision);
    assert.deepEqual(result.succeeded, ["first"]);
    assert.equal(result.failed[0]?.installationUnitId, "second");
    assert.deepEqual(result.notExecuted, ["third"]);
    assert.equal(await exists(units[0]!.unit.absolutePath), false);
    assert.equal(await exists(units[1]!.unit.absolutePath), true);
    assert.equal(await exists(units[2]!.unit.absolutePath), true);
    const operations = harness.database.listOperationRecords();
    assert.ok(operations.some((record) => record.targetId === "second" && record.status === "failed"));
    assert.ok(operations.some((record) => record.targetId === "third" && record.status === "not-executed"));
  } finally {
    await closeHarness(harness);
  }
});

test("execution revalidates the authorized root identity immediately before the final move", async () => {
  const harness = await createHarness();
  try {
    const { unit, skill } = await createUnit(harness, "root-substitution");
    const base = createNodeQuarantineFileAdapter();
    const parkedRoot = path.join(harness.temporary, "parked-skills-root");
    let quarantineMkdirCalls = 0;
    let substituted = false;
    const service = new QuarantineService({
      database: harness.database,
      dataDirectory: harness.dataPath,
      roots: [harness.root],
      now: () => new Date(NOW),
      fileAdapter: {
        mkdir: async (directoryPath, options) => {
          await base.mkdir(directoryPath, options);
          if (directoryPath === path.join(harness.dataPath, "quarantine")) {
            quarantineMkdirCalls += 1;
            if (quarantineMkdirCalls === 2) {
              await rename(harness.rootPath, parkedRoot);
              await symlink(parkedRoot, harness.rootPath, "junction");
              substituted = true;
            }
          }
        },
      },
    });
    await harness.database.setManagementMode(true);
    const plan = await service.prepare([unit.installationUnitId], inventory([unit], [skill]));
    assert.equal(plan.executable, true);

    const result = await service.quarantine(plan.planId, true, plan.inventoryRevision);
    assert.equal(substituted, true, "the fixture substitutes the root after refresh but before rename");
    assert.equal(result.succeeded.length, 0);
    assert.match(result.failed[0]?.message ?? "", /root\/parent|reparse|junction|物理身份/);
    assert.equal(await exists(path.join(parkedRoot, unit.installationUnitId)), true, "the authorized source remains unmoved");
    assert.equal(await exists(plan.items[0]!.quarantinePath), false);
  } finally {
    await closeHarness(harness);
  }
});

test("restore rejects a parent junction substitution and never writes into its target", async () => {
  const harness = await createHarness();
  try {
    const parentPath = path.join(harness.rootPath, "bundle-parent");
    const { unit, skill } = await createUnit(harness, "nested-restore", {
      absolutePath: path.join(parentPath, "nested-restore"),
    });
    const service = new QuarantineService({
      database: harness.database,
      dataDirectory: harness.dataPath,
      roots: [harness.root],
      now: () => new Date(NOW),
    });
    await harness.database.setManagementMode(true);
    const plan = await service.prepare([unit.installationUnitId], inventory([unit], [skill]));
    const result = await service.quarantine(plan.planId, true, plan.inventoryRevision);
    const entry = result.entries[0]!;

    const parkedParent = path.join(harness.temporary, "parked-parent");
    const junctionTarget = path.join(harness.temporary, "junction-target");
    await rename(parentPath, parkedParent);
    await mkdir(junctionTarget);
    await symlink(junctionTarget, parentPath, "junction");

    await assert.rejects(
      () => service.restore(entry.quarantineEntryId, true),
      /root\/parent|reparse|junction|物理身份/,
    );
    assert.equal(await exists(path.join(junctionTarget, "nested-restore")), false, "restore never crosses the substituted parent");
    assert.equal(await exists(entry.quarantinePath), true, "the quarantined copy remains recoverable");
  } finally {
    await closeHarness(harness);
  }
});

test("restore verifies the recorded content fingerprint even when size and mtime are preserved", async () => {
  const harness = await createHarness();
  try {
    const { unit, skill } = await createUnit(harness, "fingerprint-drift");
    const service = new QuarantineService({
      database: harness.database,
      dataDirectory: harness.dataPath,
      roots: [harness.root],
      now: () => new Date(NOW),
    });
    await harness.database.setManagementMode(true);
    const plan = await service.prepare([unit.installationUnitId], inventory([unit], [skill]));
    const result = await service.quarantine(plan.planId, true, plan.inventoryRevision);
    const entry = result.entries[0]!;
    const quarantinedSkill = path.join(entry.quarantinePath, "SKILL.md");
    const before = await stat(quarantinedSkill);
    const changed = Buffer.from(await readFile(quarantinedSkill));
    const index = changed.lastIndexOf(0x74);
    assert.ok(index >= 0);
    changed[index] = 0x54;
    await writeFile(quarantinedSkill, changed);
    await utimes(quarantinedSkill, before.atime, before.mtime);

    await assert.rejects(
      () => service.restore(entry.quarantineEntryId, true),
      /contentFingerprint 不一致/,
    );
    assert.equal(await exists(unit.absolutePath), false);
    assert.equal(await exists(entry.quarantinePath), true);
    assert.equal(harness.database.getQuarantineEntry(entry.quarantineEntryId)?.status, "quarantined");
  } finally {
    await closeHarness(harness);
  }
});
