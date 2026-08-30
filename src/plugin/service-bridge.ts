import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  BatchOperationResult,
  ClassificationPatch,
  InventorySnapshot,
} from "../shared/types.js";
import {
  isCompatibleProtocol,
  PROTOCOL_VERSION,
  SERVICE_ID,
} from "../shared/version.js";
import { resolveOrganizerDataDirectory } from "../shared/local-data-directory.js";

export interface RuntimeDescriptor {
  service: typeof SERVICE_ID;
  version: string;
  protocolVersion: string;
  protocolMin: string;
  protocolMax: string;
  pid: number;
  port: number;
  host: "127.0.0.1";
  token: string;
  credentialExpiresAt: number;
  installRoot: string;
}

export const RUNTIME_CREDENTIAL_REUSE_MARGIN_MS = 1_000;
export const SERVICE_START_FAILED_MESSAGE = "SERVICE_START_FAILED: Skill Organizer 本地服务启动失败；请打开桌面工作台查看详细诊断。";

export function modelSafeServiceStartFailure(_error: unknown): Error {
  return new Error(SERVICE_START_FAILED_MESSAGE);
}

export function isReusableRuntimeCredential(expiresAt: unknown, now = Date.now()): boolean {
  return Number.isSafeInteger(expiresAt)
    && Number(expiresAt) - now > RUNTIME_CREDENTIAL_REUSE_MARGIN_MS;
}

export interface OrganizerDiagnostics {
  version: string;
  roots: Array<{ id: string; label: string; path: string }>;
  cwd: string;
  runtimeAvailable: boolean;
  runtimeError: string | null;
  scanErrors: Array<{ path: string; message: string }>;
  orphanOverrideIds: string[];
  counts: InventorySnapshot["summary"];
  appServerStderr: string[];
}

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.basename(moduleDirectory).toLowerCase() === "dist"
  ? path.resolve(moduleDirectory, "..")
  : path.resolve(moduleDirectory, "..", "..");
const dataDirectory = resolveOrganizerDataDirectory(os.homedir());
const runtimePath = path.join(dataDirectory, "runtime.json");

export interface TrustedServiceLauncherRuntime {
  platform: NodeJS.Platform;
  homedir(): string;
  packageRoot: string;
  exists(filePath: string): boolean;
}

export function resolveTrustedServiceLauncher(runtime: TrustedServiceLauncherRuntime): string | null {
  if (runtime.platform !== "win32") return null;
  const stableLauncher = path.join(
    runtime.homedir(),
    "AppData",
    "Local",
    "Programs",
    "SkillOrganizerForCodex",
    "SkillOrganizerForCodex.exe",
  );
  if (runtime.exists(stableLauncher)) return stableLauncher;

  // A portable sidecar runs from <payload>/app/dist. The sibling executable
  // and pinned runtime are the only fallback; no environment path is accepted.
  if (path.basename(runtime.packageRoot).toLocaleLowerCase("en-US") !== "app") return null;
  const payloadRoot = path.dirname(path.resolve(runtime.packageRoot));
  const payloadLauncher = path.join(payloadRoot, "SkillOrganizerForCodex.exe");
  const payloadNode = path.join(payloadRoot, "runtime", "node.exe");
  const payloadServer = path.join(runtime.packageRoot, "dist", "server.mjs");
  return runtime.exists(payloadLauncher) && runtime.exists(payloadNode) && runtime.exists(payloadServer)
    ? payloadLauncher
    : null;
}

function serviceEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  delete environment.CSO_LAUNCHER_PATH;
  delete environment.CSO_NODE_PATH;
  delete environment.CODEX_CLI_PATH;
  delete environment.CSO_PROJECT_CWD;
  return environment;
}

function baseUrl(descriptor: RuntimeDescriptor): string {
  return `http://127.0.0.1:${descriptor.port}`;
}

