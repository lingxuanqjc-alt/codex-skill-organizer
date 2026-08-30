import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const helperPath = path.resolve("scripts", "runtime", "backup-state.mjs");

interface RunHelperOptions {
  simulateRenameExdev?: boolean;
  simulateFinalCopyFailure?: boolean;
}

function filesystemPreload(options: RunHelperOptions): string | null {
  if (!options.simulateRenameExdev && !options.simulateFinalCopyFailure) return null;
  const source = `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    const originalCopyFile = fs.promises.copyFile.bind(fs.promises);
    ${options.simulateRenameExdev ? `
      fs.promises.rename = async () => {
        throw Object.assign(new Error("simulated encrypted-directory rename failure"), { code: "EXDEV" });
      };
    ` : ""}
    ${options.simulateFinalCopyFailure ? `
      fs.promises.copyFile = async (sourcePath, destinationPath, ...rest) => {
        if (String(sourcePath).includes("upgrade-backup-result.json.next-")
          && String(destinationPath).endsWith("upgrade-backup-result.json")) {
          throw Object.assign(new Error("simulated final copy failure"), { code: "EIO" });
        }
        return originalCopyFile(sourcePath, destinationPath, ...rest);
      };
    ` : ""}
    syncBuiltinESMExports();
  `;
  return `data:text/javascript,${encodeURIComponent(source)}`;
}

async function runHelper(
  dataDirectory: string,
  version = "0.2.0",
  options: RunHelperOptions = {},
): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  const preload = filesystemPreload(options);
  const arguments_ = [
    ...(preload ? ["--import", preload] : []),
    helperPath,
    "--data-dir",
    dataDirectory,
    "--version",
    version,
  ];
  const child = spawn(process.execPath, arguments_, { stdio: ["ignore", "pipe", "pipe"] });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const code = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (value) => resolve(value ?? -1));
  });
  return {
    code,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  };
}

test("upgrade backup captures an online WAL database and keeps the newest ten verified snapshots", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cso-upgrade-backup-"));
  const sourcePath = path.join(root, "organizer.db");
  const source = new DatabaseSync(sourcePath);
  t.after(async () => {
    source.close();
    await rm(root, { recursive: true, force: true });
  });
  source.exec("PRAGMA journal_mode=WAL; CREATE TABLE intent(value TEXT NOT NULL); INSERT INTO intent VALUES ('preserve-me');");

  for (let index = 0; index < 12; index += 1) {
    source.prepare("INSERT INTO intent VALUES (?)").run(`row-${index}`);
    const result = await runHelper(root);
    assert.equal(result.code, 0, result.stderr);
    await new Promise((resolve) => setTimeout(resolve, 3));
  }

  const marker = JSON.parse(await readFile(path.join(root, "upgrade-backup-result.json"), "utf8")) as {
    schemaVersion: number;
    version: string;
    sourceExisted: boolean;
    backupRelativePath: string;
  };
  assert.deepEqual(
    { schemaVersion: marker.schemaVersion, version: marker.version, sourceExisted: marker.sourceExisted },
    { schemaVersion: 1, version: "0.2.0", sourceExisted: true },
  );
  assert.match(marker.backupRelativePath, /^upgrade-backups\/organizer-before-0\.2\.0-.+\.sqlite$/u);
  const backups = (await readdir(path.join(root, "upgrade-backups"))).filter((name) => name.endsWith(".sqlite"));
  assert.equal(backups.length, 10, "upgrade snapshots are time-ordered and capped at ten");

  const verified = new DatabaseSync(path.join(root, ...marker.backupRelativePath.split("/")), { readOnly: true });
  try {
    assert.equal(verified.prepare("SELECT value FROM intent ORDER BY rowid LIMIT 1").get()?.value, "preserve-me");
    assert.equal(Object.values(verified.prepare("PRAGMA integrity_check").get() ?? {})[0], "ok");
  } finally {
    verified.close();
  }
});

test("upgrade backup records a clean first install without inventing a database", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cso-first-install-backup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await runHelper(root);
  assert.equal(result.code, 0, result.stderr);
  const marker = JSON.parse(await readFile(path.join(root, "upgrade-backup-result.json"), "utf8"));
  assert.equal(marker.sourceExisted, false);
  assert.equal(marker.backupRelativePath, null);
});

test("an EFS-style EXDEV result rename falls back to a verified durable copy", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cso-first-install-exdev-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = await runHelper(root, "0.2.0", { simulateRenameExdev: true });
  assert.equal(result.code, 0, result.stderr);
  const marker = JSON.parse(await readFile(path.join(root, "upgrade-backup-result.json"), "utf8"));
  assert.equal(marker.sourceExisted, false);
  assert.equal(marker.backupRelativePath, null);
  assert.deepEqual(
    (await readdir(root)).filter((name) => name.includes("upgrade-backup-result.json.next-")),
    [],
    "the durable journal is removed only after the final bytes were verified",
  );
});

test("a failed EXDEV fallback restores an existing valid result and fails closed", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cso-result-rollback-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const resultPath = path.join(root, "upgrade-backup-result.json");
  const previous = `${JSON.stringify({
    schemaVersion: 1,
    version: "0.1.9",
    sourceExisted: false,
    backupRelativePath: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  }, null, 2)}\n`;
  await writeFile(resultPath, previous, "utf8");

  const result = await runHelper(root, "0.2.0", {
    simulateRenameExdev: true,
    simulateFinalCopyFailure: true,
  });
  assert.notEqual(result.code, 0);
  assert.equal(
    await readFile(resultPath, "utf8"),
    previous,
    "a failed replacement must not destroy the last valid installer result",
  );
});

test("a corrupt database fails closed and does not emit a successful upgrade marker", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cso-corrupt-upgrade-backup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "organizer.db"), "not a sqlite database", "utf8");
  const result = await runHelper(root);
  assert.notEqual(result.code, 0);
  await assert.rejects(readFile(path.join(root, "upgrade-backup-result.json"), "utf8"), { code: "ENOENT" });
});
