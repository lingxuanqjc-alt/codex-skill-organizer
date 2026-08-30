import { randomUUID } from "node:crypto";
import { existsSync, watch, type FSWatcher } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AppServerClient, type SkillsListEntry } from "./app-server-client.js";
import { classifySkill } from "./classifier.js";
import { resolveCodexHome } from "./codex-locations.js";
import { hashIdentity, isPathWithin, normalizeLogicalPath, normalizeWindowsComparable } from "./path-identity.js";
import { mergeScanResults, scanSkillRoots, type ScanResult } from "./scanner.js";
import { defaultPathLocationProbe, type PathLocationProbe } from "./windows-path-probe.js";
import {
  stageDatabaseRecovery,
  snapshotOpenFailure,
} from "./database-recovery.js";
import type { DurableFileOperations } from "./durable-file.js";
import {
  QuarantinePlanError,
  QuarantineSafetyError,
  QuarantineService,
  type InstallationUnitCandidate,
  type LiveQuarantineInventory,
  type QuarantineBatchResult,
  type QuarantinePlan,
} from "./quarantine-service.js";
import { CATEGORIES, isCategoryId, normalizeTagId, validateTagId } from "./taxonomy.js";
import { UpdateService, type UpdateCheckResult } from "./update-service.js";
import type {
  BatchOperationResult,
  CategoryId,
  ClassificationPatch,
  InventorySnapshot,
  InventorySummary,
  ObservedSkill,
  RootDefinition,
  RuntimeSkill,
  SkillInstanceView,
  SkillRecord,
  SkillScope,
} from "../shared/types.js";
import { PROTOCOL_VERSION } from "../shared/version.js";
import {
  DEFAULT_TAXONOMY_PACK,
  isConfirmedSqliteCorruptionError,
  LockedSkillError,
  OrganizerDatabase,
  OrganizerDatabaseError,
  type ClassificationSuggestion,
  type CategoryPreference,
  type ConfiguredRoot,
  type CustomCategory,
  type InstallationUnit,
  type LogicalSkill,
  type NewClassificationSuggestion,
  type QuarantineEntry,
  type UndoAction,
  type SavedView,
  type SkillInstance,
  type SkillSourceType,
  type UserStatePatch,
} from "../v2/index.js";

export class StaleInventoryError extends Error {}
export class InventoryMutationError extends Error {}

export interface InventoryServiceOptions {
  roots?: RootDefinition[];
  cwd?: string;
  statePath?: string;
  appServer?: AppServerClient | null;
  updateService?: UpdateService;
  pathLocationProbe?: PathLocationProbe;
  databaseRecoveryOperations?: DurableFileOperations;
  now?: () => Date;
  scanRoots?: (roots: RootDefinition[]) => Promise<ScanResult>;
  watchRoot?: (
    rootPath: string,
    listener: (eventType: string, fileName: string | Buffer | null) => void,
  ) => FSWatcher;
}

export interface UpdateCheckRequest {
  instanceIds: string[];
  expectedRevision: string;
  forceRefresh: true;
}

function defaultRoots(): RootDefinition[] {
  const profile = os.homedir();
  const codexHome = resolveCodexHome();
  return [
    { id: "codex", label: "Codex Skills", path: path.join(codexHome, "skills"), kind: "codex" },
    { id: "agents", label: "Agents Skills", path: path.join(profile, ".agents", "skills"), kind: "agents" },
    {
      id: "plugin-cache",
      label: "插件缓存",
      path: path.join(codexHome, "plugins", "cache"),
      kind: "plugin-cache",
      readonly: true,
    },
  ];
}

function rootCacheKey(root: RootDefinition): string {
  return `${root.id}\0${normalizeWindowsComparable(path.resolve(root.path))}`;
}

function rootSignature(root: RootDefinition): string {
  return JSON.stringify({
    id: root.id,
    label: root.label,
    path: normalizeWindowsComparable(path.resolve(root.path)),
    kind: root.kind,
    managementGranted: root.managementGranted ?? false,
    readonly: root.readonly ?? false,
  });
}

function defaultWatchRoot(
  rootPath: string,
  listener: (eventType: string, fileName: string | Buffer | null) => void,
): FSWatcher {
  return watch(rootPath, { recursive: true, persistent: false }, listener);
}

function isScanMetadataChange(fileName: string | Buffer | null): boolean {
  const normalized = String(fileName ?? "").replace(/\\/gu, "/").toLocaleLowerCase("en-US");
  if (!normalized) return true;
  if (
    normalized.endsWith("skill.md")
    || normalized.endsWith("plugin.json")
    || normalized.endsWith(".codex-remote-plugin-install.json")
  ) return true;
  return /(?:^|\/)\.git\/(?:config|head|packed-refs|refs\/)/u.test(normalized);
}

function defaultStatePath(): string {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return path.join(localAppData, "SkillOrganizerForCodex", "organizer.db");
}

function runtimeOnlyObserved(runtime: RuntimeSkill): ObservedSkill {
  const pluginPart = runtime.pluginId ? `plugin:${runtime.pluginId}` : `runtime:${runtime.scope}`;
  const normalizedPath = normalizeWindowsComparable(runtime.path);
  const skillId = hashIdentity("runtime", pluginPart, normalizedPath);
  return {
    skillId,
    physicalId: hashIdentity("runtime-physical", normalizedPath),
    instanceId: hashIdentity("instance", skillId, normalizedPath),
    name: runtime.name,
    description: runtime.description,
    scope: runtime.pluginId ? "plugin" : runtime.scope === "system" || runtime.scope === "admin" ? "system" : runtime.scope,
    sourceId: pluginPart,
    sourceLabel: runtime.pluginId ?? `Codex ${runtime.scope}`,
    packageId: runtime.pluginId ?? path.basename(path.dirname(runtime.path)),
    pluginId: runtime.pluginId,
    pluginVersion: null,
    installedCommit: undefined,
    rootId: "runtime",
    rootLabel: "Codex 运行时",
    absolutePath: runtime.path,
    relativePath: normalizeLogicalPath(`${path.basename(path.dirname(runtime.path))}/SKILL.md`),
    breadcrumb: `Codex 运行时 › ${runtime.path}`,
    readonly: runtime.pluginId !== null || runtime.scope === "system" || runtime.scope === "admin",
    aliases: [`Codex 运行时 › ${runtime.path}`],
    diagnostics: [{ code: "RUNTIME_ONLY", message: "此项由 Codex 运行时发现，但不在已配置物理根目录中" }],
  };
}

function createSummary(skills: SkillRecord[]): InventorySummary {
  const byScope: Record<SkillScope, number> = { user: 0, agents: 0, system: 0, plugin: 0, repo: 0, custom: 0 };
  const byCategory = Object.fromEntries(
    [...CATEGORIES.map((category) => category.id), "pending"].map((id) => [id, 0]),
  ) as InventorySummary["byCategory"];
  for (const skill of skills) {
    byScope[skill.scope] += 1;
    const category = skill.categoryId ?? "pending";
    byCategory[category] = (byCategory[category] ?? 0) + 1;
  }
  return {
    total: skills.length,
    runtimeVisible: skills.filter((skill) => skill.runtimeDiscovered).length,
    cacheOnly: skills.filter((skill) => !skill.runtimeDiscovered).length,
    pending: skills.filter((skill) => skill.categoryId === null).length,
    favorites: skills.filter((skill) => skill.favorite).length,
    duplicateNames: new Set(
      skills.filter((skill) => skill.diagnostics.some((item) => item.code === "DUPLICATE_NAME"))
        .map((skill) => skill.name.toLocaleLowerCase("en-US")),
    ).size,
    byScope,
    byCategory,
  };
}

function sourceType(skill: ObservedSkill): SkillSourceType {
  if (skill.scope === "plugin") return "codex-plugin";
  if (skill.scope === "agents") return "agents";
  if (skill.scope === "repo") return "repo";
  if (skill.scope === "custom") return "custom-root";
  if (skill.scope === "user" || skill.scope === "system") return "codex-home";
  return "unknown";
}

function rethrowDatabaseError(error: unknown): never {
  if (
    error instanceof LockedSkillError
    || error instanceof OrganizerDatabaseError
    || error instanceof QuarantinePlanError
    || error instanceof QuarantineSafetyError
  ) {
    throw new InventoryMutationError(error.message);
  }
  throw error;
}

