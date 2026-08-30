import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";

const MAX_TEXT_FILE_BYTES = 1024 * 1024;
const EXCLUDED_DIRECTORY_NAMES = new Set([
  ".git",
  ".idea",
  ".release-runtime",
  ".vs",
  ".vscode",
  "artifacts",
  "bin",
  "coverage",
  "dist",
  "node_modules",
  "obj",
  "output",
  "playwright-report",
  "self-contained-publish",
  "test-results",
]);
const BINARY_EXTENSIONS = new Set([
  ".7z", ".avi", ".bmp", ".class", ".dll", ".dylib", ".eot", ".exe",
  ".gif", ".gz", ".ico", ".jpeg", ".jpg", ".mov", ".mp3", ".mp4",
  ".pdf", ".png", ".so", ".tar", ".tif", ".tiff", ".ttf", ".wav",
  ".webm", ".webp", ".woff", ".woff2", ".zip",
]);
const SENSITIVE_EXTENSIONS = new Set([
  ".cer", ".crt", ".der", ".jks", ".key", ".keystore", ".p12", ".p7b",
  ".p7c", ".pem", ".pfx", ".snk",
]);
const SAFE_ENV_TEMPLATE_NAMES = new Set([".env.example", ".env.sample", ".env.template"]);
const SENSITIVE_EXACT_NAMES = new Set([
  ".env",
  ".envrc",
  ".netrc",
  ".npmrc",
  ".pypirc",
  "credentials.json",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "id_rsa",
]);
const PLUGIN_FILES = new Set([
  ".codex-plugin/plugin.json",
  ".mcp.json",
  "assets/skill-organizer.svg",
  "scripts/start-mcp.cmd",
  "skills/skill-organizer/SKILL.md",
]);
const PLUGIN_DIRECTORIES = new Set([
  ".codex-plugin",
  "assets",
  "scripts",
  "skills",
  "skills/skill-organizer",
]);
const MARKETPLACE_PLUGIN_PREFIX = "plugins/codex-skill-organizer";
const MARKETPLACE_FILES = new Set([
  "marketplace.json",
  ...[...PLUGIN_FILES].map((relativePath) => `${MARKETPLACE_PLUGIN_PREFIX}/${relativePath}`),
]);
const MARKETPLACE_DIRECTORIES = new Set([
  "plugins",
  MARKETPLACE_PLUGIN_PREFIX,
  ...[...PLUGIN_DIRECTORIES].map((relativePath) => `${MARKETPLACE_PLUGIN_PREFIX}/${relativePath}`),
]);

const SECRET_PATTERNS = [
  {
    id: "PRIVATE_KEY_BLOCK",
    expression: new RegExp([
      "-----BEGIN ",
      "(?:RSA |EC |DSA |OPENSSH |PGP )?",
      "PRIVATE KEY-----",
    ].join(""), "u"),
  },
  { id: "AWS_ACCESS_KEY_ID", expression: /(?:^|[^A-Z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Z0-9])/u },
  { id: "GITHUB_TOKEN", expression: /(?:github_pat_[A-Za-z0-9_]{40,}|gh[pousr]_[A-Za-z0-9]{36,})/u },
  { id: "OPENAI_API_KEY", expression: /(?:^|[^A-Za-z0-9])sk-(?:proj-)?[A-Za-z0-9_-]{32,}/u },
  { id: "GOOGLE_API_KEY", expression: /AIza[0-9A-Za-z_-]{35}/u },
  { id: "STRIPE_LIVE_KEY", expression: /(?:sk|rk)_live_[0-9A-Za-z]{16,}/u },
  { id: "SLACK_TOKEN", expression: /xox[baprs]-[0-9A-Za-z-]{20,}/u },
  { id: "BEARER_CREDENTIAL", expression: /Authorization\s*:\s*Bearer\s+[A-Za-z0-9._~+/=-]{20,}/iu },
  {
    id: "GENERIC_CREDENTIAL_ASSIGNMENT",
    expression: /(?:api[_-]?key|client[_-]?secret|access[_-]?token|password)\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{24,}/iu,
  },
];

function normalizedRelative(root, candidate) {
  return path.relative(root, candidate).split(path.sep).join("/");
}

