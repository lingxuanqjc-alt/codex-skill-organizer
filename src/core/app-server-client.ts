import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolveCodexCommand } from "./codex-locations.js";
import { normalizeWindowsComparable } from "./path-identity.js";
import type { RuntimeSkill } from "../shared/types.js";
import { PRODUCT_VERSION } from "../shared/version.js";

interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

interface JsonRpcMessage {
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: JsonRpcError;
  [key: string]: unknown;
}

export interface SkillsListEntry {
  cwd: string;
  skills: RuntimeSkill[];
  errors: Array<{ path: string; message: string }>;
}

export interface AppServerProcess {
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  pid?: number;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
}

export interface AppServerClientOptions {
  command?: string;
  requestTimeoutMs?: number;
  spawnFactory?: (command: string, args: string[]) => AppServerProcess;
  clientVersion?: string;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

function isRuntimeSkill(value: unknown): value is RuntimeSkill {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return typeof item.name === "string"
    && typeof item.description === "string"
    && typeof item.path === "string"
    && typeof item.enabled === "boolean"
    && ["user", "repo", "system", "admin"].includes(String(item.scope))
    && (item.pluginId === null || typeof item.pluginId === "string");
}

function validateSkillsListResponse(value: unknown): SkillsListEntry[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("skills/list 返回值不是对象");
  }
  const data = (value as Record<string, unknown>).data;
  if (!Array.isArray(data)) throw new Error("skills/list 缺少 data 数组");
  return data.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("skills/list data 条目无效");
    }
    const item = entry as Record<string, unknown>;
    if (typeof item.cwd !== "string" || !Array.isArray(item.skills) || !item.skills.every(isRuntimeSkill)) {
      throw new Error("skills/list data 条目字段无效");
    }
    const errors = Array.isArray(item.errors)
      ? item.errors.filter(
        (error): error is { path: string; message: string } => Boolean(
          error
          && typeof error === "object"
          && typeof (error as Record<string, unknown>).path === "string"
          && typeof (error as Record<string, unknown>).message === "string",
        ),
      )
      : [];
    return { cwd: item.cwd, skills: item.skills as RuntimeSkill[], errors };
  });
}

export class AppServerClient extends EventEmitter {
  readonly #options: Required<Pick<AppServerClientOptions, "requestTimeoutMs" | "clientVersion">>
    & Omit<AppServerClientOptions, "requestTimeoutMs" | "clientVersion">;
  #process: AppServerProcess | null = null;
  #pending = new Map<string, PendingRequest>();
  #buffer = "";
  #stderrTail: string[] = [];
  #nextRequestId = 1;
  #initialized = false;
  #knownPaths = new Map<string, RuntimeSkill>();
  #lastCwds: string[] = [];

