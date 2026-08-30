import { CATEGORY_IDS, type BuiltinCategoryId } from "../shared/types.js";
import { DEFAULT_TAXONOMY_PACK } from "../v2/taxonomy-pack.js";

export const TAXONOMY_VERSION = DEFAULT_TAXONOMY_PACK.version;

export const CATEGORIES: ReadonlyArray<{
  id: BuiltinCategoryId;
  label: string;
  description: string;
}> = DEFAULT_TAXONOMY_PACK.categories.map((category) => ({
  id: category.id,
  label: category.label.zhCN,
  description: category.description.zhCN,
}));

const CATEGORY_SET = new Set<string>(CATEGORY_IDS);

export function isCategoryId(value: unknown): value is BuiltinCategoryId {
  return typeof value === "string" && CATEGORY_SET.has(value);
}

export function normalizeTagId(value: string): string {
  return value.normalize("NFC").trim().toLocaleLowerCase("en-US").replace(/\s+/g, "-");
}

export function validateTagId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const normalized = normalizeTagId(value);
  return normalized.length > 0 && normalized.length <= 80 && /^[\p{L}\p{N}._:/+-]+$/u.test(normalized);
}
