import { build } from "esbuild";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertVersionContract, renderProductVersion } from "./version-contract.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const publicDir = path.join(dist, "public");
const { version: productVersion } = await assertVersionContract(root);

await rm(dist, { recursive: true, force: true });
await mkdir(publicDir, { recursive: true });

await Promise.all([
  build({
    entryPoints: [path.join(root, "src", "server", "main.ts")],
    outfile: path.join(dist, "server.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    sourcemap: true,
    banner: { js: "import { createRequire as __csoCreateRequire } from 'node:module'; const require = __csoCreateRequire(import.meta.url);" },
  }),
  build({
    entryPoints: [path.join(root, "src", "web", "main.ts")],
    outfile: path.join(publicDir, "app.js"),
    bundle: true,
    platform: "browser",
    format: "iife",
    target: ["chrome120"],
    sourcemap: true,
  }),
  build({
    entryPoints: [path.join(root, "src", "plugin", "mcp-sidecar.ts")],
    outfile: path.join(dist, "mcp-sidecar.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    sourcemap: true,
    banner: { js: "import { createRequire as __csoCreateRequire } from 'node:module'; const require = __csoCreateRequire(import.meta.url);" },
  }),
]);

await Promise.all([
  copyFile(path.join(root, "src", "web", "styles.css"), path.join(publicDir, "styles.css")),
  copyFile(path.join(root, "src", "web", "premium-minimal.css"), path.join(publicDir, "premium-minimal.css")),
]);

const [indexHtmlSource, premiumCss, stylesCss, browserJs] = await Promise.all([
  readFile(path.join(root, "src", "web", "index.html"), "utf8"),
  readFile(path.join(publicDir, "premium-minimal.css"), "utf8"),
  readFile(path.join(publicDir, "styles.css"), "utf8"),
  readFile(path.join(publicDir, "app.js"), "utf8"),
]);
const indexHtml = renderProductVersion(indexHtmlSource, productVersion, "src/web/index.html");
await Promise.all([
  writeFile(path.join(publicDir, "index.html"), indexHtml, "utf8"),
  writeFile(
    path.join(dist, "product-version.json"),
    `${JSON.stringify({ schemaVersion: 1, productVersion }, null, 2)}\n`,
    "utf8",
  ),
]);
const widgetHtml = indexHtml
  .replace(/\s*<link rel="stylesheet" href="\/styles\.css" \/>/, "")
  .replace(/\s*<link rel="stylesheet" href="\/premium-minimal\.css" \/>/, "")
  .replace("</head>", `<style>${`${premiumCss}\n${stylesCss}`.replaceAll("</style", "<\\/style")}</style></head>`)
  .replace(
    '<script src="/app.js" defer></script>',
    `<script>${browserJs.replaceAll("</script", "<\\/script")}</script>`,
  );
await writeFile(path.join(dist, "widget.html"), widgetHtml, "utf8");

console.log(`Built ${dist}`);
