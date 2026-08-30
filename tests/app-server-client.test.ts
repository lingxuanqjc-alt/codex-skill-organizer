import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  AppServerClient,
  type AppServerProcess,
} from "../src/core/app-server-client.js";

class FakeAppServerProcess extends EventEmitter implements AppServerProcess {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = 42;
  enabled = true;
  readonly requests: Array<Record<string, unknown>> = [];
  #buffer = "";

  constructor(private readonly skillPath: string) {
    super();
    this.stdin.setEncoding("utf8");
    this.stdin.on("data", (chunk) => this.#handle(String(chunk)));
  }

  kill(): boolean {
    queueMicrotask(() => this.emit("exit", 0, null));
    return true;
  }

  #handle(chunk: string): void {
    this.#buffer += chunk;
    while (this.#buffer.includes("\n")) {
      const index = this.#buffer.indexOf("\n");
      const line = this.#buffer.slice(0, index).trim();
      this.#buffer = this.#buffer.slice(index + 1);
      if (!line) continue;
      const message = JSON.parse(line) as Record<string, unknown>;
      this.requests.push(message);
      const method = message.method;
      if (method === "initialize") {
        this.stdout.write(`${JSON.stringify({ method: "remoteControl/status/changed", params: { status: "ok" } })}\n`);
        const response = `${JSON.stringify({ id: message.id, result: { userAgent: "fake", codexHome: "C:/fake" } })}\n`;
        this.stdout.write(response.slice(0, 8));
        queueMicrotask(() => this.stdout.write(response.slice(8)));
      } else if (method === "skills/list") {
        const response = {
          id: message.id,
          result: {
            data: [{
              cwd: "D:/fixture",
              skills: [{
                name: "fixture",
                description: "Fixture",
                path: this.skillPath,
                scope: "user",
                enabled: this.enabled,
                pluginId: null,
              }],
              errors: [],
            }],
          },
          ignoredFutureField: true,
        };
        this.stdout.write(`${JSON.stringify(response)}\n`);
      } else if (method === "skills/config/write") {
        const params = message.params as { enabled: boolean };
        this.enabled = params.enabled;
        this.stdout.write(`${JSON.stringify({ id: message.id, result: { effectiveEnabled: this.enabled } })}\n`);
        this.stdout.write(`${JSON.stringify({ method: "skills/changed", params: {} })}\n`);
      }
    }
  }
}

test("app-server client handles JSONL chunks, notifications, and exact-path write/readback", async () => {
  const skillPath = "C:\\fixture\\SKILL.md";
  const fake = new FakeAppServerProcess(skillPath);
  const client = new AppServerClient({
    command: "fake-codex",
    requestTimeoutMs: 1_000,
    spawnFactory: () => fake,
  });
  let changed = 0;
  client.on("skillsChanged", () => changed += 1);
  await client.start();
  const entries = await client.listSkills(["D:/fixture"], true);
  assert.equal(entries[0]?.skills[0]?.enabled, true);
  assert.equal(await client.setSkillEnabled(skillPath, false), false);
  assert.equal(changed, 1);
  assert.ok(fake.requests.some((request) => request.method === "initialized"));
  const writes = fake.requests.filter((request) => request.method === "skills/config/write");
  assert.equal(writes.length, 1);
  await assert.rejects(() => client.setSkillEnabled("C:\\other\\SKILL.md", true), /最近一次 skills\/list/);
  await client.stop();
});

test("app-server client keeps stderr out of the JSON protocol", async () => {
  const fake = new FakeAppServerProcess("C:\\fixture\\SKILL.md");
  const client = new AppServerClient({ command: "fake", spawnFactory: () => fake, requestTimeoutMs: 1_000 });
  await client.start();
  fake.stderr.write("WARN not json\n");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(client.stderrTail, ["WARN not json"]);
  await client.stop();
});

class ControllableAppServerProcess extends EventEmitter implements AppServerProcess {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  #buffer = "";

  constructor(private readonly respondToInitialize: boolean) {
    super();
    this.stdin.setEncoding("utf8");
    this.stdin.on("data", (chunk) => {
      this.#buffer += String(chunk);
      while (this.#buffer.includes("\n")) {
        const index = this.#buffer.indexOf("\n");
        const line = this.#buffer.slice(0, index).trim();
        this.#buffer = this.#buffer.slice(index + 1);
        if (!line) continue;
        const request = JSON.parse(line) as Record<string, unknown>;
        if (request.method === "initialize" && this.respondToInitialize) {
          this.stdout.write(`${JSON.stringify({ id: request.id, result: { userAgent: "controlled" } })}\n`);
        }
      }
    });
  }

  kill(): boolean {
    return true;
  }
}

test("app-server client reports request timeouts and returns to a stopped state", async () => {
  const fake = new ControllableAppServerProcess(false);
  const client = new AppServerClient({ command: "fake", spawnFactory: () => fake, requestTimeoutMs: 25 });
  await assert.rejects(() => client.start(), /initialize 请求超时/);
  assert.equal(client.isRunning, false);
});

test("app-server exit rejects an in-flight request instead of hanging", async () => {
  const fake = new ControllableAppServerProcess(true);
  const client = new AppServerClient({ command: "fake", spawnFactory: () => fake, requestTimeoutMs: 1_000 });
  await client.start();
  const pending = client.listSkills(["D:/fixture"], true);
  fake.emit("exit", 7, null);
  await assert.rejects(pending, /app-server 已退出/);
  assert.equal(client.isRunning, false);
});
