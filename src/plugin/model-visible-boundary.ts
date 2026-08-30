import type { BatchOperationResult, SkillRecord } from "../shared/types.js";

export interface ModelVisibleBatchOperationResult extends Record<string, unknown> {
  succeeded: string[];
  failed: Array<{
    skillId: string;
    errorCode: string;
    message: string;
  }>;
  notExecuted: string[];
  revision: string;
}

/**
 * Preserve opaque target IDs and batch status while keeping raw provider errors
 * inside the desktop/HTTP boundary. Provider errors may contain absolute paths,
 * stderr fragments, or credentials and must never be copied into model context.
 */
export function sanitizeBatchOperationResultForModel(
  result: BatchOperationResult,
  failure: { errorCode: string; message: string },
): ModelVisibleBatchOperationResult {
  return {
    succeeded: [...result.succeeded],
    failed: result.failed.map(({ skillId }) => ({
      skillId,
      errorCode: failure.errorCode,
      message: failure.message,
    })),
    notExecuted: [...result.notExecuted],
    revision: result.revision,
  };
}

/** A list_skills row intentionally omits host paths, breadcrumbs, and aliases. */
export function skillSummaryForModel(skill: SkillRecord): Record<string, unknown> {
  return {
    skillId: skill.skillId,
    name: skill.name,
    description: skill.description.slice(0, 400),
    categoryId: skill.categoryId,
    tags: skill.tags,
    source: skill.sourceLabel,
    packageId: skill.packageId,
    relativePath: skill.relativePath,
    scope: skill.scope,
    runtimeDiscovered: skill.runtimeDiscovered,
    runtimeEnabled: skill.runtimeEnabled,
    instances: (skill.instances ?? []).map((instance) => ({
      instanceId: instance.instanceId,
      version: instance.version ?? instance.pluginVersion,
      runtimeDiscovered: instance.runtimeDiscovered,
      runtimeEnabled: instance.runtimeEnabled,
      readonly: instance.readonly,
    })),
    duplicateName: skill.diagnostics.some((item) => item.code === "DUPLICATE_NAME"),
  };
}
