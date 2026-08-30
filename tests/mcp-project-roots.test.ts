import assert from "node:assert/strict";
import test from "node:test";
import {
  listLocalMcpProjectPaths,
  localProjectPathFromMcpRoot,
  localProjectPathsFromMcpRoots,
} from "../src/plugin/mcp-project-roots.js";
import { OrganizerServiceBridge } from "../src/plugin/service-bridge.js";

test("MCP file roots are safely decoded to local Windows absolute paths", () => {
  assert.equal(
    localProjectPathFromMcpRoot("file:///C:/Work/My%20Project/%E4%B8%AD%E6%96%87", "win32"),
    "C:\\Work\\My Project\\中文",
  );
  for (const uri of [
    "https://example.invalid/project",
    "file://server/share/project",
    "file:////?/C:/device-path",
    "file:///C:/project?query=1",
    "file:///C:/project#fragment",
    "file:///C:/bad%00name",
  ]) {
    assert.equal(localProjectPathFromMcpRoot(uri, "win32"), null, uri);
  }
});

test("MCP roots are deduplicated without accepting a non-file fallback", async () => {
  let listCalls = 0;
  const paths = await listLocalMcpProjectPaths({
    getClientCapabilities: () => ({ roots: { listChanged: true } }),
    listRoots: async () => {
      listCalls += 1;
      return { roots: [
        { uri: "file:///C:/Work/Project" },
        { uri: "file:///c:/work/project" },
        { uri: "https://example.invalid/not-a-root" },
      ] };
    },
  }, "win32");
  assert.deepEqual(paths, ["C:\\Work\\Project"]);
  assert.equal(listCalls, 1);

  const withoutCapability = await listLocalMcpProjectPaths({
    getClientCapabilities: () => undefined,
    listRoots: async () => {
      throw new Error("roots/list must not run without the client capability");
    },
  }, "win32");
  assert.deepEqual(withoutCapability, []);
  assert.deepEqual(localProjectPathsFromMcpRoots([], "win32"), []);
});

test("a transient roots/list failure remains retryable on the next request", async () => {
  const bridge = new OrganizerServiceBridge();
  let attempts = 0;
  bridge.setSessionProjectRootsProvider(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("workspace is still being created");
    return [];
  });
  await assert.rejects(bridge.refreshSessionProjectRoots(), /still being created/u);
  await bridge.refreshSessionProjectRoots();
  assert.equal(attempts, 2);
});

test("roots are refreshed only after initialization or an official rootsChanged notification", async () => {
  const bridge = new OrganizerServiceBridge();
  let reads = 0;
  bridge.setSessionProjectRootsProvider(async () => {
    reads += 1;
    return [];
  });
  await bridge.refreshSessionProjectRoots();
  await bridge.refreshSessionProjectRoots();
  assert.equal(reads, 1);
  await bridge.sessionProjectRootsChanged();
  assert.equal(reads, 2);
});
