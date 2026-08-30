import { constants } from "node:fs";
import { access, readFile, readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { resolveCodexCommand, resolveCodexHome } from "./codex-locations.js";

export type UpdateStatus = "up-to-date" | "update-available" | "modified" | "unavailable" | "offline";

export interface UpdateSubject {
  logicalSkillId: string;
  sourceId: string;
  installedTag?: string;
  installedCommit?: string;
  installedHash?: string;
  /** Compared only with like-for-like exact hash or commit evidence. */
  physicalFingerprint?: string;
  /** Only adjacent plugin manifests and lock files are inspected. */
  instancePath?: string;
  locallyModified: boolean;
  scope: "user" | "agents" | "system" | "plugin" | "repo" | "custom";
}

export interface UpdateCheckResult {
  logicalSkillId: string;
  status: UpdateStatus;
  checkedAt: string;
  evidenceKind: "release-tag" | "commit" | "codex-plugin" | "install-hash" | "none";
  installedEvidence?: string;
  availableEvidence?: string;
  locallyModified?: boolean;
  overwriteUpdateAllowed?: false;
  summary: string;
  compareUrl?: string;
}

export interface PluginUpdateProvider {
  check(subject: UpdateSubject): Promise<UpdateCheckResult>;
  refresh?(marketplaces: string[]): Promise<void>;
}

export interface UpdateServiceOptions {
  fetchImpl?: typeof fetch;
  now?: () => Date;
  pluginProvider?: PluginUpdateProvider;
  pluginCacheRoots?: string[];
  pluginMarketplaceFiles?: string[];
  gitRuntime?: GitStatusRuntime;
}

export interface UpdateCheckOptions {
  /** User-triggered checks default to true and never reuse the in-memory cache. */
  forceRefresh?: boolean;
}

interface GitHubRepository {
  default_branch?: unknown;
  private?: unknown;
  html_url?: unknown;
}

interface GitHubCommit { sha?: unknown }

interface GitHubComparison {
  status?: unknown;
  ahead_by?: unknown;
  behind_by?: unknown;
  html_url?: unknown;
}

interface GitHubRelease {
  tag_name?: unknown;
  html_url?: unknown;
  draft?: unknown;
  prerelease?: unknown;
}

interface PluginManifest {
  name?: unknown;
  version?: unknown;
  repository?: unknown;
}

interface PluginLockSkill {
  vendoredPath?: unknown;
  integrity?: unknown;
  source?: { ref?: unknown } | unknown;
}

interface PluginLock {
  lockVersion?: unknown;
  pluginVersion?: unknown;
  generatedBy?: unknown;
  skills?: unknown;
}

interface PluginLocation {
  marketplace: string;
  plugin: string;
  version: string;
  versionRoot: string;
  manifest: PluginManifest;
}

interface PluginIdentity { marketplace: string; plugin: string }
interface MarketplacePlugin { name?: unknown; version?: unknown; source?: unknown }
interface MarketplaceFile { name?: unknown; plugins?: unknown }

const MAX_METADATA_BYTES = 2 * 1024 * 1024;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,79}$/u;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/iu;
const SHA256_PATTERN = /^(?:sha256-)?([a-f0-9]{64})$/iu;
const GIT_VERSION_PATTERN = /^git version \d+(?:\.\d+){1,3}(?:\.[0-9A-Za-z.-]+)?$/mu;

function githubRepository(sourceId: string): { owner: string; repository: string } | null {
  const match = /^github:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/u.exec(sourceId);
  return match ? { owner: match[1]!, repository: match[2]! } : null;
}

function pluginIdentity(sourceId: string): PluginIdentity | null {
  const match = /^plugin:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/u.exec(sourceId);
  return match ? { marketplace: match[1]!, plugin: match[2]! } : null;
}

function cleanEvidence(value: string): string {
  return value.normalize("NFC").trim().slice(0, 160);
}

function cleanVersion(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const version = cleanEvidence(value);
  return VERSION_PATTERN.test(version) ? version : null;
}

function normalizeHash(value: string | undefined): string | null {
  if (!value) return null;
  const match = SHA256_PATTERN.exec(value.trim());
  return match ? `sha256-${match[1]!.toLocaleLowerCase("en-US")}` : null;
}

function normalizeCommit(value: string | undefined): string | null {
  if (!value || !COMMIT_PATTERN.test(value.trim())) return null;
  return value.trim().toLocaleLowerCase("en-US");
}

interface SemanticVersion {
  core: [number, number, number];
  prerelease: string[];
}

function parseSemanticVersion(value: string): SemanticVersion | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(value);
  if (!match) return null;
  const core = [Number(match[1]), Number(match[2]), Number(match[3])] as SemanticVersion["core"];
  if (core.some((part) => !Number.isSafeInteger(part))) return null;
  return { core, prerelease: match[4]?.split(".") ?? [] };
}