  constructor(options: AppServerClientOptions = {}) {
    super();
    this.#options = {
      ...options,
      requestTimeoutMs: options.requestTimeoutMs ?? 15_000,
      clientVersion: options.clientVersion ?? PRODUCT_VERSION,
    };
  }

  get isRunning(): boolean {
    return this.#process !== null && this.#initialized;
  }

  get stderrTail(): readonly string[] {
    return this.#stderrTail;
  }

  async start(): Promise<void> {
    if (this.#process) return;
    const command = this.#options.command ?? await resolveCodexCommand();
    const spawnFactory = this.#options.spawnFactory ?? ((resolvedCommand, args) =>
      spawn(resolvedCommand, args, {
        stdio: "pipe",
        windowsHide: true,
        shell: false,
      }) as ChildProcessWithoutNullStreams);

    this.#process = spawnFactory(command, ["app-server", "--stdio"]);
    this.#process.stdout.setEncoding?.("utf8");
    this.#process.stderr.setEncoding?.("utf8");
    this.#process.stdout.on("data", (chunk) => this.#handleStdout(String(chunk)));
    this.#process.stderr.on("data", (chunk) => this.#handleStderr(String(chunk)));
    this.#process.on("error", (error) => this.#handleExit(error));
    this.#process.on("exit", (code, signal) => {
      this.#handleExit(new Error(`codex app-server 已退出（code=${code}, signal=${signal ?? "none"}）`));
    });

    try {
      await this.#requestRaw("initialize", {
        clientInfo: {
          name: "codex_skill_organizer",
          title: "Codex Skill Organizer",
          version: this.#options.clientVersion,
        },
      }, "initialize");
      this.#write({ method: "initialized", params: {} });
      this.#initialized = true;
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    const current = this.#process;
    this.#process = null;
    this.#initialized = false;
    if (current) current.kill("SIGTERM");
    this.#rejectAll(new Error("codex app-server 已停止"));
  }

  async listSkills(cwds: string[], forceReload = false): Promise<SkillsListEntry[]> {
    if (!this.#initialized) throw new Error("codex app-server 尚未初始化");
    const uniqueCwds = [...new Set(cwds.map((cwd) => cwd.trim()).filter(Boolean))];
    const result = await this.#requestRaw("skills/list", { cwds: uniqueCwds, forceReload });
    const entries = validateSkillsListResponse(result);
    this.#knownPaths.clear();
    for (const entry of entries) {
      for (const skill of entry.skills) {
        this.#knownPaths.set(normalizeWindowsComparable(skill.path), skill);
      }
    }
    this.#lastCwds = uniqueCwds;
    return entries;
  }

  async setSkillEnabled(skillPath: string, enabled: boolean): Promise<boolean> {
    if (!this.#initialized) throw new Error("codex app-server 尚未初始化");
    const normalizedPath = normalizeWindowsComparable(skillPath);
    if (!this.#knownPaths.has(normalizedPath)) {
      throw new Error("拒绝写入：路径不在最近一次 skills/list 结果中");
    }
    const result = await this.#requestRaw("skills/config/write", { path: skillPath, enabled });
    if (!result || typeof result !== "object" || typeof (result as Record<string, unknown>).effectiveEnabled !== "boolean") {
      throw new Error("skills/config/write 返回值无效");
    }
    const entries = await this.listSkills(this.#lastCwds, true);
    const readback = entries.flatMap((entry) => entry.skills)
      .find((skill) => normalizeWindowsComparable(skill.path) === normalizedPath);
    if (!readback || readback.enabled !== enabled) {
      throw new Error("启停写入后的回读状态不一致");
    }
    return readback.enabled;
  }

  #requestRaw(method: string, params: unknown, explicitId?: string): Promise<unknown> {
    const id = explicitId ?? `cso-${this.#nextRequestId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method} 请求超时`));
      }, this.#options.requestTimeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      try {
        this.#write({ method, id, params });
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  #write(message: JsonRpcMessage): void {
    if (!this.#process) throw new Error("codex app-server 进程不可用");
    this.#process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #handleStdout(chunk: string): void {
    this.#buffer += chunk;
    while (true) {
      const lineEnd = this.#buffer.indexOf("\n");
      if (lineEnd < 0) break;
      const line = this.#buffer.slice(0, lineEnd).trim();
      this.#buffer = this.#buffer.slice(lineEnd + 1);
      if (!line) continue;
      let message: JsonRpcMessage;
      try {
        message = JSON.parse(line) as JsonRpcMessage;
      } catch {
        this.emit("protocolError", new Error("app-server stdout 包含无效 JSONL"));
        continue;
      }
      if (message.id !== undefined) {
        const key = String(message.id);
        const pending = this.#pending.get(key);
        if (!pending) continue;
        clearTimeout(pending.timer);
        this.#pending.delete(key);
        if (message.error) pending.reject(new Error(`${message.error.code}: ${message.error.message}`));
        else pending.resolve(message.result);
        continue;
      }
      if (message.method === "skills/changed") this.emit("skillsChanged");
      else if (message.method) this.emit("notification", message);
    }
  }

  #handleStderr(chunk: string): void {
    this.#stderrTail.push(...chunk.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
    if (this.#stderrTail.length > 50) this.#stderrTail.splice(0, this.#stderrTail.length - 50);
  }

  #handleExit(error: Error): void {
    this.#process = null;
    this.#initialized = false;
    this.#rejectAll(error);
    this.emit("exit", error);
  }

  #rejectAll(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}