async function openOrganizerDatabase(
  statePath: string,
  now: () => Date,
  recoveryOperations?: DurableFileOperations,
): Promise<OrganizerDatabase> {
  try {
    return await OrganizerDatabase.open(statePath, { now });
  } catch (originalError) {
    if (!isConfirmedSqliteCorruptionError(originalError)) throw originalError;
    if (!existsSync(statePath)) throw originalError;
    const snapshotDirectory = `${statePath}.snapshots`;
    let snapshots: string[] = [];
    try {
      snapshots = (await readdir(snapshotDirectory, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && entry.name.endsWith(".sqlite"))
        .map((entry) => path.join(snapshotDirectory, entry.name))
        .sort();
    } catch {
      throw originalError;
    }
    const latest = snapshots.at(-1);
    if (!latest) throw originalError;
    const suffix = now().toISOString().replace(/[:.]/gu, "-");
    const corruptDirectory = path.join(path.dirname(statePath), "corrupt-databases");
    const recovery = await stageDatabaseRecovery({
      statePath,
      snapshotPath: latest,
      corruptDirectory,
      archiveLabel: suffix,
      operations: recoveryOperations,
    });
    try {
      const database = await OrganizerDatabase.open(statePath, { now });
      await recovery.commit();
      return database;
    } catch (error) {
      try {
        await recovery.rollback();
      } catch (rollbackError) {
        throw rollbackError;
      }
      throw snapshotOpenFailure(error);
    }
  }
}

export class InventoryService {
  readonly roots: RootDefinition[];
  cwd: string;
  readonly #baseCwd: string;
  readonly statePath: string;
  readonly appServer: AppServerClient | null;
  readonly updateService: UpdateService;
  store!: OrganizerDatabase;
  quarantineService!: QuarantineService;
  readonly #now: () => Date;
  readonly #pathLocationProbe: PathLocationProbe;
  readonly #databaseRecoveryOperations: DurableFileOperations | undefined;
  readonly #scanRoots: (roots: RootDefinition[]) => Promise<ScanResult>;
  readonly #watchRoot: NonNullable<InventoryServiceOptions["watchRoot"]>;
  #observed: ObservedSkill[] = [];
  #runtimeEntries: SkillsListEntry[] = [];
  #scanErrors: Array<{ path: string; message: string }> = [];
  readonly #rootScanCache = new Map<string, { signature: string; result: ScanResult }>();
  readonly #watcherErrors = new Map<string, { path: string; message: string }>();
  readonly #backgroundRefreshErrors = new Map<string, { path: string; message: string }>();
  #runtimeError: string | null = null;
  #snapshot: InventorySnapshot | null = null;
  #refreshQueue: Promise<InventorySnapshot> | null = null;
  #invalidationTimer: NodeJS.Timeout | null = null;
  readonly #pendingRootRefreshes = new Set<string>();
  #pendingRuntimeRefresh = false;
  #closed = false;
  #watchers: FSWatcher[] = [];
  #selectedProjectPath: string | null;
  readonly #sessionProjectPaths = new Map<string, {
    paths: Map<string, string>;
    lastSeenAt: number;
  }>();
  #sessionProjectMutationQueue: Promise<unknown> = Promise.resolve();
  #runtimeMutationQueue: Promise<unknown> = Promise.resolve();

  constructor(options: InventoryServiceOptions = {}) {
    this.#baseCwd = path.resolve(options.cwd ?? process.cwd());
    this.cwd = this.#baseCwd;
    this.#selectedProjectPath = options.cwd ? path.resolve(options.cwd) : null;
    this.roots = options.roots ?? defaultRoots();
    this.statePath = options.statePath ?? defaultStatePath();
    this.appServer = options.appServer === undefined ? new AppServerClient() : options.appServer;
    this.updateService = options.updateService ?? new UpdateService();
    this.#pathLocationProbe = options.pathLocationProbe ?? defaultPathLocationProbe;
    this.#databaseRecoveryOperations = options.databaseRecoveryOperations;
    this.#scanRoots = options.scanRoots ?? scanSkillRoots;
    this.#watchRoot = options.watchRoot ?? defaultWatchRoot;
    this.#now = options.now ?? (() => new Date());
    this.appServer?.on("skillsChanged", () => this.#scheduleRuntimeRefresh(300));
  }

  async initialize(): Promise<InventorySnapshot> {
    this.store = await openOrganizerDatabase(this.statePath, this.#now, this.#databaseRecoveryOperations);
    await this.store.saveTaxonomyPack(DEFAULT_TAXONOMY_PACK);
    const selectedProject = this.store.getSelectedProjectPath();
    if (selectedProject && existsSync(selectedProject)) {
      this.#selectedProjectPath = selectedProject;
    }
    this.#loadPersistedRoots();
    this.quarantineService = new QuarantineService({
      database: this.store,
      dataDirectory: path.dirname(this.statePath),
      roots: this.roots,
      now: this.#now,
      pathLocationProbe: this.#pathLocationProbe,
    });
    if (this.appServer) {
      try {
        await this.appServer.start();
      } catch (error) {
        this.#runtimeError = error instanceof Error ? error.message : String(error);
      }
    }
    await this.refresh(true);
    this.#startWatchers();
    return this.#rebuildSnapshot();
  }

  get snapshot(): InventorySnapshot {
    if (!this.#snapshot) throw new Error("inventory 尚未初始化");
    return structuredClone(this.#snapshot);
  }

  get managementMode(): boolean {
    return this.store.getManagementMode();
  }

  async setManagementMode(enabled: boolean): Promise<InventorySnapshot> {
    await this.store.setManagementMode(enabled);
    return this.#rebuildSnapshot();
  }

  async addCustomRoot(
    absolutePath: string,
    label: string,
    expectedRevision: string,
  ): Promise<InventorySnapshot> {
    this.#assertRevision(expectedRevision);
    const physicalPath = await this.#validateLocalDirectory(absolutePath, "自定义根");
    if (physicalPath === path.parse(physicalPath).root || normalizeWindowsComparable(physicalPath) === normalizeWindowsComparable(os.homedir())) {
      throw new InventoryMutationError("不能把磁盘根目录或整个用户目录作为 Skill 根");
    }
    if (this.roots.some((root) => isPathWithin(physicalPath, root.path) || isPathWithin(root.path, physicalPath))) {
      throw new InventoryMutationError("自定义根与现有扫描根重叠");
    }
    const now = this.#now().toISOString();
    const root: ConfiguredRoot = {
      rootId: hashIdentity("custom-root", normalizeWindowsComparable(physicalPath)),
      label: label.normalize("NFC").trim().slice(0, 80) || path.basename(physicalPath),
      absolutePath: physicalPath,
      readonly: true,
      managementAuthorized: false,
      createdAt: now,
      updatedAt: now,
    };
    try {
      await this.store.upsertConfiguredRoot(root);
    } catch (error) {
      rethrowDatabaseError(error);
    }
    this.#loadPersistedRoots();
    this.#restartWatchers();
    return this.refresh(false);
  }

  async setCustomRootManagement(
    rootId: string,
    managementAuthorized: boolean,
    expectedRevision: string,
  ): Promise<InventorySnapshot> {
    this.#assertRevision(expectedRevision);
    const root = this.store.listConfiguredRoots().find((candidate) => candidate.rootId === rootId);
    if (!root) throw new InventoryMutationError(`未知自定义根: ${rootId}`);
    if (managementAuthorized) await this.#validateLocalDirectory(root.absolutePath, "自定义根");
    try {
      await this.store.upsertConfiguredRoot({
        ...root,
        readonly: !managementAuthorized,
        managementAuthorized,
        updatedAt: this.#now().toISOString(),
      });
    } catch (error) {
      rethrowDatabaseError(error);
    }
    this.#loadPersistedRoots();
    this.#restartWatchers();
    return this.refresh(false);
  }

  async removeCustomRoot(rootId: string, expectedRevision: string): Promise<InventorySnapshot> {
    this.#assertRevision(expectedRevision);
    const root = this.store.listConfiguredRoots().find((candidate) => candidate.rootId === rootId);
    if (!root) throw new InventoryMutationError(`未知自定义根: ${rootId}`);
    const unitIds = new Set(this.store.listInstallationUnits().filter((unit) => unit.rootId === rootId).map((unit) => unit.installationUnitId));
    if (this.store.listQuarantineEntries().some((entry) => entry.status === "quarantined" && unitIds.has(entry.installationUnitId))) {
      throw new InventoryMutationError("该根仍有未恢复的隔离记录，不能移除");
    }
    try {
      await this.store.deleteConfiguredRoot(rootId);
    } catch (error) {
      rethrowDatabaseError(error);
    }
    this.#loadPersistedRoots();
    this.#restartWatchers();
    return this.refresh(false);
  }

  async selectProject(projectPath: string | null, expectedRevision: string): Promise<InventorySnapshot> {
    this.#assertRevision(expectedRevision);
    const validated = projectPath === null ? null : await this.#validateLocalDirectory(projectPath, "项目目录");
    try {
      await this.store.setSelectedProjectPath(validated);
    } catch (error) {
      rethrowDatabaseError(error);
    }
    this.#selectedProjectPath = validated;
    this.cwd = this.#baseCwd;
    this.#loadPersistedRoots();
    this.#restartWatchers();
    return this.refresh(true);
  }

  async registerSessionProject(projectPath: string): Promise<InventorySnapshot> {
    const legacySessionId = `legacy-${hashIdentity("session-project", normalizeWindowsComparable(path.resolve(projectPath))).slice(0, 32)}`;
    return this.replaceSessionProjects(legacySessionId, [projectPath]);
  }

  async replaceSessionProjects(sessionId: string, projectPaths: readonly string[]): Promise<InventorySnapshot> {
    if (this.#closed) throw new Error("inventory 已关闭");
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(sessionId)) {
      throw new InventoryMutationError("Codex 会话 ID 无效");
    }
    if (projectPaths.length > 32) throw new InventoryMutationError("Codex 会话项目根不能超过 32 个");
    const validated = new Map<string, string>();
    for (const projectPath of projectPaths) {
      const physical = await this.#validateLocalDirectory(projectPath, "Codex 会话项目目录");
      validated.set(normalizeWindowsComparable(physical), physical);
    }
    if (this.#closed) throw new Error("inventory 已关闭");
    const lastSeenAt = this.#now().getTime();
    return this.#enqueueSessionProjectMutation(async () => {
      const existing = this.#sessionProjectPaths.get(sessionId);
      if (JSON.stringify([...existing?.paths.entries() ?? []]) === JSON.stringify([...validated.entries()])) {
        if (existing) existing.lastSeenAt = lastSeenAt;
        return this.snapshot;
      }
      if (validated.size === 0) this.#sessionProjectPaths.delete(sessionId);
      else this.#sessionProjectPaths.set(sessionId, { paths: validated, lastSeenAt });
      this.#loadPersistedRoots();
      this.#restartWatchers();
      return this.refresh(false);
    });
  }

  async pruneExpiredSessionProjects(ttlMs: number): Promise<InventorySnapshot> {
    if (this.#closed) throw new Error("inventory 已关闭");
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000) {
      throw new InventoryMutationError("Codex 会话项目 TTL 必须是至少 1 秒的安全整数");
    }
    return this.#enqueueSessionProjectMutation(async () => {
      const cutoff = this.#now().getTime() - ttlMs;
      let removed = false;
      for (const [sessionId, registration] of this.#sessionProjectPaths) {
        if (registration.lastSeenAt <= cutoff) {
          this.#sessionProjectPaths.delete(sessionId);
          removed = true;
        }
      }
      if (!removed) return this.snapshot;
      this.#loadPersistedRoots();
      this.#restartWatchers();
      return this.refresh(false);
    });
  }

  async saveView(
    view: Omit<SavedView, "createdAt" | "updatedAt">,
    expectedRevision: string,
  ): Promise<InventorySnapshot> {
    this.#assertRevision(expectedRevision);
    const existing = this.store.listSavedViews().find((candidate) => candidate.viewId === view.viewId);
    const now = this.#now().toISOString();
    await this.store.upsertSavedView({ ...view, createdAt: existing?.createdAt ?? now, updatedAt: now });
    return this.#rebuildSnapshot();
  }

  async deleteView(viewId: string, expectedRevision: string): Promise<InventorySnapshot> {
    this.#assertRevision(expectedRevision);
    await this.store.deleteSavedView(viewId);
    return this.#rebuildSnapshot();
  }

  async setCategoryPreference(
    preference: Omit<CategoryPreference, "updatedAt">,
    expectedRevision: string,
  ): Promise<InventorySnapshot> {
    this.#assertRevision(expectedRevision);
    await this.store.setCategoryPreference({ ...preference, updatedAt: this.#now().toISOString() });
    return this.#rebuildSnapshot();
  }

  async createCustomCategory(
    category: Omit<CustomCategory, "createdAt" | "updatedAt">,
    expectedRevision: string,
  ): Promise<InventorySnapshot> {
    this.#assertRevision(expectedRevision);
    const now = this.#now().toISOString();
    try {
      await this.store.createCustomCategory({ ...category, createdAt: now, updatedAt: now });
    } catch (error) {
      rethrowDatabaseError(error);
    }
    return this.#rebuildSnapshot();
  }

  async deleteCustomCategory(
    sourceCategoryId: `custom:${string}`,
    targetCategoryId: CategoryId,
    expectedRevision: string,
  ): Promise<{ migrated: number; snapshot: InventorySnapshot }> {
    this.#assertRevision(expectedRevision);
    try {
      const migrated = await this.store.migrateAndDeleteCustomCategory(sourceCategoryId, targetCategoryId);
      return { migrated, snapshot: await this.#rebuildSnapshot() };
    } catch (error) {
      rethrowDatabaseError(error);
    }
  }

  async refresh(forceRuntime = false): Promise<InventorySnapshot> {
    return this.#enqueueRefresh(() => this.#doRefresh(forceRuntime));
  }

  async applyClassification(patch: ClassificationPatch): Promise<InventorySnapshot> {
    this.#assertRevision(patch.expectedRevision);
    const uniqueIds = [...new Set(patch.skillIds)];
    if (uniqueIds.length === 0 || uniqueIds.length > 100) throw new InventoryMutationError("skillIds 数量必须在 1 到 100 之间");
    const currentSkills = new Map(this.snapshot.skills.map((skill) => [skill.skillId, skill]));
    for (const skillId of uniqueIds) {
      if (!currentSkills.has(skillId)) throw new InventoryMutationError(`未知 skillId: ${skillId}`);
    }
    if (
      patch.primaryCategoryId !== undefined
      && patch.primaryCategoryId !== null
      && !isCategoryId(patch.primaryCategoryId)
      && !patch.primaryCategoryId.startsWith("custom:")
    ) throw new InventoryMutationError("未知分类");
    const addTags = [...new Set((patch.addTagIds ?? []).map(normalizeTagId))];
    const removeTags = [...new Set((patch.removeTagIds ?? []).map(normalizeTagId))];
    if (![...addTags, ...removeTags].every(validateTagId)) throw new InventoryMutationError("标签格式无效");
    if (addTags.some((tag) => removeTags.includes(tag))) throw new InventoryMutationError("同一标签不能同时新增和移除");
    if (patch.locked === false && (
      patch.primaryCategoryId !== undefined || patch.restoreAutomatic || patch.favorite !== undefined
      || addTags.length > 0 || removeTags.length > 0
    )) throw new InventoryMutationError("解锁必须单独执行，再提交其他修改");

    try {
      const statePatches = uniqueIds.map((skillId) => {
        const state = this.store.getUserState(skillId);
        const statePatch: UserStatePatch = {};
        if (patch.restoreAutomatic) {
          statePatch.classification = { mode: "automatic" };
        } else if (patch.primaryCategoryId !== undefined) {
          statePatch.classification = {
            mode: "manual",
            primaryCategoryId: patch.confidence !== undefined && patch.confidence < 0.8 ? null : patch.primaryCategoryId,
          };
        }
        if (addTags.length > 0 || removeTags.length > 0) {
          statePatch.tags = [...new Set([...state.tags, ...addTags])]
            .filter((tag) => !removeTags.includes(normalizeTagId(tag)))
            .sort();
        }
        if (patch.favorite !== undefined) statePatch.favorite = patch.favorite;
        if (patch.locked !== undefined) statePatch.locked = patch.locked;
        if (Object.keys(statePatch).length === 0) throw new InventoryMutationError("分类修改内容为空");
        return { logicalSkillId: skillId, patch: statePatch };
      });
      await this.store.applyUserStatePatches(statePatches);
    } catch (error) {
      rethrowDatabaseError(error);
    }
    return this.#rebuildSnapshot();
  }

  async submitClassificationSuggestions(
    expectedRevision: string,
    suggestions: Array<{
      skillId: string;
      categoryId: CategoryId | null;
      tags?: string[];
      confidence: number;
      reason: string;
    }>,
  ): Promise<{ staged: ClassificationSuggestion[]; revision: string }> {
    this.#assertRevision(expectedRevision);
    const skills = new Set(this.snapshot.skills.map((skill) => skill.skillId));
    const prepared: NewClassificationSuggestion[] = suggestions.map((suggestion) => {
      if (!skills.has(suggestion.skillId)) throw new InventoryMutationError(`未知 skillId: ${suggestion.skillId}`);
      return {
        logicalSkillId: suggestion.skillId,
        categoryId: suggestion.confidence < 0.8 ? null : suggestion.categoryId,
        tags: suggestion.tags,
        confidence: suggestion.confidence,
        reason: suggestion.reason,
      };
    });
    try {
      const staged = await this.store.stageClassificationSuggestions(prepared);
      return { staged, revision: this.snapshot.revision };
    } catch (error) {
      rethrowDatabaseError(error);
    }
  }

  listClassificationSuggestions(): ClassificationSuggestion[] {
    return this.store.listClassificationSuggestions("pending");
  }

  async resolveClassificationSuggestions(
    suggestionIds: string[],
    status: "accepted" | "rejected",
    expectedRevision: string,
  ): Promise<{ resolved: ClassificationSuggestion[]; snapshot: InventorySnapshot }> {
    this.#assertRevision(expectedRevision);
    const uniqueIds = [...new Set(suggestionIds)];
    if (uniqueIds.length === 0 || uniqueIds.length > 100) throw new InventoryMutationError("suggestionIds 数量必须在 1 到 100 之间");
    try {
      const resolved = await this.store.resolveClassificationSuggestions(uniqueIds, status);
      return { resolved, snapshot: await this.#rebuildSnapshot() };
    } catch (error) {
      rethrowDatabaseError(error);
    }
  }

  async checkSkillUpdates(request: UpdateCheckRequest): Promise<{
    results: Array<UpdateCheckResult & { instanceId: string }>;
    checkedAt: string;
  }> {
    this.#assertRevision(request.expectedRevision);
    if (request.forceRefresh !== true) throw new InventoryMutationError("主动更新检查必须强制刷新缓存");
    const uniqueIds = [...new Set(request.instanceIds)];
    if (uniqueIds.length === 0 || uniqueIds.length > 100) throw new InventoryMutationError("instanceIds 数量必须在 1 到 100 之间");
    const targets = new Map<string, { skill: SkillRecord; instance: SkillInstanceView }>();
    for (const skill of this.snapshot.skills) {
      for (const instance of skill.instances ?? []) targets.set(instance.instanceId, { skill, instance });
    }
    const selectedTargets = uniqueIds.map((instanceId) => {
      const target = targets.get(instanceId);
      if (!target) throw new InventoryMutationError(`未知 instanceId: ${instanceId}`);
      return { instanceId, target };
    });
    const results: Array<UpdateCheckResult & { instanceId: string }> = [];
    const pluginSourceIds = selectedTargets
      .filter(({ target }) => target.skill.scope === "plugin")
      .map(({ target }) => target.skill.sourceId);
    if (pluginSourceIds.length > 0) {
      await this.updateService.refreshPluginCatalog(pluginSourceIds);
    }
    for (const { instanceId, target } of selectedTargets) {
      const installedCommit = target.instance.installedCommit && /^[a-f0-9]{40}$/iu.test(target.instance.installedCommit)
        ? target.instance.installedCommit
        : undefined;
      const installedTag = target.skill.scope === "plugin"
        ? target.instance.pluginVersion ?? undefined
        : undefined;
      const result = await this.updateService.check({
        logicalSkillId: target.skill.skillId,
        sourceId: target.skill.sourceId,
        installedCommit,
        installedTag,
        installedHash: undefined,
        instancePath: target.instance.absolutePath,
        locallyModified: false,
        scope: target.skill.scope,
      }, { forceRefresh: true });
      if (
        result.evidenceKind !== "none"
        && result.installedEvidence
        && result.availableEvidence
        && result.locallyModified !== undefined
      ) {
        await this.store.saveUpdateEvidence({
          evidenceId: hashIdentity("update-evidence", instanceId, result.checkedAt, result.availableEvidence),
          instanceId,
          sourceKind: target.skill.scope === "plugin" ? "codex-plugin" : "github",
          installedReference: result.installedEvidence,
          availableReference: result.availableEvidence,
          evidenceKind: result.evidenceKind === "commit"
            ? "commit"
            : result.evidenceKind === "codex-plugin"
              ? "tag"
              : result.evidenceKind === "install-hash"
                ? "install-hash"
                : "release",
          comparisonUrl: result.compareUrl ?? null,
          locallyModified: result.locallyModified,
          checkedAt: result.checkedAt,
          expiresAt: null,
        });
      }
      results.push({ ...result, instanceId });
    }
    return { results, checkedAt: this.#now().toISOString() };
  }

  async discoverInstallationUnits(): Promise<InstallationUnitCandidate[]> {
    const candidates = await this.quarantineService.discoverCandidates(this.#observed);
    const existingById = new Map(this.store.listInstallationUnits().map((unit) => [unit.installationUnitId, unit]));
    const persisted = candidates.map((candidate): InstallationUnitCandidate => {
      const existing = existingById.get(candidate.installationUnitId);
      const sameBoundary = existing
        && normalizeWindowsComparable(existing.absolutePath) === normalizeWindowsComparable(candidate.absolutePath)
        && existing.rootId === candidate.rootId
        && existing.kind === candidate.kind
        && existing.sourceType === candidate.sourceType
        && existing.sourceReference === candidate.sourceReference;
      return {
        ...candidate,
        confirmed: sameBoundary ? existing.confirmed : false,
        managementAuthorized: candidate.managementAuthorized && (sameBoundary ? existing.managementAuthorized : true),
      };
    });
    await this.store.syncInstallationUnits(persisted.map(({ affectedSkillIds: _skills, affectedInstanceIds: _instances, blockers: _blockers, ...unit }) => unit));
    return persisted;
  }

  async confirmInstallationUnits(
    installationUnitIds: string[],
    expectedRevision: string,
  ): Promise<{ units: InstallationUnitCandidate[]; snapshot: InventorySnapshot }> {
    this.#assertRevision(expectedRevision);
    const uniqueIds = [...new Set(installationUnitIds)];
    if (uniqueIds.length === 0 || uniqueIds.length > 100) throw new InventoryMutationError("installationUnitIds 数量必须在 1 到 100 之间");
    const candidates = await this.discoverInstallationUnits();
    const byId = new Map(candidates.map((candidate) => [candidate.installationUnitId, candidate]));
    const selected: InstallationUnitCandidate[] = [];
    for (const unitId of uniqueIds) {
      const candidate = byId.get(unitId);
      if (!candidate) throw new InventoryMutationError(`未知 installationUnitId: ${unitId}`);
      if (candidate.blockers.length > 0) {
        throw new InventoryMutationError(
          `安装单元 ${unitId} 存在安全阻断项，不能确认边界: ${candidate.blockers.map((item) => item.message).join("；")}`,
        );
      }
      selected.push({ ...candidate, confirmed: true });
    }
    try {
      await this.store.syncInstallationUnits(selected.map(({ affectedSkillIds: _skills, affectedInstanceIds: _instances, blockers: _blockers, ...unit }) => unit));
      return { units: selected, snapshot: await this.#rebuildSnapshot() };
    } catch (error) {
      rethrowDatabaseError(error);
    }
  }

  async prepareSkillQuarantine(
    installationUnitIds: string[],
    expectedRevision: string,
  ): Promise<QuarantinePlan> {
    this.#assertRevision(expectedRevision);
    try {
      return await this.quarantineService.prepare(installationUnitIds, this.#liveQuarantineInventory());
    } catch (error) {
      rethrowDatabaseError(error);
    }
  }

  async executeSkillQuarantine(
    planId: string,
    confirmed: boolean,
    expectedRevision: string,
  ): Promise<{ result: QuarantineBatchResult; snapshot: InventorySnapshot }> {
    this.#assertRevision(expectedRevision);
    try {
      const result = await this.quarantineService.quarantine(planId, confirmed, expectedRevision);
      return { result, snapshot: await this.refresh(true) };
    } catch (error) {
      rethrowDatabaseError(error);
    }
  }

  listQuarantineEntries(): QuarantineEntry[] {
    return this.store.listQuarantineEntries();
  }

  async restoreQuarantinedSkill(quarantineEntryId: string, confirmed: boolean): Promise<{
    entry: QuarantineEntry;
    snapshot: InventorySnapshot;
  }> {
    try {
      const entry = await this.quarantineService.restore(quarantineEntryId, confirmed);
      return { entry, snapshot: await this.refresh(true) };
    } catch (error) {
      rethrowDatabaseError(error);
    }
  }

  async restoreQuarantinedSkills(
    quarantineEntryIds: string[],
    confirmed: boolean,
    restoreTargets?: Record<string, string>,
  ): Promise<{
    succeeded: string[];
    failed: Array<{ quarantineEntryId: string; message: string }>;
    notExecuted: string[];
    restoredTo: Record<string, string>;
    snapshot: InventorySnapshot;
  }> {
    const uniqueIds = [...new Set(quarantineEntryIds)];
    if (uniqueIds.length === 0 || uniqueIds.length > 100) {
      throw new InventoryMutationError("quarantineEntryIds 数量必须在 1 到 100 之间");
    }
    const succeeded: string[] = [];
    const failed: Array<{ quarantineEntryId: string; message: string }> = [];
    const notExecuted: string[] = [];
    const restoredTo: Record<string, string> = {};
    for (const targetId of Object.keys(restoreTargets ?? {})) {
      if (!uniqueIds.includes(targetId)) throw new InventoryMutationError("restoreTargets 只能包含本批恢复记录");
    }
    for (let index = 0; index < uniqueIds.length; index += 1) {
      const entryId = uniqueIds[index]!;
      try {
        const entry = await this.quarantineService.restore(entryId, confirmed, restoreTargets?.[entryId]);
        succeeded.push(entryId);
        restoredTo[entryId] = entry.restoredPath ?? entry.originalPath;
      } catch (error) {
        failed.push({ quarantineEntryId: entryId, message: error instanceof Error ? error.message : String(error) });
        notExecuted.push(...uniqueIds.slice(index + 1));
        break;
      }
    }
    return { succeeded, failed, notExecuted, restoredTo, snapshot: await this.refresh(true) };
  }

  async purgeQuarantinedSkill(quarantineEntryId: string, confirmed: boolean): Promise<{ entry: QuarantineEntry }> {
    try {
      return { entry: await this.quarantineService.purge(quarantineEntryId, confirmed) };
    } catch (error) {
      rethrowDatabaseError(error);
    }
  }

  async setSkillEnabled(
    skillIds: string[],
    enabled: boolean,
    expectedRevision: string,
    confirmedSensitive = false,
  ): Promise<BatchOperationResult> {
    return this.#enqueueRuntimeMutation(async () => {
      this.#assertRevision(expectedRevision);
      if (!this.managementMode) throw new InventoryMutationError("管理模式未开启；请先在桌面工作台明确开启管理模式");
      if (!this.appServer?.isRunning) throw new InventoryMutationError("Codex app-server 不可用");
      await this.#doRefresh(true);
      this.#assertRevision(expectedRevision);
      const uniqueIds = [...new Set(skillIds)];
      if (uniqueIds.length === 0 || uniqueIds.length > 100) throw new InventoryMutationError("启停目标数量必须在 1 到 100 之间");
      const snapshot = this.snapshot;
      const targets = this.#runtimeTargets(snapshot);
      for (const targetId of uniqueIds) {
        const target = targets.get(targetId);
        if (!target) {
          const logical = snapshot.skills.find((skill) => skill.skillId === targetId);
          if (logical?.runtimeDiscovered) throw new InventoryMutationError(`${logical.name} 有多个运行时实例，请展开后选择精确实例`);
          throw new InventoryMutationError(`未知或不可写的实例 ID: ${targetId}`);
        }
        if (target.instance.runtimeEnabled === null) throw new InventoryMutationError(`实例缺少可验证的 runtime 状态: ${target.instance.instanceId}`);
        if (this.#isSensitiveRuntimeTarget(target) && !confirmedSensitive) {
          throw new InventoryMutationError("系统或插件 skill 启停需要二次确认");
        }
      }

      const succeeded: string[] = [];
      const failed: BatchOperationResult["failed"] = [];
      const notExecuted: string[] = [];
      const audit: Array<{
        instanceId: string;
        status: "succeeded" | "failed" | "not-executed";
        beforeEnabled: boolean;
        requestedEnabled: boolean;
        occurredAt: string;
      }> = [];
      for (let index = 0; index < uniqueIds.length; index += 1) {
        const targetId = uniqueIds[index]!;
        const target = targets.get(targetId)!;
        const beforeEnabled = target.instance.runtimeEnabled!;
        try {
          const effective = await this.appServer.setSkillEnabled(target.instance.absolutePath, enabled);
          if (effective !== enabled) throw new InventoryMutationError("Codex 回读状态与请求不一致");
          succeeded.push(targetId);
          audit.push({ instanceId: target.instance.instanceId, status: "succeeded", beforeEnabled, requestedEnabled: enabled, occurredAt: this.#now().toISOString() });
        } catch (error) {
          failed.push({ skillId: targetId, message: error instanceof Error ? error.message : String(error) });
          audit.push({ instanceId: target.instance.instanceId, status: "failed", beforeEnabled, requestedEnabled: enabled, occurredAt: this.#now().toISOString() });
          for (const remainingId of uniqueIds.slice(index + 1)) {
            const remaining = targets.get(remainingId)!;
            notExecuted.push(remainingId);
            audit.push({
              instanceId: remaining.instance.instanceId,
              status: "not-executed",
              beforeEnabled: remaining.instance.runtimeEnabled!,
              requestedEnabled: enabled,
              occurredAt: this.#now().toISOString(),
            });
          }
          break;
        }
      }
      await this.store.recordRuntimeOperations(audit);
      await this.#doRefresh(true);
      return { succeeded, failed, notExecuted, revision: this.snapshot.revision };
    });
  }

  listUndoActions(): UndoAction[] {
    const runtimeTargets = this.#runtimeTargets(this.snapshot);
    return this.store.listUndoActions().map((action) => {
      if (action.kind !== "runtime-enabled") return action;
      const target = action.targetIds.length === 1 ? runtimeTargets.get(action.targetIds[0]!) : undefined;
      if (!target) {
        return { ...action, available: false, unavailableReason: "精确 runtime 实例已不在当前清单", sensitive: false };
      }
      return { ...action, sensitive: this.#isSensitiveRuntimeTarget(target) };
    });
  }

  async undoOperations(
    operationIds: string[],
    expectedRevision: string,
    confirmedSensitive = false,
  ): Promise<{
    succeeded: string[];
    failed: Array<{ operationId: string; message: string }>;
    notExecuted: string[];
    snapshot: InventorySnapshot;
  }> {
    return this.#enqueueRuntimeMutation(async () => {
      this.#assertRevision(expectedRevision);
      const uniqueIds = [...new Set(operationIds)];
      if (uniqueIds.length === 0 || uniqueIds.length > 100) {
        throw new InventoryMutationError("撤销目标数量必须在 1 到 100 之间");
      }
      let actions = new Map(this.listUndoActions().map((action) => [action.operationId, action]));
      const requested = uniqueIds.map((operationId) => {
        const action = actions.get(operationId);
        if (!action) throw new InventoryMutationError(`未知撤销记录: ${operationId}`);
        if (!action.available) throw new InventoryMutationError(action.unavailableReason ?? "撤销前置状态已变化");
        return action;
      });
      const hasRuntime = requested.some((action) => action.kind === "runtime-enabled");
      if (hasRuntime) {
        if (!this.managementMode) throw new InventoryMutationError("管理模式未开启；runtime 撤销已拒绝");
        if (!this.appServer?.isRunning) throw new InventoryMutationError("Codex app-server 不可用");
        await this.#doRefresh(true);
        this.#assertRevision(expectedRevision);
        actions = new Map(this.listUndoActions().map((action) => [action.operationId, action]));
        for (const requestedAction of requested) {
          const current = actions.get(requestedAction.operationId);
          if (!current?.available) throw new InventoryMutationError(current?.unavailableReason ?? "撤销前置状态已变化");
          if (current.kind === "runtime-enabled" && current.sensitive && !confirmedSensitive) {
            throw new InventoryMutationError("系统或插件 skill 的 runtime 撤销需要二次确认");
          }
        }
      }

      const succeeded: string[] = [];
      const failed: Array<{ operationId: string; message: string }> = [];
      const notExecuted: string[] = [];
      let runtimeChanged = false;
      for (let index = 0; index < requested.length; index += 1) {
        const action = requested[index]!;
        try {
          if (action.kind === "classification") {
            await this.store.undoClassification(action.operationId);
          } else {
            const state = this.store.getRuntimeUndoState(action.operationId);
            if (!state || state.instanceId !== action.targetIds[0]) throw new InventoryMutationError("runtime 撤销记录已损坏");
            const target = this.#runtimeTargets(this.snapshot).get(state.instanceId);
            if (!target || target.instance.runtimeEnabled !== state.afterEnabled) {
              throw new InventoryMutationError("runtime 撤销前置状态已变化");
            }
            const effective = await this.appServer!.setSkillEnabled(target.instance.absolutePath, state.beforeEnabled);
            if (effective !== state.beforeEnabled) throw new InventoryMutationError("Codex 回读状态与撤销目标不一致");
            await this.store.completeRuntimeUndo(action.operationId);
            runtimeChanged = true;
          }
          succeeded.push(action.operationId);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          failed.push({ operationId: action.operationId, message });
          notExecuted.push(...requested.slice(index + 1).map((item) => item.operationId));
          const occurredAt = this.#now().toISOString();
          await this.store.recordOperation({
            operationId: randomUUID(),
            action: `${action.kind}-undo`,
            targetType: action.kind === "runtime-enabled" ? "instance" : "settings",
            targetId: action.kind === "runtime-enabled" ? action.targetIds[0]! : "workbench-batch",
            status: "failed",
            summary: { sourceOperationId: action.operationId },
            occurredAt,
          });
          for (const remaining of requested.slice(index + 1)) {
            await this.store.recordOperation({
              operationId: randomUUID(),
              action: `${remaining.kind}-undo`,
              targetType: remaining.kind === "runtime-enabled" ? "instance" : "settings",
              targetId: remaining.kind === "runtime-enabled" ? remaining.targetIds[0]! : "workbench-batch",
              status: "not-executed",
              summary: { sourceOperationId: remaining.operationId },
              occurredAt,
            });
          }
          break;
        }
      }
      const snapshot = runtimeChanged ? await this.#doRefresh(true) : await this.#rebuildSnapshot();
      return { succeeded, failed, notExecuted, snapshot };
    });
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#invalidationTimer) clearTimeout(this.#invalidationTimer);
    this.#invalidationTimer = null;
    this.#pendingRootRefreshes.clear();
    this.#pendingRuntimeRefresh = false;
    await this.#sessionProjectMutationQueue.catch(() => undefined);
    for (const watcher of this.#watchers) watcher.close();
    this.#watchers = [];
    await this.appServer?.stop();
    await this.#refreshQueue?.catch(() => undefined);
    if (this.store) await this.store.close();
  }

  async #doRefresh(forceRuntime: boolean): Promise<InventorySnapshot> {
    await this.#scanAllRoots();
    await this.#refreshRuntime(forceRuntime);
    return this.#rebuildSnapshot();
  }

  #synchronizeRootScanCache(): void {
    const live = new Map(this.roots.map((root) => [rootCacheKey(root), rootSignature(root)]));
    for (const [key, cached] of this.#rootScanCache) {
      if (live.get(key) !== cached.signature) this.#rootScanCache.delete(key);
    }
    for (const key of this.#watcherErrors.keys()) {
      if (!live.has(key)) this.#watcherErrors.delete(key);
    }
    for (const key of this.#backgroundRefreshErrors.keys()) {
      if (!live.has(key)) this.#backgroundRefreshErrors.delete(key);
    }
  }

  #applyRootScanCache(): void {
    const results = this.roots.flatMap((root) => {
      const cached = this.#rootScanCache.get(rootCacheKey(root));
      return cached && cached.signature === rootSignature(root) ? [cached.result] : [];
    });
    const merged = mergeScanResults(results);
    this.#observed = merged.skills;
    this.#scanErrors = merged.errors;
  }

  async #scanAllRoots(): Promise<void> {
    this.#synchronizeRootScanCache();
    const completed: Array<{ root: RootDefinition; result: ScanResult }> = [];
    // Keep the scanner's fixed metadata-worker bound global to this service;
    // parallel root scans would multiply that I/O concurrency per root.
    for (const root of this.roots) {
      completed.push({ root, result: await this.#scanRoots([root]) });
    }
    for (const { root, result } of completed) {
      const key = rootCacheKey(root);
      this.#rootScanCache.set(key, { signature: rootSignature(root), result });
      this.#backgroundRefreshErrors.delete(key);
    }
    this.#applyRootScanCache();
  }

  async #scanChangedRoots(requestedKeys: ReadonlySet<string>): Promise<void> {
    this.#synchronizeRootScanCache();
    const targets = this.roots.filter((root) => {
      const key = rootCacheKey(root);
      const cached = this.#rootScanCache.get(key);
      return requestedKeys.has(key) || !cached || cached.signature !== rootSignature(root);
    });
    for (const root of targets) {
      const key = rootCacheKey(root);
      try {
        const result = await this.#scanRoots([root]);
        this.#rootScanCache.set(key, { signature: rootSignature(root), result });
        this.#backgroundRefreshErrors.delete(key);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.#backgroundRefreshErrors.set(key, {
          path: root.path,
          message: `后台增量扫描失败：${message}`,
        });
      }
    }
    this.#applyRootScanCache();
  }

  async #refreshRuntime(forceRuntime: boolean): Promise<void> {
    if (this.appServer?.isRunning) {
      try {
        const runtimeCwds = [...new Set([
          this.#baseCwd,
          this.#selectedProjectPath,
          ...this.#allSessionProjectPaths(),
        ].filter((value): value is string => Boolean(value)))];
        this.#runtimeEntries = await this.appServer.listSkills(runtimeCwds, forceRuntime);
        this.#runtimeError = null;
      } catch (error) {
        this.#runtimeEntries = [];
        this.#runtimeError = error instanceof Error ? error.message : String(error);
      }
    }
  }

  async #rebuildSnapshot(): Promise<InventorySnapshot> {
    const automaticByLogical = new Map<string, ReturnType<typeof classifySkill>>();
    const instanceRecords = this.#observed.map((skill): SkillRecord => {
      const automatic = classifySkill(skill);
      automaticByLogical.set(skill.skillId, automatic);
      return {
        ...skill,
        automaticClassification: automatic,
        categoryId: automatic.categoryId,
        tags: automatic.tags,
        favorite: false,
        locked: false,
        hasManualOverride: false,
        runtimeDiscovered: false,
        runtimeEnabled: null,
        runtimeScope: null,
      };
    });
    const recordsByPath = new Map(instanceRecords.map((record) => [normalizeWindowsComparable(record.absolutePath), record]));
    for (const runtime of this.#runtimeEntries.flatMap((entry) => entry.skills)) {
      const key = normalizeWindowsComparable(runtime.path);
      let record = recordsByPath.get(key);
      if (!record) {
        const observed = runtimeOnlyObserved(runtime);
        const automatic = classifySkill(observed);
        automaticByLogical.set(observed.skillId, automatic);
        record = {
          ...observed,
          automaticClassification: automatic,
          categoryId: automatic.categoryId,
          tags: automatic.tags,
          favorite: false,
          locked: false,
          hasManualOverride: false,
          runtimeDiscovered: false,
          runtimeEnabled: null,
          runtimeScope: null,
        };
        instanceRecords.push(record);
        recordsByPath.set(key, record);
      }
      record.runtimeDiscovered = true;
      record.runtimeEnabled = runtime.enabled;
      record.runtimeScope = runtime.scope;
      record.pluginId = runtime.pluginId ?? record.pluginId;
    }
    for (const record of instanceRecords) {
      if (!record.runtimeDiscovered) record.diagnostics.push({ code: "CACHE_ONLY", message: "物理存在，但当前 Codex 运行时未列出" });
    }

    const logicalGroups = new Map<string, SkillRecord[]>();
    for (const record of instanceRecords) {
      const group = logicalGroups.get(record.skillId) ?? [];
      group.push(record);
      logicalGroups.set(record.skillId, group);
    }
    const now = this.#now().toISOString();
    const logicalSkills: LogicalSkill[] = [];
    const instances: SkillInstance[] = [];
    for (const [logicalSkillId, group] of logicalGroups) {
      const representative = group[0]!;
      const automatic = automaticByLogical.get(logicalSkillId) ?? classifySkill(representative);
      logicalSkills.push({
        logicalSkillId,
        sourceType: sourceType(representative),
        normalizedSource: representative.sourceId.normalize("NFC").toLocaleLowerCase("en-US"),
        packageId: representative.packageId.normalize("NFC"),
        pluginId: representative.pluginId,
        relativeSkillPath: representative.relativePath,
        name: representative.name,
        description: representative.description,
        existingCategory: representative.existingCategory ?? null,
        automaticCategoryId: automatic.categoryId && isCategoryId(automatic.categoryId) ? automatic.categoryId : null,
        automaticTaxonomyVersion: DEFAULT_TAXONOMY_PACK.version,
        lastSeenAt: now,
      });
      for (const item of group) {
        instances.push({
          instanceId: item.instanceId ?? hashIdentity("instance", item.skillId, normalizeWindowsComparable(item.absolutePath)),
          logicalSkillId,
          rootId: item.rootId,
          absolutePath: item.absolutePath,
          physicalFingerprint: item.physicalId,
          version: item.version ?? null,
          pluginCacheVersion: item.pluginVersion,
          runtimeScope: item.runtimeScope,
          runtimeEnabled: item.runtimeEnabled,
          readonly: item.readonly,
          lastSeenAt: now,
        });
      }
    }
    await this.store.syncInventory(logicalSkills, instances);
    const userStates = this.store.listUserStates();
    const states = new Map(userStates.map((state) => [state.logicalSkillId, state]));

    const records: SkillRecord[] = [];
    for (const group of logicalGroups.values()) {
      group.sort((left, right) => {
        if (left.runtimeDiscovered !== right.runtimeDiscovered) return left.runtimeDiscovered ? -1 : 1;
        return (right.pluginVersion ?? "").localeCompare(left.pluginVersion ?? "", "en-US", { numeric: true });
      });
      const representative = group[0]!;
      const state = states.get(representative.skillId)!;
      const automatic = automaticByLogical.get(representative.skillId) ?? representative.automaticClassification;
      const instanceViews: SkillInstanceView[] = group.map((item) => ({
        instanceId: item.instanceId ?? hashIdentity("instance", item.skillId, normalizeWindowsComparable(item.absolutePath)),
        logicalSkillId: item.skillId,
        absolutePath: item.absolutePath,
        rootId: item.rootId,
        rootLabel: item.rootLabel,
        breadcrumb: item.breadcrumb,
        aliases: item.aliases,
        pluginVersion: item.pluginVersion,
        version: item.version,
        installedCommit: item.installedCommit,
        readonly: item.readonly,
        managementGranted: this.roots.find((root) => root.id === item.rootId)?.managementGranted === true,
        runtimeDiscovered: item.runtimeDiscovered,
        runtimeEnabled: item.runtimeEnabled,
        runtimeScope: item.runtimeScope,
        diagnostics: item.diagnostics,
      }));
      records.push({
        ...representative,
        automaticClassification: automatic,
        categoryId: state.primaryCategoryId,
        tags: [...new Set([...automatic.tags, ...state.tags])].sort(),
        favorite: state.favorite,
        locked: state.locked,
        hasManualOverride: state.classificationMode === "manual" || state.tags.length > 0 || state.favorite || state.locked,
        aliases: [...new Set(group.flatMap((item) => item.aliases))],
        diagnostics: group.flatMap((item) => item.diagnostics),
        instances: instanceViews,
        runtimeDiscovered: group.some((item) => item.runtimeDiscovered),
        runtimeEnabled: representative.runtimeEnabled,
        runtimeScope: representative.runtimeScope,
      });
    }
    records.sort((a, b) => Number(b.favorite) - Number(a.favorite)
      || a.name.localeCompare(b.name, "zh-CN")
      || a.breadcrumb.localeCompare(b.breadcrumb, "zh-CN"));
    const currentIds = new Set(records.map((record) => record.skillId));
    const orphanOverrideIds = userStates.filter((state) => !currentIds.has(state.logicalSkillId) && (
      state.automaticClassificationFrozen
      || state.classificationMode === "manual"
      || state.tags.length > 0
      || state.favorite
      || state.locked
    )).map((state) => state.logicalSkillId);
    const revision = hashIdentity(
      `protocol:${PROTOCOL_VERSION}`,
      `management:${this.store.getManagementMode()}`,
      ...userStates.map((state) => JSON.stringify({
        logicalSkillId: state.logicalSkillId,
        classificationMode: state.classificationMode,
        primaryCategoryId: state.primaryCategoryId,
        tags: state.tags,
        favorite: state.favorite,
        locked: state.locked,
        automaticClassificationFrozen: state.automaticClassificationFrozen,
      })).sort(),
      ...this.store.listInstallationUnits().map((unit) => JSON.stringify({
        id: unit.installationUnitId,
        path: normalizeWindowsComparable(unit.absolutePath),
        confirmed: unit.confirmed,
        authorized: unit.managementAuthorized,
        links: unit.containsLink,
        git: unit.insideGitWorktree,
        size: unit.sizeBytes,
      })).sort(),
      ...records.flatMap((record) => (record.instances ?? []).map(
        (instance) => `${instance.instanceId}:${instance.runtimeEnabled ?? "cache"}`,
      )).sort(),
    );
    this.#snapshot = {
      revision,
      generatedAt: now,
      skills: records,
      summary: createSummary(records),
      scanErrors: this.#visibleScanErrors(),
      orphanOverrideIds,
      runtimeAvailable: Boolean(this.appServer?.isRunning && this.#runtimeError === null),
      runtimeError: this.#runtimeError,
      managementMode: this.store.getManagementMode(),
      protocolVersion: PROTOCOL_VERSION,
      customCategories: this.store.listCustomCategories().map((category) => ({
        categoryId: category.categoryId,
        label: category.label,
        sortOrder: category.sortOrder,
        hidden: category.hidden,
      })),
      categoryPreferences: this.store.listCategoryPreferences().map((preference) => ({
        categoryId: preference.categoryId,
        display: preference.display,
        sortOrder: preference.sortOrder,
        hidden: preference.hidden,
      })),
      configuredRoots: this.store.listConfiguredRoots().map((root) => ({
        rootId: root.rootId,
        label: root.label,
        absolutePath: root.absolutePath,
        readonly: root.readonly,
        managementAuthorized: root.managementAuthorized,
      })),
      selectedProjectPath: this.store.getSelectedProjectPath(),
      savedViews: this.store.listSavedViews().map((view) => ({ viewId: view.viewId, name: view.name, filters: view.filters })),
    };
    return this.snapshot;
  }

  #startWatchers(): void {
    for (const root of this.roots) {
      const key = rootCacheKey(root);
      this.#watcherErrors.delete(key);
      if (!existsSync(root.path) || path.resolve(root.path).startsWith("\\\\")) continue;
      try {
        const watcher = this.#watchRoot(root.path, (_event, fileName) => {
          if (!isScanMetadataChange(fileName)) return;
          this.#scheduleRootRefresh(key, 350);
        });
        watcher.on("error", (error) => {
          this.#watcherErrors.set(key, {
            path: root.path,
            message: `文件监听失败：${error.message}`,
          });
          this.#publishVisibleScanErrors();
        });
        this.#watchers.push(watcher);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.#watcherErrors.set(key, {
          path: root.path,
          message: `无法创建文件监听；仍可手工重扫：${message}`,
        });
      }
    }
    this.#publishVisibleScanErrors();
  }

  #restartWatchers(): void {
    for (const watcher of this.#watchers) watcher.close();
    this.#watchers = [];
    this.#startWatchers();
    this.quarantineService = new QuarantineService({
      database: this.store,
      dataDirectory: path.dirname(this.statePath),
      roots: this.roots,
      now: this.#now,
      pathLocationProbe: this.#pathLocationProbe,
    });
  }

  #loadPersistedRoots(): void {
    const retained = this.roots.filter((root) => root.kind !== "custom" && root.kind !== "repo");
    const selectedProjectCandidates: RootDefinition[] = this.#selectedProjectPath ? [
      { id: "repo-codex", label: "当前项目 Codex Skills", path: path.join(this.#selectedProjectPath, ".codex", "skills"), kind: "repo" },
      { id: "repo-agents", label: "当前项目 Agents Skills", path: path.join(this.#selectedProjectPath, ".agents", "skills"), kind: "repo" },
    ] : [];
    const sessionProjectCandidates: RootDefinition[] = this.#allSessionProjectPaths().flatMap((projectPath) => {
      const suffix = hashIdentity("session-project", normalizeWindowsComparable(projectPath)).slice(0, 12);
      const label = path.basename(projectPath) || projectPath;
      return [
        { id: `session-${suffix}-codex`, label: `${label} · Codex`, path: path.join(projectPath, ".codex", "skills"), kind: "repo" },
        { id: `session-${suffix}-agents`, label: `${label} · Agents`, path: path.join(projectPath, ".agents", "skills"), kind: "repo" },
      ];
    });
    const seenProjectPaths = new Set<string>();
    const projectRoots = [...selectedProjectCandidates, ...sessionProjectCandidates]
      .filter((root) => existsSync(root.path))
      .filter((root) => {
        const key = normalizeWindowsComparable(root.path);
        if (seenProjectPaths.has(key)) return false;
        seenProjectPaths.add(key);
        return true;
      });
    const customRoots: RootDefinition[] = this.store.listConfiguredRoots().map((root) => ({
      id: root.rootId,
      label: root.label,
      path: root.absolutePath,
      kind: "custom",
      readonly: root.readonly,
      managementGranted: root.managementAuthorized,
    }));
    this.roots.splice(0, this.roots.length, ...retained, ...projectRoots, ...customRoots);
    this.#synchronizeRootScanCache();
  }

  #allSessionProjectPaths(): string[] {
    const projects = new Map<string, string>();
    for (const registration of this.#sessionProjectPaths.values()) {
      for (const [key, projectPath] of registration.paths) projects.set(key, projectPath);
    }
    return [...projects.values()];
  }

  async #validateLocalDirectory(candidate: string, label: string): Promise<string> {
    if (!path.isAbsolute(candidate)) {
      throw new InventoryMutationError(`${label}必须是本机绝对路径，网络共享首版不支持`);
    }
    const resolved = path.resolve(candidate);
    let location: Awaited<ReturnType<PathLocationProbe>>;
    try {
      location = await this.#pathLocationProbe(resolved);
    } catch {
      location = "unknown";
    }
    if (location === "network") {
      throw new InventoryMutationError(`${label}位于网络共享或映射网络盘，首版不支持`);
    }
    if (location !== "local") {
      throw new InventoryMutationError(`${label}无法确认位于本机磁盘，拒绝授权管理`);
    }
    let info;
    try {
      info = await lstat(resolved);
    } catch {
      throw new InventoryMutationError(`${label}不存在或不可读取`);
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new InventoryMutationError(`${label}必须是无链接的普通目录`);
    const physical = await realpath(resolved);
    if (normalizeWindowsComparable(physical) !== normalizeWindowsComparable(resolved)) {
      throw new InventoryMutationError(`${label}不能通过 symlink 或 junction 指向其他位置`);
    }
    return physical;
  }

  #liveQuarantineInventory(): LiveQuarantineInventory {
    const skills = this.snapshot.skills.flatMap((skill) => (skill.instances ?? []).map((instance) => ({
      logicalSkillId: skill.skillId,
      instanceId: instance.instanceId,
      absolutePath: instance.absolutePath,
      rootId: instance.rootId,
      scope: skill.scope,
      readonly: instance.readonly,
      pluginId: skill.pluginId,
    })));
    return {
      revision: this.snapshot.revision,
      units: this.store.listInstallationUnits(),
      skills,
    };
  }

  #visibleScanErrors(): Array<{ path: string; message: string }> {
    return [
      ...this.#scanErrors,
      ...this.#watcherErrors.values(),
      ...this.#backgroundRefreshErrors.values(),
      ...this.#runtimeEntries.flatMap((entry) => entry.errors),
    ].sort((left, right) => left.path.localeCompare(right.path, "en-US") || left.message.localeCompare(right.message, "zh-CN"));
  }

  #publishVisibleScanErrors(): void {
    if (!this.#snapshot) return;
    this.#snapshot = { ...this.#snapshot, scanErrors: this.#visibleScanErrors() };
  }

  #scheduleRootRefresh(rootKey: string, delay: number): void {
    this.#pendingRootRefreshes.add(rootKey);
    this.#armScheduledRefresh(delay);
  }

  #scheduleRuntimeRefresh(delay: number): void {
    this.#pendingRuntimeRefresh = true;
    this.#armScheduledRefresh(delay);
  }

  #armScheduledRefresh(delay: number): void {
    if (this.#closed) return;
    if (this.#invalidationTimer) clearTimeout(this.#invalidationTimer);
    this.#invalidationTimer = setTimeout(() => {
      this.#invalidationTimer = null;
      if (this.#closed) return;
      const rootKeys = new Set(this.#pendingRootRefreshes);
      const refreshRuntime = this.#pendingRuntimeRefresh;
      this.#pendingRootRefreshes.clear();
      this.#pendingRuntimeRefresh = false;
      void this.#enqueueRefresh(async () => {
        if (rootKeys.size > 0) await this.#scanChangedRoots(rootKeys);
        if (refreshRuntime) await this.#refreshRuntime(true);
        return this.#rebuildSnapshot();
      }).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        const affected = rootKeys.size > 0
          ? this.roots.filter((root) => rootKeys.has(rootCacheKey(root)))
          : [];
        if (affected.length > 0) {
          for (const root of affected) {
            this.#backgroundRefreshErrors.set(rootCacheKey(root), {
              path: root.path,
              message: `后台刷新失败：${message}`,
            });
          }
        } else {
          this.#backgroundRefreshErrors.set("inventory", {
            path: this.statePath,
            message: `后台刷新失败：${message}`,
          });
        }
        this.#publishVisibleScanErrors();
        console.error(`Skill Organizer 后台刷新失败：${message}`);
      });
    }, delay);
  }

  #enqueueRefresh(operation: () => Promise<InventorySnapshot>): Promise<InventorySnapshot> {
    const previous = this.#refreshQueue;
    const run = previous
      ? previous.then(() => operation(), () => operation())
      : operation();
    let tracked: Promise<InventorySnapshot>;
    tracked = run.finally(() => {
      if (this.#refreshQueue === tracked) this.#refreshQueue = null;
    });
    this.#refreshQueue = tracked;
    return tracked;
  }

  #runtimeTargets(snapshot: InventorySnapshot): Map<string, { skill: SkillRecord; instance: SkillInstanceView }> {
    const targets = new Map<string, { skill: SkillRecord; instance: SkillInstanceView }>();
    for (const skill of snapshot.skills) {
      const runtimeInstances = (skill.instances ?? []).filter((instance) => instance.runtimeDiscovered);
      for (const instance of runtimeInstances) targets.set(instance.instanceId, { skill, instance });
      if (runtimeInstances.length === 1) targets.set(skill.skillId, { skill, instance: runtimeInstances[0]! });
    }
    return targets;
  }

  #isSensitiveRuntimeTarget(target: { skill: SkillRecord; instance: SkillInstanceView }): boolean {
    return target.skill.scope === "system"
      || target.skill.scope === "plugin"
      || target.instance.runtimeScope === "system"
      || target.instance.runtimeScope === "admin";
  }

  #enqueueRuntimeMutation<T>(operation: () => Promise<T>): Promise<T> {
    const queued = this.#runtimeMutationQueue.then(operation, operation);
    this.#runtimeMutationQueue = queued.then(() => undefined, () => undefined);
    return queued;
  }

  #enqueueSessionProjectMutation<T>(operation: () => Promise<T>): Promise<T> {
    const queued = this.#sessionProjectMutationQueue.then(operation, operation);
    this.#sessionProjectMutationQueue = queued.then(() => undefined, () => undefined);
    return queued;
  }

  #assertRevision(expectedRevision: string): void {
    if (!this.#snapshot || expectedRevision !== this.#snapshot.revision) {
      throw new StaleInventoryError("清单已变化，请刷新后重试");
    }
  }
}
