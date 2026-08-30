import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  stageDatabaseRecovery,
  type DatabaseRecoveryError,
} from "../src/core/database-recovery.js";
import {
  defaultDurableFileOperations,
  replaceFileVerifiedDurably,
  type DurableFileOperations,
} from "../src/core/durable-file.js";
import {
  publishRuntimeDescriptor,
  RuntimeDescriptorSupersededError,
} from "../src/server/runtime-descriptor.js";

function exdev(): NodeJS.ErrnoException {
  return Object.assign(new Error("simulated EFS same-directory rename failure"), { code: "EXDEV" });
}

function descriptor(token: string, startedAt: string): Record<string, unknown> {
  return {
    service: "codex-skill-organizer",
    version: "0.2.0",
    protocolVersion: "2.0",
    protocolMin: "2.0",
    protocolMax: "2.0",
    pid: process.pid,
    port: 41_321,
    host: "127.0.0.1",
    token,
    credentialExpiresAt: Date.now() + 60_000,
    startedAt,
    installRoot: "fixture",
  };
}

async function assertNoRuntimeJournals(directory: string): Promise<void> {
  const entries = await readdir(directory);
  assert.deepEqual(
    entries.filter((entry) => entry.startsWith(".runtime-") || entry.includes(".rollback-") || entry.endsWith(".publish.lock")),
    [],
  );
}

