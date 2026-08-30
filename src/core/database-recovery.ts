import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import {
  copyFileVerifiedDurably,
  defaultDurableFileOperations,
  fileExists,
  replaceFileVerifiedDurably,
  unlinkIfPresent,
  type DurableFileOperations,
} from "./durable-file.js";

const DATABASE_EXTENSIONS = ["", "-wal", "-shm"] as const;
type DatabaseExtension = typeof DATABASE_EXTENSIONS[number];

export type DatabaseRecoveryPhase = "archive" | "snapshot-install" | "snapshot-open" | "rollback";

export class DatabaseRecoveryError extends Error {
  constructor(
    readonly phase: DatabaseRecoveryPhase,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface DatabaseRecoveryTransaction {
  readonly archiveDirectory: string;
  readonly archivedPaths: ReadonlyMap<DatabaseExtension, string>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export interface StageDatabaseRecoveryOptions {
  statePath: string;
  snapshotPath: string;
  corruptDirectory: string;
  archiveLabel: string;
  operations?: DurableFileOperations;
}

function recoveryMessage(phase: DatabaseRecoveryPhase, detail: string): string {
  const labels: Record<DatabaseRecoveryPhase, string> = {
    archive: "损坏数据库归档失败",
    "snapshot-install": "数据库快照安装失败",
    "snapshot-open": "数据库快照打开失败",
    rollback: "数据库恢复回滚失败",
  };
  return `${labels[phase]}：${detail}`;
}

/**
 * Archives db/wal/shm as one verified group before changing any source file,
 * then installs the snapshot without deleting the old db first. The returned
 * transaction remains rollback-capable until the caller proves the snapshot
 * can be opened.
 */
export async function stageDatabaseRecovery(
  options: StageDatabaseRecoveryOptions,
): Promise<DatabaseRecoveryTransaction> {
  const operations = options.operations ?? defaultDurableFileOperations;
  const archiveDirectory = path.join(
    options.corruptDirectory,
    `${path.basename(options.statePath)}.${options.archiveLabel}-${randomUUID()}`,
  );
  await mkdir(archiveDirectory, { recursive: true });

  const archivedPaths = new Map<DatabaseExtension, string>();
  const originalExtensions: DatabaseExtension[] = [];
  try {
    for (const extension of DATABASE_EXTENSIONS) {
      const sourcePath = `${options.statePath}${extension}`;
      if (!await fileExists(sourcePath, operations)) continue;
      originalExtensions.push(extension);
      const archivedPath = path.join(archiveDirectory, `${path.basename(options.statePath)}${extension}`);
      await copyFileVerifiedDurably(sourcePath, archivedPath, { operations });
      archivedPaths.set(extension, archivedPath);
    }
  } catch (error) {
    await rm(archiveDirectory, { recursive: true, force: true }).catch(() => undefined);
    throw new DatabaseRecoveryError(
      "archive",
      recoveryMessage("archive", "原 db/wal/shm 保持不变，未形成完整归档组"),
      { cause: error },
    );
  }
  if (!archivedPaths.has("")) {
    await rm(archiveDirectory, { recursive: true, force: true }).catch(() => undefined);
    throw new DatabaseRecoveryError("archive", recoveryMessage("archive", "未找到主数据库文件"));
  }

  const stagedSnapshotPath = `${options.statePath}.recovery-${randomUUID()}.next`;
  let active = true;
  const rollback = async (): Promise<void> => {
    if (!active) return;
    const errors: unknown[] = [];
    for (const extension of ["-wal", "-shm"] as const) {
      try {
        await unlinkIfPresent(`${options.statePath}${extension}`, operations);
      } catch (error) {
        errors.push(error);
      }
    }

    const archivedDatabase = archivedPaths.get("")!;
    const rollbackStagePath = `${options.statePath}.rollback-${randomUUID()}.next`;
    try {
      await copyFileVerifiedDurably(archivedDatabase, rollbackStagePath, { operations });
      await replaceFileVerifiedDurably(rollbackStagePath, options.statePath, { operations });
    } catch (error) {
      errors.push(error);
    } finally {
      await unlinkIfPresent(rollbackStagePath, operations).catch(() => undefined);
    }

    for (const extension of ["-wal", "-shm"] as const) {
      const archivedPath = archivedPaths.get(extension);
      if (!archivedPath) continue;
      try {
        await copyFileVerifiedDurably(archivedPath, `${options.statePath}${extension}`, { operations });
      } catch (error) {
        errors.push(error);
      }
    }
    await unlinkIfPresent(stagedSnapshotPath, operations).catch(() => undefined);
    if (errors.length > 0) {
      throw new DatabaseRecoveryError(
        "rollback",
        recoveryMessage("rollback", "无法保证原 db/wal/shm 已完整恢复；完整归档组仍保留"),
        { cause: new AggregateError(errors) },
      );
    }
    active = false;
  };

  try {
    await copyFileVerifiedDurably(options.snapshotPath, stagedSnapshotPath, { operations });
    for (const extension of ["-wal", "-shm"] as const) {
      if (originalExtensions.includes(extension)) {
        await unlinkIfPresent(`${options.statePath}${extension}`, operations);
      }
    }
    await replaceFileVerifiedDurably(stagedSnapshotPath, options.statePath, { operations });
  } catch (error) {
    try {
      await rollback();
    } catch (rollbackError) {
      throw rollbackError;
    }
    throw new DatabaseRecoveryError(
      "snapshot-install",
      recoveryMessage("snapshot-install", "原 db/wal/shm 已从完整归档组恢复"),
      { cause: error },
    );
  }

  return {
    archiveDirectory,
    archivedPaths,
    async commit(): Promise<void> {
      active = false;
      await unlinkIfPresent(stagedSnapshotPath, operations).catch(() => undefined);
    },
    rollback,
  };
}

export function snapshotOpenFailure(error: unknown): DatabaseRecoveryError {
  return new DatabaseRecoveryError(
    "snapshot-open",
    recoveryMessage("snapshot-open", "原 db/wal/shm 已恢复，完整归档组仍保留"),
    { cause: error },
  );
}
