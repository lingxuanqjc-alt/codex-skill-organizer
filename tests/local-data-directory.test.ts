import assert from "node:assert/strict";
import test from "node:test";
import { resolveOrganizerDataDirectory } from "../src/shared/local-data-directory.js";

test("release data layout is anchored to the user home and has no environment override input", () => {
  assert.equal(
    resolveOrganizerDataDirectory("C:\\Users\\fixture-user"),
    "C:\\Users\\fixture-user\\AppData\\Local\\SkillOrganizerForCodex",
  );
  assert.throws(() => resolveOrganizerDataDirectory("relative-user"), /absolute/u);
});
