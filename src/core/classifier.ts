import type { AutomaticClassification, CategoryId, ObservedSkill } from "../shared/types.js";
import { normalizeTagId } from "./taxonomy.js";
import { classifyWithTaxonomy, DEFAULT_TAXONOMY_PACK } from "../v2/taxonomy-pack.js";

function result(
  categoryId: CategoryId | null,
  tags: string[],
  confidence: number,
  source: AutomaticClassification["source"],
  reason: string,
): AutomaticClassification {
  return {
    categoryId,
    tags: [...new Set(tags.map(normalizeTagId).filter(Boolean))].sort(),
    confidence,
    source,
    reason,
  };
}

export function classifySkill(skill: ObservedSkill): AutomaticClassification {
  const classified = classifyWithTaxonomy(DEFAULT_TAXONOMY_PACK, {
    source: skill.sourceId.replace(/^github:/u, ""),
    packageId: skill.packageId,
    pluginId: skill.pluginId,
    relativePath: skill.relativePath,
    name: skill.name,
    description: skill.description,
    existingCategory: skill.existingCategory ?? null,
  });
  const confidence = classified.source === "pending"
    ? 0
    : classified.source === "keyword"
      ? 0.82
      : classified.source === "existing-category"
        ? 0.95
        : 1;
  return result(
    classified.categoryId,
    classified.tags,
    confidence,
    classified.source === "keyword" ? "rules" : classified.source,
    classified.ruleId ? `TaxonomyPack 规则：${classified.ruleId}` : classified.source === "pending"
      ? "没有可靠的确定性分类规则"
      : "沿用已有 category",
  );
}
