import { chromium } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(projectRoot, "assets", "skill-organizer.svg");
const outputPath = path.join(projectRoot, "desktop", "Assets", "app.ico");
const sizes = [16, 24, 32, 48, 64, 128, 256];
const svg = await readFile(sourcePath, "utf8");
const browser = await chromium.launch({ headless: true });
const images = [];

try {
  for (const size of sizes) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    await page.setContent(`<!doctype html><style>html,body{margin:0;width:${size}px;height:${size}px;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
    images.push(await page.screenshot({ omitBackground: true, animations: "disabled" }));
    await page.close();
  }
} finally {
  await browser.close();
}

const headerSize = 6 + images.length * 16;
const header = Buffer.alloc(headerSize);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(images.length, 4);
let offset = headerSize;
for (let index = 0; index < images.length; index += 1) {
  const image = images[index];
  const size = sizes[index];
  const entry = 6 + index * 16;
  header.writeUInt8(size === 256 ? 0 : size, entry);
  header.writeUInt8(size === 256 ? 0 : size, entry + 1);
  header.writeUInt8(0, entry + 2);
  header.writeUInt8(0, entry + 3);
  header.writeUInt16LE(1, entry + 4);
  header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(image.length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += image.length;
}

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, Buffer.concat([header, ...images]));
console.log(`Built ${outputPath} (${images.length} PNG layers)`);
