import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PRODUCT_ID = "codex-skill-organizer";
const MANAGED_SENTINEL = ".skill-organizer-managed.json";
const MARKETPLACE_SOURCE_PATH = "./plugins/codex-skill-organizer";
const HASH_ALGORITHM = "sha256-tree-v1";
const LEGACY_VERSION = "0.1.1";
const PENDING_EXIT_CODE = 75;
const SAFETY_EXIT_CODE = 76;
const INSTALL_TRANSACTION_FILE = "plugin-install-transaction.json";
const JSON_REPLACE_JOURNAL_SUFFIX = ".skill-organizer-replace-journal.json";
const JSON_REPLACE_ARTIFACT_PREFIX = ".skill-organizer-replace-";
const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

const LEGACY_DIRECTORIES = new Set([
  ".codex-plugin",
  "assets",
  "dist",
  "dist/public",
  "scripts",
  "skills",
  "skills/skill-organizer",
]);

const LEGACY_FILES = new Set([
  ".codex-plugin/plugin.json",
  ".mcp.json",
  "dist/mcp-sidecar.mjs",
  "dist/public/app.js",
  "dist/public/index.html",
  "dist/public/premium-minimal.css",
  "dist/public/styles.css",
  "dist/server.mjs",
  "dist/widget.html",
  "README.md",
  "scripts/desktop-launch.ps1",
  "skills/skill-organizer/SKILL.md",
]);

function fail(message, exitCode = 1, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.exitCode = exitCode;
  throw error;
}

function parseArguments(argv) {
  const [command, ...rest] = argv;
  if (!new Set(["install", "complete-pending", "rollback-install", "finalize-install", "remove"]).has(command)) {
    fail(
      "Usage: manage-personal-marketplace.mjs <install|complete-pending|rollback-install|finalize-install|remove> --marketplace <path> --plugin-destination <path> --data-dir <path> [--plugin-source <path> --version <semver> --adopt-legacy-0.1.1 <true|false> --defer-finalize <true|false>]",
      64,
    );
  }

  const allowed = new Set(["marketplace", "plugin-destination", "data-dir"]);
  if (command !== "remove") allowed.add("version");
  if (command === "install" || command === "complete-pending") {
    allowed.add("adopt-legacy-0.1.1");
  }
  if (command === "install") {
    allowed.add("plugin-source");
    allowed.add("defer-finalize");
  }

  const options = { command };
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    const name = flag?.startsWith("--") ? flag.slice(2) : null;
    if (!name || value === undefined || !allowed.has(name) || Object.hasOwn(options, name)) {
      fail(`Invalid or duplicate argument near ${flag ?? "<end>"}.`, 64);
    }
    options[name] = value;
  }
  for (const required of ["marketplace", "plugin-destination", "data-dir"]) {
    if (!options[required]) fail(`--${required} is required.`, 64);
  }
  return options;
}

function parseBoolean(value, label) {
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  fail(`${label} must be exactly true or false.`, 64);
}

function requireSemver(value, label = "Version") {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:[-+][0-9A-Za-z.-]+)?$/.test(value)) {
    fail(`${label} is not valid semver.`, 64);
  }
  return value;
}

function canonical(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLocaleLowerCase("en-US") : resolved;
}

function requireExactPath(actual, expected, label) {
  if (canonical(actual) !== canonical(expected)) {
    fail(`${label} must be exactly ${expected}.`, 65);
  }
}

function requireInside(actual, expectedRoot, label) {
  const relative = path.relative(path.resolve(expectedRoot), path.resolve(actual));
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    fail(`${label} must be a child of ${expectedRoot}.`, 65);
  }
}

