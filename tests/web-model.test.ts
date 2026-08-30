import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { SkillRecord } from "../src/shared/types.js";
import {
  FACET_ALL,
  FACET_NO_PLUGIN,
  FACET_UNKNOWN,
  MAX_BATCH_SIZE,
  canConfirmInstallationUnit,
  canExecuteQuarantinePlan,
  canPrepareInstallationUnit,
  chunkAtMost100,
  instanceIdsForSkills,
  safeEvidenceUrl,
  safePluginManagementUrl,
  selectedUnlockedSkillIds,
  selectableSkillIds,
  pluginFacetValue,
  sourceFacetValue,
  supportBundleSummary,
  virtualWindow,
} from "../src/web/model.js";

function skill(skillId: string, locked: boolean, instanceIds: string[]): SkillRecord {
  return {
    skillId,
    physicalId: `physical-${skillId}`,
    instanceId: instanceIds[0],
    name: skillId,
    description: "Browser view-model fixture",
    scope: "user",
    sourceId: "fixture",
    sourceLabel: "Fixture",
    packageId: "fixture",
    pluginId: null,
    pluginVersion: null,
    rootId: "root",
    rootLabel: "Root",
    absolutePath: `C:\\fixture\\${skillId}`,
    relativePath: skillId,
    breadcrumb: skillId,
    readonly: false,
    aliases: [],
    diagnostics: [],
    automaticClassification: { categoryId: "development", tags: [], confidence: 1, source: "rules", reason: "fixture" },
    categoryId: "development",
    tags: [],
    favorite: false,
    locked,
    hasManualOverride: false,
    runtimeDiscovered: true,
    runtimeEnabled: true,
    runtimeScope: "user",
    instances: instanceIds.map((instanceId) => ({
      instanceId,
      logicalSkillId: skillId,
      absolutePath: `C:\\fixture\\${instanceId}`,
      rootId: "root",
      rootLabel: "Root",
      breadcrumb: instanceId,
      aliases: [],
      pluginVersion: null,
      readonly: false,
      managementGranted: true,
      runtimeDiscovered: true,
      runtimeEnabled: true,
      runtimeScope: "user",
      diagnostics: [],
    })),
  };
}

test("the workbench excludes locked logical skills and targets every exact instance", () => {
  const unlocked = skill("logical-a", false, ["instance-a1", "instance-a2"]);
  const locked = skill("logical-b", true, ["instance-b1"]);
  assert.deepEqual(selectableSkillIds([unlocked, locked]), ["logical-a"]);
  assert.deepEqual(instanceIdsForSkills([unlocked, locked]), ["instance-a1", "instance-a2", "instance-b1"]);
});

test("deterministic UI batching never sends more than one hundred opaque targets", () => {
  const targets = Array.from({ length: 243 }, (_, index) => `target-${index}`);
  const chunks = chunkAtMost100(targets);
  assert.deepEqual(chunks.map((chunk) => chunk.length), [MAX_BATCH_SIZE, MAX_BATCH_SIZE, 43]);
  assert.deepEqual(chunks.flat(), targets);
});

test("drag classification can only carry selected unlocked opaque IDs", () => {
  const skills = Array.from({ length: 102 }, (_, index) => skill(`logical-${index}`, index === 1, [`instance-${index}`]));
  const selected = new Set(skills.map((item) => item.skillId));
  const targets = selectedUnlockedSkillIds(skills, selected);
  assert.equal(targets.length, MAX_BATCH_SIZE);
  assert.equal(targets.includes("logical-1"), false, "a locked skill must never enter a drag payload");
  assert.deepEqual(targets.slice(0, 2), ["logical-0", "logical-2"]);
});

test("source and plugin facets keep empty and sentinel-looking metadata unambiguous", () => {
  assert.equal(sourceFacetValue(undefined), FACET_UNKNOWN);
  assert.equal(sourceFacetValue("  "), FACET_UNKNOWN);
  assert.equal(pluginFacetValue(null), FACET_NO_PLUGIN);
  assert.equal(pluginFacetValue(""), FACET_UNKNOWN);
  assert.notEqual(sourceFacetValue(FACET_ALL), FACET_ALL, "a real source named 'all' must not become the all-sources sentinel");
  assert.equal(sourceFacetValue("github:示例/skills"), "value:github%3A%E7%A4%BA%E4%BE%8B%2Fskills");
  assert.equal(sourceFacetValue("\uD800"), "value:%EF%BF%BD", "malformed Unicode metadata must not crash filter rendering");
});

test("virtual inventory renders a bounded overscanned window and still reaches the final item", () => {
  const atStart = virtualWindow(5_000, 0, 648, 108, 6);
  assert.deepEqual(atStart, { start: 0, end: 12, topSpacerPx: 0, bottomSpacerPx: 538_704 });

  const atEnd = virtualWindow(5_000, 5_000 * 108 - 648, 648, 108, 6);
  assert.equal(atEnd.end, 5_000);
  assert.ok(atEnd.end - atEnd.start <= 18, "the DOM window stays independent of total inventory size");
  assert.equal(atEnd.bottomSpacerPx, 0);
});

