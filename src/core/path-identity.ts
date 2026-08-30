import { createHash } from "node:crypto";
import path from "node:path";

export interface DirectoryIdentityStats {
  dev: number | bigint;
  ino: number | bigint;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export interface DirectoryIdentityOperations {
  lstat(filePath: string): Promise<DirectoryIdentityStats>;
  realpath(filePath: string): Promise<string>;
}

export interface PhysicalDirectoryInspection {
  declaredPath: string;
  physicalPath: string;
  device: string;
  inode: string;
}

export class UnsafeDirectoryIdentityError extends Error {}

export function normalizeWindowsComparable(input: string): string {
  return path.resolve(input).normalize("NFC").replaceAll("\\", "/").toLocaleLowerCase("en-US");
}

export function normalizeLogicalPath(input: string): string {
  return input.normalize("NFC").replaceAll("\\", "/").replace(/^\.\//, "");
}

export function hashIdentity(...parts: string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(part.normalize("NFC"));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function isPathWithin(candidate: string, root: string): boolean {
  const normalizedCandidate = normalizeWindowsComparable(candidate);
  const normalizedRoot = normalizeWindowsComparable(root).replace(/\/$/, "");
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}/`);
}

export function safeRelative(root: string, candidate: string): string | null {
  const relative = path.relative(root, candidate);
  if (relative === "") return "";
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return normalizeLogicalPath(relative);
}

function windowsPathParts(input: string): { root: string; segments: string[] } {
  let normalized = input;
  if (normalized.toLocaleLowerCase("en-US").startsWith("\\\\?\\unc\\")) {
    normalized = `\\\\${normalized.slice(8)}`;
  } else if (normalized.startsWith("\\\\?\\")) {
    normalized = normalized.slice(4);
  }
  normalized = path.win32.normalize(normalized);
  const parsed = path.win32.parse(normalized);
  return {
    root: parsed.root.toLocaleLowerCase("en-US"),
    segments: normalized.slice(parsed.root.length).split("\\").filter(Boolean),
  };
}

function differsOnlyByDosShortNames(declaredPath: string, physicalPath: string): boolean {
  const declared = windowsPathParts(declaredPath);
  const physical = windowsPathParts(physicalPath);
  if (declared.root !== physical.root || declared.segments.length !== physical.segments.length) return false;
  const shortName = /^[^ .\\/:]{1,6}~[0-9]{1,6}(?:\.[^ .\\/:]{1,3})?$/iu;
  let foundAlias = false;
  for (let index = 0; index < declared.segments.length; index += 1) {
    const declaredSegment = declared.segments[index]!;
    const physicalSegment = physical.segments[index]!;
    if (declaredSegment.localeCompare(physicalSegment, "en-US", { sensitivity: "base" }) === 0) continue;
    if (!shortName.test(declaredSegment) && !shortName.test(physicalSegment)) return false;
    foundAlias = true;
  }
  return foundAlias;
}

function samePhysicalIdentity(left: DirectoryIdentityStats, right: DirectoryIdentityStats): boolean {
  const valid = (value: number | bigint): boolean => typeof value === "bigint" || Number.isFinite(value);
  return valid(left.dev)
    && valid(left.ino)
    && valid(right.dev)
    && valid(right.ino)
    && String(left.dev) === String(right.dev)
    && String(left.ino) === String(right.ino);
}

/**
 * Resolves a directory while rejecting links in every declared path component.
 * Windows long and DOS 8.3 spellings are accepted only when both names identify
 * the same directory; other realpath mismatches remain fail-closed.
 */
export async function inspectUnlinkedDirectoryChain(
  candidate: string,
  operations: DirectoryIdentityOperations,
  platform: NodeJS.Platform = process.platform,
): Promise<PhysicalDirectoryInspection[]> {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const resolved = pathApi.resolve(candidate);
  const parsed = pathApi.parse(resolved);
  const segments = resolved.slice(parsed.root.length).split(pathApi.sep).filter(Boolean);
  const prefixes = [parsed.root];
  for (const segment of segments) prefixes.push(pathApi.join(prefixes.at(-1)!, segment));

  const inspections: PhysicalDirectoryInspection[] = [];
  for (const declaredPath of prefixes) {
    const declaredInfo = await operations.lstat(declaredPath);
    if (!declaredInfo.isDirectory() || declaredInfo.isSymbolicLink()) {
      throw new UnsafeDirectoryIdentityError("路径组件是 symlink、junction、reparse point 或非目录");
    }
    const physicalPath = await operations.realpath(declaredPath);
    const comparableDeclared = platform === "win32"
      ? path.win32.resolve(declaredPath).toLocaleLowerCase("en-US")
      : path.posix.resolve(declaredPath);
    const comparablePhysical = platform === "win32"
      ? path.win32.resolve(physicalPath).toLocaleLowerCase("en-US")
      : path.posix.resolve(physicalPath);
    if (comparableDeclared !== comparablePhysical) {
      if (platform !== "win32" || !differsOnlyByDosShortNames(declaredPath, physicalPath)) {
        throw new UnsafeDirectoryIdentityError("路径组件存在无法证明为 DOS 8.3 别名的 reparse 或 junction substitution");
      }
      const physicalInfo = await operations.lstat(physicalPath);
      if (
        !physicalInfo.isDirectory()
        || physicalInfo.isSymbolicLink()
        || !samePhysicalIdentity(declaredInfo, physicalInfo)
      ) {
        throw new UnsafeDirectoryIdentityError("DOS 8.3 路径别名与物理目录身份不一致");
      }
    }
    inspections.push({
      declaredPath,
      physicalPath,
      device: String(declaredInfo.dev),
      inode: String(declaredInfo.ino),
    });
  }
  return inspections;
}