function compareSemanticVersions(left: SemanticVersion, right: SemanticVersion): number {
  for (let index = 0; index < 3; index += 1) {
    if (left.core[index] !== right.core[index]) return left.core[index]! - right.core[index]!;
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return left.prerelease.length === right.prerelease.length ? 0 : left.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart === undefined || rightPart === undefined) return leftPart === undefined ? -1 : 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/u.test(leftPart);
    const rightNumeric = /^\d+$/u.test(rightPart);
    if (leftNumeric && rightNumeric) return Number(leftPart) - Number(rightPart);
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart.localeCompare(rightPart, "en-US");
  }
  return 0;
}

function trustedGitHubUrl(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && parsed.hostname === "github.com"
      ? parsed.toString().replace(/\/$/u, "")
      : fallback;
  } catch {
    return fallback;
  }
}

function manifestRepository(manifest: PluginManifest): string | undefined {
  const candidate = typeof manifest.repository === "string"
    ? manifest.repository
    : manifest.repository && typeof manifest.repository === "object"
      ? (manifest.repository as { url?: unknown }).url
      : undefined;
  if (typeof candidate !== "string") return undefined;
  const normalized = candidate.replace(/^git\+/u, "").replace(/\.git$/u, "");
  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== "https:" || parsed.hostname !== "github.com") return undefined;
    return parsed.toString().replace(/\/$/u, "");
  } catch {
    return undefined;
  }
}

async function readBoundedJson<T>(filePath: string): Promise<T | null> {
  try {
    const contents = await readFile(filePath);
    if (contents.byteLength > MAX_METADATA_BYTES) return null;
    return JSON.parse(contents.toString("utf8")) as T;
  } catch {
    return null;
  }
}

async function readPluginManifest(versionRoot: string): Promise<PluginManifest | null> {
  for (const manifestPath of [
    path.join(versionRoot, ".codex-plugin", "plugin.json"),
    path.join(versionRoot, "plugin.json"),
  ]) {
    const manifest = await readBoundedJson<PluginManifest>(manifestPath);
    if (manifest) return manifest;
  }
  return null;
}

function unavailable(subject: UpdateSubject, checkedAt: string, summary: string): UpdateCheckResult {
  return {
    logicalSkillId: subject.logicalSkillId,
    status: "unavailable",
    checkedAt,
    evidenceKind: "none",
    overwriteUpdateAllowed: false,
    summary,
  };
}

function modifiedResult(
  subject: UpdateSubject,
  checkedAt: string,
  evidenceKind: UpdateCheckResult["evidenceKind"],
  installedEvidence?: string,
): UpdateCheckResult {
  return {
    logicalSkillId: subject.logicalSkillId,
    status: "modified",
    checkedAt,
    evidenceKind,
    installedEvidence,
    availableEvidence: installedEvidence,
    locallyModified: true,
    overwriteUpdateAllowed: false,
    summary: "当前实例物理指纹已偏离精确安装证据；0.2.0 明确禁止覆盖式更新",
  };
}

function detectModification(subject: UpdateSubject, checkedAt: string): UpdateCheckResult | null {
  if (subject.locallyModified) {
    const installedHash = normalizeHash(subject.installedHash);
    const installedCommit = normalizeCommit(subject.installedCommit);
    return modifiedResult(
      subject,
      checkedAt,
      installedHash ? "install-hash" : installedCommit ? "commit" : "none",
      installedHash ?? installedCommit ?? undefined,
    );
  }
  const expectedHash = normalizeHash(subject.installedHash);
  const physicalHash = normalizeHash(subject.physicalFingerprint);
  if (subject.installedHash && !expectedHash) {
    return unavailable(subject, checkedAt, "安装哈希格式无效，无法形成精确更新证据");
  }
  if (expectedHash && subject.physicalFingerprint && !physicalHash) {
    return unavailable(subject, checkedAt, "当前物理指纹不是可与安装哈希比较的 SHA-256");
  }
  if (expectedHash && physicalHash && expectedHash !== physicalHash) {
    return modifiedResult(subject, checkedAt, "install-hash", expectedHash);
  }
  const expectedCommit = normalizeCommit(subject.installedCommit);
  const physicalCommit = normalizeCommit(subject.physicalFingerprint);
  if (expectedCommit && physicalCommit && expectedCommit !== physicalCommit) {
    return modifiedResult(subject, checkedAt, "commit", expectedCommit);
  }
  return null;
}

export interface GitStatusRuntime {
  platform: NodeJS.Platform;
  homedir(): string;
  /** Test-only injection boundary; production leaves this undefined. */
  trustedCandidates?: readonly string[];
  access(filePath: string): Promise<void>;
  execFile(command: string, args: string[]): Promise<{ stdout: string; stderr: string }>;
}

