import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { resolveOrganizerDataDirectory } from "../src/shared/local-data-directory.js";
import {
  INTERNAL_HEALTH_CHECK_ARGUMENT,
  INTERNAL_HEALTH_DATA_ROOT_ENV,
  INTERNAL_HEALTH_PARENT_PID_ENV,
  resolveServerDataDirectory,
} from "../src/server/server-data-directory.js";

async function exists(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function waitForFile(candidate: string, childExited: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await exists(candidate)) return;
    if (childExited()) throw new Error(`health-check server exited before writing ${candidate}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`health-check server did not write ${candidate}`);
}

test("ordinary server startup ignores internal and legacy data-root environment overrides", () => {
  const home = "C:\\Users\\fixture";
  assert.equal(resolveServerDataDirectory({
    argv: [],
    environment: {
      CSO_DATA_DIR: "C:\\attacker\\legacy",
      [INTERNAL_HEALTH_DATA_ROOT_ENV]: "C:\\attacker\\internal",
      [INTERNAL_HEALTH_PARENT_PID_ENV]: "1234",
    },
    homeDirectory: home,
    temporaryDirectory: "C:\\Temp",
    parentProcessId: 1234,
    platform: "win32",
  }), resolveOrganizerDataDirectory(home));
});

test("internal health root requires the direct desktop parent and generated local temporary shape", () => {
  const validRoot = `C:\\Temp\\SkillOrganizerForCodex-health\\${randomUUID().replaceAll("-", "")}`;
  const base = {
    argv: [INTERNAL_HEALTH_CHECK_ARGUMENT],
    environment: {
      CSO_DESKTOP_PID: "1234",
      [INTERNAL_HEALTH_DATA_ROOT_ENV]: validRoot,
      [INTERNAL_HEALTH_PARENT_PID_ENV]: "1234",
    },
    homeDirectory: "C:\\Users\\fixture",
    temporaryDirectory: "C:\\Temp",
    parentProcessId: 1234,
    platform: "win32" as const,
  };
  assert.equal(resolveServerDataDirectory(base), validRoot);
  assert.throws(
    () => resolveServerDataDirectory({ ...base, parentProcessId: 9999 }),
    /direct desktop parent/u,
  );
  assert.throws(
    () => resolveServerDataDirectory({
      ...base,
      environment: { ...base.environment, [INTERNAL_HEALTH_DATA_ROOT_ENV]: "C:\\Users\\fixture\\organizer" },
    }),
    /temporary boundary: parent mismatch/u,
  );
  assert.throws(
    () => resolveServerDataDirectory({
      ...base,
      environment: { ...base.environment, [INTERNAL_HEALTH_DATA_ROOT_ENV]: "\\\\server\\share\\organizer" },
    }),
    /temporary boundary: UNC path/u,
  );
  assert.throws(
    () => resolveServerDataDirectory({
      ...base,
      environment: { ...base.environment, [INTERNAL_HEALTH_DATA_ROOT_ENV]: "C:\\Temp\\SkillOrganizerForCodex-health\\not-a-guid" },
    }),
    /temporary boundary: invalid generated identifier/u,
  );
});

test("internal health server creates its database and descriptor without touching the release data root", {
  skip: process.platform !== "win32",
  timeout: 30_000,
}, async (t) => {
  const healthParent = path.join(os.tmpdir(), "SkillOrganizerForCodex-health");
  const healthRoot = path.join(healthParent, randomUUID().replaceAll("-", ""));
  const fakeHome = await mkdtemp(path.join(os.tmpdir(), "cso-health-home-"));
  const releaseDataRoot = resolveOrganizerDataDirectory(fakeHome);
  const serverEntry = fileURLToPath(new URL("../src/server/main.ts", import.meta.url));
  const child = spawn(process.execPath, ["--import", "tsx", serverEntry, INTERNAL_HEALTH_CHECK_ARGUMENT], {
    cwd: path.dirname(fileURLToPath(new URL("../package.json", import.meta.url))),
    env: {
      ...process.env,
      HOME: fakeHome,
      USERPROFILE: fakeHome,
      CODEX_HOME: path.join(fakeHome, ".codex"),
      CSO_DESKTOP_PID: String(process.pid),
      [INTERNAL_HEALTH_DATA_ROOT_ENV]: healthRoot,
      [INTERNAL_HEALTH_PARENT_PID_ENV]: String(process.pid),
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let exited = false;
  let stderr = "";
  const childExited = new Promise<void>((resolve) => child.once("exit", () => {
    exited = true;
    resolve();
  }));
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  t.after(async () => {
    if (!exited) {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 5_000);
        timer.unref();
        void childExited.then(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    await Promise.all([
      rm(healthRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
      rm(fakeHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
    ]);
  });

  const descriptorPath = path.join(healthRoot, "runtime.json");
  await waitForFile(descriptorPath, () => exited);
  assert.ok(await exists(path.join(healthRoot, "organizer.db")), "health-check database belongs to the temporary root");
  const descriptor = JSON.parse(await readFile(descriptorPath, "utf8")) as { pid?: number };
  assert.equal(descriptor.pid, child.pid, stderr);
  assert.equal(await exists(releaseDataRoot), false, "health-check startup must not create or migrate the release data root");
});
