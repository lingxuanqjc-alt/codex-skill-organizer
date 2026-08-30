import { createHash, randomUUID } from "node:crypto";
import { createReadStream, type Dirent, type Stats } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  realpath,
  rename,
  rm,
  utimes,
} from "node:fs/promises";
import path from "node:path";
import type { ObservedSkill, RootDefinition, SkillScope } from "../shared/types.js";
import {
  type InstallationUnit,
  type QuarantineEntry,
  OrganizerDatabase,
} from "../v2/index.js";
import {
  hashIdentity,
  inspectUnlinkedDirectoryChain,
  isPathWithin,
  normalizeWindowsComparable,
  safeRelative,
  UnsafeDirectoryIdentityError,
} from "./path-identity.js";
import { defaultPathLocationProbe, type PathLocation, type PathLocationProbe } from "./windows-path-probe.js";

const DEFAULT_SIZE_LIMIT_BYTES = 1024 * 1024 * 1024;
const MAX_TREE_ENTRIES = 25_000;

export class QuarantineSafetyError extends Error {}
export class QuarantinePlanError extends Error {}

export interface QuarantineSkillReference {
  logicalSkillId: string;
  instanceId: string;
  absolutePath: string;
  rootId: string;
  scope: SkillScope;
  readonly: boolean;
  pluginId: string | null;
}

export interface LiveQuarantineInventory {
  revision: string;
  units: InstallationUnit[];
  skills: QuarantineSkillReference[];
}

export interface QuarantineTreeEntry {
  relativePath: string;
  type: "directory" | "file" | "link" | "other";
  sizeBytes: number;
}

export type QuarantineBlockerCode =
  | "UNIT_NOT_PERSISTED"
  | "UNIT_MISMATCH"
  | "UNIT_NOT_CONFIRMED"
  | "MANAGEMENT_NOT_AUTHORIZED"
  | "PROTECTED_SCOPE"
  | "UNKNOWN_BOUNDARY"
  | "ROOT_NOT_ALLOWED"
  | "OUTSIDE_ROOT"
  | "NETWORK_PATH"
  | "GIT_WORKTREE"
  | "SIZE_LIMIT"
  | "LINK_PRESENT"
  | "INVENTORY_INCOMPLETE"
  | "SOURCE_UNAVAILABLE";

export interface QuarantineBlocker {
  code: QuarantineBlockerCode;
  message: string;
}

export interface QuarantinePlanItem {
  installationUnitId: string;
  quarantineEntryId: string;
  sourcePath: string;
  quarantinePath: string;
  affectedSkillIds: string[];
  affectedInstanceIds: string[];
  tree: QuarantineTreeEntry[];
  totalEntries: number;
  sizeBytes: number;
  fingerprint: string;
  blockers: QuarantineBlocker[];
}

export interface QuarantinePlan {
  planId: string;
  inventoryRevision: string;
  createdAt: string;
  executable: boolean;
  items: QuarantinePlanItem[];
}

export interface InstallationUnitCandidate extends InstallationUnit {
  affectedSkillIds: string[];
  affectedInstanceIds: string[];
  blockers: QuarantineBlocker[];
}

export interface QuarantineBatchResult {
  succeeded: string[];
  failed: Array<{ installationUnitId: string; message: string }>;
  notExecuted: string[];
  entries: QuarantineEntry[];
}

export interface QuarantineFileAdapter {
  lstat(filePath: string): Promise<Stats>;
  readdir(directoryPath: string): Promise<Dirent[]>;
  realpath(filePath: string): Promise<string>;
  mkdir(directoryPath: string, options: { recursive: true }): Promise<unknown>;
  rename(sourcePath: string, destinationPath: string): Promise<void>;
  copyFile(sourcePath: string, destinationPath: string): Promise<void>;
  rm(targetPath: string, options: { recursive: true; force: boolean }): Promise<void>;
  chmod(targetPath: string, mode: number): Promise<void>;
  utimes(targetPath: string, atime: Date, mtime: Date): Promise<void>;
  hashFile(filePath: string): Promise<string>;
}

export interface QuarantineServiceOptions {
  database: OrganizerDatabase;
  dataDirectory: string;
  roots: RootDefinition[];
  now?: () => Date;
  fileAdapter?: Partial<QuarantineFileAdapter>;
  sizeLimitBytes?: number;
  pathLocationProbe?: PathLocationProbe;
}

interface TreeInspection {
  tree: QuarantineTreeEntry[];
  allSkillFiles: string[];
  sizeBytes: number;
  totalEntries: number;
  containsLink: boolean;
  containsGitMetadata: boolean;
  tooManyEntries: boolean;
  fingerprint: string;
}

interface PhysicalDirectoryIdentity {
  path: string;
  physicalPath: string;
  device: string;
  inode: string;
}

interface PhysicalPathGuard {
  rootPath: string;
  targetPath: string;
  directories: PhysicalDirectoryIdentity[];
  fingerprint: string;
}

interface StoredPlanItem extends QuarantinePlanItem {
  sourceGuard: PhysicalPathGuard | null;
  restoreParentGuard: PhysicalPathGuard | null;
}

interface StoredPlan extends Omit<QuarantinePlan, "items"> {
  items: StoredPlanItem[];
  inventory: LiveQuarantineInventory;
}

