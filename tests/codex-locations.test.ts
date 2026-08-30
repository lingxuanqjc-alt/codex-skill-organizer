import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  resolveCodexCommand,
  resolveCodexHome,
  type CodexLocationRuntime,
} from "../src/core/codex-locations.js";

function runtime(overrides: Partial<CodexLocationRuntime> = {}): CodexLocationRuntime {
  return {
    platform: "win32",
    env: {},
    homedir: () => "C:\\Users\\fixture",
    access: async () => undefined,
    readdir: async () => [],
    stat: async () => ({ mtimeMs: 0 }),
    execFile: async () => { throw new Error("not found"); },
    ...overrides,
  };
}

test("Codex home accepts only an absolute CODEX_HOME override", () => {
  assert.equal(
    resolveCodexHome({ CODEX_HOME: "D:\\Portable Codex" }, () => "C:\\Users\\fixture"),
    path.resolve("D:\\Portable Codex"),
  );
  assert.equal(
    resolveCodexHome({ CODEX_HOME: "relative-codex" }, () => "C:\\Users\\fixture"),
    path.join("C:\\Users\\fixture", ".codex"),
  );
});

test("Codex command ignores ordinary CLI/PATH environment candidates and selects the newest Desktop CLI", async () => {
  const home = "C:\\Users\\fixture";
  const localAppData = path.join(home, "AppData", "Local");
  const binRoot = path.join(localAppData, "OpenAI", "Codex", "bin");
  const oldCli = path.join(binRoot, "old", "codex.exe");
  const newCli = path.join(binRoot, "new", "codex.exe");
  const calls: string[] = [];
  const result = await resolveCodexCommand(runtime({
    env: {
      LOCALAPPDATA: "C:\\attacker-controlled-localappdata",
      CODEX_CLI_PATH: "C:\\attacker\\codex.exe",
      PATH: "C:\\attacker",
    },
    homedir: () => home,
    readdir: async (directory) => directory === binRoot
      ? [
        { name: "old", isDirectory: () => true },
        { name: "new", isDirectory: () => true },
      ]
      : [],
    stat: async (filePath) => ({ mtimeMs: filePath === newCli ? 20 : 10 }),
    execFile: async (command) => {
      calls.push(command);
      if (command === newCli) return { stdout: "codex-cli 0.123.0\n", stderr: "" };
      return { stdout: "unexpected executable\n", stderr: "" };
    },
  }));
  assert.equal(result, newCli);
  assert.deepEqual(calls, [newCli]);
  assert.ok(!calls.includes("C:\\attacker\\codex.exe"));
  assert.ok(!calls.includes("where.exe"));
});

test("Codex command accepts only the explicitly documented absolute CSO override", async () => {
  const explicit = "D:\\Trusted portable Codex\\codex.exe";
  const calls: string[] = [];
  const result = await resolveCodexCommand(runtime({
    env: { CSO_CODEX_CLI_PATH: explicit },
    execFile: async (command) => {
      calls.push(command);
      if (command === explicit) return { stdout: "codex-cli 1.2.3\n", stderr: "" };
      return { stdout: "not codex\n", stderr: "" };
    },
  }));
  assert.equal(result, explicit);
  assert.deepEqual(calls, [explicit]);
});

test("Codex command rejects a relative CSO override before executing anything", async () => {
  const calls: string[] = [];
  await assert.rejects(
    () => resolveCodexCommand(runtime({
      env: { CSO_CODEX_CLI_PATH: ".\\codex.exe" },
      execFile: async (command) => {
        calls.push(command);
        return { stdout: "codex-cli 1.2.3\n", stderr: "" };
      },
    })),
    /必须是明确配置的绝对路径/u,
  );
  assert.deepEqual(calls, []);
});

test("Codex command fails closed when no candidate proves its identity", async () => {
  await assert.rejects(
    () => resolveCodexCommand(runtime()),
    /找不到受信任且可验证的 Codex CLI/u,
  );
});
