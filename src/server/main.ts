import { access, mkdir, readFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { InventoryService } from "../core/inventory-service.js";
import { startOrganizerHttpServer } from "./http-server.js";
import { SessionManager } from "./auth.js";
import { restrictRuntimeAcl } from "./windows-acl.js";
import { publishRuntimeDescriptor } from "./runtime-descriptor.js";
import {
  PRODUCT_NAME,
  PRODUCT_VERSION,
  PROTOCOL_MAX,
  PROTOCOL_MIN,
  PROTOCOL_VERSION,
  SERVICE_ID,
} from "../shared/version.js";
import { resolveServerDataDirectory } from "./server-data-directory.js";
import { ServiceLifecycle } from "./service-lifecycle.js";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const appRoot = existsSync(path.join(moduleDirectory, "public"))
  ? moduleDirectory
  : path.resolve(moduleDirectory, "..", "..", "dist");
const installRoot = process.env.CSO_INSTALL_ROOT || path.dirname(appRoot);
const publicDirectory = path.join(appRoot, "public");
const runtimeDirectory = resolveServerDataDirectory({
  argv: process.argv.slice(2),
  environment: process.env,
  homeDirectory: os.homedir(),
  temporaryDirectory: os.tmpdir(),
  parentProcessId: process.ppid,
  platform: process.platform,
});
const runtimePath = path.join(runtimeDirectory, "runtime.json");
const statePath = path.join(runtimeDirectory, "organizer.db");

async function exists(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function protectRuntimeStateFiles(): Promise<void> {
  for (const candidate of [statePath, `${statePath}-wal`, `${statePath}-shm`, `${statePath}.snapshots`]) {
    if (await exists(candidate)) {
      await restrictRuntimeAcl(candidate, { recursive: candidate.endsWith(".snapshots") });
    }
  }
}

await mkdir(runtimeDirectory, { recursive: true });
await restrictRuntimeAcl(runtimeDirectory);
await protectRuntimeStateFiles();

const inventory = new InventoryService({ statePath });
const snapshot = await inventory.initialize();
await protectRuntimeStateFiles();
const sessions = new SessionManager();
const idleTimeoutMs = 30 * 60 * 1_000;
const sessionProjectTtlMs = 5 * 60 * 1_000;
const lifecycle = new ServiceLifecycle({
  idleTimeoutMs,
  desktopLeaseTtlMs: 90_000,
});
const running = await startOrganizerHttpServer({
  inventory,
  publicDirectory,
  version: PRODUCT_VERSION,
  protocolVersion: PROTOCOL_VERSION,
  sessionManager: sessions,
  serviceLifecycle: lifecycle,
});
const descriptor = {
  service: SERVICE_ID,
  version: PRODUCT_VERSION,
  protocolVersion: PROTOCOL_VERSION,
  protocolMin: PROTOCOL_MIN,
  protocolMax: PROTOCOL_MAX,
  pid: process.pid,
  port: running.port,
  host: running.host,
  token: running.bootstrapToken,
  credentialExpiresAt: sessions.credentialExpiresAt,
  startedAt: new Date().toISOString(),
  installRoot,
};
await publishRuntimeDescriptor(runtimePath, descriptor, { protectFile: restrictRuntimeAcl });

console.log(`${PRODUCT_NAME} 已启动：${running.baseUrl}`);
console.log(`物理 ${snapshot.summary.total} 项，Codex 运行时 ${snapshot.summary.runtimeVisible} 项。`);
if (!snapshot.runtimeAvailable) console.warn(`Codex 运行时不可用：${snapshot.runtimeError}`);

let closing = false;
const credentialTimer = setTimeout(() => {
  void shutdown().finally(() => process.exit(0));
}, Math.max(1, sessions.credentialExpiresAt - Date.now()));
credentialTimer.unref();
const idleTimer = setInterval(() => {
  if (closing || !lifecycle.shouldShutdown()) return;
  void shutdown().finally(() => process.exit(0));
}, 60_000);
idleTimer.unref();
let sessionProjectSweep: Promise<unknown> | null = null;
const sessionProjectTimer = setInterval(() => {
  if (closing || sessionProjectSweep) return;
  sessionProjectSweep = inventory.pruneExpiredSessionProjects(sessionProjectTtlMs)
    .catch(() => {
      console.warn("Codex 会话项目根过期清理暂未完成；下次周期将重试");
    })
    .finally(() => {
      sessionProjectSweep = null;
    });
}, 60_000);
sessionProjectTimer.unref();
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  clearTimeout(credentialTimer);
  clearInterval(idleTimer);
  clearInterval(sessionProjectTimer);
  await running.close().catch(() => undefined);
  await inventory.close().catch(() => undefined);
  try {
    const current = JSON.parse(await readFile(runtimePath, "utf8")) as { token?: string };
    if (current.token === descriptor.token) await unlink(runtimePath);
  } catch {
    // The descriptor may already be gone after an interrupted start.
  }
}

process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
process.once("uncaughtException", (error) => {
  console.error(error);
  void shutdown().finally(() => process.exit(1));
});
process.once("unhandledRejection", (error) => {
  console.error(error);
  void shutdown().finally(() => process.exit(1));
});
