import type { InventorySnapshot } from "../shared/types.js";

export interface ClassificationCandidatePage {
  revision: string;
  total: number;
  excludedLockedCount: number;
  page: number;
  pageSize: number;
  items: Array<{
    skillId: string;
    name: string;
    description: string;
    source: string;
    existingCategory: string | null;
  }>;
}

export function classificationCandidatePage(
  snapshot: InventorySnapshot,
  input: {
    skillIds?: string[];
    pendingOnly?: boolean;
    page: number;
    pageSize: number;
  },
): ClassificationCandidatePage {
  let selected = snapshot.skills;
  if (input.skillIds) {
    if (new Set(input.skillIds).size !== input.skillIds.length) {
      throw new Error("skillIds 不能包含重复项");
    }
    const byId = new Map(snapshot.skills.map((skill) => [skill.skillId, skill]));
    const missing = input.skillIds.filter((skillId) => !byId.has(skillId));
    if (missing.length > 0) {
      throw new Error(`清单中不存在 ${missing.length} 个精确 Skill ID；请重新读取最新清单`);
    }
    selected = input.skillIds.map((skillId) => byId.get(skillId)!);
  }
  const excludedLockedCount = selected.filter((skill) => skill.locked).length;
  selected = selected.filter((skill) => !skill.locked);
  if (input.pendingOnly !== false) {
    selected = selected.filter((skill) => skill.categoryId === null);
  }

  const start = (input.page - 1) * input.pageSize;
  return {
    revision: snapshot.revision,
    total: selected.length,
    excludedLockedCount,
    page: input.page,
    pageSize: input.pageSize,
    items: selected.slice(start, start + input.pageSize).map((skill) => ({
      skillId: skill.skillId,
      name: skill.name,
      description: skill.description.slice(0, 400),
      source: skill.sourceLabel,
      existingCategory: skill.existingCategory ?? null,
    })),
  };
}
