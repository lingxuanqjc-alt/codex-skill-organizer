import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { before, test } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ClientCapabilities } from "@modelcontextprotocol/sdk/types.js";
import {
  EXTENSION_ID,
  getUiCapability,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sidecarPath = path.join(repositoryRoot, "dist", "mcp-sidecar.mjs");
const UI_URI = "ui://codex-skill-organizer/workbench.html";
const UI_CAPABILITIES = {
  extensions: {
    [EXTENSION_ID]: { mimeTypes: [RESOURCE_MIME_TYPE] },
  },
};

before(async () => {
  // Build first so the stdio process exercises the same bundled sidecar and
  // embedded widget pair that the installer and portable archive ship.
  await execFileAsync(process.execPath, ["scripts/build.mjs"], {
    cwd: repositoryRoot,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });
});

async function startActualSidecar(
  name: string,
  capabilities: ClientCapabilities,
): Promise<{ client: Client; transport: StdioClientTransport }> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [sidecarPath],
    cwd: repositoryRoot,
    stderr: "pipe",
  });
  const client = new Client(
    { name, version: "1.0.0" },
    { capabilities },
  );
  await client.connect(transport);
  return { client, transport };
}

test("UI-capable MCP client receives the exact embedded workbench resource contract", async () => {
  assert.deepEqual(getUiCapability(UI_CAPABILITIES), {
    mimeTypes: [RESOURCE_MIME_TYPE],
  });
  const { client } = await startActualSidecar("ui-capable-acceptance", UI_CAPABILITIES);
  try {
    const listed = await client.listResources();
    assert.equal(listed.resources.length, 1);
    const resource = listed.resources[0]!;
    assert.equal(resource.uri, UI_URI);
    assert.equal(resource.mimeType, RESOURCE_MIME_TYPE);
    assert.deepEqual(resource._meta, {
      ui: {
        csp: { connectDomains: [], resourceDomains: [] },
      },
    });

    const read = await client.readResource({ uri: UI_URI });
    assert.equal(read.contents.length, 1);
    const content = read.contents[0]!;
    assert.equal(content.uri, UI_URI);
    assert.equal(content.mimeType, RESOURCE_MIME_TYPE);
    assert.equal("text" in content, true);
    const html = "text" in content ? content.text : "";
    assert.match(html, /^<!doctype html>/u);
    assert.match(html, /<title>Skill Organizer for Codex<\/title>/u);
    assert.match(html, /<style>[\s\S]+<\/style>/u);
    assert.match(html, /<script>[\s\S]+<\/script>/u);
    assert.doesNotMatch(html, /https?:\/\//u);
    assert.doesNotMatch(html, /<(?:script|link|img|iframe|source)\b[^>]+(?:src|href)=["']\//u);
    assert.deepEqual(content._meta, {
      ui: {
        csp: { connectDomains: [], resourceDomains: [] },
      },
    });

    const { tools } = await client.listTools();
    const openTool = tools.find((tool) => tool.name === "open_skill_organizer");
    assert.ok(openTool);
    assert.equal(openTool._meta?.ui && typeof openTool._meta.ui === "object"
      ? (openTool._meta.ui as { resourceUri?: unknown }).resourceUri
      : undefined, UI_URI);
  } finally {
    await client.close().catch(() => undefined);
  }
});

test("text-only MCP client keeps paginated skill discovery and an honest desktop fallback", async () => {
  assert.equal(getUiCapability({}), undefined);
  const { client } = await startActualSidecar("text-only-acceptance", {});
  try {
    const { tools } = await client.listTools();
    const listTool = tools.find((tool) => tool.name === "list_skills");
    const openTool = tools.find((tool) => tool.name === "open_skill_organizer");
    assert.ok(listTool);
    assert.ok(openTool);

    const properties = listTool.inputSchema.properties ?? {};
    assert.ok(properties.page);
    assert.ok(properties.pageSize);
    assert.equal((properties.pageSize as { maximum?: unknown }).maximum, 100);
    assert.match(listTool.description ?? "", /分页/u);
    assert.match(openTool.description ?? "", /宿主.*支持.*会话内.*否则.*list_skills.*分页.*桌面/u);
    assert.doesNotMatch(openTool.description ?? "", /已打开|已嵌入|保证.*面板/u);
  } finally {
    await client.close().catch(() => undefined);
  }
});
