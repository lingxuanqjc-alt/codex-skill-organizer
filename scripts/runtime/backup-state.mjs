import { randomUUID } from "node:crypto";
import { DatabaseSync, backup } from "node:sqlite";
import { constants as fsConstants } from "node:fs";
import { copyFile, mkdir, open, readFile, readdir, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const dataDirectory = argument("--data-dir");
const version = argument("--version");
if (!dataDirectory || !path.isAbsolute(dataDirectory) || !version || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(version)) {
  process.stderr.write("Usage: backup-state.mjs --data-dir <absolute path> --version <semver>\n");
  process.exit(64);
}

const resolvedDataDirectory = path.resolve(dataDirectory);
const sourcePath = path.join(resolvedDataDirectory, "organizer.db");
const resultPath = path.join(resolvedDataDirectory, "upgrade-backup-result.json");
await mkdir(resolvedDataDirectory, { recursive: true });

async function syncFile(filePath) {
  const handle = await open(filePath, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function copyDurably(source, destination) {
  await copyFile(source, destination);
  await syncFile(destination);
}

async function verifyExactCopy(source, destination) {
  const [expected, actual] = await Promise.all([readFile(source), readFile(destination)]);
  if (!expected.equals(actual)) throw new Error("Upgrade backup result copy verification failed");
}

async function removePartialResult(filePath) {
  try {
    await unlink(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function writeResult(value) {
  const nextPath = `${resultPath}.next-${randomUUID()}`;
  const previousPath = `${resultPath}.previous-${randomUUID()}`;
  const handle = await open(nextPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    await rename(nextPath, resultPath);
    return;
  } catch (error) {
    if (error?.code !== "EXDEV") throw error;
  }

  // Windows EFS can reject a same-directory rename with EXDEV. Keep the
  // durable journal until a byte-for-byte verified copy reaches the final
  // path. If a previous result exists, preserve it durably and restore it on
  // any replacement failure so a failed attempt never destroys valid state.
  let previousExists = false;
  try {
    await copyFile(resultPath, previousPath, fsConstants.COPYFILE_EXCL);
    await syncFile(previousPath);
    previousExists = true;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  try {
    await copyDurably(nextPath, resultPath);
    await verifyExactCopy(nextPath, resultPath);
  } catch (replacementError) {
    if (previousExists) {
      try {
        await copyDurably(previousPath, resultPath);
        await verifyExactCopy(previousPath, resultPath);
      } catch (restoreError) {
        throw new AggregateError(
          [replacementError, restoreError],
          "Upgrade backup result replacement and rollback both failed",
        );
      }
    } else {
      try {
        await removePartialResult(resultPath);
      } catch (cleanupError) {
        throw new AggregateError(
          [replacementError, cleanupError],
          "Upgrade backup result replacement failed and its partial result could not be removed",
        );
      }
    }
    throw replacementError;
  }

  await unlink(nextPath);
  if (previousExists) await unlink(previousPath);
}

try {
  const info = await stat(sourcePath);
  if (!info.isFile()) throw new Error("organizer.db is not a regular file");
} catch (error) {
  if (error?.code === "ENOENT") {
    await writeResult({
      schemaVersion: 1,
      version,
      sourceExisted: false,
      backupRelativePath: null,
      createdAt: new Date().toISOString(),
    });
    process.stdout.write("No 0.2 SQLite database exists yet; upgrade backup is not required.\n");
    process.exit(0);
  }
  throw error;
}

const backupDirectory = path.join(resolvedDataDirectory, "upgrade-backups");
await mkdir(backupDirectory, { recursive: true });
const timestamp = new Date().toISOString().replace(/[:.]/gu, "-");
const destinationPath = path.join(backupDirectory, `organizer-before-${version}-${timestamp}.sqlite`);
const source = new DatabaseSync(sourcePath, { readOnly: true });
try {
  await backup(source, destinationPath);
} finally {
  source.close();
}

const verification = new DatabaseSync(destinationPath, { readOnly: true });
try {
  const row = verification.prepare("PRAGMA integrity_check").get();
  if (!row || Object.values(row)[0] !== "ok") throw new Error("SQLite upgrade backup failed integrity_check");
} finally {
  verification.close();
}

const backupNames = (await readdir(backupDirectory, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && /^organizer-before-.+\.sqlite$/u.test(entry.name))
  .map((entry) => entry.name);
const backups = await Promise.all(backupNames.map(async (name) => ({
  name,
  mtimeMs: (await stat(path.join(backupDirectory, name))).mtimeMs,
})));
backups.sort((left, right) => left.mtimeMs - right.mtimeMs || left.name.localeCompare(right.name, "en"));
for (const stale of backups.slice(0, Math.max(0, backups.length - 10))) {
  await unlink(path.join(backupDirectory, stale.name));
}
await writeResult({
  schemaVersion: 1,
  version,
  sourceExisted: true,
  backupRelativePath: `upgrade-backups/${path.basename(destinationPath)}`,
  createdAt: new Date().toISOString(),
});
process.stdout.write(`Created verified SQLite upgrade backup: ${path.basename(destinationPath)}\n`);
