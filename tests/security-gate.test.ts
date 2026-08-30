import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const securityGate = path.join(repositoryRoot, "scripts", "security-gate.mjs");

function runGate(...arguments_: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [securityGate, ...arguments_], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  return {
    status: result.status,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}

async function writeAllowlistedPlugin(root: string): Promise<void> {
  const files = [
    ".codex-plugin/plugin.json",
    ".mcp.json",
    "assets/skill-organizer.svg",
    "scripts/start-mcp.cmd",
    "skills/skill-organizer/SKILL.md",
  ];
  await Promise.all(files.map(async (relativePath) => {
    const destination = path.join(root, ...relativePath.split("/"));
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, `${relativePath}\n`, "utf8");
  }));
}

test("gitignore excludes common secret, certificate, and IDE-local files", async () => {
  const ignore = await readFile(path.join(repositoryRoot, ".gitignore"), "utf8");
  for (const expected of [
    ".env",
    ".env.*",
    "!.env.example",
    "*.pem",
    "*.key",
    "*.pfx",
    ".idea/",
    ".vscode/",
    "*.user",
    "*.suo",
  ]) {
    assert.ok(ignore.split(/\r?\n/u).includes(expected), `missing .gitignore rule: ${expected}`);
  }
});

test("repository security gate rejects sensitive filenames without printing file contents", async (context) => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "cso-secret-files-"));
  context.after(() => rm(fixture, { recursive: true, force: true }));
  await mkdir(path.join(fixture, "certs"), { recursive: true });
  await writeFile(path.join(fixture, ".env.local"), "PRIVATE_VALUE=do-not-print-this-value\n", "utf8");
  await writeFile(path.join(fixture, "certs", "release-private.pem"), "synthetic private key fixture\n", "utf8");

  const result = runGate("--repository-root", fixture);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SENSITIVE_FILENAME/u);
  assert.match(result.stderr, /\.env\.local/u);
  assert.match(result.stderr, /release-private\.pem/u);
  assert.doesNotMatch(result.stderr, /do-not-print-this-value/u);
});

test("repository security gate detects obvious credential formats and ignores generated trees", async (context) => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "cso-secret-pattern-"));
  context.after(() => rm(fixture, { recursive: true, force: true }));
  const fakeAccessKey = ["AKIA", "1234567890ABCDEF"].join("");
  await mkdir(path.join(fixture, "src"), { recursive: true });
  await writeFile(path.join(fixture, "src", "config.ts"), `export const credential = "${fakeAccessKey}";\n`, "utf8");
  for (const excluded of ["node_modules", "dist", "artifacts", "nested/bin", "nested/obj"]) {
    const target = path.join(fixture, ...excluded.split("/"), ".env");
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `${fakeAccessKey}\n`, "utf8");
  }
  const binaryPath = path.join(fixture, "assets", "large.ico");
  await mkdir(path.dirname(binaryPath), { recursive: true });
  await writeFile(binaryPath, Buffer.alloc(2 * 1024 * 1024, 0x41));

  const result = runGate("--repository-root", fixture);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /AWS_ACCESS_KEY_ID/u);
  assert.match(result.stderr, /src[\\/]config\.ts:1/u);
  assert.doesNotMatch(result.stderr, new RegExp(fakeAccessKey, "u"));

  await writeFile(path.join(fixture, "src", "config.ts"), "export const credential = undefined;\n", "utf8");
  const clean = runGate("--repository-root", fixture);
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stdout, /Repository security validation passed/u);
});

test("repository security gate fails closed on a small binary with an unknown extension", async (context) => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "cso-unknown-binary-"));
  context.after(() => rm(fixture, { recursive: true, force: true }));
  await mkdir(path.join(fixture, "src"), { recursive: true });
  await writeFile(path.join(fixture, "src", "opaque.data"), Buffer.from([0x00, 0xff, 0x00, 0xfe]));

  const result = runGate("--repository-root", fixture);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /UNSCANNED_BINARY_FILE/u);
  assert.match(result.stderr, /src[\\/]opaque\.data/u);
});

test("plugin publish gate accepts only the exact file allowlist and rejects links first", async (context) => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "cso-plugin-allowlist-"));
  context.after(() => rm(fixture, { recursive: true, force: true }));
  const pluginRoot = path.join(fixture, "plugin");
  await writeAllowlistedPlugin(pluginRoot);
  assert.equal(runGate("--plugin-root", pluginRoot).status, 0);

  await writeFile(path.join(pluginRoot, ".env"), "PLUGIN_SECRET=synthetic\n", "utf8");
  const extra = runGate("--plugin-root", pluginRoot);
  assert.notEqual(extra.status, 0);
  assert.match(extra.stderr, /PLUGIN_EXTRA_ENTRY/u);
  assert.match(extra.stderr, /\.env/u);
  await rm(path.join(pluginRoot, ".env"), { force: true });

  const outside = path.join(fixture, "outside");
  await mkdir(outside);
  try {
    await symlink(outside, path.join(pluginRoot, "linked"), process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      context.skip("the current policy does not permit creating a directory link");
      return;
    }
    throw error;
  }
  const linked = runGate("--plugin-root", pluginRoot);
  assert.notEqual(linked.status, 0);
  assert.match(linked.stderr, /PLUGIN_LINK/u);
});

test("marketplace publish gate rejects any file outside its six-file allowlist", async (context) => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "cso-marketplace-allowlist-"));
  context.after(() => rm(fixture, { recursive: true, force: true }));
  const marketplaceRoot = path.join(fixture, "marketplace");
  await mkdir(marketplaceRoot, { recursive: true });
  await writeFile(path.join(marketplaceRoot, "marketplace.json"), "{}\n", "utf8");
  await writeAllowlistedPlugin(path.join(marketplaceRoot, "plugins", "codex-skill-organizer"));
  assert.equal(runGate("--marketplace-root", marketplaceRoot).status, 0);

  await writeFile(path.join(marketplaceRoot, "release-notes.txt"), "not publishable\n", "utf8");
  const extra = runGate("--marketplace-root", marketplaceRoot);
  assert.notEqual(extra.status, 0);
  assert.match(extra.stderr, /MARKETPLACE_EXTRA_ENTRY/u);
  assert.match(extra.stderr, /release-notes\.txt/u);
});

test("ordinary and release checks both invoke the deterministic security gates", async () => {
  const packageMetadata = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  assert.equal(
    packageMetadata.scripts["check:security"],
    "node scripts/security-gate.mjs --repository-root . --plugin-root plugin/plugins/codex-skill-organizer --marketplace-root plugin",
  );
  assert.match(packageMetadata.scripts.check ?? "", /npm run check:version && npm run check:security &&/u);

  const validator = await readFile(path.join(repositoryRoot, "scripts", "release", "Validate-Plugin.ps1"), "utf8");
  assert.match(validator, /security-gate\.mjs/u);
  assert.match(validator, /--plugin-root/u);
  assert.match(validator, /--marketplace-root/u);

  const scaffold = await readFile(path.join(repositoryRoot, "scripts", "release", "Test-ReleaseScaffold.ps1"), "utf8");
  assert.match(scaffold, /security-gate\.mjs/u);
  assert.match(scaffold, /--repository-root/u);
});