test("runtime descriptor EXDEV fallback publishes a flushed, readable replacement without deleting the old descriptor first", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cso-runtime-exdev-"));
  const runtimePath = path.join(directory, "runtime.json");
  const oldDescriptor = descriptor("a".repeat(48), "2026-08-30T00:00:00.000Z");
  const nextDescriptor = descriptor("b".repeat(48), "2026-08-30T00:01:00.000Z");
  const protectedPaths: string[] = [];
  try {
    await writeFile(runtimePath, `${JSON.stringify(oldDescriptor)}\n`, "utf8");
    const operations: DurableFileOperations = {
      ...defaultDurableFileOperations,
      rename: async (sourcePath, destinationPath) => {
        if (destinationPath === runtimePath) throw exdev();
        await defaultDurableFileOperations.rename(sourcePath, destinationPath);
      },
    };
    await publishRuntimeDescriptor(runtimePath, nextDescriptor, {
      operations,
      protectFile: async (filePath) => { protectedPaths.push(filePath); },
    });
    assert.deepEqual(JSON.parse(await readFile(runtimePath, "utf8")), nextDescriptor);
    assert.ok(protectedPaths.includes(runtimePath), "the final descriptor must receive the restricted ACL callback");
    await assertNoRuntimeJournals(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("runtime descriptor EXDEV copy failure restores the existing valid descriptor and cleans partial journals", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cso-runtime-rollback-"));
  const runtimePath = path.join(directory, "runtime.json");
  const oldDescriptor = descriptor("a".repeat(48), "2026-08-30T00:00:00.000Z");
  const nextDescriptor = descriptor("b".repeat(48), "2026-08-30T00:01:00.000Z");
  let failed = false;
  const protectedPaths: string[] = [];
  try {
    await writeFile(runtimePath, `${JSON.stringify(oldDescriptor)}\n`, "utf8");
    const operations: DurableFileOperations = {
      ...defaultDurableFileOperations,
      rename: async (sourcePath, destinationPath) => {
        if (destinationPath === runtimePath) throw exdev();
        await defaultDurableFileOperations.rename(sourcePath, destinationPath);
      },
      copyFile: async (sourcePath, destinationPath) => {
        if (!failed && destinationPath === runtimePath && path.basename(sourcePath).startsWith(".runtime-")) {
          failed = true;
          await writeFile(destinationPath, "{partial", "utf8");
          throw Object.assign(new Error("simulated interrupted encrypted copy"), { code: "EIO" });
        }
        await defaultDurableFileOperations.copyFile(sourcePath, destinationPath);
      },
    };
    await assert.rejects(
      () => publishRuntimeDescriptor(runtimePath, nextDescriptor, {
        operations,
        protectFile: async (filePath) => { protectedPaths.push(filePath); },
      }),
      /interrupted encrypted copy/u,
    );
    assert.deepEqual(JSON.parse(await readFile(runtimePath, "utf8")), oldDescriptor);
    assert.equal(protectedPaths.at(-1), runtimePath, "rollback must reapply the descriptor ACL callback");
    await assertNoRuntimeJournals(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("runtime descriptor EXDEV flush failure restores the existing valid descriptor", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cso-runtime-flush-rollback-"));
  const runtimePath = path.join(directory, "runtime.json");
  const oldDescriptor = descriptor("a".repeat(48), "2026-08-30T00:00:00.000Z");
  const nextDescriptor = descriptor("b".repeat(48), "2026-08-30T00:01:00.000Z");
  let failNextDestinationFlush = true;
  try {
    await writeFile(runtimePath, `${JSON.stringify(oldDescriptor)}\n`, "utf8");
    const operations: DurableFileOperations = {
      ...defaultDurableFileOperations,
      rename: async (sourcePath, destinationPath) => {
        if (destinationPath === runtimePath) throw exdev();
        await defaultDurableFileOperations.rename(sourcePath, destinationPath);
      },
      open: async (filePath, flags, mode) => {
        const handle = await defaultDurableFileOperations.open(filePath, flags, mode);
        if (filePath !== runtimePath || flags !== "r+" || !failNextDestinationFlush) return handle;
        return new Proxy(handle, {
          get(target, property) {
            if (property === "sync") {
              return async () => {
                if (failNextDestinationFlush) {
                  failNextDestinationFlush = false;
                  throw new Error("simulated destination flush failure");
                }
                await target.sync();
              };
            }
            const value = Reflect.get(target, property, target) as unknown;
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
    };
    await assert.rejects(
      () => publishRuntimeDescriptor(runtimePath, nextDescriptor, { operations }),
      /destination flush failure/u,
    );
    assert.deepEqual(JSON.parse(await readFile(runtimePath, "utf8")), oldDescriptor);
    await assertNoRuntimeJournals(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failed durable rollback preserves the last verified old-file artifact", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cso-durable-preserve-"));
  const destinationPath = path.join(directory, "current.json");
  const stagedPath = path.join(directory, "current.next.json");
  const rollbackPath = path.join(directory, "current.rollback.json");
  try {
    await writeFile(destinationPath, "old verified payload", "utf8");
    await writeFile(stagedPath, "new payload", "utf8");
    const operations: DurableFileOperations = {
      ...defaultDurableFileOperations,
      copyFile: async (sourcePath, targetPath) => {
        if (sourcePath === rollbackPath && targetPath === destinationPath) {
          throw new Error("simulated rollback restore failure");
        }
        await defaultDurableFileOperations.copyFile(sourcePath, targetPath);
      },
    };
    await assert.rejects(
      () => replaceFileVerifiedDurably(stagedPath, destinationPath, {
        operations,
        rollbackPath,
        protectFile: async (filePath) => {
          if (filePath === destinationPath) throw new Error("simulated replacement protection failure");
        },
      }),
      (error: AggregateError) => error instanceof AggregateError
        && error.message.includes("回滚未完整完成")
        && error.errors.some((item) => item instanceof Error && item.message.includes("rollback restore failure")),
    );
    assert.equal(
      await readFile(rollbackPath, "utf8"),
      "old verified payload",
      "the verified old destination must remain recoverable when restore fails",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("first runtime descriptor EXDEV success is readable and a failed first copy leaves no partial descriptor", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cso-runtime-first-"));
  const runtimePath = path.join(directory, "runtime.json");
  const first = descriptor("c".repeat(48), "2026-08-30T00:02:00.000Z");
  try {
    const exdevOperations: DurableFileOperations = {
      ...defaultDurableFileOperations,
      rename: async () => { throw exdev(); },
    };
    await publishRuntimeDescriptor(runtimePath, first, { operations: exdevOperations });
    assert.deepEqual(JSON.parse(await readFile(runtimePath, "utf8")), first);
    await rm(runtimePath);

    let failed = false;
    const failingOperations: DurableFileOperations = {
      ...exdevOperations,
      copyFile: async (sourcePath, destinationPath) => {
        if (!failed && destinationPath === runtimePath) {
          failed = true;
          await writeFile(destinationPath, "partial", "utf8");
          throw new Error("simulated first publish failure");
        }
        await defaultDurableFileOperations.copyFile(sourcePath, destinationPath);
      },
    };
    await assert.rejects(() => publishRuntimeDescriptor(runtimePath, first, { operations: failingOperations }));
    await assert.rejects(() => readFile(runtimePath), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
    await assertNoRuntimeJournals(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an older runtime writer cannot overwrite a descriptor published by a newer startup", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cso-runtime-order-"));
  const runtimePath = path.join(directory, "runtime.json");
  const newer = descriptor("n".repeat(48), "2026-08-30T00:03:00.000Z");
  const older = descriptor("o".repeat(48), "2026-08-30T00:02:00.000Z");
  try {
    await publishRuntimeDescriptor(runtimePath, newer);
    await assert.rejects(
      () => publishRuntimeDescriptor(runtimePath, older),
      RuntimeDescriptorSupersededError,
    );
    assert.deepEqual(JSON.parse(await readFile(runtimePath, "utf8")), newer);
    await assertNoRuntimeJournals(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("concurrent runtime publishers serialize and leave the newest started descriptor readable", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cso-runtime-concurrent-"));
  const runtimePath = path.join(directory, "runtime.json");
  const older = descriptor("o".repeat(48), "2026-08-30T00:02:00.000Z");
  const newer = descriptor("n".repeat(48), "2026-08-30T00:03:00.000Z");
  let unblockOlder!: () => void;
  const blocked = new Promise<void>((resolve) => { unblockOlder = resolve; });
  let olderStaged!: () => void;
  const staged = new Promise<void>((resolve) => { olderStaged = resolve; });
  try {
    const first = publishRuntimeDescriptor(runtimePath, older, {
      protectFile: async (filePath) => {
        if (!path.basename(filePath).startsWith(".runtime-")) return;
        olderStaged();
        await blocked;
      },
    });
    await staged;
    const second = publishRuntimeDescriptor(runtimePath, newer);
    unblockOlder();
    await Promise.all([first, second]);
    assert.deepEqual(JSON.parse(await readFile(runtimePath, "utf8")), newer);
    await assertNoRuntimeJournals(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function writeDatabaseGroup(statePath: string): Promise<Map<string, string>> {
  const contents = new Map([
    ["", "old-db"],
    ["-wal", "old-wal"],
    ["-shm", "old-shm"],
  ]);
  await mkdir(path.dirname(statePath), { recursive: true });
  await Promise.all([...contents].map(([extension, value]) => writeFile(`${statePath}${extension}`, value, "utf8")));
  return contents;
}

async function assertDatabaseGroup(statePath: string, expected: Map<string, string>): Promise<void> {
  for (const [extension, value] of expected) {
    assert.equal(await readFile(`${statePath}${extension}`, "utf8"), value);
  }
}

test("database recovery handles EFS EXDEV and preserves db/wal/shm as one verified archive group", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cso-db-exdev-"));
  const statePath = path.join(directory, "state", "organizer.db");
  const snapshotPath = path.join(directory, "snapshot.sqlite");
  const originals = await writeDatabaseGroup(statePath);
  await writeFile(snapshotPath, "new-snapshot", "utf8");
  try {
    const operations: DurableFileOperations = {
      ...defaultDurableFileOperations,
      rename: async (sourcePath, destinationPath) => {
        if (destinationPath === statePath) throw exdev();
        await defaultDurableFileOperations.rename(sourcePath, destinationPath);
      },
    };
    const transaction = await stageDatabaseRecovery({
      statePath,
      snapshotPath,
      corruptDirectory: path.join(directory, "corrupt-databases"),
      archiveLabel: "fixture",
      operations,
    });
    assert.equal(await readFile(statePath, "utf8"), "new-snapshot");
    await assert.rejects(() => readFile(`${statePath}-wal`), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
    await assert.rejects(() => readFile(`${statePath}-shm`), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
    for (const [extension, value] of originals) {
      assert.equal(await readFile(transaction.archivedPaths.get(extension as "" | "-wal" | "-shm")!, "utf8"), value);
    }
    await transaction.commit();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("failure while archiving any db/wal/shm member leaves the entire original group unchanged", async () => {
  for (const failAt of [1, 2, 3]) {
    const directory = await mkdtemp(path.join(os.tmpdir(), `cso-db-archive-${failAt}-`));
    const statePath = path.join(directory, "state", "organizer.db");
    const snapshotPath = path.join(directory, "snapshot.sqlite");
    const originals = await writeDatabaseGroup(statePath);
    await writeFile(snapshotPath, "new-snapshot", "utf8");
    let archivedCopies = 0;
    try {
      const operations: DurableFileOperations = {
        ...defaultDurableFileOperations,
        copyFile: async (sourcePath, destinationPath) => {
          if (destinationPath.includes("corrupt-databases")) {
            archivedCopies += 1;
            if (archivedCopies === failAt) throw new Error(`archive member ${failAt} failed`);
          }
          await defaultDurableFileOperations.copyFile(sourcePath, destinationPath);
        },
      };
      await assert.rejects(
        () => stageDatabaseRecovery({
          statePath,
          snapshotPath,
          corruptDirectory: path.join(directory, "corrupt-databases"),
          archiveLabel: "fixture",
          operations,
        }),
        (error: DatabaseRecoveryError) => error.phase === "archive",
      );
      await assertDatabaseGroup(statePath, originals);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("an interrupted EXDEV snapshot install restores the original db/wal/shm group", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cso-db-install-rollback-"));
  const statePath = path.join(directory, "state", "organizer.db");
  const snapshotPath = path.join(directory, "snapshot.sqlite");
  const originals = await writeDatabaseGroup(statePath);
  await writeFile(snapshotPath, "new-snapshot", "utf8");
  let failed = false;
  try {
    const operations: DurableFileOperations = {
      ...defaultDurableFileOperations,
      rename: async (sourcePath, destinationPath) => {
        if (destinationPath === statePath) throw exdev();
        await defaultDurableFileOperations.rename(sourcePath, destinationPath);
      },
      copyFile: async (sourcePath, destinationPath) => {
        if (!failed && destinationPath === statePath && sourcePath.includes(".recovery-")) {
          failed = true;
          await writeFile(destinationPath, "partial-snapshot", "utf8");
          throw new Error("snapshot install interrupted");
        }
        await defaultDurableFileOperations.copyFile(sourcePath, destinationPath);
      },
    };
    await assert.rejects(
      () => stageDatabaseRecovery({
        statePath,
        snapshotPath,
        corruptDirectory: path.join(directory, "corrupt-databases"),
        archiveLabel: "fixture",
        operations,
      }),
      (error: DatabaseRecoveryError) => error.phase === "snapshot-install",
    );
    await assertDatabaseGroup(statePath, originals);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a sidecar removal failure cannot leave only part of the original WAL/SHM pair moved", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cso-db-sidecar-rollback-"));
  const statePath = path.join(directory, "state", "organizer.db");
  const snapshotPath = path.join(directory, "snapshot.sqlite");
  const originals = await writeDatabaseGroup(statePath);
  await writeFile(snapshotPath, "new-snapshot", "utf8");
  let failed = false;
  try {
    const operations: DurableFileOperations = {
      ...defaultDurableFileOperations,
      unlink: async (filePath) => {
        if (!failed && filePath === `${statePath}-shm`) {
          failed = true;
          throw new Error("simulated SHM removal failure");
        }
        await defaultDurableFileOperations.unlink(filePath);
      },
    };
    await assert.rejects(
      () => stageDatabaseRecovery({
        statePath,
        snapshotPath,
        corruptDirectory: path.join(directory, "corrupt-databases"),
        archiveLabel: "fixture",
        operations,
      }),
      (error: DatabaseRecoveryError) => error.phase === "snapshot-install",
    );
    await assertDatabaseGroup(statePath, originals);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
