import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  resolveTrustedWindowsSystemExecutable,
  restrictRuntimeAcl,
} from "../src/server/windows-acl.js";

test("Windows system executable resolution follows the validated system root instead of the user-home drive", () => {
  assert.equal(
    resolveTrustedWindowsSystemExecutable("icacls.exe", "D:\\Windows"),
    "D:\\Windows\\System32\\icacls.exe",
  );
  assert.throws(() => resolveTrustedWindowsSystemExecutable("whoami.exe", "relative"), /local absolute/u);
  assert.throws(
    () => resolveTrustedWindowsSystemExecutable("whoami.exe", "\\\\server\\share\\Windows"),
    /local absolute/u,
  );
});

test("recursive runtime ACL keeps every protected snapshot readable and removable by the current user", {
  skip: process.platform !== "win32",
}, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cso-acl-"));
  const snapshotDirectory = path.join(root, "organizer.db.snapshots");
  const snapshotPath = path.join(snapshotDirectory, "state.sqlite");
  await mkdir(snapshotDirectory);
  await writeFile(snapshotPath, "verified snapshot", "utf8");
  t.after(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  await restrictRuntimeAcl(root, { recursive: true });
  assert.equal(await readFile(snapshotPath, "utf8"), "verified snapshot");
  await rm(snapshotPath);
  assert.equal(await readFile(path.join(root, "missing"), "utf8").catch(() => null), null);
});
