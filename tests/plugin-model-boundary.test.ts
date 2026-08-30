import assert from "node:assert/strict";
import test from "node:test";
import { classificationCandidatePage } from "../src/plugin/classification-candidates.js";
import { sanitizeBatchOperationResultForModel, skillSummaryForModel } from "../src/plugin/model-visible-boundary.js";
import type { InventorySnapshot, SkillRecord } from "../src/shared/types.js";

function skill(overrides: Partial<SkillRecord> = {}): SkillRecord {
  return {
    skillId: "a".repeat(64), physicalId: "p", name: "candidate", description: "Classify this skill",
    existingCategory: "legacy-category", scope: "user", sourceId: "source", sourceLabel: "Trusted source",
    packageId: "package", pluginId: null, pluginVersion: null, rootId: "root", rootLabel: "Root",
    absolutePath: "C:\\private\\candidate\\SKILL.md", relativePath: "candidate/SKILL.md",
    breadcrumb: "private / candidate", readonly: false, aliases: [], diagnostics: [],
    automaticClassification: { categoryId: null, tags: ["secret-tag"], confidence: 0, source: "pending", reason: "pending" },
    categoryId: null, tags: ["secret-tag"], favorite: true, locked: false, hasManualOverride: false,
    runtimeDiscovered: true, runtimeEnabled: true, runtimeScope: "user", instances: [],
    ...overrides,
  };
}

function snapshot(skills: SkillRecord[]): InventorySnapshot {
  return {
    revision: "revision", generatedAt: new Date(0).toISOString(), skills,
    summary: { total: skills.length, runtimeVisible: 0, cacheOnly: 0, pending: skills.length, favorites: 0, duplicateNames: 0,
      byScope: { user: 0, agents: 0, system: 0, plugin: 0, repo: 0, custom: 0 },
      byCategory: {
        development: 0, quality: 0, security: 0, delivery: 0, "data-automation": 0,
        "docs-knowledge": 0, "design-media": 0, "research-analysis": 0, "finance-trading": 0,
        "content-social": 0, "agent-workflow": 0, pending: skills.length,
      } },
    scanErrors: [], orphanOverrideIds: [], runtimeAvailable: false, runtimeError: null,
  };
}

test("model classification candidates expose only the approved metadata boundary", () => {
  const result = classificationCandidatePage(snapshot([skill()]), { page: 1, pageSize: 25 });
  assert.deepEqual(Object.keys(result.items[0]!).sort(), ["description", "existingCategory", "name", "skillId", "source"]);
  assert.equal(JSON.stringify(result).includes("C:\\\\private"), false);
  assert.equal(JSON.stringify(result).includes("secret-tag"), false);
  assert.equal(JSON.stringify(result).includes("runtimeEnabled"), false);
});

test("model classification candidates reject stale opaque IDs and default to pending items", () => {
  const classified = skill({ skillId: "b".repeat(64), categoryId: "development" });
  assert.equal(classificationCandidatePage(snapshot([skill(), classified]), { page: 1, pageSize: 25 }).total, 1);
  assert.throws(
    () => classificationCandidatePage(snapshot([skill()]), { skillIds: ["f".repeat(64)], page: 1, pageSize: 25 }),
    /不存在 1 个精确 Skill ID/,
  );
});

test("model classification candidates never expose locked skills, including a mixed explicit selection", () => {
  const open = skill({ skillId: "c".repeat(64) });
  const locked = skill({
    skillId: "d".repeat(64),
    name: "locked-private-skill",
    description: "This metadata must never be sent to the model",
    locked: true,
  });
  const result = classificationCandidatePage(snapshot([open, locked]), {
    skillIds: [locked.skillId, open.skillId],
    page: 1,
    pageSize: 25,
  });

  assert.equal(result.total, 1);
  assert.equal(result.excludedLockedCount, 1);
  assert.deepEqual(result.items.map((item) => item.skillId), [open.skillId]);
  assert.equal(JSON.stringify(result).includes("locked-private-skill"), false);
  assert.equal(JSON.stringify(result).includes("never be sent"), false);
});

test("model-visible runtime failures replace raw app-server errors with a stable code", () => {
  const privatePath = "C:\\Users\\private-user\\.codex\\skills\\example\\SKILL.md";
  const rawResult = {
    succeeded: [],
    failed: [{ skillId: "a".repeat(64), message: `write failed for ${privatePath}` }],
    notExecuted: ["b".repeat(64)],
    revision: "revision-after-failure",
  };
  const visible = sanitizeBatchOperationResultForModel(rawResult, {
    errorCode: "RUNTIME_WRITE_FAILED",
    message: "Codex runtime write failed; details are available only in the desktop workbench.",
  });

  assert.deepEqual(visible.failed, [{
    skillId: "a".repeat(64),
    errorCode: "RUNTIME_WRITE_FAILED",
    message: "Codex runtime write failed; details are available only in the desktop workbench.",
  }]);
  assert.equal(JSON.stringify(visible).includes("private-user"), false);
  assert.equal(JSON.stringify(visible).includes("C:\\\\Users"), false);
  assert.equal(rawResult.failed[0]?.message.includes(privatePath), true, "desktop/raw result remains untouched");
});

test("list_skills model summary replaces a runtime-only absolute breadcrumb with portable metadata", () => {
  const privatePath = "C:\\Users\\private-user\\work\\repo\\.codex\\skills\\runtime-only\\SKILL.md";
  const runtimeOnly = skill({
    absolutePath: privatePath,
    breadcrumb: `Codex runtime > ${privatePath}`,
    aliases: [`Codex runtime > ${privatePath}`],
    packageId: "runtime-only",
    relativePath: "runtime-only/SKILL.md",
    sourceLabel: "Codex runtime",
  });
  const summary = skillSummaryForModel(runtimeOnly);
  const serialized = JSON.stringify(summary);

  assert.equal(serialized.includes("private-user"), false);
  assert.equal(serialized.includes("C:\\\\Users"), false);
  assert.equal(Object.hasOwn(summary, "breadcrumb"), false);
  assert.equal(Object.hasOwn(summary, "absolutePath"), false);
  assert.equal(summary.packageId, "runtime-only");
  assert.equal(summary.relativePath, "runtime-only/SKILL.md");
});