function pathIsWithin(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function lineAt(text, index) {
  let line = 1;
  for (let offset = 0; offset < index; offset += 1) {
    if (text.charCodeAt(offset) === 10) line += 1;
  }
  return line;
}

function sensitiveFilename(relativePath) {
  const basename = path.posix.basename(relativePath).toLocaleLowerCase("en-US");
  if (SAFE_ENV_TEMPLATE_NAMES.has(basename)) return false;
  if (basename.startsWith(".env.")) return true;
  if (SENSITIVE_EXACT_NAMES.has(basename)) return true;
  if (SENSITIVE_EXTENSIONS.has(path.posix.extname(basename))) return true;
  return /^service-account(?:[._-].+)?\.json$/u.test(basename);
}

function decodeText(buffer) {
  if (buffer.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return null;
  }
}

function issue(code, relativePath, detail, line) {
  return { code, path: relativePath || ".", detail, ...(line ? { line } : {}) };
}

export async function scanRepository(repositoryRoot) {
  const root = path.resolve(repositoryRoot);
  const rootInfo = await lstat(root);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new Error("Repository root must be a physical directory.");
  }
  const physicalRoot = await realpath(root);
  const issues = [];
  let scannedTextFiles = 0;
  let skippedKnownBinaryFiles = 0;

  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const normalizedName = entry.name.toLocaleLowerCase("en-US");
      if (normalizedName === ".git" || (
        !entry.isFile()
        && EXCLUDED_DIRECTORY_NAMES.has(normalizedName)
      )) {
        continue;
      }
      const entryPath = path.join(directory, entry.name);
      const relativePath = normalizedRelative(root, entryPath);
      const info = await lstat(entryPath);
      if (info.isSymbolicLink()) {
        issues.push(issue("REPOSITORY_LINK", relativePath, "repository candidates cannot contain filesystem links"));
        continue;
      }
      const physicalPath = await realpath(entryPath);
      if (!pathIsWithin(physicalPath, physicalRoot)) {
        issues.push(issue("REPOSITORY_PATH_ESCAPE", relativePath, "resolved path leaves the repository root"));
        continue;
      }
      if (info.isDirectory()) {
        await visit(entryPath);
        continue;
      }
      if (!info.isFile()) {
        issues.push(issue("REPOSITORY_SPECIAL_FILE", relativePath, "repository candidates must be regular files"));
        continue;
      }
      if (sensitiveFilename(relativePath)) {
        issues.push(issue("SENSITIVE_FILENAME", relativePath, "secret, private-key, or certificate filename is not publishable"));
        continue;
      }
      const extension = path.extname(entry.name).toLocaleLowerCase("en-US");
      if (BINARY_EXTENSIONS.has(extension)) {
        skippedKnownBinaryFiles += 1;
        continue;
      }
      if (info.size > MAX_TEXT_FILE_BYTES) {
        issues.push(issue("UNSCANNED_LARGE_FILE", relativePath, `non-binary candidate exceeds ${MAX_TEXT_FILE_BYTES} bytes`));
        continue;
      }
      const text = decodeText(await readFile(physicalPath));
      if (text === null) {
        issues.push(issue(
          "UNSCANNED_BINARY_FILE",
          relativePath,
          "unknown-extension binary candidate is not allowed because its contents cannot be scanned",
        ));
        continue;
      }
      scannedTextFiles += 1;
      for (const pattern of SECRET_PATTERNS) {
        const match = pattern.expression.exec(text);
        if (!match) continue;
        issues.push(issue(pattern.id, relativePath, "credential-like content matched a deterministic release pattern", lineAt(text, match.index)));
      }
    }
  }

  await visit(root);
  issues.sort((left, right) => left.path.localeCompare(right.path, "en")
    || (left.line ?? 0) - (right.line ?? 0)
    || left.code.localeCompare(right.code, "en"));
  return { issues, scannedTextFiles, skippedKnownBinaryFiles };
}

