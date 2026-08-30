import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { readSkillFrontmatter } from "./frontmatter.js";
import {
  hashIdentity,
  isPathWithin,
  normalizeLogicalPath,
  normalizeWindowsComparable,
  safeRelative,
} from "./path-identity.js";
import type {
  ObservedSkill,
  RootDefinition,
  SkillDiagnostic,
  SkillScope,
} from "../shared/types.js";

const MAX_DIRECTORY_ENTRIES = 250_000;
const SCAN_METADATA_CONCURRENCY = 32;
const IGNORED_DIRECTORIES = new Set([".git", "node_modules"]);

export interface ScanResult {
  skills: ObservedSkill[];
  errors: Array<{ path: string; message: string }>;
  visitedEntries: number;
}

export interface ScanOptions {
  onGitDirectoryProbe?: (directoryPath: string) => void;
}

interface SourceIdentity {
  scope: SkillScope;
  sourceId: string;
  sourceLabel: string;
  packageId: string;
  pluginId: string | null;
  pluginVersion: string | null;
  installedCommit: string | null;
  stableRelativePath: string;
  readonly: boolean;
}

interface PendingSkillCandidate {
  root: RootDefinition;
  entryPath: string;
  relativePath: string;
  breadcrumb: string;
  physicalId: string;
  aliases: string[];
}

async function mapConcurrent<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

function githubRepositoryPath(value: string): { owner: string; repository: string } | null {
  const match = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/u.exec(value);
  if (!match) return null;
  const owner = match[1]!;
  const repository = match[2]!;
  if (owner === "." || owner === ".." || repository === "." || repository === "..") return null;
  return { owner, repository };
}

