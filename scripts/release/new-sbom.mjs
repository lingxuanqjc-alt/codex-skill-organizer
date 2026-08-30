import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadDotnetEvidence } from "./dotnet-evidence.mjs";

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) throw new Error(`Invalid argument near ${flag ?? "<end>"}.`);
    values[flag.slice(2)] = value;
  }
  for (const name of ["root", "output", "version", "node-runtime-root", "desktop-assets", "dotnet-sdk-version"]) {
    if (!values[name]) throw new Error(`--${name} is required.`);
  }
  return values;
}

async function sha256(file) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

function packageNameFromLocation(location) {
  const marker = "node_modules/";
  const index = location.lastIndexOf(marker);
  return index === -1 ? location : location.slice(index + marker.length);
}

function purlFor(name, version) {
  const encodedName = name.startsWith("@")
    ? `${encodeURIComponent(name.slice(1).split("/")[0])}/${encodeURIComponent(name.split("/")[1])}`
    : encodeURIComponent(name);
  return `pkg:npm/${encodedName}@${encodeURIComponent(version)}`;
}

function nugetPurl(name, version) {
  return `pkg:nuget/${encodeURIComponent(name)}@${encodeURIComponent(version)}`;
}

function dotnetLicenses(component) {
  if (component.evidence?.licenseExpression) return [{ expression: component.evidence.licenseExpression }];
  if (component.licenseExpression) return [{ expression: component.licenseExpression }];
  const licenseFile = component.evidence?.files.find((file) => file.kind === "license");
  return licenseFile ? [{ license: { name: `${component.name} ${licenseFile.name}` } }] : [];
}

function dotnetExternalReferences(component) {
  const evidence = component.evidence ?? component;
  const references = [];
  if (evidence.repositoryUrl) references.push({ type: "vcs", url: evidence.repositoryUrl });
  if (evidence.projectUrl) references.push({ type: "website", url: evidence.projectUrl });
  if (evidence.licenseUrl) references.push({ type: "license", url: evidence.licenseUrl });
  return references;
}

function cycloneDxLicense(rawLicense) {
  if (/\b(?:AND|OR|WITH)\b|[()]/.test(rawLicense)) return { expression: rawLicense };
  if (/^[A-Za-z0-9.+-]+$/.test(rawLicense)) return { license: { id: rawLicense } };
  return { license: { name: rawLicense } };
}

