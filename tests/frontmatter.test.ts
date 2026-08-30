import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readSkillFrontmatter, type FrontmatterReadAdapter } from "../src/core/frontmatter.js";

function spyAdapter(contents: Buffer, onRead: (position: number) => void): FrontmatterReadAdapter {
  return {
    async open() {
      return {
        size: contents.length,
        async readByte(position) {
          onRead(position);
          return position < contents.length ? contents[position]! : null;
        },
        async close() {},
      };
    },
  };
}

test("frontmatter reader extracts only the bounded YAML header", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cso-frontmatter-"));
  try {
    const filePath = path.join(directory, "SKILL.md");
    await writeFile(
      filePath,
      "---\nname: 示例\ndescription: 说明\ncategory: data-source\nversion: 3.4\n---\n\n# Body\nSECRET=not-read-as-metadata\n",
      "utf8",
    );
    const result = await readSkillFrontmatter(filePath);
    assert.deepEqual(result, {
      data: { name: "示例", description: "说明", category: "data-source", version: "3.4", origin: undefined },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("short frontmatter stops at its closing delimiter without reading the body", async () => {
  const contents = Buffer.from(
    "---\nname: bounded\ndescription: metadata only\n---\nSECRET_BODY_MUST_NOT_BE_READ",
    "utf8",
  );
  const bodyOffset = contents.indexOf("SECRET_BODY_MUST_NOT_BE_READ");
  const reads: number[] = [];
  const result = await readSkillFrontmatter("ignored", spyAdapter(contents, (position) => {
    assert.ok(position < bodyOffset, `reader crossed the closing delimiter at byte ${position}`);
    reads.push(position);
  }));

  assert.equal(result.data.name, "bounded");
  assert.equal(result.data.description, "metadata only");
  assert.equal(reads.at(-1), bodyOffset - 1, "the closing delimiter newline is the last byte read");
});

test("frontmatter reader never consumes more than its byte limit", async () => {
  const contents = Buffer.concat([
    Buffer.from("---\nname: bounded\ndescription: ", "utf8"),
    Buffer.alloc(300 * 1024, 0x61),
  ]);
  let readCount = 0;
  const result = await readSkillFrontmatter("ignored", spyAdapter(contents, () => { readCount += 1; }));

  assert.equal(result.diagnostic, "FRONTMATTER_TOO_LARGE");
  assert.equal(readCount, 256 * 1024, "the hard cap applies to bytes actually read");
});

test("frontmatter reader reports malformed metadata instead of guessing", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cso-frontmatter-"));
  try {
    const filePath = path.join(directory, "SKILL.md");
    await writeFile(filePath, "---\nname: [broken\n---\n", "utf8");
    const result = await readSkillFrontmatter(filePath);
    assert.equal(result.diagnostic, "FRONTMATTER_INVALID");
    assert.deepEqual(result.data, {});
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("malformed YAML keeps its diagnostic but recovers one strict category scalar", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cso-frontmatter-"));
  try {
    const filePath = path.join(directory, "SKILL.md");
    await writeFile(
      filePath,
      "---\nname: research-goal\ndescription: Workflow: evidence first\ncategory: flow\n---\n",
      "utf8",
    );
    const result = await readSkillFrontmatter(filePath);
    assert.equal(result.diagnostic, "FRONTMATTER_INVALID");
    assert.deepEqual(result.data, { category: "flow" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
