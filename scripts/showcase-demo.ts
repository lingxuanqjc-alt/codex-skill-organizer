/**
 * Run the real workbench against synthetic skills and an isolated SQLite database.
 * Usage: npm run build; node --import tsx scripts/showcase-demo.ts
 * Open the generated artifacts/showcase/launch-url.txt locally; do not publish it.
 * Ctrl+C stops the service. No installed Codex skills or user configuration is used.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { InventoryService } from "../src/core/inventory-service.js";
import { startOrganizerHttpServer } from "../src/server/http-server.js";
import { writeSkill } from "../tests/helpers.js";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const showcase = path.join(repository, "artifacts", "showcase");
await mkdir(showcase, { recursive: true });
const isolated = await mkdtemp(path.join(showcase, "synthetic-"));
const skills = path.join(isolated, "skills");
const plugins = path.join(isolated, "plugins");

const examples = [
  ["data-cleaning", "清洗 CSV，检查缺失值与字段类型。", "data-automation"],
  ["financial-statement", "整理财务报表与指标口径。", "finance-trading"],
  ["frontend-ui", "制作网页交互原型。", "development"],
  ["code-review", "检查代码改动及验证结果。", "quality"],
  ["security-review", "检查输入边界与敏感信息处理。", "security"],
  ["release-checklist", "整理版本发布与回滚检查。", "delivery"],
  ["knowledge-notes", "将阅读记录整理为结构化笔记。", "docs-knowledge"],
  ["presentation-design", "设计演示文稿与信息图。", "design-media"],
  ["paper-reading", "归纳研究问题、证据与限制。", "research-analysis"],
  ["content-calendar", "整理内容选题与发布计划。", "content-social"],
  ["workflow-review", "评估任务拆分与工具协作。", "agent-workflow"],
] as const;

for (const [name, description, category] of examples) {
  await writeSkill(skills, name, { name, description: `[合成示例] ${description}`, category });
}
for (const version of ["1.0.0", "1.1.0"]) {
  await writeSkill(plugins, `synthetic-market/demo-research/${version}/skills/research-brief`, {
    name: "research-brief",
    description: "[合成示例] 同一插件的两个缓存版本，聚合为一个逻辑 Skill。",
    category: "research-analysis",
  });
}

const inventory = new InventoryService({
  roots: [
    { id: "synthetic-skills", label: "合成示例 Skills", path: skills, kind: "fixture", readonly: true },
    { id: "synthetic-plugins", label: "合成示例插件缓存", path: plugins, kind: "plugin-cache", readonly: true },
  ],
  cwd: isolated,
  statePath: path.join(isolated, "organizer.db"),
  appServer: null,
});
const snapshot = await inventory.initialize();
const physicalInstances = snapshot.skills.reduce((count, skill) => count + (skill.instances?.length ?? 1), 0);
assert.equal(snapshot.skills.length, 12, "the two synthetic plugin versions must share one logical identity");
assert.equal(physicalInstances, 13, "logical aggregation must retain both physical plugin versions");
assert.equal(snapshot.summary.runtimeVisible, 0, "the demo must never connect to the user's Codex runtime");
assert.equal(inventory.managementMode, false, "external management must remain disabled");
const running = await startOrganizerHttpServer({ inventory, publicDirectory: path.join(repository, "dist", "public") });
await writeFile(path.join(showcase, "launch-url.txt"), `${running.baseUrl}/#bootstrap=${running.bootstrapToken}`, "utf8");
await writeFile(path.join(showcase, "evidence.json"), JSON.stringify({
  synthetic: true,
  logicalSkills: snapshot.skills.length,
  physicalInstances,
  runtimeVisible: snapshot.summary.runtimeVisible,
  managementMode: inventory.managementMode,
  baseUrl: running.baseUrl,
  createdAt: new Date().toISOString(),
}, null, 2), "utf8");
console.log(`Synthetic demo ready: ${running.baseUrl}`);
console.log("Launch URL saved under artifacts/showcase/launch-url.txt (local use only).");
console.log("12 synthetic logical skills / 13 physical instances; Codex disconnected; management disabled.");
let closing = false;
async function close(): Promise<void> {
  if (closing) return;
  closing = true;
  await running.close();
  await inventory.close();
}
process.once("SIGINT", () => void close().finally(() => process.exit(0)));
process.once("SIGTERM", () => void close().finally(() => process.exit(0)));