const defaultGitStatusRuntime: GitStatusRuntime = {
  platform: process.platform,
  homedir: os.homedir,
  access: async (filePath) => access(filePath, constants.X_OK),
  execFile: async (command, args) => new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { encoding: "utf8", timeout: 5_000, windowsHide: true, maxBuffer: 128 * 1024 },
      (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }),
    );
  }),
};

function standardGitForWindowsCandidates(runtime: GitStatusRuntime): string[] {
  if (runtime.trustedCandidates) return runtime.trustedCandidates.map((candidate) => path.resolve(candidate));
  if (runtime.platform !== "win32") return [];
  const systemRoot = path.parse(path.resolve(runtime.homedir())).root;
  return [
    path.join(systemRoot, "Program Files", "Git", "cmd", "git.exe"),
    path.join(systemRoot, "Program Files", "Git", "bin", "git.exe"),
    path.join(systemRoot, "Program Files (x86)", "Git", "cmd", "git.exe"),
  ];
}

export async function resolveTrustedGitCommand(runtime: GitStatusRuntime = defaultGitStatusRuntime): Promise<string | null> {
  for (const candidate of standardGitForWindowsCandidates(runtime)) {
    if (!path.isAbsolute(candidate)) continue;
    try {
      await runtime.access(candidate);
      const result = await runtime.execFile(candidate, ["--version"]);
      if (GIT_VERSION_PATTERN.test(`${result.stdout}\n${result.stderr}`.trim())) return candidate;
    } catch {
      // Try the next protected standard installation location.
    }
  }
  return null;
}

export async function gitPathIsModified(
  instancePath: string,
  runtime: GitStatusRuntime = defaultGitStatusRuntime,
): Promise<boolean | null> {
  const command = await resolveTrustedGitCommand(runtime);
  if (!command) return null;
  try {
    const result = await runtime.execFile(command, [
      "-C",
      path.dirname(path.resolve(instancePath)),
      "status",
      "--porcelain=v1",
      "--untracked-files=normal",
      "--",
      ".",
    ]);
    return result.stdout.trim().length > 0;
  } catch {
    return null;
  }
}

export interface LocalCodexPluginUpdateProviderOptions {
  cacheRoots: string[];
  marketplaceFiles?: string[];
  now?: () => Date;
  catalogRuntime?: CodexPluginCatalogRuntime;
}

export interface CodexPluginCatalogRuntime {
  resolveCommand(): Promise<string>;
  execFile(command: string, args: string[]): Promise<{ stdout: string; stderr: string }>;
}

interface CodexPluginCatalogEntry {
  name?: unknown;
  marketplaceName?: unknown;
  version?: unknown;
}

interface CodexPluginCatalogPayload {
  available?: unknown;
}

const defaultCodexPluginCatalogRuntime: CodexPluginCatalogRuntime = {
  resolveCommand: () => resolveCodexCommand(),
  execFile: async (command, args) => new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { encoding: "utf8", timeout: 60_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }),
    );
  }),
};

const TRUSTED_CODEX_MARKETPLACES = new Map<string, string>([
  ["openai-curated-remote", "openai-curated"],
  ["openai-curated", "openai-curated"],
]);

function catalogMarketplaceName(name: string): string | null {
  return TRUSTED_CODEX_MARKETPLACES.get(name.toLocaleLowerCase("en-US")) ?? null;
}

export class LocalCodexPluginUpdateProvider implements PluginUpdateProvider {
  readonly #cacheRoots: string[];
  readonly #marketplaceFiles: string[];
  readonly #now: () => Date;
  readonly #catalogRuntime: CodexPluginCatalogRuntime;
  #catalogRequired = false;
  #requestedMarketplaces = new Set<string>();
  #failedMarketplaces = new Set<string>();
  #catalogVersions = new Map<string, string[]>();

  constructor(options: LocalCodexPluginUpdateProviderOptions) {
    this.#cacheRoots = options.cacheRoots.map((root) => path.resolve(root));
    this.#marketplaceFiles = (options.marketplaceFiles ?? []).map((filePath) => path.resolve(filePath));
    this.#now = options.now ?? (() => new Date());
    this.#catalogRuntime = options.catalogRuntime ?? defaultCodexPluginCatalogRuntime;
  }

