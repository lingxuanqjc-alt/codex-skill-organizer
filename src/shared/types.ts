export const CATEGORY_IDS = [
  "development",
  "quality",
  "security",
  "delivery",
  "data-automation",
  "docs-knowledge",
  "design-media",
  "research-analysis",
  "finance-trading",
  "content-social",
  "agent-workflow",
] as const;

export type BuiltinCategoryId = (typeof CATEGORY_IDS)[number];
export type CategoryId = BuiltinCategoryId | `custom:${string}`;
export type SkillScope = "user" | "agents" | "system" | "plugin" | "repo" | "custom";
export type RuntimeScope = "user" | "repo" | "system" | "admin";

export interface RootDefinition {
  id: string;
  label: string;
  path: string;
  kind: "codex" | "agents" | "plugin-cache" | "repo" | "custom" | "fixture";
  managementGranted?: boolean;
  readonly?: boolean;
}

export interface SkillDiagnostic {
  code:
    | "FRONTMATTER_MISSING"
    | "FRONTMATTER_INVALID"
    | "FRONTMATTER_TOO_LARGE"
    | "SKILL_UNREADABLE"
    | "SYMLINK_OUTSIDE_ROOT"
    | "DUPLICATE_NAME"
    | "RUNTIME_ONLY"
    | "CACHE_ONLY"
    | "RUNTIME_PATH_AMBIGUOUS";
  message: string;
}

export interface ObservedSkill {
  skillId: string;
  physicalId: string;
  instanceId?: string;
  name: string;
  description: string;
  existingCategory?: string;
  version?: string;
  installedCommit?: string;
  origin?: string;
  scope: SkillScope;
  sourceId: string;
  sourceLabel: string;
  packageId: string;
  pluginId: string | null;
  pluginVersion: string | null;
  rootId: string;
  rootLabel: string;
  absolutePath: string;
  relativePath: string;
  breadcrumb: string;
  readonly: boolean;
  aliases: string[];
  diagnostics: SkillDiagnostic[];
}

export interface SkillInstanceView {
  instanceId: string;
  logicalSkillId: string;
  absolutePath: string;
  rootId: string;
  rootLabel: string;
  breadcrumb: string;
  aliases: string[];
  pluginVersion: string | null;
  version?: string;
  installedCommit?: string;
  readonly: boolean;
  managementGranted: boolean;
  runtimeDiscovered: boolean;
  runtimeEnabled: boolean | null;
  runtimeScope: RuntimeScope | null;
  diagnostics: SkillDiagnostic[];
}

export interface RuntimeSkill {
  name: string;
  description: string;
  shortDescription?: string;
  path: string;
  scope: RuntimeScope;
  enabled: boolean;
  pluginId: string | null;
}

export interface AutomaticClassification {
  categoryId: CategoryId | null;
  tags: string[];
  confidence: number;
  source: "exact-source" | "bundle" | "existing-category" | "rules" | "pending";
  reason: string;
}

export interface SkillOverride {
  primaryCategoryId?: CategoryId | null;
  addedTagIds: string[];
  removedTagIds: string[];
  favorite: boolean;
  locked: boolean;
  updatedAt: string;
  taxonomyVersion: number;
  reason?: string;
}

export interface SkillRecord extends ObservedSkill {
  automaticClassification: AutomaticClassification;
  categoryId: CategoryId | null;
  tags: string[];
  favorite: boolean;
  locked: boolean;
  hasManualOverride: boolean;
  runtimeDiscovered: boolean;
  runtimeEnabled: boolean | null;
  runtimeScope: RuntimeScope | null;
  instances?: SkillInstanceView[];
}

export interface OrganizerStateV1 {
  schemaVersion: 1;
  revision: number;
  taxonomyVersion: number;
  updatedAt: string;
  overrides: Record<string, SkillOverride>;
}

export interface OrganizerBackupV1 {
  format: "codex-skill-organizer-backup";
  version: 1;
  exportedAt: string;
  state: OrganizerStateV1;
}

export interface InventorySummary {
  total: number;
  runtimeVisible: number;
  cacheOnly: number;
  pending: number;
  favorites: number;
  duplicateNames: number;
  byScope: Record<SkillScope, number>;
  byCategory: Record<CategoryId | "pending", number>;
}

export interface InventorySnapshot {
  revision: string;
  generatedAt: string;
  skills: SkillRecord[];
  summary: InventorySummary;
  scanErrors: Array<{ path: string; message: string }>;
  orphanOverrideIds: string[];
  runtimeAvailable: boolean;
  runtimeError: string | null;
  managementMode?: boolean;
  protocolVersion?: string;
  customCategories?: Array<{
    categoryId: `custom:${string}`;
    label: { zhCN: string; enUS: string };
    sortOrder: number;
    hidden: boolean;
  }>;
  categoryPreferences?: Array<{
    categoryId: CategoryId;
    display: { zhCN?: string; enUS?: string };
    sortOrder: number | null;
    hidden: boolean;
  }>;
  configuredRoots?: Array<{
    rootId: string;
    label: string;
    absolutePath: string;
    readonly: boolean;
    managementAuthorized: boolean;
  }>;
  selectedProjectPath?: string | null;
  savedViews?: Array<{
    viewId: string;
    name: string;
    filters: Record<string, string | boolean | string[] | null>;
  }>;
}

export interface ClassificationPatch {
  skillIds: string[];
  expectedRevision: string;
  primaryCategoryId?: CategoryId | null;
  addTagIds?: string[];
  removeTagIds?: string[];
  favorite?: boolean;
  locked?: boolean;
  restoreAutomatic?: boolean;
  reason?: string;
  confidence?: number;
}

export interface BatchOperationResult {
  succeeded: string[];
  failed: Array<{ skillId: string; message: string }>;
  notExecuted: string[];
  revision: string;
}
