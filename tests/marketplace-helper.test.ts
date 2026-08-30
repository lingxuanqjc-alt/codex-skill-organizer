import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, "..");
const helperPath = path.join(repositoryRoot, "installer", "tools", "manage-personal-marketplace.mjs");
const canonicalPluginRoot = path.join(repositoryRoot, "plugin", "plugins", "codex-skill-organizer");
const version = "0.2.0";

interface Fixture {
  root: string;
  userHome: string;
  localAppData: string;
  marketplace: string;
  destination: string;
  dataDir: string;
  source: string;
  environment: NodeJS.ProcessEnv;
}

interface HelperModule {
  computeContentSha256(root: string): Promise<string>;
  replaceJson(
    file: string,
    value: unknown,
    options?: { afterExistingMoved?: () => void | Promise<void> },
  ): Promise<void>;
  installPluginCommand(options: {
    marketplacePath: string;
    source: string;
    destination: string;
    dataDir: string;
    version: string;
    adoptLegacy?: boolean;
    dependencies?: {
      rename?: typeof rename;
      mergeMarketplace?: (marketplacePath: string) => Promise<void>;
    };
  }): Promise<unknown>;
}

function canonicalMarketplaceEntry(): Record<string, unknown> {
  return {
    name: "codex-skill-organizer",
    source: { source: "local", path: "./plugins/codex-skill-organizer" },
    policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
    category: "Productivity",
  };
}

function unrelatedMarketplaceEntry(): Record<string, unknown> {
  return {
    name: "unrelated-plugin",
    source: { source: "local", path: "./plugins/unrelated-plugin" },
    policy: { installation: "AVAILABLE", authentication: "ON_USE" },
    category: "Other",
  };
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function createFixture(t: test.TestContext, organizerEntry = false): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), "cso-marketplace-helper-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const userHome = path.join(root, "user");
  const localAppData = path.join(root, "local");
  const marketplace = path.join(userHome, ".agents", "plugins", "marketplace.json");
  const destination = path.join(userHome, "plugins", "codex-skill-organizer");
  const dataDir = path.join(localAppData, "SkillOrganizerForCodex");
  const source = path.join(
    localAppData,
    "Programs",
    "SkillOrganizerForCodex",
    "versions",
    version,
    "plugin",
    "codex-skill-organizer",
  );
  await mkdir(path.dirname(source), { recursive: true });
  await cp(canonicalPluginRoot, source, { recursive: true });
  await writeJson(marketplace, {
    name: "personal",
    interface: { displayName: "Personal" },
    plugins: organizerEntry
      ? [unrelatedMarketplaceEntry(), canonicalMarketplaceEntry()]
      : [unrelatedMarketplaceEntry()],
  });
  return {
    root,
    userHome,
    localAppData,
    marketplace,
    destination,
    dataDir,
    source,
    environment: {
      ...process.env,
      USERPROFILE: userHome,
      HOME: userHome,
      LOCALAPPDATA: localAppData,
    },
  };
}

