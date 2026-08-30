import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { classifySkill } from "../src/core/classifier.js";
import { mergeScanResults, scanSkillRoots } from "../src/core/scanner.js";
import type { ObservedSkill, RootDefinition } from "../src/shared/types.js";
import { writeSkill } from "./helpers.js";

test("scanner keeps nested skills and same-name copies distinct", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cso-scan-"));
  const codexRoot = path.join(directory, "codex");
  const agentsRoot = path.join(directory, "agents");
  try {
    await writeSkill(codexRoot, "vibe-trading", { name: "vibe-trading", description: "Finance bundle" });
    await writeSkill(codexRoot, "vibe-trading/src/skills/akshare", {
      name: "akshare",
      description: "Market data",
      category: "data-source",
    });
    await writeSkill(codexRoot, "openai-docs", { name: "openai-docs", description: "Docs" });
    await writeSkill(agentsRoot, "openai-docs", { name: "openai-docs", description: "Different copy" });

    const roots: RootDefinition[] = [
      { id: "codex", label: "Codex", path: codexRoot, kind: "codex" },
      { id: "agents", label: "Agents", path: agentsRoot, kind: "agents" },
    ];
    const result = await scanSkillRoots(roots);
    assert.equal(result.skills.length, 4);
    assert.equal(new Set(result.skills.map((skill) => skill.skillId)).size, 4);
    const akshare = result.skills.find((skill) => skill.name === "akshare");
    assert.ok(akshare);
    assert.equal(classifySkill(akshare).categoryId, "finance-trading");
    assert.deepEqual(classifySkill(akshare).tags, ["bundle:vibe-trading", "taxonomy:vibe/data-source"]);

    const duplicateDocs = result.skills.filter((skill) => skill.name === "openai-docs");
    assert.equal(duplicateDocs.length, 2);
    assert.ok(duplicateDocs.every((skill) => skill.diagnostics.some((item) => item.code === "DUPLICATE_NAME")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a familiar folder name or frontmatter origin never impersonates an exact GitHub source", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cso-source-hint-"));
  try {
    await writeSkill(directory, "vibe-trading/src/skills/local", {
      name: "local",
      description: "A local fork with a familiar parent directory",
      origin: "https://github.com/HKUDS/Vibe-Trading",
    });
    const result = await scanSkillRoots([
      { id: "fixture-root", label: "Fixture", path: directory, kind: "fixture" },
    ]);
    assert.equal(result.skills.length, 1);
    assert.equal(result.skills[0]!.sourceId, "fixture:fixture-root");
    assert.equal(result.skills[0]!.sourceLabel, "vibe-trading");
    assert.equal(result.skills[0]!.origin, "https://github.com/HKUDS/Vibe-Trading", "the unverified value remains a display hint only");
    assert.equal(classifySkill(result.skills[0]!).categoryId, "finance-trading", "bundle classification does not require false provenance");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an Agents skill uses bounded parent Git evidence without changing its agents scope", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cso-agents-git-source-"));
  try {
    const repository = path.join(directory, "public-skill-bundle");
    await mkdir(path.join(repository, ".git"), { recursive: true });
    await writeFile(path.join(repository, ".git", "config"), [
      "[remote \"origin\"]",
      "  url = git@github.com:example/portable-agents-skills.git",
      "",
    ].join("\n"), "utf8");
    const commit = "abcdef0123456789abcdef0123456789abcdef01";
    await writeFile(path.join(repository, ".git", "HEAD"), `${commit}\n`, "utf8");
    await writeSkill(repository, "skills/portable", {
      name: "portable",
      description: "Public Agents skill fixture",
    });
    await writeSkill(directory, "local-only", {
      name: "local-only",
      description: "Ordinary Agents skill fixture",
    });

    const result = await scanSkillRoots([
      { id: "agents", label: "Agents", path: directory, kind: "agents" },
    ]);
    const portable = result.skills.find((skill) => skill.name === "portable");
    const local = result.skills.find((skill) => skill.name === "local-only");
    assert.ok(portable);
    assert.equal(portable.scope, "agents");
    assert.equal(portable.sourceId, "github:example/portable-agents-skills");
    assert.equal(portable.installedCommit, commit);
    assert.ok(local);
    assert.equal(local.sourceId, "agents:local");
    assert.equal(local.installedCommit, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a URL path containing github.com on another host never becomes GitHub provenance", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cso-git-host-spoof-"));
  try {
    await mkdir(path.join(directory, ".git"), { recursive: true });
    await writeFile(path.join(directory, ".git", "config"), [
      "[remote \"origin\"]",
      "  url = https://evil.example/download/github.com/example/poisoned-skills.git",
      "",
    ].join("\n"), "utf8");
    const commit = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    await writeFile(path.join(directory, ".git", "HEAD"), `${commit}\n`, "utf8");
    await writeSkill(directory, "portable", {
      name: "portable",
      description: "Untrusted remote host fixture",
    });

    const result = await scanSkillRoots([
      { id: "fixture-root", label: "Fixture", path: directory, kind: "fixture" },
    ]);
    assert.equal(result.skills.length, 1);
    assert.equal(result.skills[0]!.sourceId, "fixture:fixture-root");
    assert.equal(result.skills[0]!.installedCommit, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a .git junction outside the allowed root never supplies provenance", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cso-git-junction-"));
  const root = path.join(directory, "allowed-root");
  const outsideGit = path.join(directory, "outside-git");
  try {
    await mkdir(outsideGit, { recursive: true });
    await writeFile(path.join(outsideGit, "config"), [
      "[remote \"origin\"]",
      "  url = https://github.com/example/outside-skills.git",
      "",
    ].join("\n"), "utf8");
    const commit = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    await writeFile(path.join(outsideGit, "HEAD"), `${commit}\n`, "utf8");
    await writeSkill(root, "portable", {
      name: "portable",
      description: "Root-external Git metadata fixture",
    });
    try {
      await symlink(outsideGit, path.join(root, ".git"), "junction");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        context.skip("the current Windows policy does not permit creating a test junction");
        return;
      }
      throw error;
    }

    const result = await scanSkillRoots([
      { id: "fixture-root", label: "Fixture", path: root, kind: "fixture" },
    ]);
    assert.equal(result.skills.length, 1);
    assert.equal(result.skills[0]!.sourceId, "fixture:fixture-root");
    assert.equal(result.skills[0]!.installedCommit, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("plugin upgrades preserve one logical ID while retaining every physical cache instance", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cso-plugin-"));
  try {
    await writeSkill(directory, "market/figma/1.0.0/skills/figma-use", { name: "figma-use", description: "Old" });
    await writeSkill(directory, "market/figma/2.1.0/skills/figma-use", { name: "figma-use", description: "New" });
    const result = await scanSkillRoots([
      { id: "plugins", label: "Plugins", path: directory, kind: "plugin-cache" },
    ]);
    assert.equal(result.skills.length, 2);
    assert.equal(new Set(result.skills.map((skill) => skill.skillId)).size, 1);
    assert.deepEqual(result.skills.map((skill) => skill.pluginVersion).sort(), ["1.0.0", "2.1.0"]);
    assert.equal(new Set(result.skills.map((skill) => skill.instanceId)).size, 2);
    assert.equal(classifySkill(result.skills[0]!).categoryId, "design-media");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("scanner never descends into node_modules", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cso-ignore-"));
  try {
    await mkdir(path.join(directory, "node_modules"), { recursive: true });
    await writeSkill(directory, "node_modules/foreign", { name: "foreign", description: "Ignore me" });
    await writeSkill(directory, "local", { name: "local", description: "Keep me" });
    const result = await scanSkillRoots([
      { id: "fixture", label: "Fixture", path: directory, kind: "fixture" },
    ]);
    assert.deepEqual(result.skills.map((skill) => skill.name), ["local"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("scanner still terminates and reports a directory junction loop", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cso-scan-loop-"));
  try {
    await writeSkill(directory, "nested/local", { name: "local", description: "Keep me once" });
    try {
      await symlink(directory, path.join(directory, "nested", "loop"), "junction");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        context.skip("the current Windows policy does not permit creating a test junction");
        return;
      }
      throw error;
    }
    const result = await scanSkillRoots([
      { id: "fixture", label: "Fixture", path: directory, kind: "fixture" },
    ]);
    assert.deepEqual(result.skills.map((skill) => skill.name), ["local"]);
    assert.ok(result.errors.some((error) => /循环/u.test(error.message)));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("scanner shares in-flight parent Git provenance across skills in one repository", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cso-git-cache-"));
  try {
    await mkdir(path.join(directory, ".git"), { recursive: true });
    await writeFile(path.join(directory, ".git", "config"), [
      "[remote \"origin\"]",
      "  url = https://github.com/example/shared-skills.git",
      "",
    ].join("\n"), "utf8");
    const commit = "0123456789abcdef0123456789abcdef01234567";
    await writeFile(path.join(directory, ".git", "HEAD"), `${commit}\n`, "utf8");
    await Promise.all(Array.from({ length: 40 }, (_, index) => writeSkill(
      directory,
      `bundle/group-${index % 4}/skill-${index}`,
      { name: `skill-${index}`, description: "Shared repository fixture" },
    )));
    const probes: string[] = [];
    const result = await scanSkillRoots(
      [{ id: "fixture", label: "Fixture", path: directory, kind: "fixture" }],
      { onGitDirectoryProbe: (directoryPath) => probes.push(path.resolve(directoryPath)) },
    );
    assert.equal(result.skills.length, 40);
    assert.ok(result.skills.every((skill) => skill.sourceId === "github:example/shared-skills"));
    assert.ok(result.skills.every((skill) => skill.installedCommit === commit));
    assert.equal(
      probes.filter((candidate) => candidate === path.resolve(directory)).length,
      1,
      "the repository root and its Git metadata must be resolved once even with concurrent metadata workers",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("per-root scan merge preserves aliases, physical deduplication, and cross-root duplicate-name diagnostics", () => {
  const skill = (overrides: Partial<ObservedSkill>): ObservedSkill => ({
    skillId: "logical-a",
    physicalId: "physical-a",
    instanceId: "instance-a",
    name: "same-name",
    description: "fixture",
    scope: "user",
    sourceId: "fixture:a",
    sourceLabel: "A",
    packageId: "a",
    pluginId: null,
    pluginVersion: null,
    rootId: "root-a",
    rootLabel: "Root A",
    absolutePath: "C:\\skills\\same\\SKILL.md",
    relativePath: "same/SKILL.md",
    breadcrumb: "Root A › same/SKILL.md",
    readonly: false,
    aliases: ["Root A › same/SKILL.md"],
    diagnostics: [],
    ...overrides,
  });
  const merged = mergeScanResults([
    { skills: [skill({})], errors: [], visitedEntries: 2 },
    {
      skills: [
        skill({ rootId: "root-alias", aliases: ["Alias Root › same/SKILL.md"] }),
        skill({
          skillId: "logical-b",
          physicalId: "physical-b",
          instanceId: "instance-b",
          sourceId: "fixture:b",
          packageId: "b",
          rootId: "root-b",
          rootLabel: "Root B",
          absolutePath: "C:\\other\\same\\SKILL.md",
          breadcrumb: "Root B › same/SKILL.md",
          aliases: ["Root B › same/SKILL.md"],
        }),
      ],
      errors: [{ path: "C:\\missing", message: "missing" }],
      visitedEntries: 4,
    },
  ]);
  assert.equal(merged.skills.length, 2);
  assert.equal(merged.visitedEntries, 6);
  assert.deepEqual(merged.skills.find((item) => item.physicalId === "physical-a")?.aliases, [
    "Root A › same/SKILL.md",
    "Alias Root › same/SKILL.md",
  ]);
  assert.ok(merged.skills.every((item) => item.diagnostics.filter((diagnostic) => diagnostic.code === "DUPLICATE_NAME").length === 1));
  assert.deepEqual(merged.errors, [{ path: "C:\\missing", message: "missing" }]);
});

test("scanner retains 5,000 unfamiliar skill instances without collapsing logical identities", { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cso-scan-5000-"));
  try {
    const total = 5_000;
    const batchSize = 100;
    for (let start = 0; start < total; start += batchSize) {
      await Promise.all(Array.from({ length: Math.min(batchSize, total - start) }, (_, offset) => {
        const index = start + offset;
        return writeSkill(directory, `bundle-${Math.floor(index / 100)}/skill-${String(index).padStart(4, "0")}`, {
          name: `fixture-${String(index).padStart(4, "0")}`,
          description: "Unfamiliar deterministic scanner fixture",
        });
      }));
    }

    const result = await scanSkillRoots([
      { id: "large-fixture", label: "Large fixture", path: directory, kind: "fixture" },
    ]);
    assert.equal(result.errors.length, 0);
    assert.equal(result.skills.length, total);
    assert.equal(new Set(result.skills.map((skill) => skill.skillId)).size, total);
    assert.equal(new Set(result.skills.map((skill) => skill.instanceId)).size, total);
    assert.ok(result.visitedEntries >= total * 2, "the scanner reports bounded traversal work for diagnostics");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
