import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PRODUCT_VERSION_TOKEN = "__PRODUCT_VERSION__";

const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function contractPaths(root) {
  return {
    packageJson: path.join(root, "package.json"),
    packageLock: path.join(root, "package-lock.json"),
    pluginManifest: path.join(root, "plugin", "plugins", "codex-skill-organizer", ".codex-plugin", "plugin.json"),
    webIndex: path.join(root, "src", "web", "index.html"),
  };
}

async function readJson(filePath, label) {
  let value;
  try {
    value = JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${filePath}`, { cause: error });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must contain a JSON object: ${filePath}`);
  }
  return value;
}

export async function readProductVersion(root) {
  const resolvedRoot = path.resolve(root);
  const packageMetadata = await readJson(contractPaths(resolvedRoot).packageJson, "package.json");
  if (typeof packageMetadata.version !== "string" || !SEMVER_PATTERN.test(packageMetadata.version)) {
    throw new Error(`package.json version must be strict semver, got ${String(packageMetadata.version)}`);
  }
  return packageMetadata.version;
}

export async function assertVersionContract(root) {
  const resolvedRoot = path.resolve(root);
  const files = contractPaths(resolvedRoot);
  const [version, lock, pluginManifest, webIndex] = await Promise.all([
    readProductVersion(resolvedRoot),
    readJson(files.packageLock, "package-lock.json"),
    readJson(files.pluginManifest, "plugin manifest"),
    readFile(files.webIndex, "utf8"),
  ]);

  const failures = [];
  if (lock.version !== version || lock.packages?.[""]?.version !== version) {
    failures.push("package-lock.json root versions are stale");
  }
  if (pluginManifest.version !== version) {
    failures.push(`plugin manifest version is ${String(pluginManifest.version)}, expected ${version}`);
  }
  if (!SEMVER_PATTERN.test(String(pluginManifest.version ?? ""))) {
    failures.push("plugin manifest version is not strict semver");
  }
  if (!webIndex.includes(PRODUCT_VERSION_TOKEN)) {
    failures.push(`src/web/index.html is missing ${PRODUCT_VERSION_TOKEN}`);
  }

  if (failures.length > 0) {
    throw new Error(
      `Product version contract failed (${failures.join("; ")}). ` +
      "Edit only package.json, then run npm run version:sync.",
    );
  }
  return { version, files };
}

export function renderProductVersion(source, version, label = "versioned source") {
  if (!SEMVER_PATTERN.test(version)) {
    throw new Error(`Cannot render invalid product version: ${version}`);
  }
  if (!source.includes(PRODUCT_VERSION_TOKEN)) {
    throw new Error(`${label} is missing ${PRODUCT_VERSION_TOKEN}`);
  }
  const rendered = source.replaceAll(PRODUCT_VERSION_TOKEN, version);
  if (rendered.includes(PRODUCT_VERSION_TOKEN)) {
    throw new Error(`${label} still contains an unresolved product version token`);
  }
  return rendered;
}

export async function syncVersionContract(root) {
  const resolvedRoot = path.resolve(root);
  const files = contractPaths(resolvedRoot);
  const version = await readProductVersion(resolvedRoot);
  const [lock, pluginManifest] = await Promise.all([
    readJson(files.packageLock, "package-lock.json"),
    readJson(files.pluginManifest, "plugin manifest"),
  ]);

  lock.version = version;
  if (!lock.packages?.[""] || typeof lock.packages[""] !== "object") {
    throw new Error("package-lock.json is missing packages[\"\"]");
  }
  lock.packages[""].version = version;
  pluginManifest.version = version;

  await Promise.all([
    writeFile(files.packageLock, `${JSON.stringify(lock, null, 2)}\n`, "utf8"),
    writeFile(files.pluginManifest, `${JSON.stringify(pluginManifest, null, 2)}\n`, "utf8"),
  ]);
  await assertVersionContract(resolvedRoot);
  return version;
}

function parseArguments(argv) {
  let mode = "check";
  let root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--check") mode = "check";
    else if (argument === "--write") mode = "write";
    else if (argument === "--root") {
      const value = argv[index + 1];
      if (!value) throw new Error("--root requires a path");
      root = path.resolve(value);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return { mode, root };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const { mode, root } = parseArguments(process.argv.slice(2));
    const version = mode === "write"
      ? await syncVersionContract(root)
      : (await assertVersionContract(root)).version;
    console.log(`Product version contract ${mode === "write" ? "synchronized" : "passed"}: ${version}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
