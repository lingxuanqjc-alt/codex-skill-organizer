import { execFile as execFileCallback } from "node:child_process";
import { constants } from "node:fs";
import { access, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const CODEX_VERSION_PATTERN = /^codex-cli\s+\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?$/mu;

export interface CodexLocationRuntime {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  homedir(): string;
  access(filePath: string): Promise<void>;
  readdir(directory: string): Promise<Array<{ name: string; isDirectory(): boolean }>>;
  stat(filePath: string): Promise<{ mtimeMs: number }>;
  execFile(command: string, args: string[]): Promise<{ stdout: string; stderr: string }>;
}

const defaultRuntime: CodexLocationRuntime = {
  platform: process.platform,
  env: process.env,
  homedir: os.homedir,
  access: async (filePath) => access(filePath, constants.X_OK),
  readdir: async (directory) => readdir(directory, { withFileTypes: true }),
  stat: async (filePath) => stat(filePath),
  execFile: async (command, args) => {
    const result = await execFile(command, args, {
      windowsHide: true,
      timeout: 5_000,
      encoding: "utf8",
      maxBuffer: 128 * 1024,
    });
    return { stdout: result.stdout, stderr: result.stderr };
  },
};

function absoluteDirectory(value: string | undefined): string | null {
  if (!value?.trim() || !path.isAbsolute(value.trim())) return null;
  return path.resolve(value.trim());
}

export function resolveCodexHome(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  return absoluteDirectory(env.CODEX_HOME) ?? path.join(homedir(), ".codex");
}

async function desktopCandidates(runtime: CodexLocationRuntime, localAppData: string): Promise<string[]> {
  const binRoot = path.join(localAppData, "OpenAI", "Codex", "bin");
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    entries = await runtime.readdir(binRoot);
  } catch {
    return [];
  }
  const candidates = await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
    const candidate = path.join(binRoot, entry.name, "codex.exe");
    try {
      await runtime.access(candidate);
      const info = await runtime.stat(candidate);
      return { candidate, mtimeMs: info.mtimeMs };
    } catch {
      return null;
    }
  }));
  return candidates
    .filter((item): item is { candidate: string; mtimeMs: number } => item !== null)
    .sort((left, right) => right.mtimeMs - left.mtimeMs || left.candidate.localeCompare(right.candidate, "en-US"))
    .map((item) => item.candidate);
}

async function isCodexCli(runtime: CodexLocationRuntime, candidate: string): Promise<boolean> {
  try {
    await runtime.access(candidate);
    const result = await runtime.execFile(candidate, ["--version"]);
    return CODEX_VERSION_PATTERN.test(`${result.stdout}\n${result.stderr}`.trim());
  } catch {
    return false;
  }
}

export async function resolveCodexCommand(runtime: CodexLocationRuntime = defaultRuntime): Promise<string> {
  const candidates: string[] = [];
  const explicit = runtime.env.CSO_CODEX_CLI_PATH?.trim();
  if (explicit) {
    if (!path.isAbsolute(explicit)) {
      throw new Error("CSO_CODEX_CLI_PATH 必须是明确配置的绝对路径");
    }
    candidates.push(path.resolve(explicit));
  }

  if (runtime.platform === "win32") {
    // Do not use LOCALAPPDATA, CODEX_CLI_PATH, PATH, where.exe, or another
    // environment-derived executable root here. The native home-directory
    // resolver anchors the three supported per-user Codex layouts.
    const localAppData = path.join(runtime.homedir(), "AppData", "Local");
    candidates.push(...await desktopCandidates(runtime, localAppData));
    candidates.push(
      path.join(localAppData, "Microsoft", "WindowsApps", "codex.exe"),
      path.join(localAppData, "Programs", "Codex", "codex.exe"),
    );
  }

  const seen = new Set<string>();
  for (const candidate of candidates) {
    const key = runtime.platform === "win32" ? candidate.toLocaleLowerCase("en-US") : candidate;
    if (seen.has(key)) continue;
    seen.add(key);
    if (await isCodexCli(runtime, candidate)) return candidate;
  }
  throw new Error("找不到受信任且可验证的 Codex CLI；请启动/更新 Codex，或按文档将 CSO_CODEX_CLI_PATH 明确指向有效的 codex-cli 绝对路径");
}