test("update comparison links fail closed outside approved HTTPS hosts", () => {
  assert.equal(safeEvidenceUrl("https://github.com/example/repo/compare/a...b"), "https://github.com/example/repo/compare/a...b");
  assert.equal(safeEvidenceUrl("http://github.com/example/repo"), null);
  assert.equal(safeEvidenceUrl("https://github.example.test/phish"), null);
  assert.equal(safeEvidenceUrl("javascript:alert(1)"), null);
});

test("support bundle receipts expose only file name, size, and hash to the UI", () => {
  const summary = supportBundleSummary({
    path: "C:\\Users\\private-user\\AppData\\Local\\SkillOrganizerForCodex\\support-bundles\\support-2026-08-30.json",
    sizeBytes: 4_096,
    sha256: "A".repeat(64),
    createdAt: "2026-08-30T00:00:00.000Z",
  });
  assert.deepEqual(summary, { fileName: "support-2026-08-30.json", sizeBytes: 4_096, sha256: "a".repeat(64) });
  assert.equal(JSON.stringify(summary).includes("private-user"), false, "the absolute path must not cross into the view model");
  assert.equal(supportBundleSummary({ path: "C:\\private\\bundle.json", sizeBytes: 1, sha256: "a".repeat(64) }), null);
});

test("native plugin management accepts only the exact Organizer codex deep link", () => {
  const exact = "codex://plugins/codex-skill-organizer?marketplacePath=C%3A%5CUsers%5Cfixture%5C.agents%5Cplugins%5Cmarketplace.json";
  assert.equal(safePluginManagementUrl(exact), exact);
  assert.equal(safePluginManagementUrl("codex://plugins/another-plugin?marketplacePath=C%3A%5Cx%5C.agents%5Cplugins%5Cmarketplace.json"), null);
  assert.equal(safePluginManagementUrl("https://example.test/plugins/codex-skill-organizer?marketplacePath=C%3A%5Cx%5C.agents%5Cplugins%5Cmarketplace.json"), null);
  assert.equal(safePluginManagementUrl("codex://plugins/codex-skill-organizer?marketplacePath=C%3A%5Cx%5Cother.json"), null);
});

test("quarantine consent stays two-stage and MCP can never execute a prepared plan", () => {
  const confirmable = { confirmed: false, managementAuthorized: true, allowed: false, blockers: [] };
  const protectedUnit = { confirmed: false, managementAuthorized: true, allowed: false, blockers: [{ code: "PROTECTED_SCOPE" }] };
  const confirmed = { confirmed: true, managementAuthorized: true, allowed: true, blockers: [] };
  const plan = { executable: true, items: [{ installationUnitId: "unit-a" }] };

  assert.equal(canConfirmInstallationUnit(confirmable), true);
  assert.equal(canConfirmInstallationUnit(protectedUnit), false);
  assert.equal(canPrepareInstallationUnit(confirmable), false);
  assert.equal(canPrepareInstallationUnit(confirmed), true);
  assert.equal(canExecuteQuarantinePlan("http", false, plan), false);
  assert.equal(canExecuteQuarantinePlan("http", true, plan), true);
  assert.equal(canExecuteQuarantinePlan("mcp", true, plan), false);
});

test("0.2 workbench exposes all three sections without a legacy JSON import affordance", async () => {
  const html = await readFile(path.resolve("src/web/index.html"), "utf8");
  const source = await readFile(path.resolve("src/web/main.ts"), "utf8");
  assert.match(html, /data-panel-content="overview"/);
  assert.match(html, /data-panel-content="inventory"/);
  assert.match(html, /data-panel-content="management"/);
  assert.match(html, /id="settingsDirectoryCard"/);
  assert.match(html, /id="configuredRootsList"/);
  assert.match(html, /id="savedViewSelect"/);
  assert.match(html, /id="sourceFilter"/);
  assert.match(html, /id="pluginFilter"/);
  assert.match(html, /id="tableWrap"[^>]+tabindex="0"/);
  assert.match(html, /id="dragStatus"[^>]+aria-live="polite"/);
  assert.match(html, /id="supportBundleButton"/);
  assert.match(html, /id="pluginManagementButton"/);
  assert.match(html, /id="categorySettingsList"/);
  assert.match(html, /id="undoActionsList"/, "management must expose precondition-matched undo history");
  assert.match(html, /0\.2\.0 从空 SQLite 开始/);
  assert.doesNotMatch(html, /id="importButton"|id="importFile"|导入分类备份/);
  assert.doesNotMatch(source, /cso-view-v2/);
  assert.doesNotMatch(source, /view\.page/, "the inventory must not fall back to client-side pagination");
  assert.match(source, /virtualWindow\(/);
  assert.match(source, /\/api\/saved-views/);
  assert.match(source, /\/api\/quarantine\/purge/);
  assert.match(source, /#desktopSettingsUnavailable/);
});