async function readHealthyDescriptor(fetchImpl: typeof fetch): Promise<RuntimeDescriptor | null> {
  try {
    const descriptor = JSON.parse(await readFile(runtimePath, "utf8")) as Partial<RuntimeDescriptor>;
    if (
      descriptor.host !== "127.0.0.1"
      || descriptor.service !== SERVICE_ID
      || !Number.isInteger(descriptor.port)
      || Number(descriptor.port) < 1
      || Number(descriptor.port) > 65_535
      || typeof descriptor.token !== "string"
      || descriptor.token.length < 32
      || !isReusableRuntimeCredential(descriptor.credentialExpiresAt)
    ) return null;
    const response = await fetchImpl(`${baseUrl(descriptor as RuntimeDescriptor)}/api/health`, {
      signal: AbortSignal.timeout(2_500),
    });
    if (!response.ok) return null;
    const health = await response.json() as {
      ok?: boolean;
      service?: string;
      protocolVersion?: string;
    };
    if (!health.ok || health.service !== SERVICE_ID) return null;
    if (!isCompatibleProtocol(descriptor.protocolVersion) || !isCompatibleProtocol(health.protocolVersion)) {
      throw new Error(
        `Organizer 协议不兼容（服务 ${String(health.protocolVersion ?? descriptor.protocolVersion)}，插件 ${PROTOCOL_VERSION}）。请重启 Codex 后重试。`,
      );
    }
    return descriptor as RuntimeDescriptor;
  } catch (error) {
    if (error instanceof Error && error.message.includes("协议不兼容")) throw error;
    return null;
  }
}

async function waitForExit(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Organizer 启动入口在 45 秒内未结束"));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
  });
}

async function detachAfterSpawn(child: ReturnType<typeof spawn>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let spawned = false;
    child.once("spawn", () => {
      spawned = true;
      child.unref();
      resolve();
    });
    child.once("error", (error) => {
      if (!spawned) reject(error);
    });
  });
}

async function launchSharedServiceUnsafe(): Promise<void> {
  if (process.platform === "win32") {
    const installedLauncher = resolveTrustedServiceLauncher({
      platform: process.platform,
      homedir: os.homedir,
      packageRoot,
      exists: existsSync,
    });
    if (!installedLauncher) {
      if (path.basename(moduleDirectory).toLocaleLowerCase("en-US") === "dist") {
        throw new Error("未找到 Skill Organizer 受信任启动入口；请修复安装或重新解压完整便携包");
      }
      const developmentServer = path.join(packageRoot, "dist", "server.mjs");
      if (!existsSync(developmentServer)) {
        throw new Error("未找到 Skill Organizer 桌面程序；请修复安装或从 Windows 安装器重新安装");
      }
      const developmentChild = spawn(process.execPath, [developmentServer], {
        cwd: packageRoot,
        detached: true,
        windowsHide: true,
        stdio: "ignore",
        env: serviceEnvironment(),
      });
      await detachAfterSpawn(developmentChild);
      return;
    }
    const child = spawn(installedLauncher, ["--headless", "--ensure-service"], {
      cwd: path.dirname(installedLauncher),
      windowsHide: true,
      stdio: "ignore",
      env: serviceEnvironment(),
    });
    const exitCode = await waitForExit(child, 45_000);
    if (exitCode !== 0) throw new Error(`Organizer launcher exited with code ${exitCode}`);
    return;
  }

  const serverPath = path.join(packageRoot, "dist", "server.mjs");
  const child = spawn(process.execPath, [serverPath], {
    cwd: packageRoot,
    detached: true,
    stdio: "ignore",
    env: serviceEnvironment(),
  });
  await detachAfterSpawn(child);
}

async function launchSharedService(): Promise<void> {
  try {
    await launchSharedServiceUnsafe();
  } catch (error) {
    throw modelSafeServiceStartFailure(error);
  }
}

export class OrganizerServiceBridge {
  #descriptor: RuntimeDescriptor | null = null;
  #ensurePromise: Promise<RuntimeDescriptor> | null = null;
  readonly #sessionId: string;
  readonly #readHealthyDescriptor: () => Promise<RuntimeDescriptor | null>;
  readonly #launchService: () => Promise<void>;
  readonly #fetch: typeof fetch;
  #sessionProjectPaths: string[] = [];
  #registeredProjectContextKey: string | null = null;
  #registeredProjectDescriptor: RuntimeDescriptor | null = null;
  #projectContextRequestPromise: Promise<void> | null = null;
  #sessionCleanupPromise: Promise<void> | null = null;
  #sessionCleanupStarted = false;
  #projectRootsProvider: (() => Promise<string[]>) | null = null;
  #projectRootsRevision = 0;
  #projectRootsAppliedRevision = -1;
  #projectRootsRefreshPromise: Promise<void> | null = null;