async function hashFileContents(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export function createNodeQuarantineFileAdapter(): QuarantineFileAdapter {
  return {
    lstat,
    readdir: (directoryPath) => readdir(directoryPath, { withFileTypes: true }),
    realpath,
    mkdir,
    rename,
    copyFile,
    rm,
    chmod,
    utimes,
    hashFile: hashFileContents,
  };
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function sourceTypeFor(root: RootDefinition, scope: SkillScope): InstallationUnit["sourceType"] {
  if (scope === "plugin" || root.kind === "plugin-cache") return "codex-plugin";
  if (scope === "repo" || root.kind === "repo") return "repo";
  if (scope === "agents" || root.kind === "agents") return "agents";
  if (scope === "custom" || root.kind === "custom") return "custom-root";
  return "codex-home";
}

function sameUnit(left: InstallationUnit, right: InstallationUnit): boolean {
  return left.installationUnitId === right.installationUnitId
    && left.kind === right.kind
    && left.rootId === right.rootId
    && normalizeWindowsComparable(left.absolutePath) === normalizeWindowsComparable(right.absolutePath)
    && left.sourceType === right.sourceType
    && left.sourceReference === right.sourceReference
    && left.confirmed === right.confirmed
    && left.managementAuthorized === right.managementAuthorized
    && left.containsLink === right.containsLink
    && left.insideGitWorktree === right.insideGitWorktree
    && left.updatedAt === right.updatedAt;
}

function blocker(code: QuarantineBlockerCode, message: string): QuarantineBlocker {
  return { code, message };
}

export class QuarantineService {
  readonly database: OrganizerDatabase;
  readonly dataDirectory: string;
  readonly quarantineDirectory: string;
  readonly roots: RootDefinition[];
  readonly sizeLimitBytes: number;

  readonly #now: () => Date;
  readonly #files: QuarantineFileAdapter;
  readonly #pathLocationProbe: PathLocationProbe;
  readonly #plans = new Map<string, StoredPlan>();

  constructor(options: QuarantineServiceOptions) {
    this.database = options.database;
    this.dataDirectory = path.resolve(options.dataDirectory);
    this.quarantineDirectory = path.join(this.dataDirectory, "quarantine");
    this.roots = [...options.roots];
    this.#now = options.now ?? (() => new Date());
    this.#files = { ...createNodeQuarantineFileAdapter(), ...options.fileAdapter };
    this.#pathLocationProbe = options.pathLocationProbe ?? defaultPathLocationProbe;
    this.sizeLimitBytes = options.sizeLimitBytes ?? DEFAULT_SIZE_LIMIT_BYTES;
    if (!Number.isSafeInteger(this.sizeLimitBytes) || this.sizeLimitBytes < 1) {
      throw new QuarantineSafetyError("sizeLimitBytes 必须是正整数");
    }
  }

  async discoverCandidates(observedRecords: ObservedSkill[]): Promise<InstallationUnitCandidate[]> {
    const groups = new Map<string, ObservedSkill[]>();
    for (const skill of observedRecords) {
      const root = this.roots.find((candidate) => candidate.id === skill.rootId);
      if (!root) continue;
      const relative = safeRelative(root.path, skill.absolutePath);
      if (relative === null) continue;
      const firstSegment = relative.split("/")[0];
      const candidatePath = firstSegment ? path.join(root.path, firstSegment) : root.path;
      const key = `${root.id}\0${normalizeWindowsComparable(candidatePath)}`;
      const group = groups.get(key) ?? [];
      group.push(skill);
      groups.set(key, group);
    }

    const candidates: InstallationUnitCandidate[] = [];
    for (const group of groups.values()) {
      const first = group[0]!;
      const root = this.roots.find((candidate) => candidate.id === first.rootId)!;
      const relative = safeRelative(root.path, first.absolutePath)!;
      const firstSegment = relative.split("/")[0]!;
      const candidatePath = path.resolve(root.path, firstSegment);
      let inspection: TreeInspection | null = null;
      const blockers: QuarantineBlocker[] = [];
      const pathLocation = await this.#safePathLocation(candidatePath);
      if (pathLocation !== "local") {
        blockers.push(blocker(
          "NETWORK_PATH",
          pathLocation === "network" ? "0.2.0 不支持网络共享或映射网络盘隔离" : "无法确认安装单元位于本机磁盘，拒绝隔离",
        ));
      } else {
        try {
          const rootInfo = await this.#files.lstat(candidatePath);
          if (rootInfo.isSymbolicLink()) {
            blockers.push(blocker("LINK_PRESENT", "安装单元目录本身是 symlink 或 junction"));
          } else {
            inspection = await this.#inspectTree(candidatePath);
          }
        } catch (error) {
          blockers.push(blocker("SOURCE_UNAVAILABLE", error instanceof Error ? error.message : String(error)));
        }
      }
      const protectedScope = group.some((skill) => skill.scope === "system" || skill.scope === "plugin" || skill.scope === "repo");
      if (protectedScope) blockers.push(blocker("PROTECTED_SCOPE", "system、plugin 和 repo skill 不能由 Organizer 隔离"));
      if (inspection?.containsLink) blockers.push(blocker("LINK_PRESENT", "安装单元包含 symlink 或 junction"));
      const insideGit = inspection?.containsGitMetadata === true
        || (pathLocation === "local" && await this.#isInsideGitWorktree(candidatePath));
      if (insideGit) blockers.push(blocker("GIT_WORKTREE", "安装单元位于 Git 工作树中"));
      if ((inspection?.sizeBytes ?? 0) >= this.sizeLimitBytes) blockers.push(blocker("SIZE_LIMIT", "安装单元达到隔离大小上限"));
      const nested = group.length > 1 || group.some((skill) => safeRelative(candidatePath, skill.absolutePath)?.split("/").length !== 1);
      const kind: InstallationUnit["kind"] = first.scope === "plugin" ? "plugin" : nested ? "bundle" : "skill";
      candidates.push({
        installationUnitId: hashIdentity("installation-unit", root.id, normalizeWindowsComparable(candidatePath)),
        kind,
        rootId: root.id,
        absolutePath: candidatePath,
        sourceType: sourceTypeFor(root, first.scope),
        sourceReference: first.sourceId,
        confirmed: false,
        managementAuthorized: pathLocation === "local"
          && (root.kind === "custom" ? root.managementGranted === true : root.readonly !== true),
        containsLink: inspection?.containsLink ?? false,
        insideGitWorktree: insideGit,
        sizeBytes: inspection?.sizeBytes ?? null,
        updatedAt: this.#now().toISOString(),
        affectedSkillIds: [...new Set(group.map((skill) => skill.skillId))].sort(),
        affectedInstanceIds: [...new Set(group.map((skill) => skill.instanceId ?? skill.physicalId))].sort(),
        blockers,
      });
    }
    return candidates.sort((left, right) => left.absolutePath.localeCompare(right.absolutePath, "en-US"));
  }

  async prepare(unitIds: string[], inventory: LiveQuarantineInventory): Promise<QuarantinePlan> {
    const uniqueIds = [...new Set(unitIds)];
    if (uniqueIds.length === 0 || uniqueIds.length > 100) {
      throw new QuarantinePlanError("隔离计划必须包含 1 到 100 个精确 installationUnitId");
    }
    if (!inventory.revision.trim()) throw new QuarantinePlanError("live inventory revision 不能为空");
    const liveUnits = new Map(inventory.units.map((unit) => [unit.installationUnitId, unit]));
    const planId = randomUUID();
    const items: StoredPlanItem[] = [];
    for (const unitId of uniqueIds) {
      const liveUnit = liveUnits.get(unitId);
      if (!liveUnit) throw new QuarantinePlanError(`live inventory 中不存在 installationUnitId: ${unitId}`);
      items.push(await this.#prepareItem(liveUnit, inventory));
    }
    for (let leftIndex = 0; leftIndex < items.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < items.length; rightIndex += 1) {
        const left = items[leftIndex]!;
        const right = items[rightIndex]!;
        if (isPathWithin(left.sourcePath, right.sourcePath) || isPathWithin(right.sourcePath, left.sourcePath)) {
          left.blockers.push(blocker("UNKNOWN_BOUNDARY", `与安装单元 ${right.installationUnitId} 的边界重叠`));
          right.blockers.push(blocker("UNKNOWN_BOUNDARY", `与安装单元 ${left.installationUnitId} 的边界重叠`));
        }
      }
    }
    const plan: StoredPlan = {
      planId,
      inventoryRevision: inventory.revision,
      createdAt: this.#now().toISOString(),
      executable: items.every((item) => item.blockers.length === 0),
      items,
      inventory: structuredClone(inventory),
    };
    this.#plans.set(planId, plan);
    return this.#publicPlan(plan);
  }

  /** Mutation entrypoint. Only the desktop backend should expose this method. */
  async quarantine(
    planId: string,
    confirmed: boolean,
    currentInventoryRevision: string,
  ): Promise<QuarantineBatchResult> {
    if (!confirmed) throw new QuarantineSafetyError("隔离移动需要桌面工作台明确确认");
    if (!this.database.getManagementMode()) throw new QuarantineSafetyError("管理模式未开启");
    const plan = this.#plans.get(planId);
    if (!plan) throw new QuarantinePlanError("隔离计划不存在或服务已重启，请重新生成");
    if (currentInventoryRevision !== plan.inventoryRevision) {
      throw new QuarantinePlanError("live inventory revision 已变化，请重新生成隔离计划");
    }
    if (!plan.executable) throw new QuarantineSafetyError("隔离计划包含安全阻断项，不能执行");

    const result: QuarantineBatchResult = { succeeded: [], failed: [], notExecuted: [], entries: [] };
    const quarantineRootGuard = await this.#ensureQuarantineRoot();
    for (let index = 0; index < plan.items.length; index += 1) {
      const item = plan.items[index]!;
      try {
        const liveUnit = plan.inventory.units.find((unit) => unit.installationUnitId === item.installationUnitId)!;
        const refreshed = await this.#prepareItem(liveUnit, plan.inventory, item.quarantineEntryId);
        if (refreshed.blockers.length > 0
          || refreshed.fingerprint !== item.fingerprint
          || !item.sourceGuard
          || !refreshed.sourceGuard
          || item.sourceGuard.fingerprint !== refreshed.sourceGuard.fingerprint
          || !item.restoreParentGuard
          || !refreshed.restoreParentGuard
          || item.restoreParentGuard.fingerprint !== refreshed.restoreParentGuard.fingerprint) {
          throw new QuarantineSafetyError("安装单元自计划生成后发生变化，请重新检查");
        }
        if (await this.#exists(item.quarantinePath)) throw new QuarantineSafetyError("隔离目标已存在，拒绝覆盖");
        await this.#moveVerified(item.sourcePath, item.quarantinePath, [item.sourceGuard, quarantineRootGuard]);
        let entry: QuarantineEntry;
        try {
          const contentFingerprint = await this.#contentFingerprint(item.quarantinePath);
          entry = {
            quarantineEntryId: item.quarantineEntryId,
            installationUnitId: item.installationUnitId,
            originalPath: item.sourcePath,
            quarantinePath: item.quarantinePath,
            contentFingerprint,
            status: "quarantined",
            quarantinedAt: this.#now().toISOString(),
            restoredAt: null,
            restoredPath: null,
          };
          await this.database.saveQuarantineEntry(entry);
        } catch (error) {
          try {
            const quarantinedGuard = await this.#captureDirectoryGuard(this.quarantineDirectory, item.quarantinePath);
            await this.#moveVerified(
              item.quarantinePath,
              item.sourcePath,
              [quarantinedGuard, item.restoreParentGuard],
            );
          } catch {
            throw new QuarantineSafetyError(`隔离记录写入失败且自动回滚失败: ${error instanceof Error ? error.message : String(error)}`);
          }
          throw error;
        }
        result.succeeded.push(item.installationUnitId);
        result.entries.push(entry);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.failed.push({ installationUnitId: item.installationUnitId, message });
        result.notExecuted.push(...plan.items.slice(index + 1).map((entry) => entry.installationUnitId));
        await this.#recordFailure(item.installationUnitId, "quarantine-failed");
        for (const skipped of result.notExecuted) await this.#recordNotExecuted(skipped, "quarantine-not-executed");
        break;
      }
    }
    this.#plans.delete(planId);
    return result;
  }

  async restore(
    quarantineEntryId: string,
    confirmed: boolean,
    restoreTargetPath?: string,
  ): Promise<QuarantineEntry> {
    if (!confirmed) throw new QuarantineSafetyError("恢复需要明确确认");
    if (!this.database.getManagementMode()) throw new QuarantineSafetyError("管理模式未开启");
    try {
      return await this.#restore(quarantineEntryId, restoreTargetPath);
    } catch (error) {
      await this.#recordQuarantineFailure(quarantineEntryId, "quarantine-restore-failed");
      throw error;
    }
  }

  async #restore(quarantineEntryId: string, restoreTargetPath?: string): Promise<QuarantineEntry> {
    const entry = this.database.getQuarantineEntry(quarantineEntryId);
    if (!entry || entry.status !== "quarantined") throw new QuarantineSafetyError("隔离记录不存在或不可恢复");
    const unit = this.database.getInstallationUnit(entry.installationUnitId);
    if (!unit || !unit.confirmed || !unit.managementAuthorized) throw new QuarantineSafetyError("安装单元未确认或未授权");
    const root = this.#assertStoredPaths(unit, entry);
    if (root.readonly || root.kind === "plugin-cache" || root.kind === "repo"
      || (root.kind === "custom" && root.managementGranted !== true)) {
      throw new QuarantineSafetyError("安装单元根目录当前未获得管理授权");
    }
    const restorePath = restoreTargetPath === undefined ? entry.originalPath : path.resolve(restoreTargetPath);
    if (restoreTargetPath !== undefined) {
      if (!path.isAbsolute(restoreTargetPath)) throw new QuarantineSafetyError("替代恢复路径必须是本机绝对路径");
      if (normalizeWindowsComparable(restorePath) === normalizeWindowsComparable(entry.originalPath)) {
        throw new QuarantineSafetyError("替代恢复路径必须与原路径不同");
      }
      if (normalizeWindowsComparable(path.dirname(restorePath)) !== normalizeWindowsComparable(path.dirname(entry.originalPath))) {
        throw new QuarantineSafetyError("替代恢复路径必须与原路径位于同一父目录");
      }
    }
    if (!isPathWithin(restorePath, root.path)
      || normalizeWindowsComparable(restorePath) === normalizeWindowsComparable(root.path)) {
      throw new QuarantineSafetyError("恢复目标不在原授权根目录内部");
    }
    const restoreLocation = await this.#safePathLocation(restorePath);
    if (restoreLocation !== "local") {
      throw new QuarantineSafetyError(restoreLocation === "network" ? "拒绝恢复到网络共享或映射网络盘" : "无法确认恢复路径位于本机磁盘");
    }
    await this.#ensureQuarantineRoot();
    if (await this.#exists(restorePath)) {
      throw new QuarantineSafetyError("[RESTORE_PATH_CONFLICT] 恢复目标已存在，恢复已停止且不会覆盖");
    }
    if (!await this.#exists(entry.quarantinePath)) throw new QuarantineSafetyError("隔离内容不存在");
    if (await this.#isInsideGitWorktree(path.dirname(restorePath))) {
      throw new QuarantineSafetyError("原路径现在位于 Git 工作树中，拒绝恢复");
    }
    const inspection = await this.#inspectTree(entry.quarantinePath);
    if (inspection.containsLink) throw new QuarantineSafetyError("隔离内容包含链接，拒绝恢复");
    const currentContentFingerprint = await this.#contentFingerprint(entry.quarantinePath);
    if (currentContentFingerprint !== entry.contentFingerprint) {
      throw new QuarantineSafetyError("隔离内容与记录的 contentFingerprint 不一致，拒绝恢复");
    }
    const quarantineSourceGuard = await this.#captureDirectoryGuard(this.quarantineDirectory, entry.quarantinePath);
    const restoreParentGuard = await this.#captureDirectoryGuard(root.path, path.dirname(restorePath));
    await this.#moveVerified(
      entry.quarantinePath,
      restorePath,
      [quarantineSourceGuard, restoreParentGuard],
    );
    const restored: QuarantineEntry = {
      ...entry,
      status: "restored",
      restoredAt: this.#now().toISOString(),
      restoredPath: restorePath,
    };
    try {
      await this.database.saveQuarantineEntry(restored);
    } catch (error) {
      try {
        const restoredSourceGuard = await this.#captureDirectoryGuard(root.path, restorePath);
        const quarantineRootGuard = await this.#ensureQuarantineRoot();
        await this.#moveVerified(
          restorePath,
          entry.quarantinePath,
          [restoredSourceGuard, quarantineRootGuard],
        );
      } catch {
        throw new QuarantineSafetyError(`恢复记录写入失败且自动回滚失败: ${error instanceof Error ? error.message : String(error)}`);
      }
      throw error;
    }
    return restored;
  }

  async purge(quarantineEntryId: string, confirmed: boolean): Promise<QuarantineEntry> {
    if (!confirmed) throw new QuarantineSafetyError("永久清空需要明确确认");
    if (!this.database.getManagementMode()) throw new QuarantineSafetyError("管理模式未开启");
    try {
      return await this.#purge(quarantineEntryId);
    } catch (error) {
      await this.#recordQuarantineFailure(quarantineEntryId, "quarantine-purge-failed");
      throw error;
    }
  }

  async #purge(quarantineEntryId: string): Promise<QuarantineEntry> {
    const entry = this.database.getQuarantineEntry(quarantineEntryId);
    if (!entry || entry.status !== "quarantined") throw new QuarantineSafetyError("仅可永久清空仍在隔离区的记录");
    const unit = this.database.getInstallationUnit(entry.installationUnitId);
    if (!unit) throw new QuarantineSafetyError("安装单元记录缺失");
    this.#assertStoredPaths(unit, entry);
    await this.#ensureQuarantineRoot();
    if (await this.#exists(entry.quarantinePath)) {
      const info = await this.#files.lstat(entry.quarantinePath);
      if (info.isSymbolicLink()) throw new QuarantineSafetyError("隔离路径被替换为链接，拒绝删除");
      const physical = await this.#files.realpath(entry.quarantinePath);
      const quarantineRoot = await this.#files.realpath(this.quarantineDirectory);
      if (!isPathWithin(physical, quarantineRoot)) throw new QuarantineSafetyError("隔离路径越界，拒绝删除");
      await this.#files.rm(entry.quarantinePath, { recursive: true, force: false });
    }
    const purged: QuarantineEntry = { ...entry, status: "purged" };
    await this.database.saveQuarantineEntry(purged);
    return purged;
  }

  async #prepareItem(
    liveUnit: InstallationUnit,
    inventory: LiveQuarantineInventory,
    quarantineEntryId: string = randomUUID(),
  ): Promise<StoredPlanItem> {
    const blockers: QuarantineBlocker[] = [];
    const persisted = this.database.getInstallationUnit(liveUnit.installationUnitId);
    if (!persisted) blockers.push(blocker("UNIT_NOT_PERSISTED", "安装单元尚未写入本地确认清单"));
    else if (!sameUnit(persisted, liveUnit)) blockers.push(blocker("UNIT_MISMATCH", "安装单元与本地确认记录不一致"));
    if (!liveUnit.confirmed) blockers.push(blocker("UNIT_NOT_CONFIRMED", "安装单元边界尚未由用户确认"));
    if (!liveUnit.managementAuthorized) blockers.push(blocker("MANAGEMENT_NOT_AUTHORIZED", "安装单元未获得管理授权"));
    if (liveUnit.kind === "unknown-directory") blockers.push(blocker("UNKNOWN_BOUNDARY", "未知目录边界不能隔离"));
    if (liveUnit.kind === "plugin" || liveUnit.sourceType === "codex-plugin" || liveUnit.sourceType === "repo") {
      blockers.push(blocker("PROTECTED_SCOPE", "plugin 和 repo skill 必须交由其原生管理器处理"));
    }
    const root = this.roots.find((candidate) => candidate.id === liveUnit.rootId);
    if (!root || root.readonly || root.kind === "plugin-cache" || root.kind === "repo") {
      blockers.push(blocker("ROOT_NOT_ALLOWED", "安装单元根目录不可由 Organizer 管理"));
    }
    if (root?.kind === "custom" && root.managementGranted !== true) {
      blockers.push(blocker("MANAGEMENT_NOT_AUTHORIZED", "自定义根目录尚未获得管理授权"));
    }
    const pathLocations = await Promise.all(
      [...new Set([liveUnit.absolutePath, root?.path].filter((candidate): candidate is string => Boolean(candidate)))]
        .map((candidate) => this.#safePathLocation(candidate)),
    );
    const hasNetworkPath = pathLocations.includes("network");
    const hasUnknownPath = pathLocations.includes("unknown");
    if (hasNetworkPath || hasUnknownPath) {
      blockers.push(blocker(
        "NETWORK_PATH",
        hasNetworkPath ? "0.2.0 不支持网络共享或映射网络盘隔离" : "无法确认安装单元位于本机磁盘，拒绝隔离",
      ));
    }
    if (root && (
      !isPathWithin(liveUnit.absolutePath, root.path)
      || normalizeWindowsComparable(liveUnit.absolutePath) === normalizeWindowsComparable(root.path)
    )) {
      blockers.push(blocker("OUTSIDE_ROOT", "安装单元必须位于允许根目录内部且不能等于整个根目录"));
    }
    if (isPathWithin(this.dataDirectory, liveUnit.absolutePath) || isPathWithin(liveUnit.absolutePath, this.dataDirectory)) {
      blockers.push(blocker("ROOT_NOT_ALLOWED", "安装单元与 Organizer 数据目录重叠"));
    }

    const affected = inventory.skills.filter((skill) => isPathWithin(skill.absolutePath, liveUnit.absolutePath));
    if (affected.length === 0) blockers.push(blocker("INVENTORY_INCOMPLETE", "安装单元没有 live Skill 实例"));
    if (affected.some((skill) => skill.rootId !== liveUnit.rootId)) {
      blockers.push(blocker("OUTSIDE_ROOT", "安装单元跨越了多个 root"));
    }
    if (affected.some((skill) => skill.scope === "system" || skill.scope === "plugin" || skill.scope === "repo" || skill.readonly)) {
      blockers.push(blocker("PROTECTED_SCOPE", "安装单元包含 system、plugin、repo 或只读 Skill"));
    }

    let inspection: TreeInspection = {
      tree: [], allSkillFiles: [], sizeBytes: 0, totalEntries: 0,
      containsLink: false, containsGitMetadata: false, tooManyEntries: false,
      fingerprint: "unavailable",
    };
    let sourceGuard: PhysicalPathGuard | null = null;
    let restoreParentGuard: PhysicalPathGuard | null = null;
    try {
      if (hasNetworkPath || hasUnknownPath) throw new QuarantineSafetyError("路径位置未通过本机磁盘验证");
      if (root) {
        sourceGuard = await this.#captureDirectoryGuard(root.path, liveUnit.absolutePath);
        restoreParentGuard = await this.#captureDirectoryGuard(root.path, path.dirname(liveUnit.absolutePath));
      }
      const unitInfo = await this.#files.lstat(liveUnit.absolutePath);
      if (!unitInfo.isDirectory() || unitInfo.isSymbolicLink()) {
        blockers.push(blocker("UNKNOWN_BOUNDARY", "安装单元必须是普通目录"));
      } else {
        inspection = await this.#inspectTree(liveUnit.absolutePath);
      }
    } catch (error) {
      blockers.push(blocker("SOURCE_UNAVAILABLE", error instanceof Error ? error.message : String(error)));
    }
    if (inspection.containsLink || liveUnit.containsLink) blockers.push(blocker("LINK_PRESENT", "安装单元包含 symlink 或 junction"));
    if (inspection.containsGitMetadata || liveUnit.insideGitWorktree || await this.#isInsideGitWorktree(liveUnit.absolutePath)) {
      blockers.push(blocker("GIT_WORKTREE", "安装单元位于 Git 工作树中"));
    }
    if (inspection.sizeBytes >= this.sizeLimitBytes) blockers.push(blocker("SIZE_LIMIT", "安装单元达到或超过隔离大小上限"));
    if (inspection.tooManyEntries) blockers.push(blocker("UNKNOWN_BOUNDARY", "安装单元目录项过多，边界无法安全确认"));

    const affectedPaths = new Set(affected.map((skill) => normalizeWindowsComparable(skill.absolutePath)));
    const physicalSkillPaths = new Set(inspection.allSkillFiles.map(normalizeWindowsComparable));
    if (
      inspection.allSkillFiles.some((skillFile) => !affectedPaths.has(normalizeWindowsComparable(skillFile)))
      || affected.some((skill) => !physicalSkillPaths.has(normalizeWindowsComparable(skill.absolutePath)))
    ) {
      blockers.push(blocker("INVENTORY_INCOMPLETE", "目录中的 SKILL.md 与 live inventory 不一致"));
    }
    const uniqueBlockers = [...new Map(blockers.map((item) => [item.code, item])).values()];
    return {
      installationUnitId: liveUnit.installationUnitId,
      quarantineEntryId,
      sourcePath: path.resolve(liveUnit.absolutePath),
      quarantinePath: path.join(this.quarantineDirectory, quarantineEntryId),
      affectedSkillIds: [...new Set(affected.map((skill) => skill.logicalSkillId))].sort(),
      affectedInstanceIds: [...new Set(affected.map((skill) => skill.instanceId))].sort(),
      tree: inspection.tree,
      totalEntries: inspection.totalEntries,
      sizeBytes: inspection.sizeBytes,
      fingerprint: inspection.fingerprint,
      blockers: uniqueBlockers,
      sourceGuard,
      restoreParentGuard,
    };
  }

  async #inspectTree(rootPath: string): Promise<TreeInspection> {
    const tree: QuarantineTreeEntry[] = [];
    const allSkillFiles: string[] = [];
    let sizeBytes = 0;
    let totalEntries = 0;
    let containsLink = false;
    let containsGitMetadata = false;
    let tooManyEntries = false;
    const fingerprint = createHash("sha256");

    const visit = async (directoryPath: string): Promise<void> => {
      const entries = await this.#files.readdir(directoryPath);
      entries.sort((left, right) => left.name.localeCompare(right.name, "en-US"));
      for (const entry of entries) {
        totalEntries += 1;
        if (totalEntries > MAX_TREE_ENTRIES) {
          tooManyEntries = true;
          return;
        }
        const entryPath = path.join(directoryPath, entry.name);
        const relativePath = safeRelative(rootPath, entryPath);
        if (relativePath === null) throw new QuarantineSafetyError("目录遍历越过安装单元边界");
        const info = await this.#files.lstat(entryPath);
        if (info.isSymbolicLink()) {
          containsLink = true;
          tree.push({ relativePath, type: "link", sizeBytes: 0 });
          fingerprint.update(`link\0${relativePath}\0`);
          continue;
        }
        if (entry.name.toLocaleLowerCase("en-US") === ".git") containsGitMetadata = true;
        if (info.isDirectory()) {
          tree.push({ relativePath, type: "directory", sizeBytes: 0 });
          fingerprint.update(`directory\0${relativePath}\0${info.mtimeMs}\0`);
          await visit(entryPath);
          if (tooManyEntries) return;
        } else if (info.isFile()) {
          sizeBytes += info.size;
          tree.push({ relativePath, type: "file", sizeBytes: info.size });
          fingerprint.update(`file\0${relativePath}\0${info.size}\0${info.mtimeMs}\0`);
          if (entry.name.toLocaleLowerCase("en-US") === "skill.md") allSkillFiles.push(entryPath);
        } else {
          containsLink = true;
          tree.push({ relativePath, type: "other", sizeBytes: 0 });
          fingerprint.update(`special\0${relativePath}\0`);
        }
      }
    };
    await visit(rootPath);
    return {
      tree,
      allSkillFiles,
      sizeBytes,
      totalEntries,
      containsLink,
      containsGitMetadata,
      tooManyEntries,
      fingerprint: fingerprint.digest("hex"),
    };
  }

  async #contentFingerprint(rootPath: string): Promise<string> {
    const rootInfo = await this.#files.lstat(rootPath);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
      throw new QuarantineSafetyError("contentFingerprint 只能校验无链接普通目录");
    }
    const fingerprint = createHash("sha256");
    let totalEntries = 0;
    let sizeBytes = 0;
    const visit = async (directoryPath: string): Promise<void> => {
      const entries = await this.#files.readdir(directoryPath);
      entries.sort((left, right) => left.name.localeCompare(right.name, "en-US"));
      for (const entry of entries) {
        totalEntries += 1;
        if (totalEntries > MAX_TREE_ENTRIES) {
          throw new QuarantineSafetyError("隔离内容目录项超过校验上限");
        }
        const entryPath = path.join(directoryPath, entry.name);
        const relativePath = safeRelative(rootPath, entryPath);
        if (relativePath === null) throw new QuarantineSafetyError("contentFingerprint 遍历越过隔离边界");
        const info = await this.#files.lstat(entryPath);
        if (info.isSymbolicLink()) throw new QuarantineSafetyError("隔离内容包含链接，无法校验 contentFingerprint");
        if (info.isDirectory()) {
          fingerprint.update(`directory\0${relativePath}\0`);
          await visit(entryPath);
        } else if (info.isFile()) {
          sizeBytes += info.size;
          if (sizeBytes >= this.sizeLimitBytes) {
            throw new QuarantineSafetyError("隔离内容达到 contentFingerprint 校验大小上限");
          }
          const contentHash = await this.#files.hashFile(entryPath);
          fingerprint.update(`file\0${relativePath}\0${info.size}\0${contentHash}\0`);
        } else {
          throw new QuarantineSafetyError("隔离内容包含不支持的文件类型");
        }
      }
    };
    await visit(rootPath);
    return fingerprint.digest("hex");
  }

  async #captureDirectoryGuard(rootPath: string, targetPath: string): Promise<PhysicalPathGuard> {
    const resolvedRoot = path.resolve(rootPath);
    const resolvedTarget = path.resolve(targetPath);
    const relativeTarget = safeRelative(resolvedRoot, resolvedTarget);
    if (relativeTarget === null) throw new QuarantineSafetyError("物理身份校验目标越过授权根目录");

    const paths = [resolvedRoot];
    let current = resolvedRoot;
    for (const segment of relativeTarget.split("/").filter(Boolean)) {
      current = path.join(current, segment);
      paths.push(current);
    }

    const directories: PhysicalDirectoryIdentity[] = [];
    let inspectedChain;
    try {
      inspectedChain = await inspectUnlinkedDirectoryChain(resolvedTarget, this.#files);
    } catch (error) {
      if (error instanceof UnsafeDirectoryIdentityError) {
        throw new QuarantineSafetyError(`授权 root/parent 存在不安全路径组件：${error.message}`);
      }
      throw error;
    }
    const inspectedByPath = new Map(
      inspectedChain.map((item) => [normalizeWindowsComparable(item.declaredPath), item]),
    );
    let physicalRoot: string | null = null;
    for (const directoryPath of paths) {
      const inspected = inspectedByPath.get(normalizeWindowsComparable(directoryPath));
      if (!inspected) throw new QuarantineSafetyError("无法取得授权 root/parent 的物理身份");
      const physicalPath = inspected.physicalPath;
      physicalRoot ??= physicalPath;
      if (!isPathWithin(physicalPath, physicalRoot)) {
        throw new QuarantineSafetyError("授权 root/parent 的物理路径越界");
      }
      directories.push({
        path: directoryPath,
        physicalPath,
        device: inspected.device,
        inode: inspected.inode,
      });
    }

    const fingerprint = createHash("sha256");
    for (const directory of directories) {
      fingerprint.update(normalizeWindowsComparable(directory.path));
      fingerprint.update("\0");
      fingerprint.update(normalizeWindowsComparable(directory.physicalPath));
      fingerprint.update("\0");
      fingerprint.update(directory.device);
      fingerprint.update("\0");
      fingerprint.update(directory.inode);
      fingerprint.update("\0");
    }
    return {
      rootPath: resolvedRoot,
      targetPath: resolvedTarget,
      directories,
      fingerprint: fingerprint.digest("hex"),
    };
  }

  async #assertDirectoryGuard(guard: PhysicalPathGuard): Promise<void> {
    const current = await this.#captureDirectoryGuard(guard.rootPath, guard.targetPath);
    if (current.fingerprint !== guard.fingerprint) {
      throw new QuarantineSafetyError("授权 root/parent 的物理身份已变化，拒绝移动");
    }
  }

  async #isInsideGitWorktree(candidate: string): Promise<boolean> {
    let current = path.resolve(candidate);
    while (true) {
      try {
        await this.#files.lstat(path.join(current, ".git"));
        return true;
      } catch (error) {
        if (!isMissing(error)) return true;
      }
      const parent = path.dirname(current);
      if (parent === current) return false;
      current = parent;
    }
  }

  async #moveVerified(
    sourcePath: string,
    destinationPath: string,
    guards: readonly PhysicalPathGuard[] = [],
  ): Promise<void> {
    const sourceInfo = await this.#files.lstat(sourcePath);
    if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) {
      throw new QuarantineSafetyError("移动源必须是无链接普通目录");
    }
    await this.#files.mkdir(path.dirname(destinationPath), { recursive: true });
    for (const guard of guards) await this.#assertDirectoryGuard(guard);
    if (await this.#exists(destinationPath)) throw new QuarantineSafetyError("移动目标已存在，拒绝覆盖");
    try {
      await this.#files.rename(sourcePath, destinationPath);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    }

    const partialPath = `${destinationPath}.partial-${randomUUID()}`;
    const parkedSourcePath = `${sourcePath}.moving-${randomUUID()}`;
    const sourceGuard = guards.find(
      (guard) => normalizeWindowsComparable(guard.targetPath) === normalizeWindowsComparable(sourcePath),
    );
    const sourceParentGuard = sourceGuard
      ? await this.#captureDirectoryGuard(sourceGuard.rootPath, path.dirname(sourcePath))
      : null;
    const destinationGuards = guards.filter((guard) => guard !== sourceGuard);
    let sourceParked = false;
    let destinationCommitted = false;
    let verifiedContentFingerprint: string | null = null;
    try {
      for (const guard of guards) await this.#assertDirectoryGuard(guard);
      if (await this.#exists(destinationPath)) throw new QuarantineSafetyError("移动目标已存在，拒绝覆盖");
      if (await this.#exists(parkedSourcePath)) throw new QuarantineSafetyError("跨卷停放路径已存在，拒绝覆盖");

      // Freeze the source with a same-volume atomic rename before copying. This
      // closes the mutation window between inspecting a live directory and
      // recursively deleting it after the destination has been committed.
      await this.#files.rename(sourcePath, parkedSourcePath);
      sourceParked = true;
      if (await this.#exists(sourcePath)) throw new QuarantineSafetyError("跨卷停放后原路径仍存在，拒绝继续");
      if (sourceParentGuard) await this.#assertDirectoryGuard(sourceParentGuard);
      for (const guard of destinationGuards) await this.#assertDirectoryGuard(guard);

      const parkedInspection = await this.#inspectTree(parkedSourcePath);
      if (parkedInspection.containsLink) throw new QuarantineSafetyError("跨卷复制源包含链接");
      await this.#copyTreeVerified(parkedSourcePath, partialPath);
      const [parkedFingerprint, partialFingerprint] = await Promise.all([
        this.#contentFingerprint(parkedSourcePath),
        this.#contentFingerprint(partialPath),
      ]);
      if (parkedFingerprint !== partialFingerprint) {
        throw new QuarantineSafetyError("跨卷复制期间停放源发生变化，拒绝提交目标");
      }
      verifiedContentFingerprint = parkedFingerprint;

      if (sourceParentGuard) await this.#assertDirectoryGuard(sourceParentGuard);
      for (const guard of destinationGuards) await this.#assertDirectoryGuard(guard);
      if (await this.#exists(sourcePath)) throw new QuarantineSafetyError("跨卷移动期间原路径被重新创建，拒绝覆盖");
      if (await this.#exists(destinationPath)) throw new QuarantineSafetyError("移动目标已存在，拒绝覆盖");
      await this.#files.rename(partialPath, destinationPath);
      destinationCommitted = true;

      const [finalSourceFingerprint, finalDestinationFingerprint] = await Promise.all([
        this.#contentFingerprint(parkedSourcePath),
        this.#contentFingerprint(destinationPath),
      ]);
      if (finalSourceFingerprint !== finalDestinationFingerprint) {
        throw new QuarantineSafetyError("跨卷提交后源或目标发生变化，拒绝删除停放源");
      }
      if (sourceParentGuard) await this.#assertDirectoryGuard(sourceParentGuard);
      for (const guard of destinationGuards) await this.#assertDirectoryGuard(guard);
      if (await this.#exists(sourcePath)) throw new QuarantineSafetyError("跨卷移动期间原路径被重新创建，拒绝删除停放源");
      await this.#files.rm(parkedSourcePath, { recursive: true, force: false });
      sourceParked = false;
    } catch (error) {
      await this.#files.rm(partialPath, { recursive: true, force: true }).catch(() => undefined);
      const rollbackFailures: string[] = [];

      if (sourceParked) {
        try {
          if (await this.#exists(sourcePath)) {
            throw new QuarantineSafetyError("原路径已被重新创建，自动回滚拒绝覆盖");
          }

          if (destinationCommitted && await this.#exists(destinationPath)) {
            if (!verifiedContentFingerprint) {
              throw new QuarantineSafetyError("跨卷回滚缺少提交前内容证据，保留恢复副本");
            }

            const parkedFingerprint = await this.#contentFingerprint(parkedSourcePath).catch(() => null);
            const destinationFingerprint = await this.#contentFingerprint(destinationPath).catch(() => null);
            if (parkedFingerprint !== verifiedContentFingerprint) {
              if (destinationFingerprint !== verifiedContentFingerprint) {
                throw new QuarantineSafetyError("跨卷回滚无法证明任一副本仍为原始内容，保留恢复副本");
              }

              // The parked tree may have been partially removed. Rebuild it
              // only from a destination that still matches the pre-commit
              // fingerprint, never from a modified destination.
              const recoveryPath = `${sourcePath}.rollback-${randomUUID()}`;
              await this.#copyTreeVerified(destinationPath, recoveryPath);
              if (await this.#contentFingerprint(recoveryPath) !== verifiedContentFingerprint) {
                throw new QuarantineSafetyError("跨卷回滚副本校验失败，保留恢复副本");
              }
              if (await this.#exists(parkedSourcePath)) {
                await this.#files.rm(parkedSourcePath, { recursive: true, force: false });
              }
              await this.#files.rename(recoveryPath, parkedSourcePath);
            }

            await this.#files.rm(destinationPath, { recursive: true, force: false });
            destinationCommitted = false;
          }

          if (!await this.#exists(parkedSourcePath)) {
            throw new QuarantineSafetyError("跨卷回滚停放源缺失");
          }
          if (sourceParentGuard) await this.#assertDirectoryGuard(sourceParentGuard);
          await this.#files.rename(parkedSourcePath, sourcePath);
          sourceParked = false;
        } catch (rollbackError) {
          rollbackFailures.push(rollbackError instanceof Error ? rollbackError.message : String(rollbackError));
        }
      }

      if (destinationCommitted && rollbackFailures.length === 0) {
        await this.#files.rm(destinationPath, { recursive: true, force: false }).catch((rollbackError: unknown) => {
          rollbackFailures.push(rollbackError instanceof Error ? rollbackError.message : String(rollbackError));
        });
      }

      if (rollbackFailures.length > 0) {
        throw new QuarantineSafetyError(
          `跨卷移动失败且自动回滚不完整；已停止后续操作: ${rollbackFailures.join("; ")}`,
        );
      }
      throw error;
    }
  }

  async #copyTreeVerified(sourcePath: string, destinationPath: string): Promise<void> {
    const sourceInfo = await this.#files.lstat(sourcePath);
    if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) {
      throw new QuarantineSafetyError("跨卷复制源必须是无链接普通目录");
    }
    await this.#files.mkdir(destinationPath, { recursive: true });
    const entries = await this.#files.readdir(sourcePath);
    for (const entry of entries) {
      const sourceEntry = path.join(sourcePath, entry.name);
      const destinationEntry = path.join(destinationPath, entry.name);
      const info = await this.#files.lstat(sourceEntry);
      if (info.isSymbolicLink()) throw new QuarantineSafetyError("跨卷复制期间检测到链接");
      if (info.isDirectory()) {
        await this.#copyTreeVerified(sourceEntry, destinationEntry);
      } else if (info.isFile()) {
        await this.#files.copyFile(sourceEntry, destinationEntry);
        const [sourceHash, destinationHash] = await Promise.all([
          this.#files.hashFile(sourceEntry),
          this.#files.hashFile(destinationEntry),
        ]);
        if (sourceHash !== destinationHash) throw new QuarantineSafetyError(`跨卷复制校验失败: ${entry.name}`);
        await this.#files.chmod(destinationEntry, info.mode);
        await this.#files.utimes(destinationEntry, info.atime, info.mtime);
      } else {
        throw new QuarantineSafetyError("跨卷复制遇到不支持的文件类型");
      }
    }
    await this.#files.chmod(destinationPath, sourceInfo.mode);
    await this.#files.utimes(destinationPath, sourceInfo.atime, sourceInfo.mtime);
  }

  #assertStoredPaths(unit: InstallationUnit, entry: QuarantineEntry): RootDefinition {
    if (normalizeWindowsComparable(unit.absolutePath) !== normalizeWindowsComparable(entry.originalPath)) {
      throw new QuarantineSafetyError("隔离记录原路径与安装单元不一致");
    }
    if (!isPathWithin(entry.quarantinePath, this.quarantineDirectory)
      || normalizeWindowsComparable(entry.quarantinePath) === normalizeWindowsComparable(this.quarantineDirectory)) {
      throw new QuarantineSafetyError("隔离记录路径越界");
    }
    const root = this.roots.find((candidate) => candidate.id === unit.rootId);
    if (!root || !isPathWithin(entry.originalPath, root.path)) {
      throw new QuarantineSafetyError("隔离记录原路径不在允许根目录中");
    }
    if (entry.restoredPath !== null && !isPathWithin(entry.restoredPath, root.path)) {
      throw new QuarantineSafetyError("隔离记录恢复路径不在允许根目录中");
    }
    return root;
  }

  async #safePathLocation(candidate: string): Promise<PathLocation> {
    try {
      return await this.#pathLocationProbe(candidate);
    } catch {
      return "unknown";
    }
  }

  async #exists(candidate: string): Promise<boolean> {
    try {
      await this.#files.lstat(candidate);
      return true;
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  }

  async #recordFailure(targetId: string, action: string): Promise<void> {
    await this.database.recordOperation({
      operationId: randomUUID(), action, targetType: "installation-unit", targetId,
      status: "failed", summary: { reason: "filesystem-operation-failed" }, occurredAt: this.#now().toISOString(),
    });
  }

  async #recordNotExecuted(targetId: string, action: string): Promise<void> {
    await this.database.recordOperation({
      operationId: randomUUID(), action, targetType: "installation-unit", targetId,
      status: "not-executed", summary: { reason: "stopped-after-failure" }, occurredAt: this.#now().toISOString(),
    });
  }

  async #recordQuarantineFailure(targetId: string, action: string): Promise<void> {
    await this.database.recordOperation({
      operationId: randomUUID(), action, targetType: "quarantine", targetId,
      status: "failed", summary: { reason: "safety-check-or-filesystem-failure" }, occurredAt: this.#now().toISOString(),
    }).catch(() => undefined);
  }

  async #ensureQuarantineRoot(): Promise<PhysicalPathGuard> {
    await this.#files.mkdir(this.dataDirectory, { recursive: true });
    await this.#files.mkdir(this.quarantineDirectory, { recursive: true });
    const [dataInfo, quarantineInfo] = await Promise.all([
      this.#files.lstat(this.dataDirectory),
      this.#files.lstat(this.quarantineDirectory),
    ]);
    if (!dataInfo.isDirectory() || dataInfo.isSymbolicLink()
      || !quarantineInfo.isDirectory() || quarantineInfo.isSymbolicLink()) {
      throw new QuarantineSafetyError("Organizer 数据目录或隔离目录不是安全的普通目录");
    }
    const [physicalData, physicalQuarantine] = await Promise.all([
      this.#files.realpath(this.dataDirectory),
      this.#files.realpath(this.quarantineDirectory),
    ]);
    if (!isPathWithin(physicalQuarantine, physicalData)) {
      throw new QuarantineSafetyError("隔离目录物理路径越过 Organizer 数据目录");
    }
    return this.#captureDirectoryGuard(this.dataDirectory, this.quarantineDirectory);
  }

  #publicPlan(plan: StoredPlan): QuarantinePlan {
    const { inventory: _inventory, items, ...publicPlan } = plan;
    return structuredClone({
      ...publicPlan,
      items: items.map(({ sourceGuard: _sourceGuard, restoreParentGuard: _restoreParentGuard, ...item }) => item),
    });
  }
}