function githubSource(value: string | undefined): { id: string; label: string } | null {
  if (!value) return null;
  const normalized = value.trim();
  let repositoryPath: { owner: string; repository: string } | null = null;

  if (/^https?:\/\//iu.test(normalized) || /^ssh:\/\//iu.test(normalized)) {
    let remote: URL;
    try {
      remote = new URL(normalized);
    } catch {
      return null;
    }
    const isHttps = remote.protocol === "https:" && (remote.port === "" || remote.port === "443");
    const isSsh = remote.protocol === "ssh:" && (remote.port === "" || remote.port === "22");
    if (
      (!isHttps && !isSsh)
      || remote.hostname.toLocaleLowerCase("en-US") !== "github.com"
      || remote.password !== ""
      || (isHttps && remote.username !== "")
      || (isSsh && remote.username !== "git")
      || remote.search !== ""
      || remote.hash !== ""
    ) return null;
    repositoryPath = githubRepositoryPath(remote.pathname);
  } else {
    const scp = /^git@github\.com:(\/?[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?(?:\.git)?\/?)$/iu.exec(normalized);
    repositoryPath = scp ? githubRepositoryPath(`/${scp[1]!.replace(/^\//u, "")}`) : null;
  }

  if (!repositoryPath) return null;
  const { owner, repository } = repositoryPath;
  return { id: `github:${owner}/${repository}`, label: `${owner}/${repository}` };
}

interface GitEvidence {
  remote?: string;
  commit?: string;
}

type GitEvidenceCache = Map<string, Promise<GitEvidence>>;

async function readBoundedText(
  filePath: string,
  maximumBytes: number,
  allowedDirectory?: string,
): Promise<string | undefined> {
  try {
    const info = await lstat(filePath);
    if (info.isSymbolicLink() || !info.isFile() || info.size > maximumBytes) return undefined;
    const physicalPath = await realpath(filePath);
    if (allowedDirectory && !isPathWithin(physicalPath, allowedDirectory)) return undefined;
    return await readFile(physicalPath, "utf8");
  } catch {
    return undefined;
  }
}

async function gitCommit(gitDirectory: string): Promise<string | undefined> {
  const head = (await readBoundedText(path.join(gitDirectory, "HEAD"), 4 * 1024, gitDirectory))?.trim();
  if (!head) return undefined;
  if (/^[a-f0-9]{40}$/iu.test(head)) return head.toLocaleLowerCase("en-US");
  const reference = /^ref:\s+(.+)$/u.exec(head)?.[1];
  if (!reference || reference.includes("..") || path.isAbsolute(reference)) return undefined;
  const loose = (await readBoundedText(
    path.join(gitDirectory, ...reference.split("/")),
    4 * 1024,
    gitDirectory,
  ))?.trim();
  if (loose && /^[a-f0-9]{40}$/iu.test(loose)) return loose.toLocaleLowerCase("en-US");
  const packed = await readBoundedText(
    path.join(gitDirectory, "packed-refs"),
    5 * 1024 * 1024,
    gitDirectory,
  );
  const escaped = reference.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = packed ? new RegExp(`^([a-f0-9]{40})\\s+${escaped}$`, "imu").exec(packed) : null;
  return match?.[1]?.toLocaleLowerCase("en-US");
}

async function parentGitEvidence(
  skillPath: string,
  rootPath: string,
  cache: GitEvidenceCache,
  options: ScanOptions,
): Promise<GitEvidence> {
  const rootComparable = normalizeWindowsComparable(rootPath);
  const rootCachePrefix = `${rootComparable}\0`;

  async function resolveDirectory(current: string): Promise<GitEvidence> {
    if (!isPathWithin(current, rootPath)) return {};
    const cacheKey = `${rootCachePrefix}${normalizeWindowsComparable(current)}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;
    const pending = (async (): Promise<GitEvidence> => {
      options.onGitDirectoryProbe?.(current);
      const gitDirectory = path.join(current, ".git");
      try {
        const entry = await lstat(gitDirectory);
        if (entry.isSymbolicLink() || !entry.isDirectory()) return {};
        const physicalGitDirectory = await realpath(gitDirectory);
        if (!isPathWithin(physicalGitDirectory, rootPath)) return {};
        const config = await readBoundedText(
          path.join(physicalGitDirectory, "config"),
          256 * 1024,
          physicalGitDirectory,
        );
        if (!config) return {};
        const originSection = /\[remote\s+"origin"\]([\s\S]*?)(?=\r?\n\[|$)/iu.exec(config)?.[1];
        const url = /^\s*url\s*=\s*(.+?)\s*$/imu.exec(originSection ?? "")?.[1];
        return { remote: url, commit: await gitCommit(physicalGitDirectory) };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return {};
      }
      if (normalizeWindowsComparable(current) === rootComparable) return {};
      const parent = path.dirname(current);
      if (parent === current) return {};
      return resolveDirectory(parent);
    })();
    cache.set(cacheKey, pending);
    return pending;
  }

  return resolveDirectory(path.dirname(skillPath));
}

async function deriveSourceIdentity(
  root: RootDefinition,
  relativePath: string,
  skillPath: string,
  gitEvidenceCache: GitEvidenceCache = new Map(),
  options: ScanOptions = {},
): Promise<SourceIdentity> {
  const segments = normalizeLogicalPath(relativePath).split("/");
  const first = segments[0] || "unknown";

  if (root.kind === "plugin-cache") {
    const [marketplace = "unknown", plugin = "unknown", version = "unknown", ...remaining] = segments;
    return {
      scope: "plugin",
      sourceId: `plugin:${marketplace}/${plugin}`,
      sourceLabel: `${plugin} · ${marketplace}`,
      packageId: plugin,
      pluginId: plugin,
      pluginVersion: version,
      installedCommit: null,
      stableRelativePath: normalizeLogicalPath(remaining.join("/")),
      readonly: true,
    };
  }

  if (root.kind === "agents") {
    const git = await parentGitEvidence(skillPath, root.path, gitEvidenceCache, options);
    const provenance = githubSource(git.remote);
    return {
      scope: "agents",
      sourceId: provenance?.id ?? "agents:local",
      sourceLabel: provenance?.label ?? "Agents 本地技能",
      packageId: first,
      pluginId: null,
      pluginVersion: null,
      installedCommit: provenance ? git.commit ?? null : null,
      stableRelativePath: normalizeLogicalPath(segments.slice(1).join("/") || "SKILL.md"),
      readonly: root.readonly ?? false,
    };
  }

  if (root.kind === "codex" && first === ".system") {
    return {
      scope: "system",
      sourceId: "system:openai",
      sourceLabel: "Codex 系统内置",
      packageId: segments[1] || first,
      pluginId: null,
      pluginVersion: null,
      installedCommit: null,
      stableRelativePath: normalizeLogicalPath(relativePath),
      readonly: true,
    };
  }

  const git = await parentGitEvidence(skillPath, root.path, gitEvidenceCache, options);
  // A directory name or self-declared frontmatter origin is only a hint. Exact
  // portable identity and update evidence require a verified parent Git remote
  // (plugin-cache identities are handled separately above).
  const provenance = githubSource(git.remote);
  const scope: SkillScope = root.kind === "repo"
    ? "repo"
    : root.kind === "custom"
      ? "custom"
      : "user";
  return {
    scope,
    sourceId: provenance?.id ?? `${root.kind === "fixture" ? "fixture" : root.kind}:${root.id}`,
    sourceLabel: provenance?.label ?? first,
    packageId: first,
    pluginId: null,
    pluginVersion: null,
    installedCommit: provenance ? git.commit ?? null : null,
    stableRelativePath: normalizeLogicalPath(segments.slice(1).join("/") || "SKILL.md"),
    readonly: root.kind === "repo" ? false : root.readonly ?? root.kind === "custom",
  };
}

function makeDiagnostic(
  code: SkillDiagnostic["code"],
  message: string,
): SkillDiagnostic {
  return { code, message };
}

function cloneObservedSkill(skill: ObservedSkill): ObservedSkill {
  return {
    ...skill,
    aliases: [...skill.aliases],
    diagnostics: skill.diagnostics
      .filter((diagnostic) => diagnostic.code !== "DUPLICATE_NAME")
      .map((diagnostic) => ({ ...diagnostic })),
  };
}

function finalizeScanResult(
  observedSkills: Iterable<ObservedSkill>,
  errors: ScanResult["errors"],
  visitedEntries: number,
): ScanResult {
  const skills = [...observedSkills].map(cloneObservedSkill);
  const names = new Map<string, ObservedSkill[]>();
  for (const skill of skills) {
    const key = skill.name.normalize("NFC").toLocaleLowerCase("en-US");
    const group = names.get(key) ?? [];
    group.push(skill);
    names.set(key, group);
  }
  for (const group of names.values()) {
    const logicalIds = new Set(group.map((skill) => skill.skillId));
    if (logicalIds.size < 2) continue;
    for (const skill of group) {
      skill.diagnostics.push(makeDiagnostic("DUPLICATE_NAME", `同名逻辑 skill 共 ${logicalIds.size} 项，按来源分别保留`));
    }
  }

  skills.sort((a, b) => a.name.localeCompare(b.name, "zh-CN") || a.breadcrumb.localeCompare(b.breadcrumb, "zh-CN"));
  const sortedErrors = errors.map((error) => ({ ...error }));
  sortedErrors.sort((a, b) => a.path.localeCompare(b.path, "en-US") || a.message.localeCompare(b.message, "zh-CN"));
  return { skills, errors: sortedErrors, visitedEntries };
}

export function mergeScanResults(results: ReadonlyArray<ScanResult>): ScanResult {
  const skillsByPhysicalId = new Map<string, ObservedSkill>();
  const errors: ScanResult["errors"] = [];
  let visitedEntries = 0;
  for (const result of results) {
    visitedEntries += result.visitedEntries;
    errors.push(...result.errors);
    for (const original of result.skills) {
      const existing = skillsByPhysicalId.get(original.physicalId);
      if (existing) {
        for (const alias of original.aliases) {
          if (!existing.aliases.includes(alias)) existing.aliases.push(alias);
        }
        continue;
      }
      skillsByPhysicalId.set(original.physicalId, cloneObservedSkill(original));
    }
  }
  return finalizeScanResult(skillsByPhysicalId.values(), errors, visitedEntries);
}

export async function scanSkillRoots(
  roots: RootDefinition[],
  options: ScanOptions = {},
): Promise<ScanResult> {
  const skillsByPhysicalId = new Map<string, ObservedSkill>();
  const candidatesByPhysicalId = new Map<string, PendingSkillCandidate>();
  const errors: ScanResult["errors"] = [];
  const allowedRootByDefinition = new Map<RootDefinition, string>();
  const gitEvidenceCache: GitEvidenceCache = new Map();
  let visitedEntries = 0;

  for (const root of roots) {
    if (path.resolve(root.path).startsWith("\\\\")) {
      errors.push({ path: root.path, message: "0.2.0 不扫描网络共享根目录" });
      continue;
    }
    try {
      const physicalRoot = await realpath(root.path);
      allowedRootByDefinition.set(root, physicalRoot);
    } catch (error) {
      errors.push({ path: root.path, message: error instanceof Error ? error.message : String(error) });
    }
  }

  async function visitDirectory(
    root: RootDefinition,
    directoryPath: string,
    ancestorPhysicalPaths: ReadonlySet<string>,
  ): Promise<void> {
    let entries;
    try {
      entries = await readdir(directoryPath, { withFileTypes: true });
    } catch (error) {
      errors.push({ path: directoryPath, message: error instanceof Error ? error.message : String(error) });
      return;
    }

    for (const entry of entries) {
      visitedEntries += 1;
      if (visitedEntries > MAX_DIRECTORY_ENTRIES) {
        throw new Error(`扫描超过 ${MAX_DIRECTORY_ENTRIES} 个目录项，已安全停止`);
      }

      const entryPath = path.join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name)) continue;
        let comparableDirectory = normalizeWindowsComparable(entryPath);
        try {
          comparableDirectory = normalizeWindowsComparable(await realpath(entryPath));
        } catch {
          // readdir will surface the useful error for unreadable directories.
        }
        if (ancestorPhysicalPaths.has(comparableDirectory)) {
          errors.push({ path: entryPath, message: "检测到目录循环，已跳过" });
          continue;
        }
        const nextAncestors = new Set(ancestorPhysicalPaths);
        nextAncestors.add(comparableDirectory);
        await visitDirectory(root, entryPath, nextAncestors);
        continue;
      }

      if (entry.isSymbolicLink()) {
        let target: string;
        try {
          target = await realpath(entryPath);
        } catch (error) {
          errors.push({ path: entryPath, message: error instanceof Error ? error.message : String(error) });
          continue;
        }

        const currentRoot = allowedRootByDefinition.get(root);
        if (!currentRoot || !isPathWithin(target, currentRoot)) {
          errors.push({ path: entryPath, message: "链接目标位于允许的 skill 根目录之外，已跳过" });
          continue;
        }

        const comparableTarget = normalizeWindowsComparable(target);
        if (ancestorPhysicalPaths.has(comparableTarget)) {
          errors.push({ path: entryPath, message: "检测到目录链接循环，已跳过" });
          continue;
        }

        const targetInfo = await stat(target);
        if (targetInfo.isDirectory()) {
          const nextAncestors = new Set(ancestorPhysicalPaths);
          nextAncestors.add(comparableTarget);
          await visitDirectory(root, entryPath, nextAncestors);
          continue;
        }
      }

      if (entry.name.toLocaleLowerCase("en-US") !== "skill.md") continue;

      const relativePath = safeRelative(root.path, entryPath);
      if (relativePath === null) {
        errors.push({ path: entryPath, message: "SKILL.md 位于扫描根目录之外，已跳过" });
        continue;
      }

      let realFilePath = entryPath;
      let physicalKey: string;
      try {
        realFilePath = await realpath(entryPath);
        await stat(realFilePath);
        // Windows file IDs can be recycled or reported inconsistently across
        // concurrent directory traversal. A resolved physical path still
        // deduplicates link aliases without collapsing unrelated files.
        physicalKey = normalizeWindowsComparable(realFilePath);
      } catch (error) {
        errors.push({ path: entryPath, message: error instanceof Error ? error.message : String(error) });
        continue;
      }

      const breadcrumb = `${root.label} › ${relativePath}`;
      const physicalId = hashIdentity("physical", physicalKey);
      const existing = candidatesByPhysicalId.get(physicalId);
      if (existing) {
        if (!existing.aliases.includes(breadcrumb)) existing.aliases.push(breadcrumb);
        continue;
      }
      candidatesByPhysicalId.set(physicalId, {
        root,
        entryPath,
        relativePath,
        breadcrumb,
        physicalId,
        aliases: [breadcrumb],
      });
    }
  }

  for (const root of roots) {
    try {
      const rootInfo = await lstat(root.path);
      if (!rootInfo.isDirectory()) continue;
      const rootRealPath = await realpath(root.path);
      await visitDirectory(root, root.path, new Set([normalizeWindowsComparable(rootRealPath)]));
    } catch (error) {
      if (!errors.some((item) => item.path === root.path)) {
        errors.push({ path: root.path, message: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  const candidates = [...candidatesByPhysicalId.values()];
  const processed = await mapConcurrent(candidates, SCAN_METADATA_CONCURRENCY, async (candidate) => {
    let frontmatter;
    const diagnostics: SkillDiagnostic[] = [];
    try {
      frontmatter = await readSkillFrontmatter(candidate.entryPath);
      if (frontmatter.diagnostic) {
        diagnostics.push(makeDiagnostic(frontmatter.diagnostic, frontmatter.message ?? "元数据解析失败"));
      }
    } catch (error) {
      frontmatter = { data: {} };
      diagnostics.push(
        makeDiagnostic("SKILL_UNREADABLE", error instanceof Error ? error.message : String(error)),
      );
    }

    const source = await deriveSourceIdentity(
      candidate.root,
      candidate.relativePath,
      candidate.entryPath,
      gitEvidenceCache,
      options,
    );
    const fallbackName = path.basename(path.dirname(candidate.entryPath));
    const skillId = hashIdentity(
      source.scope,
      source.sourceId.toLocaleLowerCase("en-US"),
      source.packageId.toLocaleLowerCase("en-US"),
      source.stableRelativePath.toLocaleLowerCase("en-US"),
    );
    const instanceId = hashIdentity("instance", skillId, normalizeWindowsComparable(candidate.entryPath));
    return {
      skillId,
      physicalId: candidate.physicalId,
      instanceId,
      name: frontmatter.data.name || fallbackName,
      description: frontmatter.data.description || "",
      existingCategory: frontmatter.data.category,
      version: frontmatter.data.version ? String(frontmatter.data.version) : undefined,
      installedCommit: source.installedCommit ?? undefined,
      origin: frontmatter.data.origin,
      scope: source.scope,
      sourceId: source.sourceId,
      sourceLabel: source.sourceLabel,
      packageId: source.packageId,
      pluginId: source.pluginId,
      pluginVersion: source.pluginVersion,
      rootId: candidate.root.id,
      rootLabel: candidate.root.label,
      absolutePath: path.resolve(candidate.entryPath),
      relativePath: normalizeLogicalPath(candidate.relativePath),
      breadcrumb: candidate.breadcrumb,
      readonly: source.readonly,
      aliases: candidate.aliases,
      diagnostics,
    } satisfies ObservedSkill;
  });
  for (const skill of processed) skillsByPhysicalId.set(skill.physicalId, skill);

  // 0.2 keeps every physical instance. InventoryService groups them by logical
  // skillId and app-server path selects the active instance. Cache versions are
  // never discarded during discovery.
  return finalizeScanResult(skillsByPhysicalId.values(), errors, visitedEntries);
}