  async refresh(marketplaces: string[]): Promise<void> {
    this.#catalogRequired = true;
    this.#requestedMarketplaces.clear();
    this.#failedMarketplaces.clear();
    this.#catalogVersions.clear();
    const requested = [...new Set(marketplaces.map((name) => name.toLocaleLowerCase("en-US")))];
    for (const marketplace of requested) {
      this.#requestedMarketplaces.add(marketplace);
      const catalogName = catalogMarketplaceName(marketplace);
      if (!catalogName) this.#failedMarketplaces.add(marketplace);
    }
    const trusted = requested
      .map((marketplace) => ({ marketplace, catalogName: catalogMarketplaceName(marketplace) }))
      .filter((item): item is { marketplace: string; catalogName: string } => item.catalogName !== null);
    if (trusted.length === 0) return;

    let command: string;
    try {
      command = await this.#catalogRuntime.resolveCommand();
    } catch {
      for (const item of trusted) this.#failedMarketplaces.add(item.marketplace);
      return;
    }
    for (const item of trusted) {
      try {
        await this.#catalogRuntime.execFile(command, ["plugin", "marketplace", "upgrade", item.catalogName, "--json"]);
        const listed = await this.#catalogRuntime.execFile(command, [
          "plugin", "list", "--marketplace", item.catalogName, "--available", "--json",
        ]);
        const payload = JSON.parse(listed.stdout) as CodexPluginCatalogPayload;
        if (!Array.isArray(payload.available)) throw new Error("Codex plugin catalog 缺少 available 清单");
        for (const raw of payload.available as CodexPluginCatalogEntry[]) {
          const marketplace = typeof raw.marketplaceName === "string" ? raw.marketplaceName : "";
          const plugin = typeof raw.name === "string" ? raw.name : "";
          const version = cleanVersion(raw.version);
          if (marketplace.toLocaleLowerCase("en-US") !== item.catalogName.toLocaleLowerCase("en-US") || !plugin || !version) continue;
          const key = `${item.catalogName.toLocaleLowerCase("en-US")}/${plugin.toLocaleLowerCase("en-US")}`;
          const versions = this.#catalogVersions.get(key) ?? [];
          versions.push(version);
          this.#catalogVersions.set(key, versions);
        }
      } catch {
        // Raw CLI errors may contain a username or an absolute path. Keep those out
        // of model-visible update evidence and fail closed with a stable message.
        this.#failedMarketplaces.add(item.marketplace);
      }
    }
  }

  async check(subject: UpdateSubject): Promise<UpdateCheckResult> {
    const checkedAt = this.#now().toISOString();
    const identity = pluginIdentity(subject.sourceId);
    if (!identity) return unavailable(subject, checkedAt, "插件来源 ID 无法映射到精确 marketplace/plugin");
    const earlyModification = detectModification(subject, checkedAt);
    if (earlyModification) return earlyModification;

    const locations = await this.#discoverCacheLocations(identity);
    const adjacent = subject.instancePath ? await this.#findAdjacentLocation(identity, subject.instancePath) : null;
    if (adjacent && !locations.some((item) => path.resolve(item.versionRoot) === path.resolve(adjacent.versionRoot))) {
      locations.push(adjacent);
    }
    const requestedVersion = cleanVersion(subject.installedTag);
    let installed = requestedVersion
      ? adjacent?.version === requestedVersion ? adjacent : locations.find((item) => item.version === requestedVersion)
      : adjacent;
    if (!installed && locations.length === 1 && !subject.installedTag) installed = locations[0]!;
    if (!installed) return unavailable(subject, checkedAt, "找不到与已安装版本一致的本机插件 manifest");
    if (String(installed.manifest.name).toLocaleLowerCase("en-US") !== identity.plugin.toLocaleLowerCase("en-US")) {
      return unavailable(subject, checkedAt, "插件 manifest 名称与来源 ID 不一致");
    }

    const lockEvidence = await this.#lockEvidence(installed, subject);
    if (lockEvidence.conflict) return unavailable(subject, checkedAt, lockEvidence.conflict);
    const installedHash = normalizeHash(subject.installedHash) ?? lockEvidence.integrity;
    const physicalHash = normalizeHash(subject.physicalFingerprint);
    if (installedHash && subject.physicalFingerprint && !physicalHash) {
      return unavailable(subject, checkedAt, "当前物理指纹不是可与安装哈希比较的 SHA-256");
    }
    if (installedHash && physicalHash && installedHash !== physicalHash) {
      return modifiedResult(subject, checkedAt, "install-hash", installedHash);
    }
    if (installedHash && !physicalHash) {
      return unavailable(subject, checkedAt, "存在精确安装哈希，但当前内容没有同算法物理哈希；无法安全判断本地修改");
    }

    const marketplaceKey = identity.marketplace.toLocaleLowerCase("en-US");
    const catalogMarketplace = catalogMarketplaceName(identity.marketplace);
    if (this.#catalogRequired && !this.#requestedMarketplaces.has(marketplaceKey)) {
      return unavailable(subject, checkedAt, "本次主动检查未包含该 Codex marketplace；未生成更新证据");
    }
    if (this.#catalogRequired && (!catalogMarketplace || this.#failedMarketplaces.has(marketplaceKey))) {
      return unavailable(subject, checkedAt, catalogMarketplace
        ? "Codex plugin catalog 主动刷新失败；未生成更新证据"
        : "该 Codex marketplace 未列入受信任更新来源；未发起网络访问");
    }
    const catalogKey = `${(catalogMarketplace ?? identity.marketplace).toLocaleLowerCase("en-US")}/${identity.plugin.toLocaleLowerCase("en-US")}`;
    const versions = this.#catalogRequired
      ? [...new Set(this.#catalogVersions.get(catalogKey) ?? [])]
      : [...new Set([
        ...locations.map((location) => location.version),
        ...await this.#marketplaceVersions(identity),
      ])];
    if (versions.length === 0) {
      return unavailable(subject, checkedAt, this.#catalogRequired
        ? "主动刷新的 Codex plugin catalog 没有返回该插件的精确可用版本"
        : "Codex 插件来源没有返回可验证的精确版本");
    }
    const installedSemantic = parseSemanticVersion(installed.version);
    if (!installedSemantic) {
      if (versions.every((version) => version === installed.version)) {
        return this.#pluginResult(subject, installed, installed.version, installedHash, physicalHash, false);
      }
      return unavailable(subject, checkedAt, "Codex 插件版本不是可排序的语义版本，拒绝猜测更新顺序");
    }
    const sortable = versions.map((version) => ({ version, semantic: parseSemanticVersion(version) }));
    if (sortable.some((item) => item.semantic === null)) {
      return unavailable(subject, checkedAt, "Codex 插件来源同时包含不可排序版本，拒绝猜测更新顺序");
    }
    sortable.sort((left, right) => compareSemanticVersions(right.semantic!, left.semantic!));
    const available = sortable[0]!;
    const order = compareSemanticVersions(available.semantic!, installedSemantic);
    if (order < 0) {
      return unavailable(subject, checkedAt, "Codex 插件来源的最高版本低于已安装版本，无法声明更新");
    }
    return this.#pluginResult(subject, installed, available.version, installedHash, physicalHash, order > 0);
  }

  #pluginResult(
    subject: UpdateSubject,
    installed: PluginLocation,
    available: string,
    installedHash: string | null,
    physicalHash: string | null,
    newer: boolean,
  ): UpdateCheckResult {
    const repository = manifestRepository(installed.manifest);
    const hashSummary = installedHash && physicalHash && installedHash === physicalHash
      ? "，当前物理指纹与安装哈希一致"
      : "；未提供可复现安装哈希，本地修改状态未知";
    const modificationVerified = Boolean(installedHash && physicalHash && installedHash === physicalHash);
    const sourceSummary = this.#catalogRequired
      ? "用户主动刷新的 Codex plugin catalog"
      : "本机 marketplace/cache metadata";
    return {
      logicalSkillId: subject.logicalSkillId,
      status: newer ? "update-available" : "up-to-date",
      checkedAt: this.#now().toISOString(),
      evidenceKind: "codex-plugin",
      installedEvidence: installed.version,
      availableEvidence: available,
      locallyModified: modificationVerified ? false : undefined,
      overwriteUpdateAllowed: false,
      summary: newer
        ? `${sourceSummary} 提供了更高的精确插件版本${hashSummary}；0.2.0 只检测，不执行更新`
        : `${sourceSummary} 中没有更高插件版本${hashSummary}`,
      compareUrl: repository,
    };
  }

  async #discoverCacheLocations(identity: PluginIdentity): Promise<PluginLocation[]> {
    const locations: PluginLocation[] = [];
    for (const cacheRoot of this.#cacheRoots) {
      const pluginRoot = path.join(cacheRoot, identity.marketplace, identity.plugin);
      let entries;
      try {
        entries = await readdir(pluginRoot, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const versionRoot = path.join(pluginRoot, entry.name);
        const manifest = await readPluginManifest(versionRoot);
        if (!manifest) continue;
        const version = cleanVersion(manifest.version);
        const name = typeof manifest.name === "string" ? manifest.name : "";
        if (!version || version !== entry.name || name.toLocaleLowerCase("en-US") !== identity.plugin.toLocaleLowerCase("en-US")) continue;
        locations.push({ ...identity, version, versionRoot, manifest });
      }
    }
    return locations;
  }

  async #findAdjacentLocation(identity: PluginIdentity, instancePath: string): Promise<PluginLocation | null> {
    let current = path.resolve(path.dirname(instancePath));
    for (let depth = 0; depth < 12; depth += 1) {
      const directManifest = await readBoundedJson<PluginManifest>(path.join(current, "plugin.json"));
      const nestedManifest = await readBoundedJson<PluginManifest>(path.join(current, ".codex-plugin", "plugin.json"));
      const manifest = directManifest ?? nestedManifest;
      if (manifest) {
        const version = cleanVersion(manifest.version);
        const name = typeof manifest.name === "string" ? manifest.name : "";
        if (version && name.toLocaleLowerCase("en-US") === identity.plugin.toLocaleLowerCase("en-US")) {
          const versionRoot = directManifest && path.basename(current).toLocaleLowerCase("en-US") === ".codex-plugin"
            ? path.dirname(current)
            : current;
          return { ...identity, version, versionRoot, manifest };
        }
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    return null;
  }

  async #lockEvidence(
    location: PluginLocation,
    subject: UpdateSubject,
  ): Promise<{ integrity: string | null; commit: string | null; conflict?: string }> {
    if (!subject.instancePath) return { integrity: null, commit: null };
    const lock = await readBoundedJson<PluginLock>(path.join(location.versionRoot, "plugin.lock.json"));
    if (!lock || !Array.isArray(lock.skills)) return { integrity: null, commit: null };
    const relativeInstance = path.relative(location.versionRoot, path.dirname(path.resolve(subject.instancePath))).replaceAll("\\", "/");
    const candidates = (lock.skills as PluginLockSkill[]).filter((skill) => {
      if (typeof skill.vendoredPath !== "string") return false;
      const vendored = skill.vendoredPath.replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/$/u, "");
      return relativeInstance === vendored || relativeInstance.startsWith(`${vendored}/`);
    });
    if (candidates.length !== 1) return { integrity: null, commit: null };
    const candidate = candidates[0]!;
    const source = candidate.source && typeof candidate.source === "object" ? candidate.source as { ref?: unknown } : null;
    const commit = typeof source?.ref === "string" ? normalizeCommit(source.ref) : null;
    if (typeof source?.ref === "string" && !commit) {
      return { integrity: null, commit, conflict: "plugin.lock.json source.ref 不是完整 commit" };
    }
    const subjectHash = normalizeHash(subject.installedHash);
    if (subject.installedHash && !subjectHash) return { integrity: null, commit, conflict: "installedHash 不是有效 SHA-256" };
    const subjectCommit = normalizeCommit(subject.installedCommit);
    if (subject.installedCommit && !subjectCommit) return { integrity: null, commit, conflict: "installedCommit 不是完整 40 位 commit" };
    if (subjectCommit && commit && subjectCommit !== commit) {
      return { integrity: null, commit, conflict: "调用方 commit 与 plugin.lock.json source.ref 冲突" };
    }
    if (subjectHash) return { integrity: subjectHash, commit };

    if (typeof candidate.integrity === "string") {
      const integrity = normalizeHash(candidate.integrity);
      if (!integrity) return { integrity: null, commit, conflict: "plugin.lock.json integrity 不是有效 SHA-256" };
      const lockVersion = Number(lock.lockVersion);
      const pluginVersion = cleanVersion(lock.pluginVersion);
      const generatedBy = typeof lock.generatedBy === "string" ? lock.generatedBy.trim() : "";
      if (lockVersion !== 1 || pluginVersion !== location.version) {
        return { integrity: null, commit, conflict: "plugin.lock.json 版本与当前插件 manifest 不一致，不能作为安装哈希" };
      }
      if (!generatedBy || /\bdraft\b/iu.test(generatedBy)) {
        return { integrity: null, commit, conflict: "plugin.lock.json 使用 draft 或未知生成器，不能作为可复现安装哈希" };
      }
      return {
        integrity: null,
        commit,
        conflict: "plugin.lock.json 未声明 Organizer 可复现的 integrity 算法，证据不足",
      };
    }
    return { integrity: null, commit };
  }

  async #marketplaceVersions(identity: PluginIdentity): Promise<string[]> {
    const versions: string[] = [];
    for (const marketplacePath of this.#marketplaceFiles) {
      const marketplace = await readBoundedJson<MarketplaceFile>(marketplacePath);
      if (
        !marketplace
        || typeof marketplace.name !== "string"
        || marketplace.name.toLocaleLowerCase("en-US") !== identity.marketplace.toLocaleLowerCase("en-US")
        || !Array.isArray(marketplace.plugins)
      ) continue;
      for (const raw of marketplace.plugins as MarketplacePlugin[]) {
        if (typeof raw.name !== "string" || raw.name.toLocaleLowerCase("en-US") !== identity.plugin.toLocaleLowerCase("en-US")) continue;
        const direct = cleanVersion(raw.version)
          ?? (raw.source && typeof raw.source === "object" ? cleanVersion((raw.source as { version?: unknown }).version) : null);
        if (direct) {
          versions.push(direct);
          continue;
        }
        if (raw.source && typeof raw.source === "object" && typeof (raw.source as { path?: unknown }).path === "string") {
          const sourcePath = path.resolve(path.dirname(marketplacePath), String((raw.source as { path: string }).path));
          const manifest = await readPluginManifest(sourcePath);
          const version = manifest ? cleanVersion(manifest.version) : null;
          const name = manifest && typeof manifest.name === "string" ? manifest.name : "";
          if (version && name.toLocaleLowerCase("en-US") === identity.plugin.toLocaleLowerCase("en-US")) versions.push(version);
        }
      }
    }
    return versions;
  }
}