  constructor(options: {
    sessionId?: string;
    readHealthyDescriptor?: () => Promise<RuntimeDescriptor | null>;
    launchService?: () => Promise<void>;
    fetchImpl?: typeof fetch;
  } = {}) {
    this.#sessionId = options.sessionId ?? randomUUID();
    this.#fetch = options.fetchImpl ?? fetch;
    this.#readHealthyDescriptor = options.readHealthyDescriptor ?? (() => readHealthyDescriptor(this.#fetch));
    this.#launchService = options.launchService ?? launchSharedService;
  }

  setSessionProjectRootsProvider(provider: () => Promise<string[]>): void {
    this.#projectRootsProvider = provider;
    this.#projectRootsRevision += 1;
  }

  async refreshSessionProjectRoots(): Promise<void> {
    if (!this.#projectRootsProvider || this.#projectRootsAppliedRevision === this.#projectRootsRevision) return;
    if (this.#projectRootsRefreshPromise) {
      await this.#projectRootsRefreshPromise;
      return this.refreshSessionProjectRoots();
    }
    const requestedRevision = this.#projectRootsRevision;
    this.#projectRootsRefreshPromise = (async () => {
      const paths = await this.#projectRootsProvider!();
      this.#setSessionProjectPaths(paths);
      this.#projectRootsAppliedRevision = requestedRevision;
      if (this.#descriptor) await this.#registerProjectContext(this.#descriptor);
    })();
    try {
      await this.#projectRootsRefreshPromise;
    } finally {
      this.#projectRootsRefreshPromise = null;
    }
    if (this.#projectRootsAppliedRevision !== this.#projectRootsRevision) {
      await this.refreshSessionProjectRoots();
    }
  }

  async sessionProjectRootsChanged(): Promise<void> {
    this.#projectRootsRevision += 1;
    await this.refreshSessionProjectRoots();
  }

