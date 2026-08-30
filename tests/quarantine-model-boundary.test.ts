import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeQuarantinePayloadForModel } from "../src/plugin/quarantine-model-boundary.js";

test("quarantine MCP payload keeps opaque impact data but removes every local absolute path", () => {
  const payload = sanitizeQuarantinePayloadForModel({
    planId: "opaque-plan",
    items: [{
      installationUnitId: "opaque-unit",
      sourcePath: "C:\\Users\\private-user\\.codex\\skills\\bundle",
      quarantinePath: "D:\\Organizer\\quarantine\\entry",
      tree: [{ relativePath: "nested/SKILL.md", type: "file", sizeBytes: 42 }],
      blockers: [{ code: "SOURCE_UNAVAILABLE", message: "EACCES at C:\\Users\\private-user\\secret" }],
    }],
    candidates: [{
      absolutePath: "/home/private-user/.codex/skills/bundle",
      pathHint: "/home/private-user/.codex/skills/bundle",
      label: "bundle",
      affectedSkillIds: ["opaque-skill"],
    }],
    entries: [{
      originalPath: "\\\\server\\share\\private-user\\bundle",
      originalPathHint: "\\\\server\\share\\private-user\\bundle",
      quarantineEntryId: "opaque-entry",
    }],
  });

  const serialized = JSON.stringify(payload);
  assert.equal(serialized.includes("private-user"), false);
  assert.equal(serialized.includes("sourcePath"), false);
  assert.equal(serialized.includes("quarantinePath"), false);
  assert.equal(serialized.includes("absolutePath"), false);
  assert.equal(serialized.includes("originalPath"), false);
  assert.equal(serialized.includes("pathHint"), false);
  assert.equal(serialized.includes("opaque-plan"), true);
  assert.equal(serialized.includes("nested/SKILL.md"), true, "relative impact paths remain useful to the model");
  assert.equal(serialized.includes("opaque-entry"), true);
});
