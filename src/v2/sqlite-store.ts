import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import {
  BUILTIN_CATEGORY_IDS,
  type CategoryId,
  type CategoryPreference,
  type ClassificationSuggestion,
  type CustomCategory,
  type ConfiguredRoot,
  type InstallationUnit,
  type LogicalSkill,
  type NewClassificationSuggestion,
  type OperationRecord,
  type RuntimeOperationAudit,
  type SavedView,
  type QuarantineEntry,
  type SkillInstance,
  type TaxonomyPack,
  type UpdateEvidence,
  type UserState,
  type UserStateSemantic,
  type UserStatePatch,
  type UndoAction,
  type UndoKind,
} from "./domain.js";
import { assertTaxonomyPack } from "./taxonomy-pack.js";

export const SQLITE_SCHEMA_VERSION = 6;

export interface SqliteMigration {
  version: number;
  sql: string;
}

export const SQLITE_MIGRATIONS: readonly SqliteMigration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE taxonomy_packs (
        pack_id TEXT NOT NULL,
        version INTEGER NOT NULL CHECK (version > 0),
        payload_json TEXT NOT NULL,
        installed_at TEXT NOT NULL,
        PRIMARY KEY (pack_id, version)
      ) STRICT;

      CREATE TABLE logical_skills (
        logical_skill_id TEXT PRIMARY KEY,
        source_type TEXT NOT NULL,
        normalized_source TEXT NOT NULL,
        package_id TEXT NOT NULL,
        plugin_id TEXT,
        relative_skill_path TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        existing_category TEXT,
        automatic_category_id TEXT,
        automatic_taxonomy_version INTEGER NOT NULL CHECK (automatic_taxonomy_version >= 0),
        last_seen_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE skill_instances (
        instance_id TEXT PRIMARY KEY,
        logical_skill_id TEXT NOT NULL REFERENCES logical_skills(logical_skill_id) ON DELETE CASCADE,
        root_id TEXT NOT NULL,
        absolute_path TEXT NOT NULL,
        physical_fingerprint TEXT NOT NULL,
        version TEXT,
        plugin_cache_version TEXT,
        runtime_scope TEXT,
        runtime_enabled INTEGER CHECK (runtime_enabled IN (0, 1) OR runtime_enabled IS NULL),
        readonly INTEGER NOT NULL CHECK (readonly IN (0, 1)),
        last_seen_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX skill_instances_logical_idx ON skill_instances(logical_skill_id);

      CREATE TABLE custom_categories (
        category_id TEXT PRIMARY KEY,
        label_zh_cn TEXT NOT NULL,
        label_en_us TEXT NOT NULL,
        sort_order INTEGER NOT NULL,
        hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE category_preferences (
        category_id TEXT PRIMARY KEY,
        display_zh_cn TEXT,
        display_en_us TEXT,
        sort_order INTEGER,
        hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE user_skill_state (
        logical_skill_id TEXT PRIMARY KEY REFERENCES logical_skills(logical_skill_id) ON DELETE CASCADE,
        classification_mode TEXT NOT NULL DEFAULT 'automatic'
          CHECK (classification_mode IN ('automatic', 'manual')),
        primary_category_id TEXT,
        favorite INTEGER NOT NULL DEFAULT 0 CHECK (favorite IN (0, 1)),
        locked INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0, 1)),
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE tags (
        tag_id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE skill_tags (
        logical_skill_id TEXT NOT NULL REFERENCES logical_skills(logical_skill_id) ON DELETE CASCADE,
        tag_id TEXT NOT NULL REFERENCES tags(tag_id) ON DELETE CASCADE,
        PRIMARY KEY (logical_skill_id, tag_id)
      ) STRICT;

      CREATE TABLE operation_records (
        operation_id TEXT PRIMARY KEY,
        action TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('succeeded', 'failed', 'not-executed')),
        summary_json TEXT NOT NULL,
        occurred_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX operation_records_occurred_idx ON operation_records(occurred_at);

      CREATE TABLE app_settings (
        setting_key TEXT PRIMARY KEY,
        setting_value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO app_settings(setting_key, setting_value, updated_at)
      VALUES ('management_mode', '0', '1970-01-01T00:00:00.000Z');
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE installation_units (
        installation_unit_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        root_id TEXT NOT NULL,
        absolute_path TEXT NOT NULL,
        source_type TEXT NOT NULL,
        source_reference TEXT,
        confirmed INTEGER NOT NULL CHECK (confirmed IN (0, 1)),
        management_authorized INTEGER NOT NULL CHECK (management_authorized IN (0, 1)),
        contains_link INTEGER NOT NULL CHECK (contains_link IN (0, 1)),
        inside_git_worktree INTEGER NOT NULL CHECK (inside_git_worktree IN (0, 1)),
        size_bytes INTEGER CHECK (size_bytes >= 0 OR size_bytes IS NULL),
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE update_evidence (
        evidence_id TEXT PRIMARY KEY,
        instance_id TEXT NOT NULL REFERENCES skill_instances(instance_id) ON DELETE CASCADE,
        source_kind TEXT NOT NULL CHECK (source_kind IN ('github', 'codex-plugin')),
        installed_reference TEXT NOT NULL,
        available_reference TEXT NOT NULL,
        evidence_kind TEXT NOT NULL CHECK (evidence_kind IN ('tag', 'release', 'commit', 'install-hash')),
        comparison_url TEXT,
        locally_modified INTEGER NOT NULL CHECK (locally_modified IN (0, 1)),
        checked_at TEXT NOT NULL,
        expires_at TEXT
      ) STRICT;
      CREATE INDEX update_evidence_instance_idx ON update_evidence(instance_id, checked_at DESC);

      CREATE TABLE quarantine_entries (
        quarantine_entry_id TEXT PRIMARY KEY,
        installation_unit_id TEXT NOT NULL REFERENCES installation_units(installation_unit_id),
        original_path TEXT NOT NULL,
        quarantine_path TEXT NOT NULL,
        content_fingerprint TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('quarantined', 'restored', 'purged')),
        quarantined_at TEXT NOT NULL,
        restored_at TEXT
      ) STRICT;

      CREATE TABLE classification_suggestions (
        suggestion_id TEXT PRIMARY KEY,
        logical_skill_id TEXT NOT NULL REFERENCES logical_skills(logical_skill_id) ON DELETE CASCADE,
        category_id TEXT,
        tags_json TEXT NOT NULL,
        confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
        reason TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
        created_at TEXT NOT NULL,
        resolved_at TEXT
      ) STRICT;
      CREATE INDEX classification_suggestions_status_idx
        ON classification_suggestions(status, created_at DESC);
    `,
  },
  {
    version: 3,
    sql: `
      CREATE TABLE configured_roots (
        root_id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        absolute_path TEXT NOT NULL UNIQUE,
        readonly INTEGER NOT NULL DEFAULT 1 CHECK (readonly IN (0, 1)),
        management_authorized INTEGER NOT NULL DEFAULT 0 CHECK (management_authorized IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE saved_views (
        view_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        filters_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
    `,
  },
  {
    version: 4,
    sql: `
      CREATE TABLE undo_records (
        operation_id TEXT PRIMARY KEY REFERENCES operation_records(operation_id) ON DELETE CASCADE,
        undo_kind TEXT NOT NULL CHECK (undo_kind IN ('classification', 'runtime-enabled')),
        target_ids_json TEXT NOT NULL,
        before_state_json TEXT NOT NULL,
        after_state_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        undone_at TEXT
      ) STRICT;
      CREATE INDEX undo_records_created_idx ON undo_records(created_at DESC);
    `,
  },
  {
    version: 5,
    sql: `
      ALTER TABLE user_skill_state
      ADD COLUMN automatic_classification_frozen INTEGER NOT NULL DEFAULT 0
        CHECK (automatic_classification_frozen IN (0, 1));

      -- Before this column existed, a persisted user_skill_state row could
      -- only have been created by a personal classification/tag/favorite/lock
      -- action. Preserve that boundary during the v4 -> v5 migration.
      UPDATE user_skill_state SET automatic_classification_frozen = 1;
    `,
  },
  {
    version: 6,
    sql: `
      ALTER TABLE quarantine_entries ADD COLUMN restored_path TEXT;
    `,
  },
];

export class OrganizerDatabaseError extends Error {}
export class LockedSkillError extends OrganizerDatabaseError {}
export class UnknownCategoryError extends OrganizerDatabaseError {}
export class LogicalIdentityCollisionError extends OrganizerDatabaseError {}
export class UnsupportedSchemaVersionError extends OrganizerDatabaseError {
  constructor(
    readonly actualVersion: number,
    readonly supportedVersion = SQLITE_SCHEMA_VERSION,
  ) {
    super(`数据库 schema ${actualVersion} 高于当前支持版本 ${supportedVersion}`);
    this.name = "UnsupportedSchemaVersionError";
  }
}

/**
 * Node's SQLite binding reports both primary and extended SQLite result codes
 * through `errcode`. Recovery is destructive enough that message matching is
 * insufficient: only SQLITE_CORRUPT (11) and SQLITE_NOTADB (26) are accepted.
 */
export function isConfirmedSqliteCorruptionError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; errcode?: unknown };
  if (candidate.code !== "ERR_SQLITE_ERROR") return false;
  if (typeof candidate.errcode !== "number" || !Number.isInteger(candidate.errcode) || candidate.errcode < 0) {
    return false;
  }
  const primaryResultCode = candidate.errcode & 0xff;
  return primaryResultCode === 11 || primaryResultCode === 26;
}

export interface OrganizerDatabaseOptions {
  snapshotDirectory?: string;
  snapshotRetention?: number;
  auditRetentionDays?: number;
  timeoutMs?: number;
  now?: () => Date;
}

interface AuditDescriptor {
  action: string;
  targetType: OperationRecord["targetType"];
  targetId: string;
  summary?: OperationRecord["summary"];
}

interface LogicalIdentityRow {
  source_type: string;
  normalized_source: string;
  package_id: string;
  plugin_id: string | null;
  relative_skill_path: string;
  automatic_category_id: LogicalSkill["automaticCategoryId"];
  automatic_taxonomy_version: number;
  automatic_classification_frozen: number;
}

interface ClassificationUndoState {
  logicalSkillId: string;
  state: UserStateSemantic;
}

interface RuntimeUndoState {
  instanceId: string;
  enabled: boolean;
}

interface UndoRow extends Record<string, unknown> {
  operation_id: string;
  undo_kind: UndoKind;
  target_ids_json: string;
  before_state_json: string;
  after_state_json: string;
  created_at: string;
  undone_at: string | null;
}

const BUILTIN_CATEGORY_SET = new Set<string>(BUILTIN_CATEGORY_IDS);
const CUSTOM_CATEGORY_PATTERN = /^custom:[\p{L}\p{N}][\p{L}\p{N}._-]{0,63}$/u;
const TAG_PATTERN = /^[\p{L}\p{N}._:/+-]+$/u;

function assertNonEmpty(value: string, field: string): void {
  if (!value.normalize("NFC").trim()) throw new OrganizerDatabaseError(`${field} 不能为空`);
}

function assertIsoDate(value: string, field: string): void {
  if (Number.isNaN(Date.parse(value))) throw new OrganizerDatabaseError(`${field} 不是有效日期`);
}

function normalizeTag(tag: string): { id: string; display: string } {
  const display = tag.normalize("NFC").trim();
  const id = display.toLocaleLowerCase("en-US").replace(/\s+/g, "-");
  if (!id || id.length > 80 || !TAG_PATTERN.test(id)) {
    throw new OrganizerDatabaseError(`标签格式无效: ${tag}`);
  }
  return { id, display };
}

function parseJson<T>(value: string, context: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new OrganizerDatabaseError(`${context} JSON 已损坏`);
  }
}

function bool(value: unknown): boolean {
  return value === 1;
}

function scrubAuditSummary(summary: OperationRecord["summary"]): OperationRecord["summary"] {
  const redacted: OperationRecord["summary"] = {};
  for (const [key, value] of Object.entries(summary)) {
    if (typeof value !== "string") {
      redacted[key] = value;
      continue;
    }
    const trimmed = value.slice(0, 200);
    redacted[key] = /(?:^[a-z]:[\\/]|^\\\\|^\/)/iu.test(trimmed) ? "[redacted]" : trimmed;
  }
  return redacted;
}

function toUserState(row: Record<string, unknown>, tags: string[]): UserState {
  const classificationMode = row.classification_mode === "manual" ? "manual" : "automatic";
  return {
    logicalSkillId: String(row.logical_skill_id),
    classificationMode,
    primaryCategoryId: (classificationMode === "manual"
      ? row.primary_category_id
      : row.automatic_category_id) as CategoryId | null,
    tags,
    favorite: bool(row.favorite),
    locked: bool(row.locked),
    automaticClassificationFrozen: bool(row.automatic_classification_frozen),
    updatedAt: String(row.updated_at),
  };
}

function semanticUserState(state: UserState): UserStateSemantic {
  return {
    classificationMode: state.classificationMode,
    primaryCategoryId: state.primaryCategoryId,
    tags: [...state.tags].sort((left, right) => left.localeCompare(right, "en-US")),
    favorite: state.favorite,
    locked: state.locked,
  };
}

function sameSemanticUserState(left: UserStateSemantic, right: UserStateSemantic): boolean {
  return left.classificationMode === right.classificationMode
    && left.primaryCategoryId === right.primaryCategoryId
    && left.favorite === right.favorite
    && left.locked === right.locked
    && left.tags.length === right.tags.length
    && left.tags.every((tag, index) => tag === right.tags[index]);
}

export class OrganizerDatabase {
  readonly filePath: string;
  readonly snapshotDirectory: string;
  readonly snapshotRetention: number;
  readonly auditRetentionDays: number;

  readonly #database: DatabaseSync;
  readonly #now: () => Date;
  #snapshotSequence = 0;
  #closed = false;
  #writeQueue: Promise<unknown> = Promise.resolve();

  private constructor(filePath: string, database: DatabaseSync, options: OrganizerDatabaseOptions) {
    this.filePath = filePath;
    this.snapshotDirectory = options.snapshotDirectory ?? `${filePath}.snapshots`;
    this.snapshotRetention = options.snapshotRetention ?? 10;
    this.auditRetentionDays = options.auditRetentionDays ?? 30;
    this.#database = database;
    this.#now = options.now ?? (() => new Date());
    if (!Number.isInteger(this.snapshotRetention) || this.snapshotRetention < 1) {
      throw new OrganizerDatabaseError("snapshotRetention 必须是正整数");
    }
    if (!Number.isInteger(this.auditRetentionDays) || this.auditRetentionDays < 1) {
      throw new OrganizerDatabaseError("auditRetentionDays 必须是正整数");
    }
  }

  static async open(filePath: string, options: OrganizerDatabaseOptions = {}): Promise<OrganizerDatabase> {
    if (filePath !== ":memory:") await mkdir(path.dirname(filePath), { recursive: true });
    const database = new DatabaseSync(filePath, {
      timeout: options.timeoutMs ?? 5_000,
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
      allowExtension: false,
      defensive: true,
    });
    const store = new OrganizerDatabase(filePath, database, options);
    try {
      await store.#initialize();
      return store;
    } catch (error) {
      database.close();
      throw error;
    }
  }

  get schemaVersion(): number {
    this.#assertOpen();
    const row = this.#database.prepare("PRAGMA user_version").get() as { user_version: number };
    return Number(row.user_version);
  }

  get journalMode(): string {
    this.#assertOpen();
    const row = this.#database.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    return String(row.journal_mode).toLocaleLowerCase("en-US");
  }

  async close(): Promise<void> {
    await this.#writeQueue;
    if (!this.#closed) {
      this.#closed = true;
      this.#database.close();
    }
  }

  async listSnapshotFiles(): Promise<string[]> {
    if (this.filePath === ":memory:") return [];
    try {
      const entries = await readdir(this.snapshotDirectory, { withFileTypes: true });
      return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".sqlite"))
        .map((entry) => path.join(this.snapshotDirectory, entry.name))
        .sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async saveTaxonomyPack(pack: TaxonomyPack): Promise<void> {
    assertTaxonomyPack(pack);
    await this.#write(null, () => {
      this.#database.prepare(`
        INSERT INTO taxonomy_packs(pack_id, version, payload_json, installed_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(pack_id, version) DO UPDATE SET
          payload_json = excluded.payload_json,
          installed_at = excluded.installed_at
      `).run(pack.packId, pack.version, JSON.stringify(pack), this.#now().toISOString());
    });
  }

  getTaxonomyPack(packId: string, version?: number): TaxonomyPack | null {
    this.#assertOpen();
    const row = version === undefined
      ? this.#database.prepare(`
          SELECT payload_json FROM taxonomy_packs WHERE pack_id = ? ORDER BY version DESC LIMIT 1
        `).get(packId)
      : this.#database.prepare(`
          SELECT payload_json FROM taxonomy_packs WHERE pack_id = ? AND version = ?
        `).get(packId, version);
    if (!row) return null;
    const pack = parseJson<TaxonomyPack>(String((row as Record<string, unknown>).payload_json), "TaxonomyPack");
    assertTaxonomyPack(pack);
    return pack;
  }

  async upsertLogicalSkill(skill: LogicalSkill): Promise<void> {
    this.#validateLogicalSkill(skill);
    await this.#write(null, () => this.#upsertLogicalSkill(skill));
  }

  /**
   * Applies one live-discovery generation in one transaction and one pre-write
   * snapshot. Missing rows are deliberately retained: lastSeenAt is the stale
   * marker and user state is never deleted by discovery.
   */
  async syncInventory(logicalSkills: LogicalSkill[], instances: SkillInstance[]): Promise<void> {
    for (const skill of logicalSkills) this.#validateLogicalSkill(skill);
    for (const instance of instances) this.#validateSkillInstance(instance);
    const incomingLogicalIds = new Set(logicalSkills.map((skill) => skill.logicalSkillId));
    if (incomingLogicalIds.size !== logicalSkills.length) {
      throw new OrganizerDatabaseError("同批 inventory 包含重复 logicalSkillId");
    }
    if (new Set(instances.map((instance) => instance.instanceId)).size !== instances.length) {
      throw new OrganizerDatabaseError("同批 inventory 包含重复 instanceId");
    }
    await this.#write(null, () => {
      for (const skill of logicalSkills) this.#upsertLogicalSkill(skill);
      for (const instance of instances) {
        if (!incomingLogicalIds.has(instance.logicalSkillId)) this.#assertLogicalSkillExists(instance.logicalSkillId);
        this.#upsertSkillInstance(instance);
      }
    });
  }

  listLogicalSkills(): LogicalSkill[] {
    this.#assertOpen();
    return this.#database.prepare(`
      SELECT * FROM logical_skills ORDER BY name, logical_skill_id
    `).all().map((raw) => {
      const row = raw as Record<string, unknown>;
      return {
        logicalSkillId: String(row.logical_skill_id),
        sourceType: row.source_type as LogicalSkill["sourceType"],
        normalizedSource: String(row.normalized_source),
        packageId: String(row.package_id),
        pluginId: row.plugin_id === null ? null : String(row.plugin_id),
        relativeSkillPath: String(row.relative_skill_path),
        name: String(row.name),
        description: String(row.description),
        existingCategory: row.existing_category === null ? null : String(row.existing_category),
        automaticCategoryId: row.automatic_category_id as LogicalSkill["automaticCategoryId"],
        automaticTaxonomyVersion: Number(row.automatic_taxonomy_version),
        lastSeenAt: String(row.last_seen_at),
      };
    });
  }

  async upsertSkillInstance(instance: SkillInstance): Promise<void> {
    this.#validateSkillInstance(instance);
    await this.#write(null, () => {
      this.#assertLogicalSkillExists(instance.logicalSkillId);
      this.#upsertSkillInstance(instance);
    });
  }

  listSkillInstances(logicalSkillId?: string): SkillInstance[] {
    this.#assertOpen();
    const rows = logicalSkillId === undefined
      ? this.#database.prepare("SELECT * FROM skill_instances ORDER BY instance_id").all()
      : this.#database.prepare(`
          SELECT * FROM skill_instances WHERE logical_skill_id = ? ORDER BY instance_id
        `).all(logicalSkillId);
    return rows.map((raw) => {
      const row = raw as Record<string, unknown>;
      return {
        instanceId: String(row.instance_id),
        logicalSkillId: String(row.logical_skill_id),
        rootId: String(row.root_id),
        absolutePath: String(row.absolute_path),
        physicalFingerprint: String(row.physical_fingerprint),
        version: row.version === null ? null : String(row.version),
        pluginCacheVersion: row.plugin_cache_version === null ? null : String(row.plugin_cache_version),
        runtimeScope: row.runtime_scope as SkillInstance["runtimeScope"],
        runtimeEnabled: row.runtime_enabled === null ? null : bool(row.runtime_enabled),
        readonly: bool(row.readonly),
        lastSeenAt: String(row.last_seen_at),
      };
    });
  }

  async upsertInstallationUnit(unit: InstallationUnit): Promise<void> {
    this.#validateInstallationUnit(unit);
    await this.#write(null, () => this.#upsertInstallationUnit(unit));
  }

  async syncInstallationUnits(units: InstallationUnit[]): Promise<void> {
    for (const unit of units) this.#validateInstallationUnit(unit);
    if (new Set(units.map((unit) => unit.installationUnitId)).size !== units.length) {
      throw new OrganizerDatabaseError("同批 installation units 包含重复 ID");
    }
    await this.#write(null, () => {
      for (const unit of units) this.#upsertInstallationUnit(unit);
    });
  }

  #upsertInstallationUnit(unit: InstallationUnit): void {
    this.#database.prepare(`
        INSERT INTO installation_units(
          installation_unit_id, kind, root_id, absolute_path, source_type, source_reference,
          confirmed, management_authorized, contains_link, inside_git_worktree, size_bytes, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(installation_unit_id) DO UPDATE SET
          kind = excluded.kind,
          root_id = excluded.root_id,
          absolute_path = excluded.absolute_path,
          source_type = excluded.source_type,
          source_reference = excluded.source_reference,
          confirmed = excluded.confirmed,
          management_authorized = excluded.management_authorized,
          contains_link = excluded.contains_link,
          inside_git_worktree = excluded.inside_git_worktree,
          size_bytes = excluded.size_bytes,
          updated_at = excluded.updated_at
      `).run(
        unit.installationUnitId,
        unit.kind,
        unit.rootId,
        unit.absolutePath,
        unit.sourceType,
        unit.sourceReference,
        Number(unit.confirmed),
        Number(unit.managementAuthorized),
        Number(unit.containsLink),
        Number(unit.insideGitWorktree),
        unit.sizeBytes,
        unit.updatedAt,
      );
  }

  #validateInstallationUnit(unit: InstallationUnit): void {
    assertNonEmpty(unit.installationUnitId, "installationUnitId");
    assertNonEmpty(unit.absolutePath, "absolutePath");
    assertIsoDate(unit.updatedAt, "updatedAt");
    if (unit.sizeBytes !== null && (!Number.isSafeInteger(unit.sizeBytes) || unit.sizeBytes < 0)) {
      throw new OrganizerDatabaseError("sizeBytes 无效");
    }
  }

  getInstallationUnit(installationUnitId: string): InstallationUnit | null {
    this.#assertOpen();
    const row = this.#database.prepare(`
      SELECT * FROM installation_units WHERE installation_unit_id = ?
    `).get(installationUnitId);
    return row ? this.#toInstallationUnit(row as Record<string, unknown>) : null;
  }

  listInstallationUnits(): InstallationUnit[] {
    this.#assertOpen();
    return this.#database.prepare(`
      SELECT * FROM installation_units ORDER BY installation_unit_id
    `).all().map((row) => this.#toInstallationUnit(row as Record<string, unknown>));
  }

  async saveUpdateEvidence(evidence: UpdateEvidence): Promise<void> {
    assertIsoDate(evidence.checkedAt, "checkedAt");
    if (evidence.expiresAt !== null) assertIsoDate(evidence.expiresAt, "expiresAt");
    await this.#write(null, () => {
      this.#database.prepare(`
        INSERT INTO update_evidence(
          evidence_id, instance_id, source_kind, installed_reference, available_reference,
          evidence_kind, comparison_url, locally_modified, checked_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(evidence_id) DO UPDATE SET
          instance_id = excluded.instance_id,
          source_kind = excluded.source_kind,
          installed_reference = excluded.installed_reference,
          available_reference = excluded.available_reference,
          evidence_kind = excluded.evidence_kind,
          comparison_url = excluded.comparison_url,
          locally_modified = excluded.locally_modified,
          checked_at = excluded.checked_at,
          expires_at = excluded.expires_at
      `).run(
        evidence.evidenceId,
        evidence.instanceId,
        evidence.sourceKind,
        evidence.installedReference,
        evidence.availableReference,
        evidence.evidenceKind,
        evidence.comparisonUrl,
        Number(evidence.locallyModified),
        evidence.checkedAt,
        evidence.expiresAt,
      );
    });
  }

  listUpdateEvidence(instanceId?: string): UpdateEvidence[] {
    this.#assertOpen();
    const rows = instanceId === undefined
      ? this.#database.prepare("SELECT * FROM update_evidence ORDER BY checked_at DESC, evidence_id").all()
      : this.#database.prepare(`
          SELECT * FROM update_evidence WHERE instance_id = ? ORDER BY checked_at DESC, evidence_id
        `).all(instanceId);
    return rows.map((raw) => {
      const row = raw as Record<string, unknown>;
      return {
        evidenceId: String(row.evidence_id),
        instanceId: String(row.instance_id),
        sourceKind: row.source_kind as UpdateEvidence["sourceKind"],
        installedReference: String(row.installed_reference),
        availableReference: String(row.available_reference),
        evidenceKind: row.evidence_kind as UpdateEvidence["evidenceKind"],
        comparisonUrl: row.comparison_url === null ? null : String(row.comparison_url),
        locallyModified: bool(row.locally_modified),
        checkedAt: String(row.checked_at),
        expiresAt: row.expires_at === null ? null : String(row.expires_at),
      };
    });
  }

  async saveQuarantineEntry(entry: QuarantineEntry): Promise<void> {
    assertIsoDate(entry.quarantinedAt, "quarantinedAt");
    if (entry.restoredAt !== null) assertIsoDate(entry.restoredAt, "restoredAt");
    await this.#write(
      {
        action: "quarantine-record",
        targetType: "quarantine",
        targetId: entry.quarantineEntryId,
        summary: { status: entry.status },
      },
      () => {
        this.#database.prepare(`
          INSERT INTO quarantine_entries(
            quarantine_entry_id, installation_unit_id, original_path, quarantine_path,
            content_fingerprint, status, quarantined_at, restored_at, restored_path
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(quarantine_entry_id) DO UPDATE SET
            status = excluded.status,
            restored_at = excluded.restored_at,
            restored_path = excluded.restored_path
        `).run(
          entry.quarantineEntryId,
          entry.installationUnitId,
          entry.originalPath,
          entry.quarantinePath,
          entry.contentFingerprint,
          entry.status,
          entry.quarantinedAt,
          entry.restoredAt,
          entry.restoredPath,
        );
      },
    );
  }

  getQuarantineEntry(quarantineEntryId: string): QuarantineEntry | null {
    this.#assertOpen();
    const row = this.#database.prepare(`
      SELECT * FROM quarantine_entries WHERE quarantine_entry_id = ?
    `).get(quarantineEntryId);
    return row ? this.#toQuarantineEntry(row as Record<string, unknown>) : null;
  }

  listQuarantineEntries(): QuarantineEntry[] {
    this.#assertOpen();
    return this.#database.prepare(`
      SELECT * FROM quarantine_entries ORDER BY quarantined_at DESC, quarantine_entry_id
    `).all().map((row) => this.#toQuarantineEntry(row as Record<string, unknown>));
  }

  getUserState(logicalSkillId: string): UserState {
    this.#assertOpen();
    this.#assertLogicalSkillExists(logicalSkillId);
    const row = this.#database.prepare(`
      SELECT
        l.logical_skill_id,
        l.automatic_category_id,
        COALESCE(u.classification_mode, 'automatic') AS classification_mode,
        u.primary_category_id,
        COALESCE(u.favorite, 0) AS favorite,
        COALESCE(u.locked, 0) AS locked,
        COALESCE(u.automatic_classification_frozen, 0) AS automatic_classification_frozen,
        COALESCE(u.updated_at, l.last_seen_at) AS updated_at
      FROM logical_skills l
      LEFT JOIN user_skill_state u ON u.logical_skill_id = l.logical_skill_id
      WHERE l.logical_skill_id = ?
    `).get(logicalSkillId) as Record<string, unknown>;
    const tags = this.#database.prepare(`
      SELECT t.display_name
      FROM skill_tags st JOIN tags t ON t.tag_id = st.tag_id
      WHERE st.logical_skill_id = ?
      ORDER BY t.tag_id
    `).all(logicalSkillId).map((tagRow) => String((tagRow as Record<string, unknown>).display_name));
    return toUserState(row, tags);
  }

  listUserStates(): UserState[] {
    this.#assertOpen();
    const rows = this.#database.prepare(`
      SELECT
        l.logical_skill_id,
        l.automatic_category_id,
        COALESCE(u.classification_mode, 'automatic') AS classification_mode,
        u.primary_category_id,
        COALESCE(u.favorite, 0) AS favorite,
        COALESCE(u.locked, 0) AS locked,
        COALESCE(u.automatic_classification_frozen, 0) AS automatic_classification_frozen,
        COALESCE(u.updated_at, l.last_seen_at) AS updated_at
      FROM logical_skills l
      LEFT JOIN user_skill_state u ON u.logical_skill_id = l.logical_skill_id
      ORDER BY l.logical_skill_id
    `).all() as Array<Record<string, unknown>>;
    const tagsBySkill = new Map<string, string[]>();
    for (const raw of this.#database.prepare(`
      SELECT st.logical_skill_id, t.display_name
      FROM skill_tags st JOIN tags t ON t.tag_id = st.tag_id
      ORDER BY st.logical_skill_id, t.tag_id
    `).all()) {
      const row = raw as Record<string, unknown>;
      const logicalSkillId = String(row.logical_skill_id);
      const tags = tagsBySkill.get(logicalSkillId) ?? [];
      tags.push(String(row.display_name));
      tagsBySkill.set(logicalSkillId, tags);
    }
    return rows.map((row) => toUserState(row, tagsBySkill.get(String(row.logical_skill_id)) ?? []));
  }

  /** Applies the workbench's final user decision atomically with one audit record. */
  async applyUserStatePatch(logicalSkillId: string, patch: UserStatePatch): Promise<UserState> {
    const keys = Object.keys(patch);
    if (keys.length === 0) throw new OrganizerDatabaseError("UserState patch 不能为空");
    const unlocking = patch.locked === false;
    const modifiesProtectedState = patch.classification !== undefined
      || patch.tags !== undefined
      || patch.favorite !== undefined;
    if (unlocking && modifiesProtectedState) {
      throw new LockedSkillError("解锁必须是独立操作，再提交其他修改");
    }
    const normalizedTags = patch.tags === undefined ? undefined : this.#normalizeDistinctTags(patch.tags);
    await this.#write(
      {
        action: "user-state-patch",
        targetType: "logical-skill",
        targetId: logicalSkillId,
        summary: {
          classificationChanged: patch.classification !== undefined,
          tagsChanged: patch.tags !== undefined,
          favoriteChanged: patch.favorite !== undefined,
          lockChanged: patch.locked !== undefined,
        },
      },
      () => this.#applyUserStatePatchMutation(logicalSkillId, patch, normalizedTags),
    );
    return this.getUserState(logicalSkillId);
  }

  /** Applies up to 100 prevalidated workbench edits in one SQLite transaction. */
  async applyUserStatePatches(
    patches: Array<{ logicalSkillId: string; patch: UserStatePatch }>,
  ): Promise<UserState[]> {
    if (patches.length === 0 || patches.length > 100) {
      throw new OrganizerDatabaseError("批量 UserState 修改必须包含 1 到 100 项");
    }
    if (new Set(patches.map((item) => item.logicalSkillId)).size !== patches.length) {
      throw new OrganizerDatabaseError("同批修改不能重复 logicalSkillId");
    }
    const prepared = patches.map(({ logicalSkillId, patch }) => {
      const keys = Object.keys(patch);
      if (keys.length === 0) throw new OrganizerDatabaseError("UserState patch 不能为空");
      const unlocking = patch.locked === false;
      const modifiesProtectedState = patch.classification !== undefined
        || patch.tags !== undefined
        || patch.favorite !== undefined;
      if (unlocking && modifiesProtectedState) {
        throw new LockedSkillError("解锁必须是独立操作，再提交其他修改");
      }
      return {
        logicalSkillId,
        patch,
        normalizedTags: patch.tags === undefined ? undefined : this.#normalizeDistinctTags(patch.tags),
      };
    });
    await this.#write(null, () => {
      const before: ClassificationUndoState[] = prepared.map((item) => ({
        logicalSkillId: item.logicalSkillId,
        state: semanticUserState(this.getUserState(item.logicalSkillId)),
      }));
      for (const item of prepared) {
        this.#applyUserStatePatchMutation(item.logicalSkillId, item.patch, item.normalizedTags);
      }
      const after: ClassificationUndoState[] = prepared.map((item) => ({
        logicalSkillId: item.logicalSkillId,
        state: semanticUserState(this.getUserState(item.logicalSkillId)),
      }));
      const operationId = randomUUID();
      const occurredAt = this.#now().toISOString();
      this.#insertOperation({
        operationId,
        action: "user-state-batch-patch",
        targetType: "settings",
        targetId: "workbench-batch",
        status: "succeeded",
        summary: { count: prepared.length },
        occurredAt,
      });
      if (before.some((item, index) => !sameSemanticUserState(item.state, after[index]!.state))) {
        this.#insertUndoRecord(operationId, "classification", prepared.map((item) => item.logicalSkillId), before, after, occurredAt);
      }
    });
    return prepared.map((item) => this.getUserState(item.logicalSkillId));
  }

  async setManualClassification(logicalSkillId: string, categoryId: CategoryId | null): Promise<UserState> {
    await this.#write(
      {
        action: "classification-set",
        targetType: "logical-skill",
        targetId: logicalSkillId,
        summary: { categoryId },
      },
      () => {
        this.#assertLogicalSkillExists(logicalSkillId);
        this.#assertUnlocked(logicalSkillId);
        if (categoryId !== null) this.#assertCategoryExists(categoryId);
        const now = this.#now().toISOString();
        this.#touchUserState(logicalSkillId, now);
        this.#database.prepare(`
          UPDATE user_skill_state
          SET classification_mode = 'manual', primary_category_id = ?, updated_at = ?
          WHERE logical_skill_id = ?
        `).run(categoryId, now, logicalSkillId);
      },
    );
    return this.getUserState(logicalSkillId);
  }

  async restoreAutomaticClassification(logicalSkillId: string): Promise<UserState> {
    await this.#write(
      {
        action: "classification-restore-automatic",
        targetType: "logical-skill",
        targetId: logicalSkillId,
      },
      () => {
        this.#assertLogicalSkillExists(logicalSkillId);
        this.#assertUnlocked(logicalSkillId);
        const now = this.#now().toISOString();
        this.#touchUserState(logicalSkillId, now);
        this.#database.prepare(`
          UPDATE user_skill_state
          SET classification_mode = 'automatic', primary_category_id = NULL, updated_at = ?
          WHERE logical_skill_id = ?
        `).run(now, logicalSkillId);
      },
    );
    return this.getUserState(logicalSkillId);
  }

  async setFavorite(logicalSkillId: string, favorite: boolean): Promise<UserState> {
    await this.#write(
      {
        action: "favorite-set",
        targetType: "logical-skill",
        targetId: logicalSkillId,
        summary: { favorite },
      },
      () => {
        this.#assertLogicalSkillExists(logicalSkillId);
        this.#assertUnlocked(logicalSkillId);
        const now = this.#now().toISOString();
        this.#touchUserState(logicalSkillId, now);
        this.#database.prepare(`
          UPDATE user_skill_state SET favorite = ?, updated_at = ? WHERE logical_skill_id = ?
        `).run(Number(favorite), now, logicalSkillId);
      },
    );
    return this.getUserState(logicalSkillId);
  }

  async setLocked(logicalSkillId: string, locked: boolean): Promise<UserState> {
    await this.#write(
      {
        action: locked ? "skill-lock" : "skill-unlock",
        targetType: "logical-skill",
        targetId: logicalSkillId,
      },
      () => {
        this.#assertLogicalSkillExists(logicalSkillId);
        const now = this.#now().toISOString();
        this.#touchUserState(logicalSkillId, now);
        this.#database.prepare(`
          UPDATE user_skill_state SET locked = ?, updated_at = ? WHERE logical_skill_id = ?
        `).run(Number(locked), now, logicalSkillId);
      },
    );
    return this.getUserState(logicalSkillId);
  }

  async replaceTags(logicalSkillId: string, tags: string[]): Promise<UserState> {
    const normalized = this.#normalizeDistinctTags(tags);
    await this.#write(
      {
        action: "tags-replace",
        targetType: "logical-skill",
        targetId: logicalSkillId,
        summary: { tagCount: normalized.length },
      },
      () => {
        this.#assertLogicalSkillExists(logicalSkillId);
        this.#assertUnlocked(logicalSkillId);
        this.#replaceTags(logicalSkillId, normalized);
      },
    );
    return this.getUserState(logicalSkillId);
  }

  async mergeTags(sourceTag: string, targetTag: string): Promise<number> {
    const source = normalizeTag(sourceTag);
    const target = normalizeTag(targetTag);
    if (source.id === target.id) throw new OrganizerDatabaseError("来源和目标标签相同");
    return this.#write(
      {
        action: "tag-merge",
        targetType: "settings",
        targetId: source.id,
        summary: { targetTagId: target.id },
      },
      () => {
        const sourceExists = this.#database.prepare("SELECT 1 FROM tags WHERE tag_id = ?").get(source.id);
        if (!sourceExists) throw new OrganizerDatabaseError(`未知标签: ${source.id}`);
        const locked = this.#database.prepare(`
          SELECT st.logical_skill_id
          FROM skill_tags st JOIN user_skill_state u ON u.logical_skill_id = st.logical_skill_id
          WHERE st.tag_id = ? AND u.locked = 1 LIMIT 1
        `).get(source.id);
        if (locked) throw new LockedSkillError("锁定 Skill 的标签不能被批量合并");
        const now = this.#now().toISOString();
        this.#database.prepare(`
          INSERT INTO tags(tag_id, display_name, created_at, updated_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(tag_id) DO UPDATE SET updated_at = excluded.updated_at
        `).run(target.id, target.display, now, now);
        const countRow = this.#database.prepare("SELECT COUNT(*) AS count FROM skill_tags WHERE tag_id = ?")
          .get(source.id) as { count: number };
        this.#database.prepare(`
          INSERT OR IGNORE INTO skill_tags(logical_skill_id, tag_id)
          SELECT logical_skill_id, ? FROM skill_tags WHERE tag_id = ?
        `).run(target.id, source.id);
        this.#database.prepare("DELETE FROM skill_tags WHERE tag_id = ?").run(source.id);
        this.#database.prepare("DELETE FROM tags WHERE tag_id = ?").run(source.id);
        return Number(countRow.count);
      },
    );
  }

  async createCustomCategory(category: CustomCategory): Promise<void> {
    this.#assertCustomCategoryId(category.categoryId);
    assertNonEmpty(category.label.zhCN, "label.zhCN");
    assertNonEmpty(category.label.enUS, "label.enUS");
    assertIsoDate(category.createdAt, "createdAt");
    assertIsoDate(category.updatedAt, "updatedAt");
    await this.#write(
      { action: "category-create", targetType: "category", targetId: category.categoryId },
      () => {
        this.#database.prepare(`
          INSERT INTO custom_categories(
            category_id, label_zh_cn, label_en_us, sort_order, hidden, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          category.categoryId,
          category.label.zhCN.trim(),
          category.label.enUS.trim(),
          category.sortOrder,
          Number(category.hidden),
          category.createdAt,
          category.updatedAt,
        );
      },
    );
  }

  listCustomCategories(): CustomCategory[] {
    this.#assertOpen();
    return this.#database.prepare(`
      SELECT * FROM custom_categories ORDER BY sort_order, category_id
    `).all().map((raw) => {
      const row = raw as Record<string, unknown>;
      return {
        categoryId: String(row.category_id) as `custom:${string}`,
        label: { zhCN: String(row.label_zh_cn), enUS: String(row.label_en_us) },
        sortOrder: Number(row.sort_order),
        hidden: bool(row.hidden),
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
      };
    });
  }

  async setCategoryPreference(preference: CategoryPreference): Promise<void> {
    this.#assertCategoryExists(preference.categoryId);
    if (preference.display.zhCN !== undefined) assertNonEmpty(preference.display.zhCN, "display.zhCN");
    if (preference.display.enUS !== undefined) assertNonEmpty(preference.display.enUS, "display.enUS");
    assertIsoDate(preference.updatedAt, "updatedAt");
    await this.#write(
      { action: "category-preference-set", targetType: "category", targetId: preference.categoryId },
      () => {
        this.#database.prepare(`
          INSERT INTO category_preferences(
            category_id, display_zh_cn, display_en_us, sort_order, hidden, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(category_id) DO UPDATE SET
            display_zh_cn = excluded.display_zh_cn,
            display_en_us = excluded.display_en_us,
            sort_order = excluded.sort_order,
            hidden = excluded.hidden,
            updated_at = excluded.updated_at
        `).run(
          preference.categoryId,
          preference.display.zhCN ?? null,
          preference.display.enUS ?? null,
          preference.sortOrder,
          Number(preference.hidden),
          preference.updatedAt,
        );
      },
    );
  }

  listCategoryPreferences(): CategoryPreference[] {
    this.#assertOpen();
    return this.#database.prepare(`
      SELECT * FROM category_preferences ORDER BY COALESCE(sort_order, 2147483647), category_id
    `).all().map((raw) => {
      const row = raw as Record<string, unknown>;
      const display: CategoryPreference["display"] = {};
      if (row.display_zh_cn !== null) display.zhCN = String(row.display_zh_cn);
      if (row.display_en_us !== null) display.enUS = String(row.display_en_us);
      return {
        categoryId: String(row.category_id) as CategoryId,
        display,
        sortOrder: row.sort_order === null ? null : Number(row.sort_order),
        hidden: bool(row.hidden),
        updatedAt: String(row.updated_at),
      };
    });
  }

  async migrateAndDeleteCustomCategory(sourceCategoryId: CategoryId, targetCategoryId: CategoryId): Promise<number> {
    this.#assertCustomCategoryId(sourceCategoryId);
    if (sourceCategoryId === targetCategoryId) throw new OrganizerDatabaseError("来源和目标分类相同");
    return this.#write(
      {
        action: "category-migrate-delete",
        targetType: "category",
        targetId: sourceCategoryId,
        summary: { targetCategoryId },
      },
      () => {
        if (!this.#database.prepare("SELECT 1 FROM custom_categories WHERE category_id = ?").get(sourceCategoryId)) {
          throw new UnknownCategoryError(`未知自定义分类: ${sourceCategoryId}`);
        }
        this.#assertCategoryExists(targetCategoryId);
        const locked = this.#database.prepare(`
          SELECT logical_skill_id FROM user_skill_state
          WHERE classification_mode = 'manual' AND primary_category_id = ? AND locked = 1 LIMIT 1
        `).get(sourceCategoryId);
        const lockedSuggestion = this.#database.prepare(`
          SELECT s.logical_skill_id
          FROM classification_suggestions s
          JOIN user_skill_state u ON u.logical_skill_id = s.logical_skill_id
          WHERE s.status = 'pending' AND s.category_id = ? AND u.locked = 1 LIMIT 1
        `).get(sourceCategoryId);
        if (locked || lockedSuggestion) throw new LockedSkillError("锁定 Skill 的分类不能被批量迁移");
        const countRow = this.#database.prepare(`
          SELECT COUNT(*) AS count FROM user_skill_state
          WHERE classification_mode = 'manual' AND primary_category_id = ?
        `).get(sourceCategoryId) as { count: number };
        const now = this.#now().toISOString();
        this.#database.prepare(`
          UPDATE user_skill_state SET primary_category_id = ?, updated_at = ?
          WHERE classification_mode = 'manual' AND primary_category_id = ?
        `).run(targetCategoryId, now, sourceCategoryId);
        this.#database.prepare(`
          UPDATE classification_suggestions SET category_id = ?
          WHERE status = 'pending' AND category_id = ?
        `).run(targetCategoryId, sourceCategoryId);
        this.#database.prepare("DELETE FROM category_preferences WHERE category_id = ?").run(sourceCategoryId);
        this.#database.prepare("DELETE FROM custom_categories WHERE category_id = ?").run(sourceCategoryId);
        return Number(countRow.count);
      },
    );
  }

  async setManagementMode(enabled: boolean): Promise<void> {
    await this.#write(
      {
        action: "management-mode-set",
        targetType: "settings",
        targetId: "management-mode",
        summary: { enabled },
      },
      () => {
        this.#database.prepare(`
          INSERT INTO app_settings(setting_key, setting_value, updated_at)
          VALUES ('management_mode', ?, ?)
          ON CONFLICT(setting_key) DO UPDATE SET
            setting_value = excluded.setting_value,
            updated_at = excluded.updated_at
        `).run(enabled ? "1" : "0", this.#now().toISOString());
      },
    );
  }

  async upsertConfiguredRoot(root: ConfiguredRoot): Promise<void> {
    assertNonEmpty(root.rootId, "rootId");
    assertNonEmpty(root.label, "label");
    assertNonEmpty(root.absolutePath, "absolutePath");
    if (!path.isAbsolute(root.absolutePath)) throw new OrganizerDatabaseError("configured root 必须是绝对路径");
    assertIsoDate(root.createdAt, "createdAt");
    assertIsoDate(root.updatedAt, "updatedAt");
    await this.#write(
      { action: "configured-root-upsert", targetType: "settings", targetId: root.rootId },
      () => {
        this.#database.prepare(`
          INSERT INTO configured_roots(
            root_id, label, absolute_path, readonly, management_authorized, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(root_id) DO UPDATE SET
            label = excluded.label,
            absolute_path = excluded.absolute_path,
            readonly = excluded.readonly,
            management_authorized = excluded.management_authorized,
            updated_at = excluded.updated_at
        `).run(
          root.rootId,
          root.label.trim(),
          path.resolve(root.absolutePath),
          Number(root.readonly),
          Number(root.managementAuthorized),
          root.createdAt,
          root.updatedAt,
        );
      },
    );
  }

  listConfiguredRoots(): ConfiguredRoot[] {
    this.#assertOpen();
    return this.#database.prepare("SELECT * FROM configured_roots ORDER BY label, root_id").all().map((raw) => {
      const row = raw as Record<string, unknown>;
      return {
        rootId: String(row.root_id),
        label: String(row.label),
        absolutePath: String(row.absolute_path),
        readonly: bool(row.readonly),
        managementAuthorized: bool(row.management_authorized),
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
      };
    });
  }

  async deleteConfiguredRoot(rootId: string): Promise<void> {
    assertNonEmpty(rootId, "rootId");
    await this.#write(
      { action: "configured-root-delete", targetType: "settings", targetId: rootId },
      () => {
        const result = this.#database.prepare("DELETE FROM configured_roots WHERE root_id = ?").run(rootId);
        if (Number(result.changes) !== 1) throw new OrganizerDatabaseError(`未知 configured root: ${rootId}`);
      },
    );
  }

  async upsertSavedView(view: SavedView): Promise<void> {
    assertNonEmpty(view.viewId, "viewId");
    assertNonEmpty(view.name, "name");
    assertIsoDate(view.createdAt, "createdAt");
    assertIsoDate(view.updatedAt, "updatedAt");
    await this.#write(
      { action: "saved-view-upsert", targetType: "settings", targetId: view.viewId },
      () => {
        this.#database.prepare(`
          INSERT INTO saved_views(view_id, name, filters_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(view_id) DO UPDATE SET
            name = excluded.name,
            filters_json = excluded.filters_json,
            updated_at = excluded.updated_at
        `).run(view.viewId, view.name.trim(), JSON.stringify(view.filters), view.createdAt, view.updatedAt);
      },
    );
  }

  listSavedViews(): SavedView[] {
    this.#assertOpen();
    return this.#database.prepare("SELECT * FROM saved_views ORDER BY name, view_id").all().map((raw) => {
      const row = raw as Record<string, unknown>;
      return {
        viewId: String(row.view_id),
        name: String(row.name),
        filters: parseJson<SavedView["filters"]>(String(row.filters_json), "saved view filters"),
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
      };
    });
  }

  async deleteSavedView(viewId: string): Promise<void> {
    assertNonEmpty(viewId, "viewId");
    await this.#write(
      { action: "saved-view-delete", targetType: "settings", targetId: viewId },
      () => {
        const result = this.#database.prepare("DELETE FROM saved_views WHERE view_id = ?").run(viewId);
        if (Number(result.changes) !== 1) throw new OrganizerDatabaseError(`未知 saved view: ${viewId}`);
      },
    );
  }

  getManagementMode(): boolean {
    this.#assertOpen();
    const row = this.#database.prepare(`
      SELECT setting_value FROM app_settings WHERE setting_key = 'management_mode'
    `).get() as { setting_value?: string } | undefined;
    return row?.setting_value === "1";
  }

  async setSelectedProjectPath(projectPath: string | null): Promise<void> {
    if (projectPath !== null && !path.isAbsolute(projectPath)) {
      throw new OrganizerDatabaseError("project path 必须是绝对路径");
    }
    await this.#write(
      { action: "selected-project-set", targetType: "settings", targetId: "selected-project" },
      () => {
        if (projectPath === null) {
          this.#database.prepare("DELETE FROM app_settings WHERE setting_key = 'selected_project_path'").run();
          return;
        }
        this.#database.prepare(`
          INSERT INTO app_settings(setting_key, setting_value, updated_at)
          VALUES ('selected_project_path', ?, ?)
          ON CONFLICT(setting_key) DO UPDATE SET
            setting_value = excluded.setting_value,
            updated_at = excluded.updated_at
        `).run(path.resolve(projectPath), this.#now().toISOString());
      },
    );
  }

  getSelectedProjectPath(): string | null {
    this.#assertOpen();
    const row = this.#database.prepare(`
      SELECT setting_value FROM app_settings WHERE setting_key = 'selected_project_path'
    `).get() as { setting_value?: string } | undefined;
    return row?.setting_value ?? null;
  }

  async stageClassificationSuggestions(
    suggestions: NewClassificationSuggestion[],
  ): Promise<ClassificationSuggestion[]> {
    if (suggestions.length === 0 || suggestions.length > 100) {
      throw new OrganizerDatabaseError("每批建议必须包含 1 到 100 项");
    }
    const prepared = suggestions.map((suggestion) => {
      if (!Number.isFinite(suggestion.confidence) || suggestion.confidence < 0 || suggestion.confidence > 1) {
        throw new OrganizerDatabaseError("建议 confidence 必须在 0 到 1 之间");
      }
      assertNonEmpty(suggestion.reason, "reason");
      return {
        ...suggestion,
        suggestionId: suggestion.suggestionId ?? randomUUID(),
        tags: this.#normalizeDistinctTags(suggestion.tags ?? []),
      };
    });
    if (new Set(prepared.map((item) => item.suggestionId)).size !== prepared.length) {
      throw new OrganizerDatabaseError("同批建议 suggestionId 不能重复");
    }
    const createdAt = this.#now().toISOString();
    await this.#write(null, () => {
      for (const suggestion of prepared) {
        this.#assertLogicalSkillExists(suggestion.logicalSkillId);
        this.#assertUnlocked(suggestion.logicalSkillId);
        if (suggestion.categoryId !== null) this.#assertCategoryExists(suggestion.categoryId);
      }
      const statement = this.#database.prepare(`
        INSERT INTO classification_suggestions(
          suggestion_id, logical_skill_id, category_id, tags_json, confidence,
          reason, status, created_at, resolved_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, NULL)
      `);
      for (const suggestion of prepared) {
        statement.run(
          suggestion.suggestionId,
          suggestion.logicalSkillId,
          suggestion.categoryId,
          JSON.stringify(suggestion.tags.map((tag) => tag.display)),
          suggestion.confidence,
          suggestion.reason.slice(0, 500),
          createdAt,
        );
      }
    });
    return prepared.map((suggestion) => ({
      suggestionId: suggestion.suggestionId,
      logicalSkillId: suggestion.logicalSkillId,
      categoryId: suggestion.categoryId,
      tags: suggestion.tags.map((tag) => tag.display),
      confidence: suggestion.confidence,
      reason: suggestion.reason.slice(0, 500),
      status: "pending",
      createdAt,
      resolvedAt: null,
    }));
  }

  listClassificationSuggestions(
    status?: ClassificationSuggestion["status"],
  ): ClassificationSuggestion[] {
    this.#assertOpen();
    const rows = status === undefined
      ? this.#database.prepare("SELECT * FROM classification_suggestions ORDER BY created_at DESC, suggestion_id").all()
      : this.#database.prepare(`
          SELECT * FROM classification_suggestions WHERE status = ? ORDER BY created_at DESC, suggestion_id
        `).all(status);
    return rows.map((raw) => {
      const row = raw as Record<string, unknown>;
      return {
        suggestionId: String(row.suggestion_id),
        logicalSkillId: String(row.logical_skill_id),
        categoryId: row.category_id as CategoryId | null,
        tags: parseJson<string[]>(String(row.tags_json), "classification suggestion tags"),
        confidence: Number(row.confidence),
        reason: String(row.reason),
        status: row.status as ClassificationSuggestion["status"],
        createdAt: String(row.created_at),
        resolvedAt: row.resolved_at === null ? null : String(row.resolved_at),
      };
    });
  }

  async resolveClassificationSuggestion(
    suggestionId: string,
    resolution: "accepted" | "rejected",
  ): Promise<ClassificationSuggestion> {
    return (await this.resolveClassificationSuggestions([suggestionId], resolution))[0]!;
  }

  async resolveClassificationSuggestions(
    suggestionIds: string[],
    resolution: "accepted" | "rejected",
  ): Promise<ClassificationSuggestion[]> {
    if (suggestionIds.length === 0 || suggestionIds.length > 100) {
      throw new OrganizerDatabaseError("批量建议处理必须包含 1 到 100 项");
    }
    if (new Set(suggestionIds).size !== suggestionIds.length) {
      throw new OrganizerDatabaseError("同批处理不能重复 suggestionId");
    }
    await this.#write(null, () => {
        const selectSuggestion = this.#database.prepare(`
          SELECT * FROM classification_suggestions WHERE suggestion_id = ?
        `);
        const prepared = suggestionIds.map((suggestionId) => {
          const row = selectSuggestion.get(suggestionId) as Record<string, unknown> | undefined;
          if (!row) throw new OrganizerDatabaseError(`未知建议: ${suggestionId}`);
          if (row.status !== "pending") throw new OrganizerDatabaseError(`建议已经处理: ${suggestionId}`);
          const logicalSkillId = String(row.logical_skill_id);
          this.#assertLogicalSkillExists(logicalSkillId);
          this.#assertUnlocked(logicalSkillId);
          const categoryId = row.category_id as CategoryId | null;
          if (categoryId !== null) this.#assertCategoryExists(categoryId);
          const suggestedTags = this.#normalizeDistinctTags(
            parseJson<string[]>(String(row.tags_json), "classification suggestion tags"),
          );
          return { suggestionId, logicalSkillId, categoryId, suggestedTags };
        });
        const before: ClassificationUndoState[] = resolution === "accepted"
          ? prepared.map((suggestion) => ({
              logicalSkillId: suggestion.logicalSkillId,
              state: semanticUserState(this.getUserState(suggestion.logicalSkillId)),
            }))
          : [];

        const now = this.#now().toISOString();
        const updateState = this.#database.prepare(`
            UPDATE user_skill_state
            SET classification_mode = 'manual', primary_category_id = ?, updated_at = ?
            WHERE logical_skill_id = ?
        `);
        const selectTags = this.#database.prepare(`
            SELECT t.display_name FROM skill_tags st JOIN tags t ON t.tag_id = st.tag_id
            WHERE st.logical_skill_id = ?
        `);
        const resolveSuggestion = this.#database.prepare(`
          UPDATE classification_suggestions SET status = ?, resolved_at = ? WHERE suggestion_id = ?
        `);
        for (const suggestion of prepared) {
          // Accepting or rejecting a staged model suggestion is an explicit
          // personal decision about this skill, so future taxonomy upgrades
          // must preserve the automatic category visible at this point.
          this.#touchUserState(suggestion.logicalSkillId, now);
          if (resolution === "accepted") {
            updateState.run(suggestion.categoryId, now, suggestion.logicalSkillId);
            const existingTags = selectTags.all(suggestion.logicalSkillId)
              .map((tagRow) => String((tagRow as Record<string, unknown>).display_name));
            this.#replaceTags(
              suggestion.logicalSkillId,
              this.#normalizeDistinctTags([
                ...existingTags,
                ...suggestion.suggestedTags.map((tag) => tag.display),
              ]),
            );
          }
          resolveSuggestion.run(resolution, now, suggestion.suggestionId);
        }
        const operationId = randomUUID();
        this.#insertOperation({
          operationId,
          action: `classification-suggestions-${resolution}`,
          targetType: "settings",
          targetId: "classification-suggestion-batch",
          status: "succeeded",
          summary: { count: suggestionIds.length },
          occurredAt: now,
        });
        if (resolution === "accepted") {
          const after: ClassificationUndoState[] = prepared.map((suggestion) => ({
            logicalSkillId: suggestion.logicalSkillId,
            state: semanticUserState(this.getUserState(suggestion.logicalSkillId)),
          }));
          if (before.some((item, index) => !sameSemanticUserState(item.state, after[index]!.state))) {
            this.#insertUndoRecord(
              operationId,
              "classification",
              prepared.map((suggestion) => suggestion.logicalSkillId),
              before,
              after,
              now,
            );
          }
        }
      });
    const resolved = new Map(
      this.listClassificationSuggestions().map((suggestion) => [suggestion.suggestionId, suggestion]),
    );
    return suggestionIds.map((suggestionId) => resolved.get(suggestionId)!);
  }

  async recordRuntimeOperations(records: RuntimeOperationAudit[]): Promise<void> {
    if (records.length === 0 || records.length > 100) {
      throw new OrganizerDatabaseError("runtime 审计批次必须包含 1 到 100 项");
    }
    if (new Set(records.map((record) => record.instanceId)).size !== records.length) {
      throw new OrganizerDatabaseError("runtime 审计批次不能重复 instanceId");
    }
    for (const record of records) {
      assertIsoDate(record.occurredAt, "occurredAt");
      if (!this.#database.prepare("SELECT 1 FROM skill_instances WHERE instance_id = ?").get(record.instanceId)) {
        throw new OrganizerDatabaseError(`未知 instanceId: ${record.instanceId}`);
      }
    }
    await this.#write(null, () => {
      for (const record of records) {
        const operationId = record.operationId ?? randomUUID();
        this.#insertOperation({
          operationId,
          action: "runtime-enabled-set",
          targetType: "instance",
          targetId: record.instanceId,
          status: record.status,
          summary: {
            beforeEnabled: record.beforeEnabled,
            requestedEnabled: record.requestedEnabled,
          },
          occurredAt: record.occurredAt,
        });
        if (record.status === "succeeded" && record.beforeEnabled !== record.requestedEnabled) {
          this.#insertUndoRecord(
            operationId,
            "runtime-enabled",
            [record.instanceId],
            [{ instanceId: record.instanceId, enabled: record.beforeEnabled } satisfies RuntimeUndoState],
            [{ instanceId: record.instanceId, enabled: record.requestedEnabled } satisfies RuntimeUndoState],
            record.occurredAt,
          );
        }
      }
    });
  }

  listUndoActions(): UndoAction[] {
    this.#assertOpen();
    const cutoff = new Date(this.#now().getTime() - this.auditRetentionDays * 24 * 60 * 60 * 1_000).toISOString();
    const rows = this.#database.prepare(`
      SELECT u.*, o.occurred_at
      FROM undo_records u JOIN operation_records o ON o.operation_id = u.operation_id
      WHERE o.occurred_at >= ?
      ORDER BY o.occurred_at DESC, u.operation_id
    `).all(cutoff) as UndoRow[];
    return rows.map((row) => this.#toUndoAction(row));
  }

  getRuntimeUndoState(operationId: string): {
    instanceId: string;
    beforeEnabled: boolean;
    afterEnabled: boolean;
  } | null {
    this.#assertOpen();
    const row = this.#getUndoRow(operationId);
    if (!row || row.undo_kind !== "runtime-enabled") return null;
    const before = this.#parseRuntimeUndoStates(row.before_state_json, "runtime undo before");
    const after = this.#parseRuntimeUndoStates(row.after_state_json, "runtime undo after");
    if (before.length !== 1 || after.length !== 1 || before[0]!.instanceId !== after[0]!.instanceId) {
      throw new OrganizerDatabaseError("runtime undo 记录已损坏");
    }
    return {
      instanceId: before[0]!.instanceId,
      beforeEnabled: before[0]!.enabled,
      afterEnabled: after[0]!.enabled,
    };
  }

  async undoClassification(operationId: string): Promise<void> {
    await this.#write(null, () => {
      const row = this.#getUndoRow(operationId);
      if (!row || row.undo_kind !== "classification") throw new OrganizerDatabaseError("未知分类撤销记录");
      if (row.undone_at !== null) throw new OrganizerDatabaseError("该操作已经撤销");
      const before = this.#parseClassificationUndoStates(row.before_state_json, "classification undo before");
      const after = this.#parseClassificationUndoStates(row.after_state_json, "classification undo after");
      if (before.length !== after.length || before.length === 0) throw new OrganizerDatabaseError("分类撤销记录已损坏");
      for (let index = 0; index < after.length; index += 1) {
        const expected = after[index]!;
        if (before[index]?.logicalSkillId !== expected.logicalSkillId) throw new OrganizerDatabaseError("分类撤销目标已损坏");
        const current = semanticUserState(this.getUserState(expected.logicalSkillId));
        if (!sameSemanticUserState(current, expected.state)) {
          throw new OrganizerDatabaseError("当前分类语义状态不再等于操作后的状态，前置状态已变化");
        }
      }
      for (const item of before) this.#restoreUserStateSemantic(item.logicalSkillId, item.state);
      const now = this.#now().toISOString();
      this.#database.prepare("UPDATE undo_records SET undone_at = ? WHERE operation_id = ?").run(now, operationId);
      this.#insertOperation({
        operationId: randomUUID(),
        action: "classification-undo",
        targetType: "settings",
        targetId: "workbench-batch",
        status: "succeeded",
        summary: { sourceOperationId: operationId, count: before.length },
        occurredAt: now,
      });
    });
  }

  async completeRuntimeUndo(operationId: string): Promise<{ instanceId: string; enabled: boolean }> {
    return this.#write(null, () => {
      const row = this.#getUndoRow(operationId);
      if (!row || row.undo_kind !== "runtime-enabled") throw new OrganizerDatabaseError("未知 runtime 撤销记录");
      if (row.undone_at !== null) throw new OrganizerDatabaseError("该操作已经撤销");
      const state = this.getRuntimeUndoState(operationId);
      if (!state) throw new OrganizerDatabaseError("runtime 撤销记录已损坏");
      const current = this.#database.prepare("SELECT runtime_enabled FROM skill_instances WHERE instance_id = ?")
        .get(state.instanceId) as { runtime_enabled: number | null } | undefined;
      if (!current || current.runtime_enabled === null || bool(current.runtime_enabled) !== state.afterEnabled) {
        throw new OrganizerDatabaseError("当前 runtime 状态不再等于操作后的状态，前置状态已变化");
      }
      const now = this.#now().toISOString();
      this.#database.prepare(`
        UPDATE skill_instances SET runtime_enabled = ?, last_seen_at = ? WHERE instance_id = ?
      `).run(Number(state.beforeEnabled), now, state.instanceId);
      this.#database.prepare("UPDATE undo_records SET undone_at = ? WHERE operation_id = ?").run(now, operationId);
      this.#insertOperation({
        operationId: randomUUID(),
        action: "runtime-enabled-undo",
        targetType: "instance",
        targetId: state.instanceId,
        status: "succeeded",
        summary: { sourceOperationId: operationId, enabled: state.beforeEnabled },
        occurredAt: now,
      });
      return { instanceId: state.instanceId, enabled: state.beforeEnabled };
    });
  }

  async recordOperation(record: OperationRecord): Promise<void> {
    assertIsoDate(record.occurredAt, "occurredAt");
    await this.#write(null, () => this.#insertOperation(record));
  }

  listOperationRecords(): OperationRecord[] {
    this.#assertOpen();
    return this.#database.prepare(`
      SELECT * FROM operation_records ORDER BY occurred_at DESC, operation_id
    `).all().map((raw) => {
      const row = raw as Record<string, unknown>;
      return {
        operationId: String(row.operation_id),
        action: String(row.action),
        targetType: row.target_type as OperationRecord["targetType"],
        targetId: String(row.target_id),
        status: row.status as OperationRecord["status"],
        summary: parseJson<OperationRecord["summary"]>(String(row.summary_json), "operation summary"),
        occurredAt: String(row.occurred_at),
      };
    });
  }

  async #initialize(): Promise<void> {
    const currentVersion = this.schemaVersion;
    if (currentVersion > SQLITE_SCHEMA_VERSION) {
      throw new UnsupportedSchemaVersionError(currentVersion);
    }
    const journalBefore = this.journalMode;
    if (currentVersion > 0 && (currentVersion < SQLITE_SCHEMA_VERSION || journalBefore !== "wal")) {
      await this.#createSnapshot(`before-migration-v${currentVersion}`);
    }
    this.#database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;");
    for (const migration of SQLITE_MIGRATIONS) {
      if (migration.version <= currentVersion) continue;
      this.#database.exec("BEGIN EXCLUSIVE");
      try {
        this.#database.exec(migration.sql);
        this.#database.exec(`PRAGMA user_version = ${migration.version}`);
        this.#database.exec("COMMIT");
      } catch (error) {
        this.#database.exec("ROLLBACK");
        throw error;
      }
    }
  }

  async #write<T>(audit: AuditDescriptor | null, mutation: () => T): Promise<T> {
    this.#assertOpen();
    const run = async (): Promise<T> => {
      await this.#createSnapshot(audit?.action ?? "state-write");
      this.#database.exec("BEGIN IMMEDIATE");
      try {
        const result = mutation();
        if (audit) {
          this.#insertOperation({
            operationId: randomUUID(),
            action: audit.action,
            targetType: audit.targetType,
            targetId: audit.targetId,
            status: "succeeded",
            summary: audit.summary ?? {},
            occurredAt: this.#now().toISOString(),
          });
        }
        this.#pruneAudit();
        this.#database.exec("COMMIT");
        return result;
      } catch (error) {
        this.#database.exec("ROLLBACK");
        throw error;
      }
    };
    const operation = this.#writeQueue.then(run, run);
    this.#writeQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async #createSnapshot(label: string): Promise<void> {
    if (this.filePath === ":memory:") return;
    await mkdir(this.snapshotDirectory, { recursive: true });
    const stamp = this.#now().toISOString().replace(/[:.]/g, "-");
    const sequence = String(this.#snapshotSequence++).padStart(6, "0");
    const safeLabel = label.replace(/[^a-z0-9-]+/giu, "-").slice(0, 40) || "write";
    const destination = path.join(
      this.snapshotDirectory,
      `${stamp}-${sequence}-${safeLabel}-${randomUUID()}.sqlite`,
    );
    const pending = `${destination}.pending`;
    const reservation = await open(pending, "wx");
    await reservation.close();
    try {
      await backup(this.#database, pending);
      await rename(pending, destination);
    } catch (error) {
      await unlink(pending).catch(() => undefined);
      throw error;
    }
    const snapshots = await this.listSnapshotFiles();
    for (const stale of snapshots.slice(0, Math.max(0, snapshots.length - this.snapshotRetention))) {
      await unlink(stale);
    }
  }

  #upsertLogicalSkill(skill: LogicalSkill): void {
    const existing = this.#database.prepare(`
      SELECT
        l.source_type,
        l.normalized_source,
        l.package_id,
        l.plugin_id,
        l.relative_skill_path,
        l.automatic_category_id,
        l.automatic_taxonomy_version,
        COALESCE(u.automatic_classification_frozen, 0) AS automatic_classification_frozen
      FROM logical_skills l
      LEFT JOIN user_skill_state u ON u.logical_skill_id = l.logical_skill_id
      WHERE l.logical_skill_id = ?
    `).get(skill.logicalSkillId) as LogicalIdentityRow | undefined;
    if (existing && (
      existing.source_type !== skill.sourceType
      || existing.normalized_source !== skill.normalizedSource
      || existing.package_id !== skill.packageId
      || existing.plugin_id !== skill.pluginId
      || existing.relative_skill_path !== skill.relativeSkillPath
    )) {
      throw new LogicalIdentityCollisionError(`logicalSkillId 身份冲突: ${skill.logicalSkillId}`);
    }
    const automaticCategoryId = existing?.automatic_classification_frozen === 1
      ? existing.automatic_category_id
      : skill.automaticCategoryId;
    const automaticTaxonomyVersion = existing?.automatic_classification_frozen === 1
      ? existing.automatic_taxonomy_version
      : skill.automaticTaxonomyVersion;
    this.#database.prepare(`
      INSERT INTO logical_skills(
        logical_skill_id, source_type, normalized_source, package_id, plugin_id,
        relative_skill_path, name, description, existing_category, automatic_category_id,
        automatic_taxonomy_version, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(logical_skill_id) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        existing_category = excluded.existing_category,
        automatic_category_id = excluded.automatic_category_id,
        automatic_taxonomy_version = excluded.automatic_taxonomy_version,
        last_seen_at = excluded.last_seen_at
    `).run(
      skill.logicalSkillId,
      skill.sourceType,
      skill.normalizedSource,
      skill.packageId,
      skill.pluginId,
      skill.relativeSkillPath,
      skill.name,
      skill.description,
      skill.existingCategory,
      automaticCategoryId,
      automaticTaxonomyVersion,
      skill.lastSeenAt,
    );
  }

  #upsertSkillInstance(instance: SkillInstance): void {
    this.#database.prepare(`
      INSERT INTO skill_instances(
        instance_id, logical_skill_id, root_id, absolute_path, physical_fingerprint,
        version, plugin_cache_version, runtime_scope, runtime_enabled, readonly, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(instance_id) DO UPDATE SET
        logical_skill_id = excluded.logical_skill_id,
        root_id = excluded.root_id,
        absolute_path = excluded.absolute_path,
        physical_fingerprint = excluded.physical_fingerprint,
        version = excluded.version,
        plugin_cache_version = excluded.plugin_cache_version,
        runtime_scope = excluded.runtime_scope,
        runtime_enabled = excluded.runtime_enabled,
        readonly = excluded.readonly,
        last_seen_at = excluded.last_seen_at
    `).run(
      instance.instanceId,
      instance.logicalSkillId,
      instance.rootId,
      instance.absolutePath,
      instance.physicalFingerprint,
      instance.version,
      instance.pluginCacheVersion,
      instance.runtimeScope,
      instance.runtimeEnabled === null ? null : Number(instance.runtimeEnabled),
      Number(instance.readonly),
      instance.lastSeenAt,
    );
  }

  #toInstallationUnit(row: Record<string, unknown>): InstallationUnit {
    return {
      installationUnitId: String(row.installation_unit_id),
      kind: row.kind as InstallationUnit["kind"],
      rootId: String(row.root_id),
      absolutePath: String(row.absolute_path),
      sourceType: row.source_type as InstallationUnit["sourceType"],
      sourceReference: row.source_reference === null ? null : String(row.source_reference),
      confirmed: bool(row.confirmed),
      managementAuthorized: bool(row.management_authorized),
      containsLink: bool(row.contains_link),
      insideGitWorktree: bool(row.inside_git_worktree),
      sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
      updatedAt: String(row.updated_at),
    };
  }

  #toQuarantineEntry(row: Record<string, unknown>): QuarantineEntry {
    return {
      quarantineEntryId: String(row.quarantine_entry_id),
      installationUnitId: String(row.installation_unit_id),
      originalPath: String(row.original_path),
      quarantinePath: String(row.quarantine_path),
      contentFingerprint: String(row.content_fingerprint),
      status: row.status as QuarantineEntry["status"],
      quarantinedAt: String(row.quarantined_at),
      restoredAt: row.restored_at === null ? null : String(row.restored_at),
      restoredPath: row.restored_path === null ? null : String(row.restored_path),
    };
  }

  #validateLogicalSkill(skill: LogicalSkill): void {
    for (const [field, value] of [
      ["logicalSkillId", skill.logicalSkillId],
      ["normalizedSource", skill.normalizedSource],
      ["packageId", skill.packageId],
      ["relativeSkillPath", skill.relativeSkillPath],
      ["name", skill.name],
    ] as const) assertNonEmpty(value, field);
    assertIsoDate(skill.lastSeenAt, "lastSeenAt");
    if (!Number.isInteger(skill.automaticTaxonomyVersion) || skill.automaticTaxonomyVersion < 0) {
      throw new OrganizerDatabaseError("automaticTaxonomyVersion 无效");
    }
    if (skill.automaticCategoryId !== null && !BUILTIN_CATEGORY_SET.has(skill.automaticCategoryId)) {
      throw new UnknownCategoryError(`自动分类必须使用内置 ID: ${skill.automaticCategoryId}`);
    }
  }

  #validateSkillInstance(instance: SkillInstance): void {
    for (const [field, value] of [
      ["instanceId", instance.instanceId],
      ["logicalSkillId", instance.logicalSkillId],
      ["rootId", instance.rootId],
      ["absolutePath", instance.absolutePath],
      ["physicalFingerprint", instance.physicalFingerprint],
    ] as const) assertNonEmpty(value, field);
    assertIsoDate(instance.lastSeenAt, "lastSeenAt");
  }

  #assertLogicalSkillExists(logicalSkillId: string): void {
    if (!this.#database.prepare("SELECT 1 FROM logical_skills WHERE logical_skill_id = ?").get(logicalSkillId)) {
      throw new OrganizerDatabaseError(`未知 logicalSkillId: ${logicalSkillId}`);
    }
  }

  #ensureUserState(logicalSkillId: string, now: string): void {
    this.#database.prepare(`
      INSERT OR IGNORE INTO user_skill_state(
        logical_skill_id, classification_mode, primary_category_id, favorite, locked,
        automatic_classification_frozen, updated_at
      ) VALUES (?, 'automatic', NULL, 0, 0, 0, ?)
    `).run(logicalSkillId, now);
  }

  #touchUserState(logicalSkillId: string, now: string): void {
    this.#ensureUserState(logicalSkillId, now);
    this.#database.prepare(`
      UPDATE user_skill_state
      SET automatic_classification_frozen = 1, updated_at = ?
      WHERE logical_skill_id = ?
    `).run(now, logicalSkillId);
  }

  #applyUserStatePatchMutation(
    logicalSkillId: string,
    patch: UserStatePatch,
    normalizedTags: Array<{ id: string; display: string }> | undefined,
  ): void {
    this.#assertLogicalSkillExists(logicalSkillId);
    const modifiesProtectedState = patch.classification !== undefined
      || patch.tags !== undefined
      || patch.favorite !== undefined;
    if (modifiesProtectedState || patch.locked === true) this.#assertUnlocked(logicalSkillId);
    if (patch.classification?.mode === "manual") {
      const categoryId = patch.classification.primaryCategoryId ?? null;
      if (categoryId !== null) this.#assertCategoryExists(categoryId);
    } else if (patch.classification?.primaryCategoryId !== undefined) {
      throw new OrganizerDatabaseError("automatic 分类不能携带 primaryCategoryId");
    }
    const now = this.#now().toISOString();
    this.#touchUserState(logicalSkillId, now);
    if (patch.classification) {
      this.#database.prepare(`
        UPDATE user_skill_state
        SET classification_mode = ?, primary_category_id = ?, updated_at = ?
        WHERE logical_skill_id = ?
      `).run(
        patch.classification.mode,
        patch.classification.mode === "manual" ? patch.classification.primaryCategoryId ?? null : null,
        now,
        logicalSkillId,
      );
    }
    if (patch.favorite !== undefined) {
      this.#database.prepare(`
        UPDATE user_skill_state SET favorite = ?, updated_at = ? WHERE logical_skill_id = ?
      `).run(Number(patch.favorite), now, logicalSkillId);
    }
    if (normalizedTags !== undefined) this.#replaceTags(logicalSkillId, normalizedTags);
    if (patch.locked !== undefined) {
      this.#database.prepare(`
        UPDATE user_skill_state SET locked = ?, updated_at = ? WHERE logical_skill_id = ?
      `).run(Number(patch.locked), now, logicalSkillId);
    }
  }

  #assertUnlocked(logicalSkillId: string): void {
    const row = this.#database.prepare(`
      SELECT locked FROM user_skill_state WHERE logical_skill_id = ?
    `).get(logicalSkillId) as { locked: number } | undefined;
    if (row?.locked === 1) throw new LockedSkillError(`Skill 已锁定: ${logicalSkillId}`);
  }

  #assertCategoryExists(categoryId: CategoryId): void {
    if (BUILTIN_CATEGORY_SET.has(categoryId)) return;
    this.#assertCustomCategoryId(categoryId);
    if (!this.#database.prepare("SELECT 1 FROM custom_categories WHERE category_id = ?").get(categoryId)) {
      throw new UnknownCategoryError(`未知分类: ${categoryId}`);
    }
  }

  #assertCustomCategoryId(categoryId: string): asserts categoryId is `custom:${string}` {
    if (!CUSTOM_CATEGORY_PATTERN.test(categoryId)) {
      throw new UnknownCategoryError(`无效自定义分类 ID: ${categoryId}`);
    }
  }

  #normalizeDistinctTags(tags: string[]): Array<{ id: string; display: string }> {
    const unique = new Map<string, { id: string; display: string }>();
    for (const tag of tags) {
      const normalized = normalizeTag(tag);
      if (!unique.has(normalized.id)) unique.set(normalized.id, normalized);
    }
    return [...unique.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  #replaceTags(logicalSkillId: string, tags: Array<{ id: string; display: string }>): void {
    const now = this.#now().toISOString();
    this.#touchUserState(logicalSkillId, now);
    this.#database.prepare("DELETE FROM skill_tags WHERE logical_skill_id = ?").run(logicalSkillId);
    const upsertTag = this.#database.prepare(`
      INSERT INTO tags(tag_id, display_name, created_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(tag_id) DO UPDATE SET display_name = excluded.display_name, updated_at = excluded.updated_at
    `);
    const attachTag = this.#database.prepare(`
      INSERT INTO skill_tags(logical_skill_id, tag_id) VALUES (?, ?)
    `);
    for (const tag of tags) {
      upsertTag.run(tag.id, tag.display, now, now);
      attachTag.run(logicalSkillId, tag.id);
    }
    this.#database.prepare("UPDATE user_skill_state SET updated_at = ? WHERE logical_skill_id = ?")
      .run(now, logicalSkillId);
    this.#database.exec("DELETE FROM tags WHERE tag_id NOT IN (SELECT tag_id FROM skill_tags)");
  }

  #restoreUserStateSemantic(logicalSkillId: string, state: UserStateSemantic): void {
    this.#assertLogicalSkillExists(logicalSkillId);
    if (state.classificationMode === "manual" && state.primaryCategoryId !== null) {
      this.#assertCategoryExists(state.primaryCategoryId);
    }
    const normalizedTags = this.#normalizeDistinctTags(state.tags);
    const now = this.#now().toISOString();
    this.#touchUserState(logicalSkillId, now);
    this.#database.prepare(`
      UPDATE user_skill_state
      SET classification_mode = ?, primary_category_id = ?, favorite = ?, locked = ?, updated_at = ?
      WHERE logical_skill_id = ?
    `).run(
      state.classificationMode,
      state.classificationMode === "manual" ? state.primaryCategoryId : null,
      Number(state.favorite),
      Number(state.locked),
      now,
      logicalSkillId,
    );
    this.#replaceTags(logicalSkillId, normalizedTags);
  }

  #insertUndoRecord(
    operationId: string,
    kind: UndoKind,
    targetIds: string[],
    beforeState: unknown,
    afterState: unknown,
    createdAt: string,
  ): void {
    this.#database.prepare(`
      INSERT INTO undo_records(
        operation_id, undo_kind, target_ids_json, before_state_json, after_state_json, created_at, undone_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL)
    `).run(
      operationId,
      kind,
      JSON.stringify(targetIds),
      JSON.stringify(beforeState),
      JSON.stringify(afterState),
      createdAt,
    );
  }

  #getUndoRow(operationId: string): UndoRow | null {
    return (this.#database.prepare("SELECT * FROM undo_records WHERE operation_id = ?").get(operationId) as UndoRow | undefined) ?? null;
  }

  #parseClassificationUndoStates(value: string, context: string): ClassificationUndoState[] {
    const parsed = parseJson<unknown>(value, context);
    if (!Array.isArray(parsed)) throw new OrganizerDatabaseError(`${context} 格式无效`);
    return parsed.map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new OrganizerDatabaseError(`${context} 格式无效`);
      const record = item as Record<string, unknown>;
      const state = record.state as Record<string, unknown> | undefined;
      if (
        typeof record.logicalSkillId !== "string"
        || !state
        || (state.classificationMode !== "automatic" && state.classificationMode !== "manual")
        || (state.primaryCategoryId !== null && typeof state.primaryCategoryId !== "string")
        || !Array.isArray(state.tags)
        || !state.tags.every((tag) => typeof tag === "string")
        || typeof state.favorite !== "boolean"
        || typeof state.locked !== "boolean"
      ) throw new OrganizerDatabaseError(`${context} 格式无效`);
      return {
        logicalSkillId: record.logicalSkillId,
        state: {
          classificationMode: state.classificationMode,
          primaryCategoryId: state.primaryCategoryId as CategoryId | null,
          tags: [...state.tags].sort((left, right) => left.localeCompare(right, "en-US")),
          favorite: state.favorite,
          locked: state.locked,
        },
      };
    });
  }

  #parseRuntimeUndoStates(value: string, context: string): RuntimeUndoState[] {
    const parsed = parseJson<unknown>(value, context);
    if (!Array.isArray(parsed)) throw new OrganizerDatabaseError(`${context} 格式无效`);
    return parsed.map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new OrganizerDatabaseError(`${context} 格式无效`);
      const record = item as Record<string, unknown>;
      if (typeof record.instanceId !== "string" || typeof record.enabled !== "boolean") {
        throw new OrganizerDatabaseError(`${context} 格式无效`);
      }
      return { instanceId: record.instanceId, enabled: record.enabled };
    });
  }

  #toUndoAction(row: UndoRow): UndoAction {
    const targetIds = parseJson<string[]>(row.target_ids_json, "undo target ids");
    if (!Array.isArray(targetIds) || !targetIds.every((targetId) => typeof targetId === "string")) {
      throw new OrganizerDatabaseError("undo target ids 格式无效");
    }
    if (row.undone_at !== null) {
      return {
        operationId: row.operation_id,
        kind: row.undo_kind,
        targetIds,
        occurredAt: row.created_at,
        available: false,
        unavailableReason: "该操作已经撤销",
      };
    }
    if (row.undo_kind === "classification") {
      const after = this.#parseClassificationUndoStates(row.after_state_json, "classification undo after");
      const matches = after.length === targetIds.length && after.every((item, index) => (
        item.logicalSkillId === targetIds[index]
        && sameSemanticUserState(semanticUserState(this.getUserState(item.logicalSkillId)), item.state)
      ));
      return {
        operationId: row.operation_id,
        kind: row.undo_kind,
        targetIds,
        occurredAt: row.created_at,
        available: matches,
        unavailableReason: matches ? null : "分类、标签、收藏或锁定状态已经变化",
      };
    }
    const after = this.#parseRuntimeUndoStates(row.after_state_json, "runtime undo after");
    const state = after.length === 1 ? after[0] : undefined;
    const current = state ? this.#database.prepare("SELECT runtime_enabled FROM skill_instances WHERE instance_id = ?")
      .get(state.instanceId) as { runtime_enabled: number | null } | undefined : undefined;
    const matches = Boolean(
      state
      && targetIds.length === 1
      && targetIds[0] === state.instanceId
      && current
      && current.runtime_enabled !== null
      && bool(current.runtime_enabled) === state.enabled,
    );
    return {
      operationId: row.operation_id,
      kind: row.undo_kind,
      targetIds,
      occurredAt: row.created_at,
      available: matches,
      unavailableReason: matches ? null : "runtime 状态已经变化或实例不可用",
    };
  }

  #insertOperation(record: OperationRecord): void {
    assertNonEmpty(record.operationId, "operationId");
    assertNonEmpty(record.action, "action");
    assertNonEmpty(record.targetId, "targetId");
    this.#database.prepare(`
      INSERT INTO operation_records(
        operation_id, action, target_type, target_id, status, summary_json, occurred_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.operationId,
      record.action,
      record.targetType,
      record.targetId,
      record.status,
      JSON.stringify(scrubAuditSummary(record.summary)),
      record.occurredAt,
    );
  }

  #pruneAudit(): void {
    const cutoff = new Date(this.#now().getTime() - this.auditRetentionDays * 24 * 60 * 60 * 1_000).toISOString();
    this.#database.prepare("DELETE FROM operation_records WHERE occurred_at < ?").run(cutoff);
  }

  #assertOpen(): void {
    if (this.#closed) throw new OrganizerDatabaseError("数据库已关闭");
  }
}
