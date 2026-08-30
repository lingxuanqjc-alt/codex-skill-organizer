import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeSupportBundleStderr } from "../src/server/support-bundle.js";

test("support bundle stderr redacts credentials and environment values promised by the UI exclusions", () => {
  const secret = "TOP_SECRET_VALUE";
  const lines = [
    `Authorization: Bearer ${secret}`,
    `Cookie: cso_session=${secret}`,
    `HTTPS_PROXY=http://private:${secret}@proxy.example.test:8080`,
    `HOME=C:\\Users\\private-user TEMP=C:\\Temp warning`,
    "ordinary app-server warning",
  ].map(sanitizeSupportBundleStderr);
  const serialized = JSON.stringify(lines);

  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes("private-user"), false);
  assert.equal(serialized.includes("C:\\\\Temp"), false);
  assert.equal(lines.at(-1), "ordinary app-server warning");
  assert.ok(lines.slice(0, 3).every((line) => line === "[redacted sensitive stderr line]"));
});
