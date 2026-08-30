import { createHash, randomUUID } from "node:crypto";
import {
  copyFile,
  open,
  readFile,
  rename,
  unlink,
  type FileHandle,
} from "node:fs/promises";

export interface DurableFileOperations {
  copyFile(sourcePath: string, destinationPath: string): Promise<void>;
  open(filePath: string, flags: string | number, mode?: number): Promise<FileHandle>;
  readFile(filePath: string): Promise<Buffer>;
  rename(sourcePath: string, destinationPath: string): Promise<void>;
  unlink(filePath: string): Promise<void>;
}

export const defaultDurableFileOperations: DurableFileOperations = {
  copyFile: async (sourcePath, destinationPath) => copyFile(sourcePath, destinationPath),
  open: async (filePath, flags, mode) => open(filePath, flags, mode),
  readFile: async (filePath) => readFile(filePath),
  rename: async (sourcePath, destinationPath) => rename(sourcePath, destinationPath),
  unlink: async (filePath) => unlink(filePath),
};

export interface DurableWriteOptions {
  mode?: number;
  flag?: string | number;
  operations?: DurableFileOperations;
}

export interface VerifiedCopyOptions {
  operations?: DurableFileOperations;
  protectFile?: (filePath: string) => Promise<void>;
}

export interface DurableReplacementOptions extends VerifiedCopyOptions {
  rollbackPath?: string;
}

interface FileFingerprint {
  size: number;
  sha256: string;
}

async function fingerprintFile(
  filePath: string,
  operations: DurableFileOperations,
): Promise<FileFingerprint> {
  const handle = await operations.open(filePath, "r");
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1_024);
  let size = 0;
  try {
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      size += bytesRead;
    }
  } finally {
    await handle.close();
  }
  return { size, sha256: hash.digest("hex") };
}

function sameFingerprint(left: FileFingerprint, right: FileFingerprint): boolean {
  return left.size === right.size && left.sha256 === right.sha256;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

export async function fileExists(
  filePath: string,
  operations: DurableFileOperations = defaultDurableFileOperations,
): Promise<boolean> {
  let handle;
  try {
    handle = await operations.open(filePath, "r");
    await handle.close();
    return true;
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    if (isMissing(error)) return false;
    throw error;
  }
}

export async function unlinkIfPresent(
  filePath: string,
  operations: DurableFileOperations = defaultDurableFileOperations,
): Promise<void> {
  try {
    await operations.unlink(filePath);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

export async function writeFileDurably(
  filePath: string,
  contents: string | Uint8Array,
  options: DurableWriteOptions = {},
): Promise<void> {
  const operations = options.operations ?? defaultDurableFileOperations;
  const handle = await operations.open(filePath, options.flag ?? "w", options.mode ?? 0o600);
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncFile(filePath: string, operations: DurableFileOperations): Promise<void> {
  const handle = await operations.open(filePath, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function assertPayload(
  filePath: string,
  expected: FileFingerprint,
  operations: DurableFileOperations,
): Promise<void> {
  const actual = await fingerprintFile(filePath, operations);
  if (!sameFingerprint(actual, expected)) {
    throw new Error(`持久化文件校验失败: ${filePath}`);
  }
}

/**
 * Copies a file, flushes the destination, and verifies both length and SHA-256.
 * The source is read again after the copy so a changing source fails closed.
 */
export async function copyFileVerifiedDurably(
  sourcePath: string,
  destinationPath: string,
  options: VerifiedCopyOptions = {},
): Promise<void> {
  const operations = options.operations ?? defaultDurableFileOperations;
  const sourceBefore = await fingerprintFile(sourcePath, operations);
  await operations.copyFile(sourcePath, destinationPath);
  await options.protectFile?.(destinationPath);
  await syncFile(destinationPath, operations);
  const [sourceAfter, destination] = await Promise.all([
    fingerprintFile(sourcePath, operations),
    fingerprintFile(destinationPath, operations),
  ]);
  if (!sameFingerprint(sourceAfter, sourceBefore) || !sameFingerprint(destination, sourceBefore)) {
    throw new Error(`持久化复制校验失败: ${sourcePath} -> ${destinationPath}`);
  }
}

/**
 * Replaces a file without deleting the valid destination first. A verified
 * rollback copy is retained until the new destination has been flushed and
 * read back. Windows EFS can report EXDEV for same-directory rename; that path
 * falls back to a verified copy and restores the old destination on failure.
 */
export async function replaceFileVerifiedDurably(
  stagedPath: string,
  destinationPath: string,
  options: DurableReplacementOptions = {},
): Promise<void> {
  const operations = options.operations ?? defaultDurableFileOperations;
  const expected = await fingerprintFile(stagedPath, operations);
  const destinationExisted = await fileExists(destinationPath, operations);
  const rollbackPath = options.rollbackPath
    ?? `${destinationPath}.rollback-${randomUUID()}`;
  let rollbackReady = false;
  let replacementStarted = false;
  let primaryError: unknown;

  try {
    if (destinationExisted) {
      await copyFileVerifiedDurably(destinationPath, rollbackPath, options);
      rollbackReady = true;
    }
    replacementStarted = true;
    try {
      await operations.rename(stagedPath, destinationPath);
      await options.protectFile?.(destinationPath);
      await syncFile(destinationPath, operations);
      await assertPayload(destinationPath, expected, operations);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
      await copyFileVerifiedDurably(stagedPath, destinationPath, options);
      await assertPayload(destinationPath, expected, operations);
    }
    await unlinkIfPresent(stagedPath, operations);
    if (rollbackReady) await unlinkIfPresent(rollbackPath, operations);
    return;
  } catch (error) {
    primaryError = error;
  }

  const rollbackErrors: unknown[] = [];
  let rollbackRestored = false;
  if (replacementStarted) {
    try {
      if (destinationExisted && rollbackReady) {
        await copyFileVerifiedDurably(rollbackPath, destinationPath, options);
        rollbackRestored = true;
      } else if (!destinationExisted) {
        await unlinkIfPresent(destinationPath, operations);
      }
    } catch (error) {
      rollbackErrors.push(error);
    }
  }
  if (rollbackReady && rollbackRestored) {
    try {
      await unlinkIfPresent(rollbackPath, operations);
    } catch (error) {
      rollbackErrors.push(error);
    }
  } else if (!rollbackReady) {
    await unlinkIfPresent(rollbackPath, operations).catch(() => undefined);
  }
  if (rollbackErrors.length > 0) {
    throw new AggregateError(
      [primaryError, ...rollbackErrors],
      `文件替换失败且回滚未完整完成: ${destinationPath}`,
    );
  }
  throw primaryError;
}