async function validateExactPublishTree(publishRoot, expectedFiles, expectedDirectories, codePrefix) {
  const root = path.resolve(publishRoot);
  const rootInfo = await lstat(root);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    return { issues: [issue(`${codePrefix}_LINK`, ".", "publish root must be a physical directory")] };
  }
  const physicalRoot = await realpath(root);
  const issues = [];
  const seen = new Set();

  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      const relativePath = normalizedRelative(root, entryPath);
      const info = await lstat(entryPath);
      if (info.isSymbolicLink()) {
        issues.push(issue(`${codePrefix}_LINK`, relativePath, "publish tree cannot contain filesystem links"));
        continue;
      }
      const physicalPath = await realpath(entryPath);
      if (!pathIsWithin(physicalPath, physicalRoot)) {
        issues.push(issue(`${codePrefix}_LINK`, relativePath, "entry resolves outside the publish root"));
        continue;
      }
      if (info.isDirectory()) {
        if (!expectedDirectories.has(relativePath)) {
          issues.push(issue(`${codePrefix}_EXTRA_ENTRY`, relativePath, "directory is not in the exact publish allowlist"));
          continue;
        }
        seen.add(relativePath);
        await visit(entryPath);
        continue;
      }
      if (!info.isFile()) {
        issues.push(issue(`${codePrefix}_SPECIAL_FILE`, relativePath, "publish entries must be regular files"));
        continue;
      }
      if (!expectedFiles.has(relativePath)) {
        issues.push(issue(`${codePrefix}_EXTRA_ENTRY`, relativePath, "file is not in the exact publish allowlist"));
        continue;
      }
      seen.add(relativePath);
    }
  }

  await visit(root);
  for (const expected of [...expectedDirectories, ...expectedFiles]) {
    if (!seen.has(expected)) issues.push(issue(`${codePrefix}_MISSING_ENTRY`, expected, "required allowlisted entry is missing"));
  }
  issues.sort((left, right) => left.path.localeCompare(right.path, "en") || left.code.localeCompare(right.code, "en"));
  return { issues };
}

export function validatePluginPublishTree(pluginRoot) {
  return validateExactPublishTree(pluginRoot, PLUGIN_FILES, PLUGIN_DIRECTORIES, "PLUGIN");
}

export function validateMarketplacePublishTree(marketplaceRoot) {
  return validateExactPublishTree(
    marketplaceRoot,
    MARKETPLACE_FILES,
    MARKETPLACE_DIRECTORIES,
    "MARKETPLACE",
  );
}

function printIssues(label, issues) {
  process.stderr.write(`${label} failed with ${issues.length} issue(s):\n`);
  for (const item of issues) {
    const location = item.line ? `${item.path}:${item.line}` : item.path;
    process.stderr.write(`- [${item.code}] ${location}: ${item.detail}\n`);
  }
}

function parseArguments(arguments_) {
  const parsed = { repositoryRoot: null, pluginRoot: null, marketplaceRoot: null };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    const value = arguments_[index + 1];
    if (
      (argument === "--repository-root" || argument === "--plugin-root" || argument === "--marketplace-root")
      && value
      && !value.startsWith("--")
    ) {
      if (argument === "--repository-root") parsed.repositoryRoot = value;
      else if (argument === "--plugin-root") parsed.pluginRoot = value;
      else parsed.marketplaceRoot = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown or incomplete security-gate argument: ${argument}`);
  }
  if (!parsed.repositoryRoot && !parsed.pluginRoot && !parsed.marketplaceRoot) {
    throw new Error("Use --repository-root, --plugin-root, and/or --marketplace-root.");
  }
  return parsed;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  let failed = false;
  if (options.repositoryRoot) {
    const result = await scanRepository(options.repositoryRoot);
    if (result.issues.length) {
      printIssues("Repository security validation", result.issues);
      failed = true;
    } else {
      process.stdout.write(
        `Repository security validation passed: ${result.scannedTextFiles} text candidates; `
        + `${result.skippedKnownBinaryFiles} known binary files not read.\n`,
      );
    }
  }
  if (options.pluginRoot) {
    const result = await validatePluginPublishTree(options.pluginRoot);
    if (result.issues.length) {
      printIssues("Plugin publish validation", result.issues);
      failed = true;
    } else {
      process.stdout.write("Plugin publish validation passed: exact allowlist matched.\n");
    }
  }
  if (options.marketplaceRoot) {
    const result = await validateMarketplacePublishTree(options.marketplaceRoot);
    if (result.issues.length) {
      printIssues("Marketplace publish validation", result.issues);
      failed = true;
    } else {
      process.stdout.write("Marketplace publish validation passed: exact allowlist matched.\n");
    }
  }
  if (failed) process.exitCode = 1;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write(`Security validation failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
