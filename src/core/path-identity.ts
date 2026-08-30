import { createHash } from "node:crypto";
import path from "node:path";

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
