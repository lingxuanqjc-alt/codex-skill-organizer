import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadDotnetEvidence } from "./dotnet-evidence.mjs";

const LICENSE_NAMES = ["LICENSE", "LICENSE.md", "LICENSE.txt", "LICENCE", "LICENCE.md", "COPYING"];

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) throw new Error(`Invalid argument near ${flag ?? "<end>"}.`);
    values[flag.slice(2)] = value;
  }
  for (const name of ["root", "node-runtime-root", "output", "desktop-assets", "dotnet-sdk-version"]) {
    if (!values[name]) throw new Error(`--${name} is required.`);
  }
  return values;
}

function packageNameFromLocation(location) {
  const marker = "node_modules/";
  const index = location.lastIndexOf(marker);
  return index === -1 ? location : location.slice(index + marker.length);
}

async function optionalText(file) {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function findLicense(packageRoot) {
  for (const name of LICENSE_NAMES) {
    const text = await optionalText(path.join(packageRoot, name));
    if (text !== null) return { name, text: text.trim() };
  }
  return null;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const root = path.resolve(options.root);
  const runtimeRoot = path.resolve(options["node-runtime-root"]);
  const nodeLicense = await optionalText(path.join(runtimeRoot, "LICENSE"));
  if (!nodeLicense) throw new Error("Pinned Node.js runtime does not contain LICENSE.");

  const lock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
  if (!lock.packages || typeof lock.packages !== "object") throw new Error("package-lock.json must contain packages metadata.");
  const packages = [];
  for (const [location, lockEntry] of Object.entries(lock.packages)) {
    if (!location || !location.includes("node_modules/") || !lockEntry || typeof lockEntry !== "object") continue;
    const packageRoot = path.join(root, ...location.split("/"));
    let packageJson;
    try {
      packageJson = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT" && lockEntry.optional) continue;
      throw error;
    }
    const name = packageJson.name ?? lockEntry.name ?? packageNameFromLocation(location);
    const version = packageJson.version ?? lockEntry.version;
    const license = packageJson.license ?? lockEntry.license ?? "NOASSERTION";
    if (!name || !version) throw new Error(`Dependency metadata is incomplete for ${location}.`);
    packages.push({
      name,
      version,
      license: typeof license === "string" ? license : "NOASSERTION",
      development: Boolean(lockEntry.dev),
      licenseFile: await findLicense(packageRoot),
    });
  }
  packages.sort((left, right) => `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`, "en"));
  const dotnet = await loadDotnetEvidence({
    assetsPath: options["desktop-assets"],
    sdkVersion: options["dotnet-sdk-version"],
  });

  const lines = [
    "THIRD-PARTY SOFTWARE NOTICES",
    "Skill Organizer for Codex",
    "",
    "This file is generated from the exact npm dependency tree, bundled Node.js runtime, and restored .NET/NuGet evidence used for this release.",
    "A development dependency is used to build or test the release and is not necessarily present as a separate runtime file.",
    "",
    "DEPENDENCY INDEX",
    ...packages.map((item) => `- ${item.name}@${item.version} — ${item.license}${item.development ? " (development)" : ""}`),
    "",
    ".NET AND NUGET COMPONENT INDEX",
    `- ${dotnet.sdk.name}@${dotnet.sdk.version} — build-only — ${dotnet.sdk.licenseExpression} — ${dotnet.sdk.licenseUrl}`,
    ...dotnet.components.map((item) => {
      const evidence = item.evidence.licenseExpression
        ?? item.evidence.licenseFile
        ?? item.evidence.licenseUrl
        ?? "NOASSERTION";
      return `- ${item.name}@${item.version} — ${item.bundled ? "bundled runtime" : "build-only"} — ${evidence} — NuGet SHA-512 ${item.packageSha512}`;
    }),
    "",
  ];

  for (const item of packages) {
    if (!item.licenseFile) continue;
    lines.push(
      "=".repeat(78),
      `${item.name}@${item.version} — ${item.licenseFile.name}`,
      "=".repeat(78),
      item.licenseFile.text,
      "",
    );
  }

  const dotnetEvidence = new Map();
  for (const component of dotnet.components) {
    for (const file of component.evidence.files) {
      const current = dotnetEvidence.get(file.sha256) ?? {
        sha256: file.sha256,
        names: new Set(),
        files: new Set(),
        text: file.text,
      };
      current.names.add(`${component.name}@${component.version}`);
      current.files.add(file.name);
      dotnetEvidence.set(file.sha256, current);
    }
  }
  for (const evidence of [...dotnetEvidence.values()].sort((left, right) => left.sha256.localeCompare(right.sha256, "en"))) {
    lines.push(
      "=".repeat(78),
      `.NET/NuGet license evidence — ${[...evidence.names].sort().join(", ")}`,
      `Files: ${[...evidence.files].sort().join(", ")} — SHA-256 ${evidence.sha256}`,
      "=".repeat(78),
      evidence.text,
      "",
    );
  }

  lines.push(
    "=".repeat(78),
    "Bundled Node.js runtime — LICENSE",
    "=".repeat(78),
    nodeLicense.trim(),
    "",
  );

  const output = path.resolve(options.output);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${lines.join("\n")}\n`, "utf8");
  process.stdout.write(`Wrote notices for ${packages.length} npm and ${dotnet.components.length} .NET/NuGet components to ${output}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
