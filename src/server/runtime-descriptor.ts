import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  defaultDurableFileOperations,
  replaceFileVerifiedDurably,
  unlinkIfPresent,
  writeFileDurably,
  type DurableFileOperations,
} from "../core/durable-file.js";

export class RuntimeDescriptorSupersededError extends Error {}

export interface RuntimeDescriptorPublicationOptions {
  operations?: DurableFileOperations;
  protectFile?: (filePath: string) => Promise<void>;
  lockWaitMs?: number;
  now?: () => number;
}

interface DescriptorOrder {
  startedAt?: unknown;
  token?: unknown;
}

interface LockOwner {
  pid: number;
  acquiredAt: number;
}

const LOCK_STALE_AFTER_MS = 30_000;

function descriptorStartedAt(value: DescriptorOrder): number | null {
  if (typeof value.startedAt !== "string") return null;
  const parsed = Date.parse(value.startedAt);
  return Number.isFinite(parsed) ? parsed : null;
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readJsonIfPresent(
  filePath: string,
  operations: DurableFileOperations,
): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse((await operations.readFile(filePath)).toString("utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function acquirePublicationLock(
  lockPath: string,
  options: RuntimeDescriptorPublicationOptions,
): Promise<() => Promise<void>> {
  const operations = options.operations ?? defaultDurableFileOperations;
  const now = options.now ?? Date.now;
  const startedWaitingAt = now();
  const deadline = startedWaitingAt + (options.lockWaitMs ?? 5_000);

  while (true) {
    let handle;
    let ownsLock = false;
    try {
      handle = await operations.open(lockPath, "wx", 0o600);
      ownsLock = true;
      const owner: LockOwner = { pid: process.pid, acquiredAt: now() };
      await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await options.protectFile?.(lockPath);
      return async () => unlinkIfPresent(lockPath, operations);
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        if (ownsLock) await unlinkIfPresent(lockPath, operations).catch(() => undefined);
        throw error;
      }
    }

    const owner = await readJsonIfPresent(lockPath, operations) as Partial<LockOwner> | null;
    if (
      owner
      && typeof owner.acquiredAt === "number"
      && now() - owner.acquiredAt > LOCK_STALE_AFTER_MS
      && typeof owner.pid === "number"
      && !processIsAlive(owner.pid)
    ) {
      const staleLockPath = `${lockPath}.stale-${randomUUID()}`;
      try {
        await operations.rename(lockPath, staleLockPath);
        await unlinkIfPresent(staleLockPath, operations).catch(() => undefined);
        continue;
      } catch {
        // A competing publisher may have changed the lock; retry without ever
        // unlinking a path that could now belong to that newer process.
      }
    }
    if (now() >= deadline) throw new Error("runtime descriptor 发布锁超时；保留现有 descriptor");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Publishes runtime.json under an inter-process lock with an older-writer guard. */
export async function publishRuntimeDescriptor(
  runtimePath: string,
  descriptor: Record<string, unknown>,
  options: RuntimeDescriptorPublicationOptions = {},
): Promise<void> {
  const operations = options.operations ?? defaultDurableFileOperations;
  const candidateStartedAt = descriptorStartedAt(descriptor);
  if (candidateStartedAt === null) throw new Error("runtime descriptor startedAt 无效");
  const lockPath = `${runtimePath}.publish.lock`;
  const release = await acquirePublicationLock(lockPath, options);
  const stagedPath = path.join(
    path.dirname(runtimePath),
    `.runtime-${process.pid}-${randomUUID()}.json`,
  );
  try {
    const current = await readJsonIfPresent(runtimePath, operations);
    const currentStartedAt = current ? descriptorStartedAt(current) : null;
    if (
      currentStartedAt !== null
      && currentStartedAt > candidateStartedAt
      && current?.token !== descriptor.token
    ) {
      throw new RuntimeDescriptorSupersededError("检测到更新的 runtime descriptor；旧启动实例拒绝覆盖");
    }
    await writeFileDurably(stagedPath, `${JSON.stringify(descriptor, null, 2)}\n`, {
      operations,
      mode: 0o600,
      flag: "wx",
    });
    await options.protectFile?.(stagedPath);
    await replaceFileVerifiedDurably(stagedPath, runtimePath, {
      operations,
      protectFile: options.protectFile,
    });
  } catch (error) {
    await unlinkIfPresent(stagedPath, operations).catch(() => undefined);
    throw error;
  } finally {
    await release();
  }
}