export class UpdateService {
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;
  readonly #pluginProvider: PluginUpdateProvider;
  readonly #gitRuntime: GitStatusRuntime;
  readonly #cache = new Map<string, UpdateCheckResult>();

  constructor(options: UpdateServiceOptions = {}) {
    this.#fetch = options.fetchImpl ?? fetch;
    this.#now = options.now ?? (() => new Date());
    this.#gitRuntime = options.gitRuntime ?? defaultGitStatusRuntime;
    this.#pluginProvider = options.pluginProvider ?? new LocalCodexPluginUpdateProvider({
      cacheRoots: options.pluginCacheRoots ?? [path.join(resolveCodexHome(), "plugins", "cache")],
      marketplaceFiles: options.pluginMarketplaceFiles ?? [path.join(os.homedir(), ".agents", "plugins", "marketplace.json")],
      now: this.#now,
    });
  }

  async refreshPluginCatalog(sourceIds: string[]): Promise<void> {
    const marketplaces = sourceIds
      .map((sourceId) => pluginIdentity(sourceId)?.marketplace)
      .filter((marketplace): marketplace is string => Boolean(marketplace));
    await this.#pluginProvider.refresh?.([...new Set(marketplaces)]);
  }

  async check(subject: UpdateSubject, options: UpdateCheckOptions = {}): Promise<UpdateCheckResult> {
    const forceRefresh = options.forceRefresh ?? true;
    const cacheKey = JSON.stringify(subject);
    if (!forceRefresh) {
      const cached = this.#cache.get(cacheKey);
      if (cached) return structuredClone(cached);
    }
    const result = await this.#checkFresh(subject);
    if (result.status !== "offline") this.#cache.set(cacheKey, structuredClone(result));
    return result;
  }

  async #checkFresh(subject: UpdateSubject): Promise<UpdateCheckResult> {
    const checkedAt = this.#now().toISOString();
    if (subject.scope === "system" || subject.scope === "repo") {
      return unavailable(subject, checkedAt, "系统和项目范围 Skill 不由 Organizer 检查更新");
    }
    const shouldCheckGit = !subject.locallyModified && Boolean(subject.installedCommit && subject.instancePath);
    const gitModified = shouldCheckGit
      ? await gitPathIsModified(subject.instancePath!, this.#gitRuntime)
      : null;
    if (shouldCheckGit && gitModified === null) {
      return unavailable(subject, checkedAt, "找不到受信任的标准 Git for Windows，或无法核验本地修改状态；本次更新检查已安全停止");
    }
    const effectiveSubject = gitModified === true ? { ...subject, locallyModified: true } : subject;
    const modification = detectModification(effectiveSubject, checkedAt);
    if (modification) return modification;
    if (subject.scope === "plugin") return this.#pluginProvider.check(effectiveSubject);

    const repository = githubRepository(subject.sourceId);
    if (!repository) return unavailable(subject, checkedAt, "来源不是已验证的公开 GitHub 仓库");
    if (!subject.installedCommit && !subject.installedTag) {
      return unavailable(subject, checkedAt, "缺少精确 tag、release 或 commit 安装证据");
    }
    if (subject.installedCommit && !normalizeCommit(subject.installedCommit)) {
      return unavailable(subject, checkedAt, "installedCommit 必须是完整 40 位 commit");
    }
    if (subject.installedTag && !cleanVersion(subject.installedTag)) {
      return unavailable(subject, checkedAt, "installedTag 格式无效");
    }

    try {
      const base = `https://api.github.com/repos/${repository.owner}/${repository.repository}`;
      const repo = await this.#getJson<GitHubRepository>(base);
      if (repo.private !== false) return unavailable(subject, checkedAt, "仓库未被严格验证为公开 GitHub 仓库");
      const fallback = `https://github.com/${repository.owner}/${repository.repository}`;
      const htmlBase = trustedGitHubUrl(repo.html_url, fallback);
      if (subject.installedCommit) {
        const branch = typeof repo.default_branch === "string" && repo.default_branch.trim() ? repo.default_branch : "HEAD";
        const head = await this.#getJson<GitHubCommit>(`${base}/commits/${encodeURIComponent(branch)}`);
        if (typeof head.sha !== "string" || !COMMIT_PATTERN.test(head.sha)) {
          return unavailable(subject, checkedAt, "GitHub 未返回可验证的远端 commit");
        }
        const installed = normalizeCommit(subject.installedCommit)!;
        const available = head.sha.toLocaleLowerCase("en-US");
        const same = available === installed;
        if (!same) {
          const comparison = await this.#getJson<GitHubComparison>(
            `${base}/compare/${encodeURIComponent(installed)}...${encodeURIComponent(available)}`,
          );
          const aheadBy = typeof comparison.ahead_by === "number" ? comparison.ahead_by : -1;
          const behindBy = typeof comparison.behind_by === "number" ? comparison.behind_by : -1;
          if (comparison.status !== "ahead" || aheadBy <= 0 || behindBy !== 0) {
            return unavailable(subject, checkedAt, "远端默认分支未被 GitHub compare 明确证明为安装 commit 的线性后继");
          }
          return {
            logicalSkillId: subject.logicalSkillId,
            status: "update-available",
            checkedAt,
            evidenceKind: "commit",
            installedEvidence: installed,
            availableEvidence: available,
            locallyModified: false,
            overwriteUpdateAllowed: false,
            summary: `GitHub compare 明确证明远端默认分支领先 ${aheadBy} 个 commit；0.2.0 只检测，不执行更新`,
            compareUrl: trustedGitHubUrl(comparison.html_url, `${htmlBase}/compare/${installed}...${available}`),
          };
        }
        return {
          logicalSkillId: subject.logicalSkillId,
          status: "up-to-date",
          checkedAt,
          evidenceKind: "commit",
          installedEvidence: installed,
          availableEvidence: available,
          locallyModified: false,
          overwriteUpdateAllowed: false,
          summary: "安装 commit 与公开仓库默认分支一致；0.2.0 只检测，不执行更新",
          compareUrl: htmlBase,
        };
      }

      const release = await this.#getJson<GitHubRelease>(`${base}/releases/latest`);
      if (typeof release.tag_name !== "string" || release.draft === true || release.prerelease === true) {
        return unavailable(subject, checkedAt, "GitHub 未返回可验证的正式 release tag");
      }
      const installed = cleanVersion(subject.installedTag)!;
      const available = cleanVersion(release.tag_name);
      if (!available) return unavailable(subject, checkedAt, "GitHub release tag 格式无效");
      const installedSemantic = parseSemanticVersion(installed);
      const availableSemantic = parseSemanticVersion(available);
      if (!installedSemantic || !availableSemantic) {
        if (installed === available) {
          return {
            logicalSkillId: subject.logicalSkillId,
            status: "up-to-date",
            checkedAt,
            evidenceKind: "release-tag",
            installedEvidence: installed,
            availableEvidence: available,
            locallyModified: false,
            overwriteUpdateAllowed: false,
            summary: "安装 tag 与最新正式 release 完全一致；0.2.0 只检测，不执行更新",
            compareUrl: trustedGitHubUrl(release.html_url, htmlBase),
          };
        }
        return unavailable(subject, checkedAt, "release tag 不是双方均可排序的语义版本，拒绝猜测更新顺序");
      }
      const order = compareSemanticVersions(availableSemantic, installedSemantic);
      if (order < 0) return unavailable(subject, checkedAt, "最新正式 release 的语义版本低于本机安装版本，无法声明更新");
      const newer = order > 0;
      return {
        logicalSkillId: subject.logicalSkillId,
        status: newer ? "update-available" : "up-to-date",
        checkedAt,
        evidenceKind: "release-tag",
        installedEvidence: installed,
        availableEvidence: available,
        locallyModified: false,
        overwriteUpdateAllowed: false,
        summary: newer
          ? "语义版本明确证明最新正式 release 高于安装 tag；0.2.0 只检测，不执行更新"
          : "安装 tag 与最新正式 release 的语义版本一致；0.2.0 只检测，不执行更新",
        compareUrl: newer
          ? `${htmlBase}/compare/${encodeURIComponent(installed)}...${encodeURIComponent(available)}`
          : trustedGitHubUrl(release.html_url, htmlBase),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === "GITHUB_404" || message === "GITHUB_401") {
        return unavailable(subject, checkedAt, "GitHub 仓库不存在、私有或无法公开验证");
      }
      return {
        logicalSkillId: subject.logicalSkillId,
        status: "offline",
        checkedAt,
        evidenceKind: "none",
        overwriteUpdateAllowed: false,
        summary: message === "RATE_LIMITED"
          ? "GitHub 匿名请求已限流，请稍后由用户重新检查"
          : "无法连接已验证的 GitHub 来源；本次未生成新的更新证据",
      };
    }
  }

  async #getJson<T>(url: string): Promise<T> {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.hostname !== "api.github.com") throw new Error("UNTRUSTED_UPDATE_HOST");
    const response = await this.#fetch(parsed, {
      method: "GET",
      redirect: "error",
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "codex-skill-organizer/0.2",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 403 || response.status === 429) throw new Error("RATE_LIMITED");
    if (!response.ok) throw new Error(`GITHUB_${response.status}`);
    return response.json() as Promise<T>;
  }
}
