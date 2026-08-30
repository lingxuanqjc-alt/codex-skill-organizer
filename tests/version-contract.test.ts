import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const contractScript = path.join(repositoryRoot, "scripts", "version-contract.mjs");

async function writeFixture(root: string): Promise<void> {
  const manifestDirectory = path.join(root, "plugin", "plugins", "codex-skill-organizer", ".codex-plugin");
  const webDirectory = path.join(root, "src", "web");
  await Promise.all([
    mkdir(manifestDirectory, { recursive: true }),
    mkdir(webDirectory, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(root, "package.json"), '{"name":"fixture","version":"1.2.3"}\n', "utf8"),
    writeFile(path.join(root, "package-lock.json"), '{"version":"1.2.3","packages":{"":{"version":"1.2.3"}}}\n', "utf8"),
    writeFile(path.join(manifestDirectory, "plugin.json"), '{"name":"codex-skill-organizer","version":"1.2.3"}\n', "utf8"),
    writeFile(path.join(webDirectory, "index.html"), '<meta content="__PRODUCT_VERSION__">\n', "utf8"),
  ]);
}

function runContract(root: string, mode: "--check" | "--write" = "--check"): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [contractScript, "--root", root, mode], {
    encoding: "utf8",
  });
}

test("version gate rejects a deliberately drifted derived plugin manifest", async (context) => {
  const fixtureRoot = path.join(tmpdir(), `cso-version-contract-${process.pid}-${Date.now()}`);
  context.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(fixtureRoot, { recursive: true, force: true });
  });
  await writeFixture(fixtureRoot);
  assert.equal(runContract(fixtureRoot).status, 0, "an aligned fixture must pass");

  const manifestPath = path.join(fixtureRoot, "plugin", "plugins", "codex-skill-organizer", ".codex-plugin", "plugin.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { version: string };
  manifest.version = "1.2.4";
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");

  const drifted = runContract(fixtureRoot);
  assert.notEqual(drifted.status, 0, "a stale derived manifest must fail before build or release");
  assert.match(String(drifted.stderr), /plugin manifest version is 1\.2\.4, expected 1\.2\.3/);

  const synchronized = runContract(fixtureRoot, "--write");
  assert.equal(synchronized.status, 0, "the explicit generator must restore package-derived versions");
  const repaired = JSON.parse(await readFile(manifestPath, "utf8")) as { version: string };
  assert.equal(repaired.version, "1.2.3");
  assert.equal(runContract(fixtureRoot).status, 0);
});
