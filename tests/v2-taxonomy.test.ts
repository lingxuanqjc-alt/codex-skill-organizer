import assert from "node:assert/strict";
import test from "node:test";
import {
  BUILTIN_CATEGORY_IDS,
  DEFAULT_TAXONOMY_PACK,
  assertTaxonomyPack,
  classifyWithTaxonomy,
} from "../src/v2/index.js";

test("taxonomy pack keeps the eleven portable category identities while labels remain bilingual", () => {
  assert.doesNotThrow(() => assertTaxonomyPack(DEFAULT_TAXONOMY_PACK));
  assert.deepEqual(
    new Set(DEFAULT_TAXONOMY_PACK.categories.map((category) => category.id)),
    new Set(BUILTIN_CATEGORY_IDS),
  );
  assert.equal(DEFAULT_TAXONOMY_PACK.categories.length, 11);
  assert.ok(DEFAULT_TAXONOMY_PACK.categories.every((category) => category.label.zhCN && category.label.enUS));
});

test("deterministic source and bundle rules win before existing labels and keywords", () => {
  const vibe = classifyWithTaxonomy(DEFAULT_TAXONOMY_PACK, {
    source: "HKUDS/Vibe-Trading",
    packageId: "vibe-trading",
    pluginId: null,
    relativePath: "src/skills/research-goal/SKILL.md",
    name: "research-goal",
    description: "Research workflow",
    existingCategory: "研究与分析",
  });
  assert.equal(vibe.categoryId, "finance-trading");
  assert.equal(vibe.source, "exact-source");
  assert.deepEqual(vibe.tags, ["bundle:vibe-trading", "taxonomy:vibe/研究与分析"]);

  const existing = classifyWithTaxonomy(DEFAULT_TAXONOMY_PACK, {
    source: "unknown/source",
    packageId: "notes",
    pluginId: null,
    relativePath: "notes/SKILL.md",
    name: "notes",
    description: "No keyword match",
    existingCategory: "文档与知识",
  });
  assert.equal(existing.categoryId, "docs-knowledge");
  assert.equal(existing.source, "existing-category");

  const chineseKeyword = classifyWithTaxonomy(DEFAULT_TAXONOMY_PACK, {
    source: "unknown/source",
    packageId: "unknown",
    pluginId: null,
    relativePath: "unknown/SKILL.md",
    name: "代码审查助手",
    description: "提升质量",
    existingCategory: null,
  });
  assert.equal(chineseKeyword.categoryId, "quality");
  assert.equal(chineseKeyword.source, "keyword");

  const unknown = classifyWithTaxonomy(DEFAULT_TAXONOMY_PACK, {
    source: "unknown/source",
    packageId: "misc",
    pluginId: null,
    relativePath: "misc/SKILL.md",
    name: "misc",
    description: "Unclassified helper",
    existingCategory: null,
  });
  assert.equal(unknown.source, "pending", "the SKILL.md filename itself is not classification evidence");
});
