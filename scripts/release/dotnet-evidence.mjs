import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const LICENSE_NAMES = ["LICENSE", "LICENSE.txt", "LICENSE.TXT", "LICENSE.md", "LICENCE", "COPYING"];
const NOTICE_NAMES = ["NOTICE", "NOTICE.txt", "NOTICE.TXT", "THIRD-PARTY-NOTICES.TXT", "ThirdPartyNotices.txt"];
const REQUIRED_RUNTIME_PACKAGES = new Set([
  "microsoft.web.webview2",
  "microsoft.netcore.app.runtime.win-x64",
  "microsoft.windowsdesktop.app.runtime.win-x64",
]);

async function optionalText(file) {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function decodeXml(value) {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&")
    .trim();
}

function elementText(xml, name) {
  const match = xml.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, "i"));
  return match ? decodeXml(match[1]) : null;
}

function attributeValue(source, name) {
  const match = source.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, "i"));
  return match ? decodeXml(match[1]) : null;
}

function exactVersion(range) {
  const trimmed = String(range ?? "").trim();
  const exactRange = trimmed.match(/^\[([^,\]]+),\s*\1\]$/);
  if (exactRange) return exactRange[1];
  const exact = trimmed.match(/^\[([^\]]+)\]$/);
  if (exact) return exact[1];
  if (/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(trimmed)) return trimmed;
  throw new Error(`A deterministic .NET component version was not exact: ${trimmed}`);
}

function sha512Hex(value) {
  if (!value) return null;
  const bytes = Buffer.from(String(value).trim(), "base64");
  return bytes.length === 64 ? bytes.toString("hex") : null;
}

async function evidenceFile(packageRoot, fileName, kind) {
  const file = path.join(packageRoot, fileName);
  const text = await optionalText(file);
  if (text === null) return null;
  return {
    kind,
    name: fileName,
    sha256: createHash("sha256").update(text, "utf8").digest("hex"),
    text: text.trim(),
  };
}

async function loadPackageEvidence(packageRoot) {
  const names = await readdir(packageRoot);
  const nuspecName = names.find((name) => name.toLowerCase().endsWith(".nuspec"));
  if (!nuspecName) throw new Error(`NuGet package has no nuspec: ${packageRoot}`);
  const nuspec = await readFile(path.join(packageRoot, nuspecName), "utf8");
  const licenseMatch = nuspec.match(/<license\b([^>]*)>([\s\S]*?)<\/license>/i);
  const licenseType = licenseMatch ? attributeValue(licenseMatch[1], "type") : null;
  const licenseValue = licenseMatch ? decodeXml(licenseMatch[2]) : null;
  const repositoryMatch = nuspec.match(/<repository\b([^>]*)\/?\s*>/i);
  const repositoryUrl = repositoryMatch ? attributeValue(repositoryMatch[1], "url") : null;
  const repositoryCommit = repositoryMatch ? attributeValue(repositoryMatch[1], "commit") : null;
  const licenseUrl = elementText(nuspec, "licenseUrl");
  const projectUrl = elementText(nuspec, "projectUrl");

  const requestedEvidence = [];
  if (licenseType?.toLowerCase() === "file" && licenseValue) requestedEvidence.push([licenseValue, "license"]);
  for (const name of LICENSE_NAMES) requestedEvidence.push([name, "license"]);
  for (const name of NOTICE_NAMES) requestedEvidence.push([name, "notice"]);

  const files = [];
  const seen = new Set();
  for (const [name, kind] of requestedEvidence) {
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const evidence = await evidenceFile(packageRoot, name, kind);
    if (evidence) files.push(evidence);
  }
  files.sort((left, right) => left.name.localeCompare(right.name, "en"));

  return {
    licenseExpression: licenseType?.toLowerCase() === "expression" ? licenseValue : null,
    licenseFile: licenseType?.toLowerCase() === "file" ? licenseValue : null,
    licenseUrl,
    projectUrl,
    repositoryUrl,
    repositoryCommit,
    files,
  };
}

function componentRole(name) {
  return REQUIRED_RUNTIME_PACKAGES.has(name.toLowerCase()) ? "runtime" : "build";
}

export async function loadDotnetEvidence({ assetsPath, sdkVersion }) {
  const assets = JSON.parse(await readFile(path.resolve(assetsPath), "utf8"));
  if (!assets.libraries || !assets.project?.frameworks || !assets.packageFolders) {
    throw new Error("desktop/obj/project.assets.json is missing package evidence.");
  }
  if (!/^\d+\.\d+\.\d+$/.test(sdkVersion)) throw new Error(`Invalid .NET SDK version: ${sdkVersion}`);

  const packageFolders = Object.keys(assets.packageFolders).sort((left, right) => left.localeCompare(right, "en"));
  const records = new Map();
  const add = (name, version, packagePath, sha512) => {
    const key = `${name.toLowerCase()}@${version}`;
    if (!records.has(key)) records.set(key, { name, version, packagePath, sha512 });
  };

  for (const [libraryName, library] of Object.entries(assets.libraries)) {
    if (library?.type !== "package") continue;
    const slash = libraryName.lastIndexOf("/");
    if (slash <= 0) throw new Error(`Invalid NuGet library identity: ${libraryName}`);
    add(libraryName.slice(0, slash), libraryName.slice(slash + 1), library.path, library.sha512);
  }

  for (const framework of Object.values(assets.project.frameworks)) {
    for (const dependency of framework?.downloadDependencies ?? []) {
      const version = exactVersion(dependency.version);
      add(dependency.name, version, `${dependency.name.toLowerCase()}/${version}`, null);
    }
  }

  const components = [];
  for (const record of records.values()) {
    let packageRoot = null;
    for (const folder of packageFolders) {
      const candidate = path.join(folder, ...record.packagePath.replaceAll("\\", "/").split("/"));
      try {
        await readdir(candidate);
        packageRoot = candidate;
        break;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    if (!packageRoot) throw new Error(`Restored NuGet package is missing: ${record.name}@${record.version}`);
    const evidence = await loadPackageEvidence(packageRoot);
    let packageSha512 = sha512Hex(record.sha512);
    if (!packageSha512) {
      const storedHash = await optionalText(path.join(packageRoot, `${record.name.toLowerCase()}.${record.version}.nupkg.sha512`));
      packageSha512 = sha512Hex(storedHash);
    }
    if (!packageSha512) throw new Error(`NuGet package hash evidence is missing: ${record.name}@${record.version}`);
    const role = componentRole(record.name);
    components.push({
      ...record,
      role,
      bundled: role === "runtime",
      packageSha512,
      evidence,
    });
  }
  components.sort((left, right) => `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`, "en"));

  for (const required of REQUIRED_RUNTIME_PACKAGES) {
    if (!components.some((component) => component.name.toLowerCase() === required && component.bundled)) {
      throw new Error(`Required bundled .NET component is absent from restore evidence: ${required}`);
    }
  }
  if (!components.some((component) => component.name.toLowerCase() === "microsoft.net.illink.tasks" && component.role === "build")) {
    throw new Error("Microsoft.NET.ILLink.Tasks build evidence is absent.");
  }

  return {
    sdk: {
      name: ".NET SDK",
      version: sdkVersion,
      role: "build",
      bundled: false,
      licenseExpression: "MIT",
      licenseUrl: "https://github.com/dotnet/sdk/blob/main/LICENSE.TXT",
    },
    components,
  };
}
