export const BUILTIN_CATEGORY_IDS = [
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

export type BuiltinCategoryId = (typeof BUILTIN_CATEGORY_IDS)[number];
export type CategoryId = BuiltinCategoryId | `custom:${string}`;

export interface LocalizedText {
  zhCN: string;
  enUS: string;
}

export interface TaxonomyCategory {
  id: BuiltinCategoryId;
  label: LocalizedText;
  description: LocalizedText;
}

export type TaxonomyMatchField =
  | "source"
  | "package"
  | "plugin"
  | "relativePath"
  | "name"
  | "description"
  | "searchable";

export interface TaxonomyMatcher {
  field: TaxonomyMatchField;
  operator: "equals" | "startsWith" | "contains" | "token";
  value: string;
}

export interface TaxonomyRule {
  id: string;
  categoryId: BuiltinCategoryId;
  priority: number;
  matchers: TaxonomyMatcher[];
  tags?: string[];
}

export interface TaxonomyPack {
  packId: string;
  version: number;
  categories: TaxonomyCategory[];
  categoryAliases: Record<string, BuiltinCategoryId>;
  exactSourceRules: TaxonomyRule[];
  bundleRules: TaxonomyRule[];
  keywordRules: TaxonomyRule[];
  migrationAliases: Record<string, BuiltinCategoryId>;
}

export type SkillSourceType =
  | "codex-home"
  | "agents"
  | "codex-plugin"
  | "repo"
  | "custom-root"
  | "unknown";

/** Portable identity. It intentionally contains no machine-specific absolute path. */
export interface LogicalSkill {
  logicalSkillId: string;
  sourceType: SkillSourceType;
  normalizedSource: string;
  packageId: string;
  pluginId: string | null;
  relativeSkillPath: string;
  name: string;
  description: string;
  existingCategory: string | null;
  automaticCategoryId: BuiltinCategoryId | null;
  automaticTaxonomyVersion: number;
  lastSeenAt: string;
}

/** Machine-local observation of one logical skill. */
export interface SkillInstance {
  instanceId: string;
  logicalSkillId: string;
  rootId: string;
  absolutePath: string;
  physicalFingerprint: string;
  version: string | null;
  pluginCacheVersion: string | null;
  runtimeScope: "user" | "repo" | "system" | "admin" | null;
  runtimeEnabled: boolean | null;
  readonly: boolean;
  lastSeenAt: string;
}

export type InstallationUnitKind = "plugin" | "bundle" | "skill" | "unknown-directory";

export interface InstallationUnit {
  installationUnitId: string;
  kind: InstallationUnitKind;
  rootId: string;
  absolutePath: string;
  sourceType: SkillSourceType;
  sourceReference: string | null;
  confirmed: boolean;
  managementAuthorized: boolean;
  containsLink: boolean;
  insideGitWorktree: boolean;
  sizeBytes: number | null;
  updatedAt: string;
}

export interface UserState {
  logicalSkillId: string;
  classificationMode: "automatic" | "manual";
  primaryCategoryId: CategoryId | null;
  tags: string[];
  favorite: boolean;
  locked: boolean;
  /**
   * Once the user has touched this skill, later TaxonomyPack versions must not
   * silently replace the automatic category that was visible at that moment.
   */
  automaticClassificationFrozen: boolean;
  updatedAt: string;
}

export interface UserStatePatch {
  classification?: {
    mode: "automatic" | "manual";
    primaryCategoryId?: CategoryId | null;
  };
  tags?: string[];
  favorite?: boolean;
  locked?: boolean;
}

export interface CustomCategory {
  categoryId: `custom:${string}`;
  label: LocalizedText;
  sortOrder: number;
  hidden: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CategoryPreference {
  categoryId: CategoryId;
  display: Partial<LocalizedText>;
  sortOrder: number | null;
  hidden: boolean;
  updatedAt: string;
}

export interface ConfiguredRoot {
  rootId: string;
  label: string;
  absolutePath: string;
  readonly: boolean;
  managementAuthorized: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SavedView {
  viewId: string;
  name: string;
  filters: Record<string, string | boolean | string[] | null>;
  createdAt: string;
  updatedAt: string;
}

export interface UpdateEvidence {
  evidenceId: string;
  instanceId: string;
  sourceKind: "github" | "codex-plugin";
  installedReference: string;
  availableReference: string;
  evidenceKind: "tag" | "release" | "commit" | "install-hash";
  comparisonUrl: string | null;
  locallyModified: boolean;
  checkedAt: string;
  expiresAt: string | null;
}

export interface QuarantineEntry {
  quarantineEntryId: string;
  installationUnitId: string;
  originalPath: string;
  quarantinePath: string;
  contentFingerprint: string;
  status: "quarantined" | "restored" | "purged";
  quarantinedAt: string;
  restoredAt: string | null;
  /** Actual restore destination; differs from originalPath only after an explicit conflict choice. */
  restoredPath: string | null;
}

export interface OperationRecord {
  operationId: string;
  action: string;
  targetType: "logical-skill" | "instance" | "installation-unit" | "category" | "settings" | "quarantine";
  targetId: string;
  status: "succeeded" | "failed" | "not-executed";
  /** Redacted, path-free summary suitable for the local 30-day audit log. */
  summary: Record<string, string | number | boolean | null>;
  occurredAt: string;
}

export type UndoKind = "classification" | "runtime-enabled";

export interface UndoAction {
  operationId: string;
  kind: UndoKind;
  targetIds: string[];
  occurredAt: string;
  available: boolean;
  unavailableReason: string | null;
  sensitive?: boolean;
}

export interface UserStateSemantic {
  classificationMode: UserState["classificationMode"];
  primaryCategoryId: CategoryId | null;
  tags: string[];
  favorite: boolean;
  locked: boolean;
}

export interface RuntimeOperationAudit {
  operationId?: string;
  instanceId: string;
  status: OperationRecord["status"];
  beforeEnabled: boolean;
  requestedEnabled: boolean;
  occurredAt: string;
}

export interface ClassificationSuggestion {
  suggestionId: string;
  logicalSkillId: string;
  categoryId: CategoryId | null;
  tags: string[];
  confidence: number;
  reason: string;
  status: "pending" | "accepted" | "rejected";
  createdAt: string;
  resolvedAt: string | null;
}

export interface NewClassificationSuggestion {
  suggestionId?: string;
  logicalSkillId: string;
  categoryId: CategoryId | null;
  tags?: string[];
  confidence: number;
  reason: string;
}

export interface TaxonomyClassificationInput {
  source: string;
  packageId: string;
  pluginId: string | null;
  relativePath: string;
  name: string;
  description: string;
  existingCategory: string | null;
}

export interface TaxonomyClassificationResult {
  categoryId: BuiltinCategoryId | null;
  tags: string[];
  source: "exact-source" | "bundle" | "existing-category" | "keyword" | "pending";
  ruleId: string | null;
}