async function loadPackageMetadata(root, location, lockEntry) {
  const packageFile = path.join(root, ...location.split("/"), "package.json");
  let packageJson = {};
  try {
    packageJson = JSON.parse(await readFile(packageFile, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const name = packageJson.name ?? lockEntry.name ?? packageNameFromLocation(location);
  const version = packageJson.version ?? lockEntry.version;
  if (!name || !version) throw new Error(`Dependency metadata is incomplete for ${location}.`);
  const rawLicense = packageJson.license ?? lockEntry.license ?? "NOASSERTION";
  const license = typeof rawLicense === "string" ? rawLicense : "NOASSERTION";
  return { name, version, license, packageJson };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const root = path.resolve(options.root);
  const runtimeRoot = path.resolve(options["node-runtime-root"]);
  const runtimeVersion = process.version.replace(/^v/, "");
  const runtimeExe = path.join(runtimeRoot, "node.exe");
  const runtimeLicense = path.join(runtimeRoot, "LICENSE");
  await readFile(runtimeLicense, "utf8");
  const lock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
  if (!lock.packages || typeof lock.packages !== "object") throw new Error("package-lock.json must use lockfile packages metadata.");

  const componentsByPurl = new Map();
  for (const [location, lockEntry] of Object.entries(lock.packages)) {
    if (!location || !location.includes("node_modules/") || !lockEntry || typeof lockEntry !== "object") continue;
    const metadata = await loadPackageMetadata(root, location, lockEntry);
    const purl = purlFor(metadata.name, metadata.version);
    if (componentsByPurl.has(purl)) continue;
    const component = {
      type: "library",
      "bom-ref": purl,
      name: metadata.name,
      version: metadata.version,
      scope: lockEntry.dev ? "excluded" : "required",
      licenses: [cycloneDxLicense(metadata.license)],
      purl,
      properties: [
        { name: "cdx:npm:package:path", value: location },
        { name: "skill-organizer:build-development-dependency", value: String(Boolean(lockEntry.dev)) },
      ],
    };
    const repository = typeof metadata.packageJson.repository === "string"
      ? metadata.packageJson.repository
      : metadata.packageJson.repository?.url;
    if (typeof repository === "string" && repository.trim()) {
      component.externalReferences = [{ type: "vcs", url: repository.replace(/^git\+/, "") }];
    }
    componentsByPurl.set(purl, component);
  }
  const components = [...componentsByPurl.values()];
  components.push({
    type: "framework",
    "bom-ref": `pkg:generic/nodejs@${runtimeVersion}?arch=x64&os=windows`,
    name: "Node.js",
    version: runtimeVersion,
    supplier: { name: "Node.js contributors" },
    hashes: [{ alg: "SHA-256", content: await sha256(runtimeExe) }],
    licenses: [{ license: { name: "Node.js license bundle" } }],
    purl: `pkg:generic/nodejs@${runtimeVersion}?arch=x64&os=windows`,
    scope: "required",
    properties: [
      { name: "skill-organizer:bundled-path", value: "runtime/node.exe" },
      { name: "skill-organizer:license-path", value: "runtime/LICENSE" },
    ],
  });
  const dotnet = await loadDotnetEvidence({
    assetsPath: options["desktop-assets"],
    sdkVersion: options["dotnet-sdk-version"],
  });
  for (const component of dotnet.components) {
    const purl = nugetPurl(component.name, component.version);
    const properties = [
      { name: "skill-organizer:dotnet-role", value: component.role },
      { name: "skill-organizer:bundled", value: String(component.bundled) },
      { name: "skill-organizer:nuget-package-path", value: component.packagePath.replaceAll("\\", "/") },
    ];
    for (const file of component.evidence.files) {
      properties.push({ name: `skill-organizer:license-evidence:${file.name}`, value: file.sha256 });
    }
    const item = {
      type: component.role === "runtime" ? "framework" : "library",
      "bom-ref": purl,
      name: component.name,
      version: component.version,
      hashes: [{ alg: "SHA-512", content: component.packageSha512 }],
      licenses: dotnetLicenses(component),
      purl,
      scope: component.bundled ? "required" : "excluded",
      properties,
    };
    const externalReferences = dotnetExternalReferences(component);
    if (externalReferences.length > 0) item.externalReferences = externalReferences;
    components.push(item);
  }
  const dotnetSdkPurl = `pkg:generic/dotnet-sdk@${encodeURIComponent(dotnet.sdk.version)}?os=windows&arch=x64`;
  components.push({
    type: "application",
    "bom-ref": dotnetSdkPurl,
    name: dotnet.sdk.name,
    version: dotnet.sdk.version,
    licenses: dotnetLicenses(dotnet.sdk),
    purl: dotnetSdkPurl,
    scope: "excluded",
    properties: [
      { name: "skill-organizer:dotnet-role", value: "build" },
      { name: "skill-organizer:bundled", value: "false" },
    ],
    externalReferences: dotnetExternalReferences(dotnet.sdk),
  });
  components.sort((left, right) => left["bom-ref"].localeCompare(right["bom-ref"], "en"));

  const bom = {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    metadata: {
      component: {
        type: "application",
        "bom-ref": `pkg:github/lingxuanqjc-alt/codex-skill-organizer@${options.version}`,
        name: "Skill Organizer for Codex",
        version: options.version,
        licenses: [{ license: { id: "MIT" } }],
        externalReferences: [{ type: "vcs", url: "https://github.com/lingxuanqjc-alt/codex-skill-organizer" }],
        properties: [
          { name: "skill-organizer:bundled-tool", value: "tools/backup-state.mjs" },
          { name: "skill-organizer:bundled-tool", value: "tools/manage-personal-marketplace.mjs" },
          { name: "skill-organizer:build-dotnet-sdk", value: dotnet.sdk.version },
        ],
      },
    },
    components,
  };

  const output = path.resolve(options.output);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(bom, null, 2)}\n`, "utf8");
  process.stdout.write(`Wrote ${components.length} components to ${output}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