  async clearSessionProjects(): Promise<void> {
    if (this.#sessionCleanupPromise) return this.#sessionCleanupPromise;
    this.#sessionCleanupStarted = true;
    this.#sessionCleanupPromise = (async () => {
      try {
        await this.#projectContextRequestPromise?.catch(() => undefined);
        const descriptor = this.#registeredProjectDescriptor;
        if (!descriptor) return;
        await this.#postSessionProjects(descriptor, [], 5_000);
      } catch {
        console.warn("Skill Organizer 未能清理本次 Codex 会话的项目根；清理过程不会启动新服务");
      } finally {
        this.#registeredProjectContextKey = null;
        this.#registeredProjectDescriptor = null;
      }
    })();
    return this.#sessionCleanupPromise;
  }

  async ensureService(force = false): Promise<RuntimeDescriptor> {
    await this.refreshSessionProjectRoots();
    if (!force && this.#descriptor) {
      await this.#registerProjectContext(this.#descriptor);
      return this.#descriptor;
    }
    if (this.#ensurePromise) return this.#ensurePromise;
    this.#ensurePromise = (async () => {
      const existing = await this.#readHealthyDescriptor();
      if (existing) {
        await this.#registerProjectContext(existing);
        return existing;
      }
      await this.#launchService();
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const descriptor = await this.#readHealthyDescriptor();
        if (descriptor) {
          await this.#registerProjectContext(descriptor);
          return descriptor;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      throw new Error("Organizer 本地服务在 30 秒内未就绪");
    })();
    try {
      this.#descriptor = await this.#ensurePromise;
      return this.#descriptor;
    } finally {
      this.#ensurePromise = null;
    }
  }

  async getInventory(refresh = false): Promise<InventorySnapshot> {
    return this.request(refresh ? "/api/rescan" : "/api/inventory", refresh ? { method: "POST" } : {});
  }

  async applyClassification(patch: ClassificationPatch): Promise<InventorySnapshot> {
    return this.request("/api/classification", { method: "PATCH", body: JSON.stringify(patch) });
  }

  async setEnabled(
    skillIds: string[],
    enabled: boolean,
    expectedRevision: string,
  ): Promise<BatchOperationResult> {
    return this.request("/api/runtime-enabled", {
      method: "POST",
      body: JSON.stringify({ skillIds, enabled, expectedRevision }),
    });
  }

  async diagnostics(): Promise<OrganizerDiagnostics> {
    return this.request("/api/diagnostics");
  }

  async submitSuggestions(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("/api/classification-suggestions", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async checkUpdates(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("/api/update-check", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async prepareQuarantine(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("/api/quarantine/prepare", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async quarantineInventory(): Promise<Record<string, unknown>> {
    return this.request("/api/quarantine");
  }

  async desktopUrl(): Promise<string> {
    const descriptor = await this.ensureService();
    return `${baseUrl(descriptor)}/#bootstrap=${encodeURIComponent(descriptor.token)}`;
  }

  async request<T>(pathname: string, init: RequestInit = {}, retried = false): Promise<T> {
    try {
      const descriptor = await this.ensureService(retried);
      await this.#registerProjectContext(descriptor, true);
      const url = `${baseUrl(descriptor)}${pathname}`;
      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${descriptor.token}`);
      if (init.body) headers.set("Content-Type", "application/json");
      if (init.method && !["GET", "HEAD"].includes(init.method)) headers.set("Origin", baseUrl(descriptor));
      const response = await this.#fetch(url, { ...init, headers, signal: AbortSignal.timeout(30_000) });
      const payload = await response.json() as T & { error?: string };
      if (response.status === 401 && !retried) {
        this.#descriptor = null;
        return this.request(pathname, init, true);
      }
      if (!response.ok) throw new Error(payload.error ?? `Organizer 请求失败（${response.status}）`);
      return payload;
    } catch (error) {
      if (!retried && error instanceof TypeError) {
        this.#descriptor = null;
        return this.request(pathname, init, true);
      }
      throw error;
    }
  }

  async #registerProjectContext(descriptor: RuntimeDescriptor, renew = false): Promise<void> {
    if (this.#sessionCleanupStarted) return;
    const signature = JSON.stringify(this.#sessionProjectPaths);
    const contextKey = `${descriptor.token}\0${signature}`;
    if (!renew && this.#registeredProjectContextKey === contextKey) return;
    if (this.#projectContextRequestPromise) {
      await this.#projectContextRequestPromise;
      return this.#registerProjectContext(descriptor, renew);
    }
    this.#projectContextRequestPromise = this.#postSessionProjects(descriptor, this.#sessionProjectPaths);
    try {
      await this.#projectContextRequestPromise;
      this.#registeredProjectContextKey = contextKey;
      this.#registeredProjectDescriptor = descriptor;
    } finally {
      this.#projectContextRequestPromise = null;
    }
  }

  async #postSessionProjects(
    descriptor: RuntimeDescriptor,
    projectPaths: readonly string[],
    timeoutMs = 30_000,
  ): Promise<void> {
    const origin = baseUrl(descriptor);
    const response = await this.#fetch(`${origin}/api/session-project`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${descriptor.token}`,
        "Content-Type": "application/json",
        Origin: origin,
      },
      body: JSON.stringify({ sessionId: this.#sessionId, projectPaths }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const payload = await response.json() as { error?: string };
    if (!response.ok) throw new Error(payload.error ?? `Organizer 会话项目注册失败（${response.status}）`);
  }

  #setSessionProjectPaths(paths: readonly string[]): void {
    const normalized = [...new Set(paths
      .filter((candidate) => path.isAbsolute(candidate))
      .map((candidate) => path.resolve(candidate)))]
      .sort((left, right) => left.localeCompare(right, "en-US"));
    const previous = JSON.stringify(this.#sessionProjectPaths);
    this.#sessionProjectPaths = normalized;
    if (JSON.stringify(normalized) !== previous) this.#registeredProjectContextKey = null;
  }
}