async function runHelper(
  fixture: Fixture,
  command: "install" | "complete-pending" | "rollback-install" | "finalize-install" | "remove",
  extra: string[] = [],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const args = [
    helperPath,
    command,
    "--marketplace",
    fixture.marketplace,
    "--plugin-destination",
    fixture.destination,
    "--data-dir",
    fixture.dataDir,
    ...extra,
  ];
  try {
    const result = await execFileAsync(process.execPath, args, {
      env: fixture.environment,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as Error & { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof failure.code === "number" ? failure.code : -1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? failure.message,
    };
  }
}

function installArguments(fixture: Fixture, adoptLegacy = false): string[] {
  return [
    "--plugin-source",
    fixture.source,
    "--version",
    version,
    "--adopt-legacy-0.1.1",
    String(adoptLegacy),
  ];
}

async function readMarketplace(fixture: Fixture): Promise<{ plugins: Array<{ name?: string }> }> {
  return JSON.parse(await readFile(fixture.marketplace, "utf8")) as { plugins: Array<{ name?: string }> };
}

async function createLegacyPlugin(destination: string): Promise<void> {
  const files = new Map<string, string>([
    [".codex-plugin/plugin.json", JSON.stringify({ name: "codex-skill-organizer", version: "0.1.1" })],
    [".mcp.json", JSON.stringify({ mcpServers: { codex_skill_organizer: { type: "stdio", command: "node" } } })],
    ["dist/mcp-sidecar.mjs", "export {};"],
    ["dist/public/app.js", "void 0;"],
    ["dist/public/index.html", "<!doctype html>"],
    ["dist/public/premium-minimal.css", ":root{}"],
    ["dist/public/styles.css", "body{}"],
    ["dist/server.mjs", "export {};"],
    ["dist/widget.html", "<!doctype html>"],
    ["README.md", "legacy 0.1.1"],
    ["scripts/desktop-launch.ps1", "Write-Output 'legacy'"],
    ["skills/skill-organizer/SKILL.md", "---\nname: skill-organizer\n---\n"],
  ]);
  await mkdir(path.join(destination, "assets"), { recursive: true });
  for (const [relative, content] of files) {
    const file = path.join(destination, ...relative.split("/"));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content, "utf8");
  }
}

async function helperModule(): Promise<HelperModule> {
  return await import(`${pathToFileURL(helperPath).href}?test=${Date.now()}`) as HelperModule;
}

test("fresh install records a deterministic content hash and managed remove preserves unrelated marketplace entries", async (t) => {
  const fixture = await createFixture(t);
  const installed = await runHelper(fixture, "install", installArguments(fixture));
  assert.equal(installed.code, 0, installed.stderr);
  const marker = JSON.parse(await readFile(path.join(fixture.destination, ".skill-organizer-managed.json"), "utf8")) as {
    schemaVersion: number;
    contentSha256: string;
    hashAlgorithm: string;
  };
  assert.equal(marker.schemaVersion, 2);
  assert.equal(marker.hashAlgorithm, "sha256-tree-v1");
  assert.match(marker.contentSha256, /^[0-9a-f]{64}$/);
  let marketplace = await readMarketplace(fixture);
  assert.deepEqual(marketplace.plugins.map((entry) => entry.name).sort(), ["codex-skill-organizer", "unrelated-plugin"]);

  const removed = await runHelper(fixture, "remove");
  assert.equal(removed.code, 0, removed.stderr);
  await assert.rejects(readFile(path.join(fixture.destination, ".codex-plugin", "plugin.json")), { code: "ENOENT" });
  marketplace = await readMarketplace(fixture);
  assert.deepEqual(marketplace.plugins.map((entry) => entry.name), ["unrelated-plugin"]);
  const backups = await readdir(path.join(fixture.dataDir, "plugin-backups"));
  assert.ok(backups.some((entry) => entry.startsWith("uninstalled-")));
});

test("a rerun recovers an interrupted marketplace replacement after the existing file was parked", async (t) => {
  const fixture = await createFixture(t);
  const crashScript = path.join(fixture.root, "crash-marketplace-replacement.mjs");
  const replacement = {
    name: "personal",
    interface: { displayName: "Personal" },
    plugins: [unrelatedMarketplaceEntry(), canonicalMarketplaceEntry()],
  };
  await writeFile(
    crashScript,
    [
      `import { replaceJson } from ${JSON.stringify(pathToFileURL(helperPath).href)};`,
      `const replacement = ${JSON.stringify(replacement)};`,
      "await replaceJson(process.argv[2], replacement, {",
      "  afterExistingMoved: () => process.exit(91),",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );

  let crashCode = 0;
  try {
    await execFileAsync(process.execPath, [crashScript, fixture.marketplace], {
      env: fixture.environment,
      windowsHide: true,
    });
  } catch (error) {
    crashCode = Number((error as { code?: unknown }).code);
  }
  assert.equal(crashCode, 91, "the fixture must terminate exactly after parking the existing marketplace");
  await assert.rejects(readFile(fixture.marketplace), { code: "ENOENT" });

  const interruptedArtifacts = await readdir(path.dirname(fixture.marketplace));
  assert.ok(interruptedArtifacts.some((entry) => entry.includes("skill-organizer-replace-journal")));
  assert.ok(interruptedArtifacts.some((entry) => entry.includes("skill-organizer-replace-backup")));

  const rerun = await runHelper(fixture, "install", installArguments(fixture));
  assert.equal(rerun.code, 0, rerun.stderr);
  const marketplace = JSON.parse(await readFile(fixture.marketplace, "utf8")) as {
    plugins: Array<Record<string, unknown>>;
  };
  assert.deepEqual(
    marketplace.plugins.find((entry) => entry.name === "unrelated-plugin"),
    unrelatedMarketplaceEntry(),
    "recovery must preserve every field of the pre-existing third-party entry",
  );
  assert.equal(marketplace.plugins.filter((entry) => entry.name === "codex-skill-organizer").length, 1);
  const remainingArtifacts = await readdir(path.dirname(fixture.marketplace));
  assert.equal(
    remainingArtifacts.some((entry) => entry.includes("skill-organizer-replace-")),
    false,
    "a verified rerun removes only its owned recovery artifacts",
  );
});

test("legacy 0.1.1 adoption is refused by default and succeeds only after explicit confirmation with a verified backup", async (t) => {
  const fixture = await createFixture(t, true);
  await createLegacyPlugin(fixture.destination);
  const refused = await runHelper(fixture, "install", installArguments(fixture));
  assert.equal(refused.code, 73);
  assert.equal(JSON.parse(await readFile(path.join(fixture.destination, ".codex-plugin", "plugin.json"), "utf8")).version, "0.1.1");

  const adopted = await runHelper(fixture, "install", installArguments(fixture, true));
  assert.equal(adopted.code, 0, adopted.stderr);
  const marker = JSON.parse(await readFile(path.join(fixture.destination, ".skill-organizer-managed.json"), "utf8"));
  assert.equal(marker.schemaVersion, 2);
  const backups = await readdir(path.join(fixture.dataDir, "plugin-backups"), { withFileTypes: true });
  const legacyBackup = backups.find((entry) => entry.isDirectory() && entry.name.startsWith("legacy-0.1.1-for-"));
  assert.ok(legacyBackup);
  const legacyManifest = JSON.parse(await readFile(
    path.join(fixture.dataDir, "plugin-backups", legacyBackup.name, ".codex-plugin", "plugin.json"),
    "utf8",
  ));
  assert.equal(legacyManifest.version, "0.1.1");
});

test("a locked legacy adoption remains unchanged until an explicitly authorized pending retry completes", async (t) => {
  const fixture = await createFixture(t, true);
  await createLegacyPlugin(fixture.destination);
  const helper = await helperModule();
  const lockedRename: typeof rename = async (from, to) => {
    const sourcePath = from instanceof URL ? from.pathname : from.toString();
    const targetPath = to instanceof URL ? to.pathname : to.toString();
    if (path.resolve(sourcePath) === path.resolve(fixture.destination)
        && path.basename(targetPath).startsWith(".codex-skill-organizer.rollback-")) {
      throw Object.assign(new Error("locked legacy plugin"), { code: "EBUSY" });
    }
    return rename(from, to);
  };

  await assert.rejects(
    helper.installPluginCommand({
      marketplacePath: fixture.marketplace,
      source: fixture.source,
      destination: fixture.destination,
      dataDir: fixture.dataDir,
      version,
      adoptLegacy: true,
      dependencies: { rename: lockedRename },
    }),
    (error: unknown) => (error as { exitCode?: number }).exitCode === 75,
  );
  assert.equal(
    JSON.parse(await readFile(path.join(fixture.destination, ".codex-plugin", "plugin.json"), "utf8")).version,
    "0.1.1",
  );
  const backups = await readdir(path.join(fixture.dataDir, "plugin-backups"));
  assert.equal(backups.filter((entry) => entry.startsWith("legacy-0.1.1-for-")).length, 1);

  const completed = await runHelper(fixture, "complete-pending", [
    "--version",
    version,
    "--adopt-legacy-0.1.1",
    "true",
  ]);
  assert.equal(completed.code, 0, completed.stderr);
  assert.equal(
    JSON.parse(await readFile(path.join(fixture.destination, ".codex-plugin", "plugin.json"), "utf8")).version,
    version,
  );
  await assert.rejects(readFile(path.join(fixture.dataDir, "plugin-update-pending.json")), { code: "ENOENT" });
});

test("a modified managed plugin is neither overwritten nor removed", async (t) => {
  const fixture = await createFixture(t);
  assert.equal((await runHelper(fixture, "install", installArguments(fixture))).code, 0);
  const readme = path.join(fixture.destination, "README.md");
  await writeFile(readme, "local modification", "utf8");

  const overwrite = await runHelper(fixture, "install", installArguments(fixture));
  assert.equal(overwrite.code, 74);
  assert.equal(await readFile(readme, "utf8"), "local modification");
  const removeResult = await runHelper(fixture, "remove");
  assert.equal(removeResult.code, 74);
  assert.equal(await readFile(readme, "utf8"), "local modification");
  const marketplace = await readMarketplace(fixture);
  assert.ok(marketplace.plugins.some((entry) => entry.name === "codex-skill-organizer"));
});

test("a locked replacement reports exit 75 and complete-pending applies only the staged, fingerprinted plugin", async (t) => {
  const fixture = await createFixture(t);
  assert.equal((await runHelper(fixture, "install", installArguments(fixture))).code, 0);
  const updatedSource = path.join(
    fixture.localAppData,
    "Programs",
    "SkillOrganizerForCodex",
    "versions",
    version,
    "plugin-variant",
    "codex-skill-organizer",
  );
  await cp(canonicalPluginRoot, updatedSource, { recursive: true });
  await writeFile(path.join(updatedSource, "pending-proof.txt"), "new payload", "utf8");
  const helper = await helperModule();
  const lockedRename: typeof rename = async (from, to) => {
    const sourcePath = from instanceof URL ? from.pathname : from.toString();
    const targetPath = to instanceof URL ? to.pathname : to.toString();
    if (path.resolve(sourcePath) === path.resolve(fixture.destination) && path.basename(targetPath).startsWith(".codex-skill-organizer.rollback-")) {
      const error = Object.assign(new Error("locked"), { code: "EBUSY" });
      throw error;
    }
    return rename(from, to);
  };
  await assert.rejects(
    helper.installPluginCommand({
      marketplacePath: fixture.marketplace,
      source: updatedSource,
      destination: fixture.destination,
      dataDir: fixture.dataDir,
      version,
      dependencies: { rename: lockedRename },
    }),
    (error: unknown) => (error as { exitCode?: number }).exitCode === 75,
  );
  const pendingPath = path.join(fixture.dataDir, "plugin-update-pending.json");
  const pending = JSON.parse(await readFile(pendingPath, "utf8"));
  assert.equal(pending.schemaVersion, 2);
  assert.equal(pending.status, "pending-codex-restart");
  assert.match(pending.stagedContentSha256, /^[0-9a-f]{64}$/);

  const completed = await runHelper(fixture, "complete-pending", ["--version", version]);
  assert.equal(completed.code, 0, completed.stderr);
  assert.equal(await readFile(path.join(fixture.destination, "pending-proof.txt"), "utf8"), "new payload");
  await assert.rejects(readFile(pendingPath), { code: "ENOENT" });
});

test("marketplace merge failure restores the previous managed plugin and does not leave a replacement orphan", async (t) => {
  const fixture = await createFixture(t);
  assert.equal((await runHelper(fixture, "install", installArguments(fixture))).code, 0);
  const helper = await helperModule();
  const originalHash = await helper.computeContentSha256(fixture.destination);
  const updatedSource = path.join(fixture.root, "updated-source");
  await cp(canonicalPluginRoot, updatedSource, { recursive: true });
  await writeFile(path.join(updatedSource, "merge-failure-proof.txt"), "must roll back", "utf8");

  await assert.rejects(helper.installPluginCommand({
    marketplacePath: fixture.marketplace,
    source: updatedSource,
    destination: fixture.destination,
    dataDir: fixture.dataDir,
    version,
    dependencies: {
      mergeMarketplace: async () => {
        throw new Error("injected marketplace failure");
      },
    },
  }), /injected marketplace failure/);
  assert.equal(await helper.computeContentSha256(fixture.destination), originalHash);
  await assert.rejects(readFile(path.join(fixture.destination, "merge-failure-proof.txt")), { code: "ENOENT" });
  const marketplace = await readMarketplace(fixture);
  assert.ok(marketplace.plugins.some((entry) => entry.name === "codex-skill-organizer"));
});

test("a marker-commit rollback restores the exact managed plugin and marketplace from before an upgrade", async (t) => {
  const fixture = await createFixture(t);
  const helper = await helperModule();
  const initial = await runHelper(fixture, "install", installArguments(fixture));
  assert.equal(initial.code, 0, initial.stderr);
  const originalHash = await helper.computeContentSha256(fixture.destination);
  const originalMarketplace = await readFile(fixture.marketplace);

  const updatedSource = path.join(
    fixture.localAppData,
    "Programs",
    "SkillOrganizerForCodex",
    "versions",
    version,
    "plugin-marker-upgrade",
    "codex-skill-organizer",
  );
  await cp(canonicalPluginRoot, updatedSource, { recursive: true });
  await writeFile(path.join(updatedSource, "marker-upgrade-proof.txt"), "new payload", "utf8");

  const deferred = await runHelper(fixture, "install", [
    "--plugin-source",
    updatedSource,
    "--version",
    version,
    "--adopt-legacy-0.1.1",
    "false",
    "--defer-finalize",
    "true",
  ]);
  assert.equal(deferred.code, 0, deferred.stderr);
  assert.equal(await readFile(path.join(fixture.destination, "marker-upgrade-proof.txt"), "utf8"), "new payload");
  await assert.doesNotReject(readFile(path.join(fixture.dataDir, "plugin-install-transaction.json")));

  const rolledBack = await runHelper(fixture, "rollback-install", ["--version", version]);
  assert.equal(rolledBack.code, 0, rolledBack.stderr);
  assert.equal(await helper.computeContentSha256(fixture.destination), originalHash);
  assert.deepEqual(await readFile(fixture.marketplace), originalMarketplace);
  await assert.rejects(readFile(path.join(fixture.destination, "marker-upgrade-proof.txt")), { code: "ENOENT" });
  await assert.rejects(readFile(path.join(fixture.dataDir, "plugin-install-transaction.json")), { code: "ENOENT" });
});

test("a same-version marker rollback restores its parked prior directory even when content hashes are identical", async (t) => {
  const fixture = await createFixture(t);
  assert.equal((await runHelper(fixture, "install", installArguments(fixture))).code, 0);
  const deferred = await runHelper(fixture, "install", [
    ...installArguments(fixture),
    "--defer-finalize",
    "true",
  ]);
  assert.equal(deferred.code, 0, deferred.stderr);
  const rolledBack = await runHelper(fixture, "rollback-install", ["--version", version]);
  assert.equal(rolledBack.code, 0, rolledBack.stderr);
  await assert.rejects(readFile(path.join(fixture.dataDir, "plugin-install-transaction.json")), { code: "ENOENT" });
});

test("finalizing a marker transaction commits the replacement and removes rollback state", async (t) => {
  const fixture = await createFixture(t);
  assert.equal((await runHelper(fixture, "install", installArguments(fixture))).code, 0);
  const updatedSource = path.join(
    fixture.localAppData,
    "Programs",
    "SkillOrganizerForCodex",
    "versions",
    version,
    "plugin-marker-finalize",
    "codex-skill-organizer",
  );
  await cp(canonicalPluginRoot, updatedSource, { recursive: true });
  await writeFile(path.join(updatedSource, "marker-finalize-proof.txt"), "committed", "utf8");

  const deferred = await runHelper(fixture, "install", [
    "--plugin-source",
    updatedSource,
    "--version",
    version,
    "--adopt-legacy-0.1.1",
    "false",
    "--defer-finalize",
    "true",
  ]);
  assert.equal(deferred.code, 0, deferred.stderr);
  const finalized = await runHelper(fixture, "finalize-install", ["--version", version]);
  assert.equal(finalized.code, 0, finalized.stderr);
  assert.equal(await readFile(path.join(fixture.destination, "marker-finalize-proof.txt"), "utf8"), "committed");
  await assert.rejects(readFile(path.join(fixture.dataDir, "plugin-install-transaction.json")), { code: "ENOENT" });
  const pluginParentEntries = await readdir(path.dirname(fixture.destination));
  assert.equal(pluginParentEntries.some((entry) => entry.startsWith(".codex-skill-organizer.rollback-")), false);
});

test("remove refuses an unowned Organizer directory before changing its marketplace entry", async (t) => {
  const fixture = await createFixture(t, true);
  await createLegacyPlugin(fixture.destination);
  const removed = await runHelper(fixture, "remove");
  assert.equal(removed.code, 73);
  assert.equal(JSON.parse(await readFile(path.join(fixture.destination, ".codex-plugin", "plugin.json"), "utf8")).version, "0.1.1");
  const marketplace = await readMarketplace(fixture);
  assert.ok(marketplace.plugins.some((entry) => entry.name === "codex-skill-organizer"));
});