async function pathInfo(candidate) {
  try {
    return await lstat(candidate);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function ordinalCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function collectTreeRecords(root, { excludeManagedSentinel = false } = {}) {
  const records = [];
  async function visit(absolute, relative) {
    const stats = await lstat(absolute);
    if (stats.isSymbolicLink()) {
      fail(`Symbolic links and junction-like entries are not accepted: ${absolute}`, 65);
    }
    const normalized = relative.split(path.sep).join("/");
    if (stats.isDirectory()) {
      if (normalized) records.push({ type: "directory", path: normalized });
      const entries = await readdir(absolute, { withFileTypes: true });
      entries.sort((left, right) => ordinalCompare(left.name, right.name));
      for (const entry of entries) {
        await visit(path.join(absolute, entry.name), relative ? path.join(relative, entry.name) : entry.name);
      }
      return;
    }
    if (!stats.isFile()) fail(`Unsupported plugin entry type: ${absolute}`, 65);
    if (excludeManagedSentinel && normalized === MANAGED_SENTINEL) return;
    const bytes = await readFile(absolute);
    records.push({
      type: "file",
      path: normalized,
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  await visit(path.resolve(root), "");
  return records;
}

export async function computeContentSha256(root) {
  const records = await collectTreeRecords(root, { excludeManagedSentinel: true });
  return createHash("sha256").update(JSON.stringify(records)).digest("hex");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function replacementJournalPath(file) {
  return `${path.resolve(file)}${JSON_REPLACE_JOURNAL_SUFFIX}`;
}

function replacementArtifactPath(file, kind) {
  return `${path.resolve(file)}${JSON_REPLACE_ARTIFACT_PREFIX}${kind}-${randomUUID()}`;
}

function validateReplacementArtifactPath(file, candidate, kind) {
  if (typeof candidate !== "string" || !path.isAbsolute(candidate)) {
    fail(`Interrupted JSON ${kind} path is invalid.`, SAFETY_EXIT_CODE);
  }
  const target = path.resolve(file);
  const resolved = path.resolve(candidate);
  if (canonical(path.dirname(resolved)) !== canonical(path.dirname(target))) {
    fail(`Interrupted JSON ${kind} is outside the target directory.`, SAFETY_EXIT_CODE);
  }
  const escapedTarget = path.basename(target).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedKind = kind.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const expected = new RegExp(`^${escapedTarget}\\.skill-organizer-replace-${escapedKind}-${UUID_PATTERN}$`, "i");
  if (!expected.test(path.basename(resolved))) {
    fail(`Interrupted JSON ${kind} does not have an Organizer-owned name.`, SAFETY_EXIT_CODE);
  }
  return resolved;
}

async function hashOrdinaryFile(candidate, label) {
  const info = await pathInfo(candidate);
  if (!info) return null;
  if (!info.isFile() || info.isSymbolicLink()) {
    fail(`${label} is not an ordinary file.`, SAFETY_EXIT_CODE);
  }
  return sha256(await readFile(candidate));
}

function processIsAlive(processId) {
  if (processId === process.pid) return true;
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

async function readReplacementJournal(file) {
  const journalPath = replacementJournalPath(file);
  const info = await pathInfo(journalPath);
  if (!info) return null;
  if (!info.isFile() || info.isSymbolicLink()) {
    fail("Interrupted JSON replacement journal is not an ordinary file.", SAFETY_EXIT_CODE);
  }
  let journal;
  try {
    journal = JSON.parse(await readFile(journalPath, "utf8"));
  } catch (error) {
    fail("Interrupted JSON replacement journal is invalid; recovery stopped.", SAFETY_EXIT_CODE, error);
  }
  const targetPath = path.resolve(file);
  if (
    !journal
    || typeof journal !== "object"
    || Array.isArray(journal)
    || journal.schemaVersion !== 1
    || journal.managedBy !== PRODUCT_ID
    || journal.operation !== "replace-json"
    || typeof journal.targetPath !== "string"
    || !path.isAbsolute(journal.targetPath)
    || canonical(journal.targetPath) !== canonical(targetPath)
    || typeof journal.targetExisted !== "boolean"
    || !/^[0-9a-f]{64}$/.test(journal.afterSha256 ?? "")
    || !Number.isSafeInteger(journal.ownerPid)
    || journal.ownerPid < 1
    || typeof journal.createdAt !== "string"
    || Number.isNaN(Date.parse(journal.createdAt))
  ) {
    fail("Interrupted JSON replacement journal does not belong to this target.", SAFETY_EXIT_CODE);
  }
  if (journal.targetExisted !== (typeof journal.beforeSha256 === "string")) {
    fail("Interrupted JSON replacement journal has inconsistent prior-state evidence.", SAFETY_EXIT_CODE);
  }
  if (journal.targetExisted && !/^[0-9a-f]{64}$/.test(journal.beforeSha256)) {
    fail("Interrupted JSON replacement journal has an invalid prior-state hash.", SAFETY_EXIT_CODE);
  }
  if (!journal.targetExisted && (journal.beforeSha256 !== null || journal.backupPath !== null)) {
    fail("Interrupted JSON replacement journal invents a prior target.", SAFETY_EXIT_CODE);
  }
  const nextPath = validateReplacementArtifactPath(targetPath, journal.nextPath, "next");
  const backupPath = journal.targetExisted
    ? validateReplacementArtifactPath(targetPath, journal.backupPath, "backup")
    : null;
  return { ...journal, targetPath, nextPath, backupPath, journalPath };
}

async function recoverInterruptedJsonReplacement(file, { allowCurrentOwner = false } = {}) {
  const journal = await readReplacementJournal(file);
  if (!journal) return false;
  if ((!allowCurrentOwner || journal.ownerPid !== process.pid) && processIsAlive(journal.ownerPid)) {
    fail("Another Organizer process is still replacing this JSON file.", PENDING_EXIT_CODE);
  }

  let targetHash = await hashOrdinaryFile(journal.targetPath, "JSON replacement target");
  let backupHash = journal.backupPath
    ? await hashOrdinaryFile(journal.backupPath, "JSON replacement backup")
    : null;
  const nextHash = await hashOrdinaryFile(journal.nextPath, "JSON replacement candidate");

  if (!targetHash && journal.targetExisted) {
    if (backupHash !== journal.beforeSha256) {
      fail("Interrupted JSON replacement has no verified prior-state backup.", SAFETY_EXIT_CODE);
    }
    await rename(journal.backupPath, journal.targetPath);
    targetHash = await hashOrdinaryFile(journal.targetPath, "Restored JSON replacement target");
    backupHash = null;
    if (targetHash !== journal.beforeSha256) {
      fail("Interrupted JSON replacement restored an unverifiable prior state.", SAFETY_EXIT_CODE);
    }
  }

  if (!targetHash && !journal.targetExisted) {
    if (nextHash !== journal.afterSha256) {
      fail("Interrupted new JSON replacement has no verified candidate.", SAFETY_EXIT_CODE);
    }
    await rename(journal.nextPath, journal.targetPath);
    targetHash = await hashOrdinaryFile(journal.targetPath, "Recovered JSON replacement target");
    if (targetHash !== journal.afterSha256) {
      fail("Interrupted new JSON replacement committed unverifiable content.", SAFETY_EXIT_CODE);
    }
  }

  const committed = targetHash === journal.afterSha256;
  const restored = journal.targetExisted && targetHash === journal.beforeSha256;
  if (!committed && !restored) {
    fail("Interrupted JSON replacement target differs from both verified states.", SAFETY_EXIT_CODE);
  }
  if (nextHash && nextHash !== journal.afterSha256) {
    fail("Interrupted JSON replacement candidate was modified; recovery artifacts were preserved.", SAFETY_EXIT_CODE);
  }
  if (backupHash && backupHash !== journal.beforeSha256) {
    fail("Interrupted JSON replacement backup was modified; recovery artifacts were preserved.", SAFETY_EXIT_CODE);
  }

  await rm(journal.nextPath, { force: true });
  if (journal.backupPath) await rm(journal.backupPath, { force: true });
  await rm(journal.journalPath, { force: true });
  return true;
}

async function readJsonObject(file, label, { optional = false } = {}) {
  await recoverInterruptedJsonReplacement(file);
  try {
    const value = JSON.parse(await readFile(file, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      fail(`${label} must contain a JSON object.`, 65);
    }
    return value;
  } catch (error) {
    if (optional && error?.code === "ENOENT") return null;
    if (error instanceof SyntaxError) fail(`${label} contains invalid JSON.`, 65);
    throw error;
  }
}

async function replaceJsonText(file, serialized, { afterExistingMoved } = {}) {
  await mkdir(path.dirname(file), { recursive: true });
  await recoverInterruptedJsonReplacement(file);
  const next = replacementArtifactPath(file, "next");
  const backup = replacementArtifactPath(file, "backup");
  const journalPath = replacementJournalPath(file);
  await writeFile(next, serialized, { encoding: "utf8", flag: "wx", flush: true });
  const existing = await pathInfo(file);
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
    await rm(next, { force: true });
    fail("JSON replacement target is not an ordinary file.", SAFETY_EXIT_CODE);
  }
  const beforeSha256 = existing ? await hashOrdinaryFile(file, "JSON replacement target") : null;
  const afterSha256 = sha256(Buffer.from(serialized, "utf8"));
  try {
    await writeFile(journalPath, `${JSON.stringify({
      schemaVersion: 1,
      managedBy: PRODUCT_ID,
      operation: "replace-json",
      targetPath: path.resolve(file),
      targetExisted: Boolean(existing),
      beforeSha256,
      afterSha256,
      nextPath: next,
      backupPath: existing ? backup : null,
      ownerPid: process.pid,
      createdAt: new Date().toISOString(),
    }, null, 2)}\n`, { encoding: "utf8", flag: "wx", flush: true });
  } catch (error) {
    await rm(next, { force: true }).catch(() => undefined);
    throw error;
  }
  try {
    if (existing) {
      await rename(file, backup);
      await afterExistingMoved?.();
    }
    await rename(next, file);
    if (await hashOrdinaryFile(file, "Committed JSON replacement target") !== afterSha256) {
      fail("Committed JSON replacement does not match its journal.", SAFETY_EXIT_CODE);
    }
  } catch (error) {
    try {
      await recoverInterruptedJsonReplacement(file, { allowCurrentOwner: true });
    } catch (recoveryError) {
      fail("JSON replacement failed and its verified prior state could not be restored.", SAFETY_EXIT_CODE, recoveryError);
    }
    throw error;
  }
  await recoverInterruptedJsonReplacement(file, { allowCurrentOwner: true });
}

export async function replaceJson(file, value, options = {}) {
  await replaceJsonText(file, `${JSON.stringify(value, null, 2)}\n`, options);
}

function canonicalEntry() {
  return {
    name: PRODUCT_ID,
    source: { source: "local", path: MARKETPLACE_SOURCE_PATH },
    policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
    category: "Productivity",
  };
}

function sourceMatches(entry) {
  return entry?.source?.source === "local"
    && entry?.source?.path?.replaceAll("\\", "/") === MARKETPLACE_SOURCE_PATH;
}

async function loadMarketplace(file) {
  const marketplace = await readJsonObject(file, "Personal marketplace", { optional: true }) ?? {
    name: "personal",
    interface: { displayName: "Personal" },
    plugins: [],
  };
  if (typeof marketplace.name !== "string" || !marketplace.name.trim()) {
    fail("Personal marketplace has no valid name.", 65);
  }
  if (!Array.isArray(marketplace.plugins)) {
    fail("Personal marketplace plugins must be an array.", 65);
  }
  const matches = marketplace.plugins.filter((entry) => entry?.name === PRODUCT_ID);
  if (matches.length > 1) fail("Personal marketplace has duplicate Organizer entries.", 65);
  if (matches.length === 1 && !sourceMatches(matches[0])) {
    fail("An Organizer entry with a different source already exists; it was not overwritten.", 73);
  }
  return marketplace;
}

function hasCanonicalOrganizerEntry(marketplace) {
  return marketplace.plugins.some((entry) => entry?.name === PRODUCT_ID && sourceMatches(entry));
}

async function mergeMarketplace(file) {
  const marketplace = await loadMarketplace(file);
  const index = marketplace.plugins.findIndex((entry) => entry?.name === PRODUCT_ID);
  if (index === -1) marketplace.plugins.push(canonicalEntry());
  else marketplace.plugins[index] = canonicalEntry();
  await replaceJson(file, marketplace);
}

async function removeMarketplaceEntry(file) {
  const marketplace = await loadMarketplace(file);
  const nextPlugins = marketplace.plugins.filter((entry) => entry?.name !== PRODUCT_ID);
  if (nextPlugins.length === marketplace.plugins.length) return false;
  marketplace.plugins = nextPlugins;
  await replaceJson(file, marketplace);
  return true;
}

async function validatePluginSource(source, expectedVersion) {
  const sourceStats = await pathInfo(source);
  if (!sourceStats?.isDirectory() || sourceStats.isSymbolicLink()) {
    fail("Plugin source is missing or is not a physical directory.", 66);
  }
  if (await pathInfo(path.join(source, MANAGED_SENTINEL))) {
    fail("Canonical plugin source must not contain an installer ownership marker.", 65);
  }
  const manifest = await readJsonObject(path.join(source, ".codex-plugin", "plugin.json"), "Plugin manifest");
  if (manifest.name !== PRODUCT_ID) fail("Plugin manifest name does not match Organizer.", 65);
  if (manifest.version !== expectedVersion) fail("Plugin manifest version does not match installer version.", 65);
  return computeContentSha256(source);
}

async function validateManagedPlugin(destination, expected = {}) {
  const stats = await pathInfo(destination);
  if (!stats) return null;
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    fail("Existing plugin destination is not a physical directory.", 73);
  }
  const manifest = await readJsonObject(path.join(destination, ".codex-plugin", "plugin.json"), "Existing plugin manifest");
  if (manifest.name !== PRODUCT_ID) {
    fail("Existing plugin destination is not an Organizer installation.", 73);
  }
  const sentinel = await readJsonObject(path.join(destination, MANAGED_SENTINEL), "Managed plugin marker", { optional: true });
  if (!sentinel) return null;
  if (
    sentinel.schemaVersion !== 2
    || sentinel.managedBy !== PRODUCT_ID
    || sentinel.hashAlgorithm !== HASH_ALGORITHM
    || typeof sentinel.version !== "string"
    || !/^[0-9a-f]{64}$/.test(sentinel.contentSha256 ?? "")
    || manifest.version !== sentinel.version
  ) {
    fail("Existing Organizer ownership marker is invalid; files were preserved.", 73);
  }
  const contentSha256 = await computeContentSha256(destination);
  if (contentSha256 !== sentinel.contentSha256) {
    fail("Existing managed Organizer plugin was modified; overwrite and removal were refused.", 74);
  }
  if (expected.version && sentinel.version !== expected.version) {
    fail("Managed Organizer version no longer matches the pending operation.", 74);
  }
  if (expected.contentSha256 && contentSha256 !== expected.contentSha256) {
    fail("Managed Organizer content no longer matches the pending operation.", 74);
  }
  return { kind: "managed", version: sentinel.version, contentSha256 };
}

async function validateLegacyPlugin(destination) {
  const stats = await pathInfo(destination);
  if (!stats?.isDirectory() || stats.isSymbolicLink()) {
    fail("Legacy Organizer destination is not a physical directory.", 73);
  }
  if (await pathInfo(path.join(destination, MANAGED_SENTINEL))) {
    fail("A marked Organizer directory cannot be adopted as legacy 0.1.1.", 73);
  }
  const manifest = await readJsonObject(path.join(destination, ".codex-plugin", "plugin.json"), "Legacy plugin manifest");
  if (manifest.name !== PRODUCT_ID || manifest.version !== LEGACY_VERSION) {
    fail("Only the exact Organizer 0.1.1 legacy plugin can be adopted.", 73);
  }
  const records = await collectTreeRecords(destination);
  const directories = new Set(records.filter((record) => record.type === "directory").map((record) => record.path));
  const files = new Set(records.filter((record) => record.type === "file").map((record) => record.path));
  if (
    directories.size !== LEGACY_DIRECTORIES.size
    || files.size !== LEGACY_FILES.size
    || [...LEGACY_DIRECTORIES].some((entry) => !directories.has(entry))
    || [...LEGACY_FILES].some((entry) => !files.has(entry))
  ) {
    fail("Legacy Organizer 0.1.1 structure is not the known release layout; adoption was refused.", 73);
  }
  return { kind: "legacy-0.1.1", version: LEGACY_VERSION, contentSha256: await computeContentSha256(destination) };
}

async function inspectExistingPlugin(destination, { adoptLegacy, marketplace }) {
  if (!(await pathInfo(destination))) return null;
  const managed = await validateManagedPlugin(destination);
  if (managed) return managed;
  if (!adoptLegacy) {
    fail("Existing Organizer directory is not owned by this installer; files were preserved.", 73);
  }
  if (!hasCanonicalOrganizerEntry(marketplace)) {
    fail("Legacy adoption requires the exact personal marketplace source entry.", 73);
  }
  return validateLegacyPlugin(destination);
}

function backupDirectoryFor(dataDir) {
  return path.join(dataDir, "plugin-backups");
}

async function createDurableBackup(destination, existing, dataDir, incomingVersion) {
  const backupRoot = backupDirectoryFor(dataDir);
  await mkdir(backupRoot, { recursive: true });
  const label = existing.kind === "legacy-0.1.1" ? "legacy-0.1.1" : `before-${existing.version}`;
  const backup = path.join(backupRoot, `${label}-for-${incomingVersion}-${randomUUID()}`);
  await cp(destination, backup, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
  const backupHash = await computeContentSha256(backup);
  if (backupHash !== existing.contentSha256) {
    await rm(backup, { recursive: true, force: true }).catch(() => undefined);
    fail("Plugin backup verification failed; the existing plugin was not changed.", SAFETY_EXIT_CODE);
  }
  if (existing.kind === "managed") await validateManagedPlugin(backup, existing);
  else await validateLegacyPlugin(backup);
  return backup;
}

async function stagePlugin(source, dataDir, version, contentSha256) {
  const stagedRoot = path.join(dataDir, "plugin-staging", `${version}-${randomUUID()}`);
  const stagedPlugin = path.join(stagedRoot, PRODUCT_ID);
  await mkdir(stagedRoot, { recursive: true });
  await cp(source, stagedPlugin, { recursive: true, errorOnExist: true, force: false });
  const stagedHash = await computeContentSha256(stagedPlugin);
  if (stagedHash !== contentSha256) {
    await rm(stagedRoot, { recursive: true, force: true }).catch(() => undefined);
    fail("Staged plugin content does not match the validated source.", SAFETY_EXIT_CODE);
  }
  await writeFile(
    path.join(stagedPlugin, MANAGED_SENTINEL),
    `${JSON.stringify({
      schemaVersion: 2,
      managedBy: PRODUCT_ID,
      version,
      hashAlgorithm: HASH_ALGORITHM,
      contentSha256,
    }, null, 2)}\n`,
    "utf8",
  );
  await validateManagedPlugin(stagedPlugin, { version, contentSha256 });
  return { stagedRoot, stagedPlugin, contentSha256 };
}

async function prepareDestinationCandidate(stagedPlugin, destination, expected, copyPath = cp) {
  const candidate = path.join(path.dirname(destination), `.${PRODUCT_ID}.next-${randomUUID()}`);
  try {
    await copyPath(stagedPlugin, candidate, { recursive: true, errorOnExist: true, force: false });
    await validateManagedPlugin(candidate, expected);
    return candidate;
  } catch (error) {
    await rm(candidate, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function swapCandidate({ stagedPlugin, destination, existing, expected, movePath = rename, copyPath = cp }) {
  await mkdir(path.dirname(destination), { recursive: true });
  const candidate = await prepareDestinationCandidate(stagedPlugin, destination, expected, copyPath);
  const rollbackPath = existing
    ? path.join(path.dirname(destination), `.${PRODUCT_ID}.rollback-${randomUUID()}`)
    : null;
  let previousMoved = false;
  try {
    if (rollbackPath) {
      await movePath(destination, rollbackPath);
      previousMoved = true;
    }
    await movePath(candidate, destination);
    return { rollbackPath, previousMoved };
  } catch (error) {
    await rm(candidate, { recursive: true, force: true }).catch(() => undefined);
    if (previousMoved && !(await pathInfo(destination)) && (await pathInfo(rollbackPath))) {
      try {
        await movePath(rollbackPath, destination);
      } catch (restoreError) {
        fail("Plugin swap failed and the prior destination could not be restored.", SAFETY_EXIT_CODE, restoreError);
      }
    }
    throw error;
  }
}

async function compensateSwap({ destination, rollbackPath, expected, movePath = rename }) {
  const installed = await validateManagedPlugin(destination, expected);
  if (!installed) fail("Replacement compensation could not identify the staged plugin.", SAFETY_EXIT_CODE);
  await rm(destination, { recursive: true, force: true });
  if (rollbackPath) {
    try {
      await movePath(rollbackPath, destination);
    } catch (error) {
      fail("Marketplace update failed and the prior plugin could not be restored.", SAFETY_EXIT_CODE, error);
    }
  }
}

function targetDescriptor(existing, durableBackup) {
  if (!existing) return { kind: "absent" };
  return {
    kind: existing.kind,
    version: existing.version,
    contentSha256: existing.contentSha256,
    durableBackup,
  };
}

async function writePendingMarker(pendingMarker, { version, staged, destination, existing, durableBackup, reason }) {
  await replaceJson(pendingMarker, {
    schemaVersion: 2,
    status: "pending-codex-restart",
    productId: PRODUCT_ID,
    version,
    stagedPlugin: path.resolve(staged.stagedPlugin),
    stagedContentSha256: staged.contentSha256,
    destination: path.resolve(destination),
    target: targetDescriptor(existing, durableBackup),
    reason: reason?.code ?? "REPLACE_FAILED",
    createdAt: new Date().toISOString(),
  });
}

async function finishSuccessfulSwap({ staged, rollbackPath, pendingMarker }) {
  if (rollbackPath) await rm(rollbackPath, { recursive: true, force: true }).catch(() => undefined);
  await rm(staged.stagedRoot, { recursive: true, force: true }).catch(() => undefined);
  await rm(pendingMarker, { force: true });
}

function installTransactionPath(dataDir) {
  return path.join(dataDir, INSTALL_TRANSACTION_FILE);
}

async function readMarketplaceSnapshot(file) {
  await recoverInterruptedJsonReplacement(file);
  const info = await pathInfo(file);
  if (!info) {
    return { existed: false, sha256: null, utf8Base64: null };
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    fail("Personal marketplace snapshot target is not an ordinary file.", SAFETY_EXIT_CODE);
  }
  const bytes = await readFile(file);
  try {
    const parsed = JSON.parse(bytes.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new SyntaxError();
  } catch (error) {
    fail("Personal marketplace snapshot is not a JSON object.", SAFETY_EXIT_CODE, error);
  }
  return {
    existed: true,
    sha256: sha256(bytes),
    utf8Base64: bytes.toString("base64"),
  };
}

function validateMarketplaceSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || typeof snapshot.existed !== "boolean") {
    fail("Plugin install transaction has no valid prior marketplace snapshot.", SAFETY_EXIT_CODE);
  }
  if (!snapshot.existed) {
    if (snapshot.sha256 !== null || snapshot.utf8Base64 !== null) {
      fail("Plugin install transaction invents a prior marketplace file.", SAFETY_EXIT_CODE);
    }
    return;
  }
  if (!/^[0-9a-f]{64}$/.test(snapshot.sha256 ?? "") || typeof snapshot.utf8Base64 !== "string") {
    fail("Plugin install transaction has incomplete prior marketplace evidence.", SAFETY_EXIT_CODE);
  }
  const bytes = Buffer.from(snapshot.utf8Base64, "base64");
  if (sha256(bytes) !== snapshot.sha256) {
    fail("Plugin install transaction prior marketplace evidence was modified.", SAFETY_EXIT_CODE);
  }
  try {
    const parsed = JSON.parse(bytes.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new SyntaxError();
  } catch (error) {
    fail("Plugin install transaction prior marketplace is not a JSON object.", SAFETY_EXIT_CODE, error);
  }
}

function markerTransactionTarget(existing, rollbackPath) {
  if (!existing) return { kind: "absent", rollbackPath: null };
  return {
    kind: existing.kind,
    version: existing.version,
    contentSha256: existing.contentSha256,
    rollbackPath: path.resolve(rollbackPath),
  };
}

function validateRollbackPath(candidate, destination) {
  if (typeof candidate !== "string" || !path.isAbsolute(candidate)) {
    fail("Plugin install transaction rollback path is invalid.", SAFETY_EXIT_CODE);
  }
  const resolved = path.resolve(candidate);
  if (canonical(path.dirname(resolved)) !== canonical(path.dirname(destination))) {
    fail("Plugin install transaction rollback path escaped the plugin parent.", SAFETY_EXIT_CODE);
  }
  const expected = new RegExp(`^\\.${PRODUCT_ID}\\.rollback-${UUID_PATTERN}$`, "i");
  if (!expected.test(path.basename(resolved))) {
    fail("Plugin install transaction rollback path is not Organizer-owned.", SAFETY_EXIT_CODE);
  }
  return resolved;
}

async function writeInstallTransaction({
  transactionPath,
  marketplacePath,
  destination,
  version,
  contentSha256,
  existing,
  rollbackPath,
  marketplaceBefore,
  marketplaceAfterSha256,
}) {
  await replaceJson(transactionPath, {
    schemaVersion: 1,
    status: "awaiting-marker-commit",
    productId: PRODUCT_ID,
    version,
    destination: path.resolve(destination),
    marketplacePath: path.resolve(marketplacePath),
    incomingContentSha256: contentSha256,
    target: markerTransactionTarget(existing, rollbackPath),
    marketplaceBefore,
    marketplaceAfterSha256,
    createdAt: new Date().toISOString(),
  });
}

async function readInstallTransaction(context, version) {
  const transactionPath = installTransactionPath(context.dataDir);
  const transaction = await readJsonObject(transactionPath, "Plugin install transaction", { optional: true });
  if (!transaction) return null;
  if (
    transaction.schemaVersion !== 1
    || transaction.status !== "awaiting-marker-commit"
    || transaction.productId !== PRODUCT_ID
    || transaction.version !== version
    || typeof transaction.destination !== "string"
    || !path.isAbsolute(transaction.destination)
    || canonical(transaction.destination) !== canonical(context.destination)
    || typeof transaction.marketplacePath !== "string"
    || !path.isAbsolute(transaction.marketplacePath)
    || canonical(transaction.marketplacePath) !== canonical(context.marketplacePath)
    || !/^[0-9a-f]{64}$/.test(transaction.incomingContentSha256 ?? "")
    || !/^[0-9a-f]{64}$/.test(transaction.marketplaceAfterSha256 ?? "")
    || !transaction.target
    || !new Set(["absent", "managed", "legacy-0.1.1"]).has(transaction.target.kind)
    || typeof transaction.createdAt !== "string"
    || Number.isNaN(Date.parse(transaction.createdAt))
  ) {
    fail("Plugin install transaction is invalid or belongs to another operation.", SAFETY_EXIT_CODE);
  }
  validateMarketplaceSnapshot(transaction.marketplaceBefore);
  if (transaction.target.kind === "absent") {
    if (transaction.target.rollbackPath !== null) {
      fail("Plugin install transaction invents a rollback directory for an absent target.", SAFETY_EXIT_CODE);
    }
  } else {
    if (
      !/^[0-9a-f]{64}$/.test(transaction.target.contentSha256 ?? "")
      || typeof transaction.target.version !== "string"
      || (transaction.target.kind === "legacy-0.1.1" && transaction.target.version !== LEGACY_VERSION)
    ) {
      fail("Plugin install transaction target identity is incomplete.", SAFETY_EXIT_CODE);
    }
    transaction.target.rollbackPath = validateRollbackPath(transaction.target.rollbackPath, context.destination);
  }
  return { ...transaction, transactionPath };
}

async function restoreMarketplaceSnapshot(marketplacePath, snapshot, expectedCurrentSha256) {
  validateMarketplaceSnapshot(snapshot);
  const currentSha256 = await hashOrdinaryFile(marketplacePath, "Current personal marketplace");
  if (currentSha256 === snapshot.sha256) return;
  if (currentSha256 !== expectedCurrentSha256) {
    fail("Personal marketplace changed after plugin staging; rollback was refused.", SAFETY_EXIT_CODE);
  }
  if (!snapshot.existed) {
    await rm(marketplacePath, { force: true });
    if (await pathInfo(marketplacePath)) {
      fail("Prior absent marketplace state could not be restored.", SAFETY_EXIT_CODE);
    }
    return;
  }
  const text = Buffer.from(snapshot.utf8Base64, "base64").toString("utf8");
  await replaceJsonText(marketplacePath, text);
  if (await hashOrdinaryFile(marketplacePath, "Restored personal marketplace") !== snapshot.sha256) {
    fail("Restored personal marketplace does not match its prior snapshot.", SAFETY_EXIT_CODE);
  }
}

function descriptorsMatch(actual, expected) {
  return actual?.version === expected?.version && actual?.contentSha256 === expected?.contentSha256;
}

async function identifyTransactionDestination(destination, transaction) {
  if (!(await pathInfo(destination))) return "absent";
  const managed = await validateManagedPlugin(destination);
  if (managed) {
    if (managed.version === transaction.version
        && managed.contentSha256 === transaction.incomingContentSha256) return "incoming";
    if (transaction.target.kind === "managed" && descriptorsMatch(managed, transaction.target)) return "prior";
    fail("Managed plugin changed after marker staging; transaction action was refused.", SAFETY_EXIT_CODE);
  }
  if (transaction.target.kind === "legacy-0.1.1") {
    const legacy = await validateLegacyPlugin(destination);
    if (descriptorsMatch(legacy, transaction.target)) return "prior";
  }
  fail("Plugin destination no longer matches either verified transaction state.", SAFETY_EXIT_CODE);
}

async function validateTransactionRollback(transaction) {
  if (transaction.target.kind === "absent") return false;
  const rollbackInfo = await pathInfo(transaction.target.rollbackPath);
  if (!rollbackInfo) return false;
  if (transaction.target.kind === "managed") {
    const managed = await validateManagedPlugin(transaction.target.rollbackPath, transaction.target);
    if (!managed) fail("Plugin transaction rollback directory is not installer-managed.", SAFETY_EXIT_CODE);
  } else {
    const legacy = await validateLegacyPlugin(transaction.target.rollbackPath);
    if (!descriptorsMatch(legacy, transaction.target)) {
      fail("Legacy plugin transaction rollback directory changed.", SAFETY_EXIT_CODE);
    }
  }
  return true;
}

async function restoreTransactionPlugin(context, transaction, movePath = rename) {
  let state = await identifyTransactionDestination(context.destination, transaction);
  if (transaction.target.kind === "absent") {
    if (state === "incoming") {
      await rm(context.destination, { recursive: true, force: true });
      state = "absent";
    }
    if (state !== "absent") fail("An absent plugin target could not be restored.", SAFETY_EXIT_CODE);
    return;
  }

  const rollbackExists = await validateTransactionRollback(transaction);
  if (!rollbackExists) {
    if (state === "prior") return;
    fail("Verified prior plugin rollback state is missing.", SAFETY_EXIT_CODE);
  }
  if (state === "incoming" || state === "prior") {
    await rm(context.destination, { recursive: true, force: true });
    state = "absent";
  }
  if (state !== "absent") fail("Plugin transaction entered an unknown rollback state.", SAFETY_EXIT_CODE);
  await movePath(transaction.target.rollbackPath, context.destination);
  if (transaction.target.kind === "managed") {
    const restored = await validateManagedPlugin(context.destination, transaction.target);
    if (!restored) fail("Restored plugin is not installer-managed.", SAFETY_EXIT_CODE);
  } else {
    const restored = await validateLegacyPlugin(context.destination);
    if (!descriptorsMatch(restored, transaction.target)) {
      fail("Restored legacy plugin does not match the verified prior installation.", SAFETY_EXIT_CODE);
    }
  }
}

export async function rollbackInstallCommand({ marketplacePath, destination, dataDir, version, dependencies = {} }) {
  const context = { marketplacePath, destination, dataDir };
  const transaction = await readInstallTransaction(context, version);
  if (!transaction) fail("No marker-commit plugin transaction exists to roll back.", SAFETY_EXIT_CODE);
  await restoreMarketplaceSnapshot(
    marketplacePath,
    transaction.marketplaceBefore,
    transaction.marketplaceAfterSha256,
  );
  await restoreTransactionPlugin(context, transaction, dependencies.rename ?? rename);
  const restoredMarketplaceSha256 = await hashOrdinaryFile(marketplacePath, "Restored personal marketplace");
  if (restoredMarketplaceSha256 !== transaction.marketplaceBefore.sha256) {
    fail("Plugin transaction rollback did not restore the exact prior marketplace.", SAFETY_EXIT_CODE);
  }
  await rm(transaction.transactionPath, { force: true });
  if (transaction.target.kind !== "absent" && await pathInfo(transaction.target.rollbackPath)) {
    await rm(transaction.target.rollbackPath, { recursive: true, force: true }).catch(() => undefined);
  }
  return { status: "rolled-back" };
}

export async function finalizeInstallCommand({ marketplacePath, destination, dataDir, version }) {
  const context = { marketplacePath, destination, dataDir };
  const transaction = await readInstallTransaction(context, version);
  if (!transaction) fail("No marker-commit plugin transaction exists to finalize.", SAFETY_EXIT_CODE);
  if (await identifyTransactionDestination(destination, transaction) !== "incoming") {
    fail("Plugin transaction cannot finalize because the intended plugin is not installed.", SAFETY_EXIT_CODE);
  }
  if (await hashOrdinaryFile(marketplacePath, "Current personal marketplace")
      !== transaction.marketplaceAfterSha256) {
    fail("Personal marketplace changed before plugin transaction finalization.", SAFETY_EXIT_CODE);
  }
  if (transaction.target.kind !== "absent" && !(await validateTransactionRollback(transaction))) {
    fail("Plugin transaction cannot finalize without its verified prior rollback directory.", SAFETY_EXIT_CODE);
  }
  await rm(transaction.transactionPath, { force: true });
  if (transaction.target.kind !== "absent") {
    await rm(transaction.target.rollbackPath, { recursive: true, force: true }).catch(() => undefined);
  }
  return { status: "finalized" };
}

export async function installPluginCommand({
  marketplacePath,
  source,
  destination,
  dataDir,
  version,
  adoptLegacy = false,
  deferFinalize = false,
  dependencies = {},
}) {
  const mergeMarketplaceImpl = dependencies.mergeMarketplace ?? mergeMarketplace;
  const movePath = dependencies.rename ?? rename;
  const copyPath = dependencies.cp ?? cp;
  const pendingMarker = path.join(dataDir, "plugin-update-pending.json");
  const transactionPath = installTransactionPath(dataDir);
  if (await pathInfo(pendingMarker)) {
    fail("A plugin replacement is already pending; complete it before starting another install.", PENDING_EXIT_CODE);
  }
  if (await pathInfo(transactionPath)) {
    fail("A plugin marker transaction is already pending; finalize or roll it back before installing again.", SAFETY_EXIT_CODE);
  }
  const marketplace = await loadMarketplace(marketplacePath);
  const marketplaceBefore = deferFinalize ? await readMarketplaceSnapshot(marketplacePath) : null;
  const contentSha256 = await validatePluginSource(source, version);
  const existing = await inspectExistingPlugin(destination, { adoptLegacy, marketplace });
  const durableBackup = existing
    ? await createDurableBackup(destination, existing, dataDir, version)
    : null;
  const staged = await stagePlugin(source, dataDir, version, contentSha256);
  const expected = { version, contentSha256 };
  let swap;
  try {
    swap = await swapCandidate({ stagedPlugin: staged.stagedPlugin, destination, existing, expected, movePath, copyPath });
  } catch (error) {
    await writePendingMarker(pendingMarker, {
      version,
      staged,
      destination,
      existing,
      durableBackup,
      reason: error,
    });
    fail("Plugin replacement is pending because the destination could not be atomically replaced.", PENDING_EXIT_CODE, error);
  }

  try {
    await mergeMarketplaceImpl(marketplacePath);
  } catch (error) {
    await compensateSwap({ destination, rollbackPath: swap.rollbackPath, expected, movePath });
    await rm(staged.stagedRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  if (deferFinalize) {
    let marketplaceAfter;
    try {
      marketplaceAfter = await readMarketplaceSnapshot(marketplacePath);
      if (!marketplaceAfter.existed) {
        fail("Deferred plugin install did not create a personal marketplace.", SAFETY_EXIT_CODE);
      }
      await writeInstallTransaction({
        transactionPath,
        marketplacePath,
        destination,
        version,
        contentSha256,
        existing,
        rollbackPath: swap.rollbackPath,
        marketplaceBefore,
        marketplaceAfterSha256: marketplaceAfter.sha256,
      });
    } catch (error) {
      try {
        marketplaceAfter ??= await readMarketplaceSnapshot(marketplacePath);
        await restoreMarketplaceSnapshot(marketplacePath, marketplaceBefore, marketplaceAfter.sha256);
        await compensateSwap({ destination, rollbackPath: swap.rollbackPath, expected, movePath });
      } catch (restoreError) {
        fail(
          "Deferred plugin install failed and its verified prior state could not be restored.",
          SAFETY_EXIT_CODE,
          restoreError,
        );
      }
      await rm(staged.stagedRoot, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    await rm(staged.stagedRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(pendingMarker, { force: true });
    return { status: "awaiting-marker-commit", backup: durableBackup, contentSha256 };
  }
  await finishSuccessfulSwap({ staged, rollbackPath: swap.rollbackPath, pendingMarker });
  return { status: "installed", backup: durableBackup, contentSha256 };
}

function validatePendingShape(marker, context, version) {
  if (
    marker?.schemaVersion !== 2
    || marker.status !== "pending-codex-restart"
    || marker.productId !== PRODUCT_ID
    || marker.version !== version
    || typeof marker.destination !== "string"
    || !path.isAbsolute(marker.destination)
    || canonical(marker.destination) !== canonical(context.destination)
    || typeof marker.stagedPlugin !== "string"
    || !path.isAbsolute(marker.stagedPlugin)
    || !/^[0-9a-f]{64}$/.test(marker.stagedContentSha256 ?? "")
    || !marker.target
    || !new Set(["absent", "managed", "legacy-0.1.1"]).has(marker.target.kind)
    || Number.isNaN(Date.parse(marker.createdAt))
  ) {
    fail("Pending plugin marker is invalid or belongs to another operation.", 65);
  }
  const stagingRoot = path.join(context.dataDir, "plugin-staging");
  requireInside(marker.stagedPlugin, stagingRoot, "Pending staged plugin");
  if (path.basename(path.resolve(marker.stagedPlugin)) !== PRODUCT_ID) {
    fail("Pending staged plugin has an invalid directory name.", 65);
  }
  const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!new RegExp(`^${escapedVersion}-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`, "i")
    .test(path.basename(path.dirname(marker.stagedPlugin)))) {
    fail("Pending staged plugin is outside the expected version staging directory.", 65);
  }
  if (marker.target.kind !== "absent") {
    if (
      !/^[0-9a-f]{64}$/.test(marker.target.contentSha256 ?? "")
      || typeof marker.target.version !== "string"
      || typeof marker.target.durableBackup !== "string"
      || !path.isAbsolute(marker.target.durableBackup)
      || (marker.target.kind === "legacy-0.1.1" && marker.target.version !== LEGACY_VERSION)
    ) {
      fail("Pending target identity is incomplete.", 65);
    }
    requireInside(marker.target.durableBackup, backupDirectoryFor(context.dataDir), "Pending durable backup");
  }
}

async function validatePendingTarget(marker, context, adoptLegacy) {
  if (marker.target.kind === "absent") {
    if (await pathInfo(context.destination)) fail("Pending target changed from absent to occupied.", 74);
    return null;
  }
  if (marker.target.kind === "managed") {
    const managed = await validateManagedPlugin(context.destination, marker.target);
    if (!managed) fail("Pending managed target no longer exists.", 74);
    const backup = await validateManagedPlugin(marker.target.durableBackup, marker.target);
    if (!backup) fail("Pending managed backup no longer exists.", 74);
    return managed;
  }
  if (!adoptLegacy) fail("Completing a legacy adoption requires explicit confirmation again.", 73);
  const marketplace = await loadMarketplace(context.marketplace);
  if (!hasCanonicalOrganizerEntry(marketplace)) fail("Legacy marketplace source changed while replacement was pending.", 73);
  const legacy = await validateLegacyPlugin(context.destination);
  if (legacy.contentSha256 !== marker.target.contentSha256) fail("Legacy target changed while replacement was pending.", 74);
  const backup = await validateLegacyPlugin(marker.target.durableBackup);
  if (backup.contentSha256 !== marker.target.contentSha256) fail("Legacy adoption backup no longer matches the pending target.", 74);
  return legacy;
}

export async function completePendingCommand({
  marketplacePath,
  destination,
  dataDir,
  version,
  adoptLegacy = false,
  dependencies = {},
}) {
  const mergeMarketplaceImpl = dependencies.mergeMarketplace ?? mergeMarketplace;
  const movePath = dependencies.rename ?? rename;
  const copyPath = dependencies.cp ?? cp;
  const pendingMarker = path.join(dataDir, "plugin-update-pending.json");
  const marker = await readJsonObject(pendingMarker, "Pending plugin marker", { optional: true });
  if (!marker) return { status: "no-pending" };
  const context = { marketplace: marketplacePath, destination, dataDir };
  validatePendingShape(marker, context, version);

  const stagedStats = await pathInfo(marker.stagedPlugin);
  if (!stagedStats) {
    const installed = await validateManagedPlugin(destination, {
      version,
      contentSha256: marker.stagedContentSha256,
    });
    const marketplace = await loadMarketplace(marketplacePath);
    if (!installed || !hasCanonicalOrganizerEntry(marketplace)) {
      fail("Pending staged plugin is missing and the intended installation is not complete.", SAFETY_EXIT_CODE);
    }
    await rm(pendingMarker, { force: true });
    return { status: "completed-already", contentSha256: marker.stagedContentSha256 };
  }

  const staged = await validateManagedPlugin(marker.stagedPlugin, {
    version,
    contentSha256: marker.stagedContentSha256,
  });
  if (!staged) fail("Pending staged plugin is not installer-managed.", 65);
  await loadMarketplace(marketplacePath);
  const existing = await validatePendingTarget(marker, context, adoptLegacy);
  const expected = { version, contentSha256: marker.stagedContentSha256 };
  let swap;
  try {
    swap = await swapCandidate({
      stagedPlugin: marker.stagedPlugin,
      destination,
      existing,
      expected,
      movePath,
      copyPath,
    });
  } catch (error) {
    fail("Plugin replacement is still pending; the target could not be atomically replaced.", PENDING_EXIT_CODE, error);
  }

  try {
    await mergeMarketplaceImpl(marketplacePath);
  } catch (error) {
    await compensateSwap({ destination, rollbackPath: swap.rollbackPath, expected, movePath });
    throw error;
  }
  const stagedRoot = path.dirname(marker.stagedPlugin);
  await finishSuccessfulSwap({ staged: { stagedRoot }, rollbackPath: swap.rollbackPath, pendingMarker });
  return {
    status: "installed",
    backup: marker.target.durableBackup ?? null,
    contentSha256: marker.stagedContentSha256,
  };
}

async function discardPendingStaging(dataDir) {
  const markerPath = path.join(dataDir, "plugin-update-pending.json");
  const marker = await readJsonObject(markerPath, "Pending plugin marker", { optional: true }).catch(() => null);
  if (!marker || marker.schemaVersion !== 2 || marker.productId !== PRODUCT_ID || typeof marker.stagedPlugin !== "string") return;
  try {
    requireInside(marker.stagedPlugin, path.join(dataDir, "plugin-staging"), "Pending staged plugin");
    await rm(path.dirname(marker.stagedPlugin), { recursive: true, force: true });
    await rm(markerPath, { force: true });
  } catch {
    // Invalid or inaccessible pending state is preserved for manual diagnosis.
  }
}

export async function removePluginCommand({ marketplacePath, destination, dataDir, dependencies = {} }) {
  const movePath = dependencies.rename ?? rename;
  const destinationExists = Boolean(await pathInfo(destination));
  const existing = await validateManagedPlugin(destination);
  if (destinationExists && !existing) {
    fail("Existing Organizer directory is not owned by this installer; removal was refused.", 73);
  }
  await loadMarketplace(marketplacePath);
  if (!existing) {
    const marketplaceEntryRemoved = await removeMarketplaceEntry(marketplacePath);
    await discardPendingStaging(dataDir);
    return { status: "not-installed", marketplaceEntryRemoved };
  }

  const backupRoot = backupDirectoryFor(dataDir);
  await mkdir(backupRoot, { recursive: true });
  const backup = path.join(backupRoot, `uninstalled-${Date.now()}-${randomUUID()}`);
  await movePath(destination, backup);
  let marketplaceEntryRemoved;
  try {
    marketplaceEntryRemoved = await removeMarketplaceEntry(marketplacePath);
  } catch (error) {
    try {
      await movePath(backup, destination);
    } catch (restoreError) {
      fail("Marketplace removal failed and the managed plugin could not be restored.", SAFETY_EXIT_CODE, restoreError);
    }
    throw error;
  }
  await discardPendingStaging(dataDir);
  return { status: "moved-to-backup", backup, marketplaceEntryRemoved };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const userHome = os.homedir();
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) fail("LOCALAPPDATA is required.", 66);

  const expectedMarketplace = path.join(userHome, ".agents", "plugins", "marketplace.json");
  const expectedDestination = path.join(userHome, "plugins", PRODUCT_ID);
  const expectedDataDir = path.join(localAppData, "SkillOrganizerForCodex");
  requireExactPath(options.marketplace, expectedMarketplace, "Marketplace path");
  requireExactPath(options["plugin-destination"], expectedDestination, "Plugin destination");
  requireExactPath(options["data-dir"], expectedDataDir, "Organizer data directory");

  const context = {
    marketplacePath: path.resolve(options.marketplace),
    destination: path.resolve(options["plugin-destination"]),
    dataDir: path.resolve(options["data-dir"]),
  };
  if (options.command === "install") {
    if (!options["plugin-source"] || !options.version) fail("Install requires --plugin-source and --version.", 64);
    const version = requireSemver(options.version, "Installer version");
    const programRoot = path.join(localAppData, "Programs", "SkillOrganizerForCodex");
    requireInside(options["plugin-source"], programRoot, "Plugin source");
    const result = await installPluginCommand({
      ...context,
      source: path.resolve(options["plugin-source"]),
      version,
      adoptLegacy: parseBoolean(options["adopt-legacy-0.1.1"], "--adopt-legacy-0.1.1"),
      deferFinalize: parseBoolean(options["defer-finalize"], "--defer-finalize"),
    });
    process.stdout.write(`${JSON.stringify({ ...result, marketplaceRegistered: true })}\n`);
    return;
  }
  if (options.command === "complete-pending") {
    if (!options.version) fail("Complete-pending requires --version.", 64);
    const result = await completePendingCommand({
      ...context,
      version: requireSemver(options.version, "Pending version"),
      adoptLegacy: parseBoolean(options["adopt-legacy-0.1.1"], "--adopt-legacy-0.1.1"),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (options.command === "rollback-install" || options.command === "finalize-install") {
    if (!options.version) fail(`${options.command} requires --version.`, 64);
    const transactionContext = {
      ...context,
      version: requireSemver(options.version, "Transaction version"),
    };
    const result = options.command === "rollback-install"
      ? await rollbackInstallCommand(transactionContext)
      : await finalizeInstallCommand(transactionContext);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  const result = await removePluginCommand(context);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`Skill Organizer plugin registration failed: ${error.message}\n`);
    process.exitCode = Number.isInteger(error.exitCode) ? error.exitCode : 1;
  });
}
