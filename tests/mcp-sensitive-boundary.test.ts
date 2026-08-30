import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("MCP tool schemas cannot turn caller booleans into sensitive desktop confirmation", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/plugin/mcp-sidecar.ts"],
    cwd: repositoryRoot,
    stderr: "pipe",
  });
  const client = new Client({ name: "sensitive-boundary-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const runtimeTool = tools.find((tool) => tool.name === "set_skill_enabled");
    const restoreTool = tools.find((tool) => tool.name === "restore_quarantined_skill");
    assert.ok(runtimeTool);
    assert.ok(restoreTool);

    const runtimeProperties = runtimeTool.inputSchema.properties ?? {};
    const restoreProperties = restoreTool.inputSchema.properties ?? {};
    assert.equal(Object.hasOwn(runtimeProperties, "confirmedSensitive"), false);
    assert.equal(Object.hasOwn(restoreProperties, "confirmed"), false);
    assert.equal(restoreTool.annotations?.readOnlyHint, true);
    assert.equal(restoreTool.annotations?.destructiveHint, false);
    assert.match(runtimeTool.description ?? "", /桌面工作台确认/u);
    assert.match(restoreTool.description ?? "", /MCP 不执行文件移动/u);
  } finally {
    await client.close().catch(() => undefined);
  }
});
