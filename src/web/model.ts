import type { SkillRecord } from "../shared/types.js";

export const MAX_BATCH_SIZE = 100;
export const FACET_ALL = "all";
export const FACET_UNKNOWN = "__unknown";
export const FACET_NO_PLUGIN = "__none";

export interface VirtualWindow {
  start: number;
  end: number;
  topSpacerPx: number;
  bottomSpacerPx: number;
}

export interface SupportBundleSummary {
  fileName: string;
  sizeBytes: number;
  sha256: string;
}

export interface InstallationUnitSafetyView {
  confirmed?: boolean;
  managementAuthorized?: boolean;
  allowed?: boolean;
  blockers?: readonly unknown[];
}

export interface QuarantinePlanSafetyView {
  executable?: boolean;
  items?: readonly unknown[];
}

export function selectableSkillIds(skills: readonly SkillRecord[]): string[] {
  return skills.filter((skill) => !skill.locked).map((skill) => skill.skillId);
}

export function selectedUnlockedSkillIds(
  skills: readonly SkillRecord[],
  selectedIds: ReadonlySet<string>,
): string[] {
  return skills
    .filter((skill) => selectedIds.has(skill.skillId) && !skill.locked)
    .slice(0, MAX_BATCH_SIZE)
    .map((skill) => skill.skillId);
}

function encodedFacetValue(value: string): string {
  return `value:${encodeURIComponent(value.normalize("NFC").trim().toWellFormed())}`;
}

export function sourceFacetValue(value: unknown): string {
  return typeof value === "string" && value.normalize("NFC").trim()
    ? encodedFacetValue(value)
    : FACET_UNKNOWN;
}

export function pluginFacetValue(value: unknown): string {
  if (value === null || value === undefined) return FACET_NO_PLUGIN;
  return typeof value === "string" && value.normalize("NFC").trim()
    ? encodedFacetValue(value)
    : FACET_UNKNOWN;
}

export function virtualWindow(
  itemCount: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  overscan: number,
): VirtualWindow {
  const count = Math.max(0, Math.trunc(itemCount));
  const height = Math.max(1, rowHeight);
  const safeScrollTop = Math.max(0, Number.isFinite(scrollTop) ? scrollTop : 0);
  const safeViewport = Math.max(height, Number.isFinite(viewportHeight) ? viewportHeight : height);
  const safeOverscan = Math.max(0, Math.trunc(overscan));
  const visibleStart = Math.min(count, Math.floor(safeScrollTop / height));
  const visibleCount = Math.max(1, Math.ceil(safeViewport / height));
  const start = Math.max(0, visibleStart - safeOverscan);
  const end = Math.min(count, visibleStart + visibleCount + safeOverscan);
  return {
    start,
    end,
    topSpacerPx: start * height,
    bottomSpacerPx: Math.max(0, (count - end) * height),
  };
}

export function supportBundleSummary(value: unknown): SupportBundleSummary | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.path !== "string" || typeof record.sha256 !== "string" || typeof record.sizeBytes !== "number") return null;
  const fileName = record.path.split(/[\\/]/u).at(-1)?.normalize("NFC").trim() ?? "";
  if (!/^support-[A-Za-z0-9._-]+\.json$/u.test(fileName)) return null;
  if (!Number.isSafeInteger(record.sizeBytes) || record.sizeBytes <= 0) return null;
  const sha256 = record.sha256.toLocaleLowerCase("en-US");
  if (!/^[a-f0-9]{64}$/u.test(sha256)) return null;
  return { fileName, sizeBytes: record.sizeBytes, sha256 };
}

export function safePluginManagementUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    const parameters = [...url.searchParams.keys()];
    const marketplacePath = url.searchParams.get("marketplacePath");
    if (url.protocol !== "codex:" || url.hostname !== "plugins" || url.pathname !== "/codex-skill-organizer") return null;
    if (url.username || url.password || url.hash || parameters.length !== 1 || parameters[0] !== "marketplacePath" || !marketplacePath) return null;
    const normalizedPath = marketplacePath.replaceAll("\\", "/");
    const absolutePath = normalizedPath.startsWith("/") || /^[A-Za-z]:\//u.test(normalizedPath);
    if (!absolutePath || !/(?:^|\/)\.agents\/plugins\/marketplace\.json$/iu.test(normalizedPath)) return null;
    return url.href;
  } catch {
    return null;
  }
}

export function instanceIdsForSkills(skills: readonly SkillRecord[]): string[] {
  const identifiers = new Set<string>();
  for (const skill of skills) {
    const instances = skill.instances?.length ? skill.instances : [{ instanceId: skill.instanceId ?? skill.skillId }];
    for (const instance of instances) identifiers.add(instance.instanceId);
  }
  return [...identifiers];
}

export function chunkAtMost100<T>(values: readonly T[]): T[][] {
  const chunks: T[][] = [];
  for (let offset = 0; offset < values.length; offset += MAX_BATCH_SIZE) {
    chunks.push(values.slice(offset, offset + MAX_BATCH_SIZE));
  }
  return chunks;
}

export function canConfirmInstallationUnit(candidate: InstallationUnitSafetyView): boolean {
  return candidate.confirmed !== true
    && candidate.managementAuthorized === true
    && (candidate.blockers?.length ?? 0) === 0;
}

export function canPrepareInstallationUnit(candidate: InstallationUnitSafetyView): boolean {
  return candidate.confirmed === true
    && candidate.allowed === true
    && candidate.managementAuthorized === true
    && (candidate.blockers?.length ?? 0) === 0;
}

export function canExecuteQuarantinePlan(
  transportMode: "http" | "mcp",
  managementMode: boolean,
  plan: QuarantinePlanSafetyView,
): boolean {
  return transportMode === "http"
    && managementMode
    && plan.executable === true
    && (plan.items?.length ?? 0) > 0;
}

export function safeEvidenceUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    if (url.hostname === "github.com" || url.hostname.endsWith(".github.com")) return url.href;
    if (url.hostname === "developers.openai.com" || url.hostname === "chatgpt.com") return url.href;
    return null;
  } catch {
    return null;
  }
}
