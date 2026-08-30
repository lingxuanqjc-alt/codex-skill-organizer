import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  LocalCodexPluginUpdateProvider,
  resolveTrustedGitCommand,
  UpdateService,
  type CodexPluginCatalogRuntime,
  type GitStatusRuntime,
  type UpdateSubject,
} from "../src/core/update-service.js";

const base: UpdateSubject = {
  logicalSkillId: "logical-1",
  sourceId: "github:owner/repository",
  installedCommit: "1111111111111111111111111111111111111111",
  locallyModified: false,
  scope: "user",
};

function gitRuntime(overrides: Partial<GitStatusRuntime> = {}): GitStatusRuntime {
  return {
    platform: "win32",
    homedir: () => "C:\\Users\\fixture",
    access: async () => undefined,
    execFile: async () => { throw new Error("not found"); },
    ...overrides,
  };
}

test("Git resolver never consults PATH or executes an arbitrary lookalike candidate", async () => {
  const calls: string[] = [];
  const command = await resolveTrustedGitCommand(gitRuntime({
    execFile: async (candidate) => {
      calls.push(candidate);
      return { stdout: "not git\n", stderr: "" };
    },
  }));
  assert.equal(command, null);
  assert.ok(calls.length > 0);
  assert.ok(calls.every((candidate) => /^C:\\Program Files(?: \(x86\))?\\Git\\(?:cmd|bin)\\git\.exe$/iu.test(candidate)));
  assert.ok(!calls.includes("git"));
  assert.ok(!calls.includes("C:\\attacker\\git.exe"));
});

test("missing trusted Git makes local modification evidence fail closed before network access", async () => {
  const service = new UpdateService({
    fetchImpl: (() => { throw new Error("network must not run without local modification evidence"); }) as typeof fetch,
    gitRuntime: gitRuntime({
      trustedCandidates: ["C:\\Program Files\\Git\\cmd\\git.exe"],
      access: async () => { throw new Error("missing"); },
    }),
  });
  const result = await service.check({ ...base, instancePath: "C:\\skills\\fixture\\SKILL.md" });
  assert.equal(result.status, "unavailable");
  assert.match(result.summary, /安全停止/u);
});

test("update evidence compares exact public GitHub commits without downloading skill content", async () => {
  const calls: string[] = [];
  const service = new UpdateService({
    fetchImpl: (async (input: URL | RequestInfo) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/owner/repository")) {
        return Response.json({ default_branch: "main", private: false, html_url: "https://github.com/owner/repository" });
      }
      if (url.includes("/commits/")) return Response.json({ sha: "2222222222222222222222222222222222222222" });
      return Response.json({
        status: "ahead",
        ahead_by: 2,
        behind_by: 0,
        html_url: `https://github.com/owner/repository/compare/${"1".repeat(40)}...${"2".repeat(40)}`,
      });
    }) as typeof fetch,
    now: () => new Date("2026-08-30T00:00:00.000Z"),
  });

  const result = await service.check(base);
  assert.equal(result.status, "update-available");
  assert.equal(result.evidenceKind, "commit");
  assert.match(result.compareUrl ?? "", /compare\/1111.+\.\.\.2222/u);
  assert.equal(calls.length, 3);
  assert.ok(calls.every((url) => url.startsWith("https://api.github.com/")));
});

test("unknown, private-scope, and locally modified sources fail closed", async () => {
  const service = new UpdateService({ fetchImpl: (() => { throw new Error("network must not run"); }) as typeof fetch });
  assert.equal((await service.check({ ...base, sourceId: "local:unknown", installedCommit: undefined })).status, "unavailable");
  assert.equal((await service.check({ ...base, locallyModified: true })).status, "modified");
  assert.equal((await service.check({ ...base, scope: "repo" })).status, "unavailable");
});

test("an explicit check surfaces rate limits without inventing update evidence", async () => {
  const service = new UpdateService({
    fetchImpl: (async () => new Response("", { status: 429 })) as typeof fetch,
  });
  const result = await service.check(base);
  assert.equal(result.status, "offline");
  assert.equal(result.evidenceKind, "none");
  assert.match(result.summary, /限流/u);
});

test("release evidence uses only an exact public GitHub release tag", async () => {
  const calls: string[] = [];
  const service = new UpdateService({
    fetchImpl: (async (input: URL | RequestInfo) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/owner/repository")) {
        return Response.json({ private: false, html_url: "https://github.com/owner/repository" });
      }
      return Response.json({ tag_name: "v2.0.0", html_url: "https://github.com/owner/repository/releases/tag/v2.0.0", draft: false, prerelease: false });
    }) as typeof fetch,
  });
  const result = await service.check({
    ...base,
    installedCommit: undefined,
    installedTag: "v1.0.0",
  });
  assert.equal(result.status, "update-available");
  assert.equal(result.evidenceKind, "release-tag");
  assert.equal(result.installedEvidence, "v1.0.0");
  assert.equal(result.availableEvidence, "v2.0.0");
  assert.equal(calls.length, 2);
});

test("different GitHub commits are not updates unless compare proves a linear remote advance", async () => {
  for (const status of ["behind", "diverged", "unknown"] as const) {
    const service = new UpdateService({
      fetchImpl: (async (input: URL | RequestInfo) => {
        const url = String(input);
        if (url.endsWith("/owner/repository")) {
          return Response.json({ default_branch: "main", private: false, html_url: "https://github.com/owner/repository" });
        }
        if (url.includes("/commits/")) return Response.json({ sha: "2".repeat(40) });
        return Response.json({ status, ahead_by: status === "diverged" ? 2 : 0, behind_by: status === "behind" ? 2 : 1 });
      }) as typeof fetch,
    });
    const result = await service.check(base);
    assert.equal(result.status, "unavailable", `${status} must never be presented as a remote update`);
    assert.equal(result.evidenceKind, "none");
  }
});

test("release ordering fails closed for installed-ahead and incomparable tags", async () => {
  for (const [installedTag, remoteTag] of [["v3.0.0", "v2.0.0"], ["stable-a", "stable-b"]] as const) {
    const service = new UpdateService({
      fetchImpl: (async (input: URL | RequestInfo) => String(input).endsWith("/owner/repository")
        ? Response.json({ private: false, html_url: "https://github.com/owner/repository" })
        : Response.json({ tag_name: remoteTag, draft: false, prerelease: false })) as typeof fetch,
    });
    const result = await service.check({ ...base, installedCommit: undefined, installedTag });
    assert.equal(result.status, "unavailable");
    assert.equal(result.evidenceKind, "none");
  }
});

test("forceRefresh always bypasses cached GitHub evidence", async () => {
  let calls = 0;
  const service = new UpdateService({
    fetchImpl: (async (input: URL | RequestInfo) => {
      calls += 1;
      return String(input).endsWith("/owner/repository")
        ? Response.json({ default_branch: "main", private: false })
        : String(input).includes("/commits/")
          ? Response.json({ sha: "2222222222222222222222222222222222222222" })
          : Response.json({ status: "ahead", ahead_by: 1, behind_by: 0 });
    }) as typeof fetch,
  });
  await service.check(base, { forceRefresh: false });
  await service.check(base, { forceRefresh: false });
  assert.equal(calls, 3, "a non-forced second check may reuse exact subject evidence");
  await service.check(base, { forceRefresh: true });
  assert.equal(calls, 6, "forceRefresh performs fresh repository, commit, and ancestry requests");
});

test("physical fingerprint mismatch is modified and blocks overwrite without network access", async () => {
  const service = new UpdateService({
    fetchImpl: (() => { throw new Error("modified evidence must fail before network"); }) as typeof fetch,
  });
  const result = await service.check({
    ...base,
    installedHash: `sha256-${"a".repeat(64)}`,
    physicalFingerprint: "b".repeat(64),
  });
  assert.equal(result.status, "modified");
  assert.equal(result.evidenceKind, "install-hash");
  assert.equal(result.locallyModified, true);
  assert.equal(result.overwriteUpdateAllowed, false);
  assert.match(result.summary, /禁止覆盖式更新/u);
});

test("a dirty Git-backed skill is marked modified before any remote update request", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cso-git-modified-"));
  try {
    const instancePath = path.join(temporary, "skills", "fixture", "SKILL.md");
    await mkdir(path.dirname(instancePath), { recursive: true });
    await writeFile(instancePath, "---\nname: fixture\ndescription: clean\n---\n", "utf8");
    execFileSync("git", ["init", "--quiet"], { cwd: temporary, windowsHide: true });
    execFileSync("git", ["config", "user.email", "fixture@example.invalid"], { cwd: temporary, windowsHide: true });
    execFileSync("git", ["config", "user.name", "Fixture"], { cwd: temporary, windowsHide: true });
    execFileSync("git", ["add", "skills/fixture/SKILL.md"], { cwd: temporary, windowsHide: true });
    execFileSync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: temporary, windowsHide: true });
    const installedCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: temporary,
      encoding: "utf8",
      windowsHide: true,
    }).trim();
    await writeFile(instancePath, "---\nname: fixture\ndescription: locally changed\n---\n", "utf8");

    const service = new UpdateService({
      fetchImpl: (() => { throw new Error("dirty local evidence must stop before network"); }) as typeof fetch,
    });
    const result = await service.check({
      ...base,
      installedCommit,
      instancePath,
    });
    assert.equal(result.status, "modified");
    assert.equal(result.locallyModified, true);
    assert.equal(result.overwriteUpdateAllowed, false);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("local Codex plugin metadata reports only exact sortable versions and still blocks modification", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cso-plugin-update-"));
  try {
    const cacheRoot = path.join(temporary, "cache");
    const pluginRoot = path.join(cacheRoot, "fixture-market", "fixture-plugin");
    const installedRoot = path.join(pluginRoot, "1.0.0");
    const cachedNewRoot = path.join(pluginRoot, "2.0.0");
    const instancePath = path.join(installedRoot, "skills", "fixture-skill", "SKILL.md");
    for (const [root, version] of [[installedRoot, "1.0.0"], [cachedNewRoot, "2.0.0"]] as const) {
      await mkdir(path.join(root, ".codex-plugin"), { recursive: true });
      await writeFile(path.join(root, ".codex-plugin", "plugin.json"), JSON.stringify({
        name: "fixture-plugin",
        version,
        repository: "https://github.com/example/fixture-plugin",
      }), "utf8");
    }
    await mkdir(path.dirname(instancePath), { recursive: true });
    // The SKILL.md body is intentionally absent: update evidence must not read or download it.
    await writeFile(path.join(installedRoot, "plugin.lock.json"), JSON.stringify({
      skills: [{
        id: "fixture-skill",
        vendoredPath: "skills/fixture-skill",
        integrity: `sha256-${"a".repeat(64)}`,
        source: { ref: "1".repeat(40) },
      }],
    }), "utf8");
    const marketplacePath = path.join(temporary, "marketplace.json");
    await writeFile(marketplacePath, JSON.stringify({
      name: "fixture-market",
      plugins: [{ name: "fixture-plugin", version: "3.0.0" }],
    }), "utf8");
    const service = new UpdateService({
      pluginCacheRoots: [cacheRoot],
      pluginMarketplaceFiles: [marketplacePath],
      fetchImpl: (() => { throw new Error("plugin evidence must stay local"); }) as typeof fetch,
      now: () => new Date("2026-08-30T00:00:00.000Z"),
    });
    const subject: UpdateSubject = {
      logicalSkillId: "plugin-logical",
      sourceId: "plugin:fixture-market/fixture-plugin",
      installedTag: "1.0.0",
      installedHash: `sha256-${"a".repeat(64)}`,
      physicalFingerprint: "a".repeat(64),
      instancePath,
      locallyModified: false,
      scope: "plugin",
    };
    const result = await service.check(subject);
    assert.equal(result.status, "update-available");
    assert.equal(result.evidenceKind, "codex-plugin");
    assert.equal(result.installedEvidence, "1.0.0");
    assert.equal(result.availableEvidence, "3.0.0");
    assert.equal(result.locallyModified, false, "matching caller-provided install/content hashes verify a clean instance");
    assert.match(result.summary, /只检测/u);

    const modified = await service.check({ ...subject, physicalFingerprint: "b".repeat(64) });
    assert.equal(modified.status, "modified");
    assert.equal(modified.evidenceKind, "install-hash");
    assert.equal(modified.overwriteUpdateAllowed, false);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("draft, placeholder, or version-drifted plugin locks never impersonate reproducible install hashes", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cso-plugin-draft-lock-"));
  try {
    const cacheRoot = path.join(temporary, "cache");
    const installedRoot = path.join(cacheRoot, "fixture-market", "fixture-plugin", "2.0.0");
    const instancePath = path.join(installedRoot, "skills", "fixture-skill", "SKILL.md");
    await mkdir(path.join(installedRoot, ".codex-plugin"), { recursive: true });
    await mkdir(path.dirname(instancePath), { recursive: true });
    await writeFile(path.join(installedRoot, ".codex-plugin", "plugin.json"), JSON.stringify({
      name: "fixture-plugin",
      version: "2.0.0",
    }), "utf8");
    const service = new UpdateService({
      pluginCacheRoots: [cacheRoot],
      pluginMarketplaceFiles: [],
      fetchImpl: (() => { throw new Error("draft lock checks stay local"); }) as typeof fetch,
    });
    const subject: UpdateSubject = {
      logicalSkillId: "plugin-draft-lock",
      sourceId: "plugin:fixture-market/fixture-plugin",
      installedTag: "2.0.0",
      instancePath,
      locallyModified: false,
      scope: "plugin",
    };

    await writeFile(path.join(installedRoot, "plugin.lock.json"), JSON.stringify({
      lockVersion: 1,
      pluginVersion: "1.0.0",
      generatedBy: "codex plugin pack (draft)",
      skills: [{ vendoredPath: "skills/fixture-skill", integrity: `sha256-${"a".repeat(64)}` }],
    }), "utf8");
    const drifted = await service.check(subject);
    assert.equal(drifted.status, "unavailable");
    assert.match(drifted.summary, /版本.*不一致/u);

    await writeFile(path.join(installedRoot, "plugin.lock.json"), JSON.stringify({
      lockVersion: 1,
      pluginVersion: "2.0.0",
      generatedBy: "codex plugin pack (draft)",
      skills: [{ vendoredPath: "skills/fixture-skill", integrity: "sha256-<fill-during-pack>" }],
    }), "utf8");
    const placeholder = await service.check(subject);
    assert.equal(placeholder.status, "unavailable");
    assert.match(placeholder.summary, /不是有效 SHA-256/u);

    await writeFile(path.join(installedRoot, "plugin.lock.json"), JSON.stringify({
      lockVersion: 1,
      pluginVersion: "2.0.0",
      generatedBy: "codex plugin pack (draft)",
      skills: [{ vendoredPath: "skills/fixture-skill", integrity: `sha256-${"a".repeat(64)}` }],
    }), "utf8");
    const draft = await service.check(subject);
    assert.equal(draft.status, "unavailable");
    assert.match(draft.summary, /draft|未知生成器/u);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("an explicit plugin check refreshes the remote Codex catalog before comparing versions", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cso-plugin-catalog-"));
  try {
    const cacheRoot = path.join(temporary, "cache");
    const installedRoot = path.join(cacheRoot, "openai-curated-remote", "fixture-plugin", "1.0.0");
    const instancePath = path.join(installedRoot, "skills", "fixture", "SKILL.md");
    await mkdir(path.join(installedRoot, ".codex-plugin"), { recursive: true });
    await mkdir(path.dirname(instancePath), { recursive: true });
    await writeFile(path.join(installedRoot, ".codex-plugin", "plugin.json"), JSON.stringify({
      name: "fixture-plugin",
      version: "1.0.0",
      repository: "https://github.com/example/fixture-plugin",
    }), "utf8");

    const calls: string[][] = [];
    const catalogRuntime: CodexPluginCatalogRuntime = {
      resolveCommand: async () => "C:\\trusted\\codex.exe",
      execFile: async (_command, args) => {
        calls.push(args);
        if (args[1] === "marketplace") return { stdout: "{}", stderr: "" };
        return {
          stdout: JSON.stringify({
            available: [{ marketplaceName: "openai-curated", name: "fixture-plugin", version: "2.0.0" }],
          }),
          stderr: "",
        };
      },
    };
    const provider = new LocalCodexPluginUpdateProvider({ cacheRoots: [cacheRoot], catalogRuntime });
    const service = new UpdateService({ pluginProvider: provider });
    await service.refreshPluginCatalog(["plugin:openai-curated-remote/fixture-plugin"]);
    const result = await service.check({
      logicalSkillId: "plugin-catalog",
      sourceId: "plugin:openai-curated-remote/fixture-plugin",
      installedTag: "1.0.0",
      instancePath,
      locallyModified: false,
      scope: "plugin",
    });

    assert.equal(result.status, "update-available");
    assert.equal(result.availableEvidence, "2.0.0");
    assert.match(result.summary, /主动刷新/u);
    assert.deepEqual(calls, [
      ["plugin", "marketplace", "upgrade", "openai-curated", "--json"],
      ["plugin", "list", "--marketplace", "openai-curated", "--available", "--json"],
    ]);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("a failed plugin catalog refresh exposes no raw CLI path and never falls back to stale cache", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cso-plugin-catalog-fail-"));
  try {
    const cacheRoot = path.join(temporary, "cache");
    const installedRoot = path.join(cacheRoot, "openai-curated-remote", "fixture-plugin", "1.0.0");
    const staleRoot = path.join(cacheRoot, "openai-curated-remote", "fixture-plugin", "9.0.0");
    const instancePath = path.join(installedRoot, "skills", "fixture", "SKILL.md");
    for (const [root, version] of [[installedRoot, "1.0.0"], [staleRoot, "9.0.0"]] as const) {
      await mkdir(path.join(root, ".codex-plugin"), { recursive: true });
      await writeFile(path.join(root, ".codex-plugin", "plugin.json"), JSON.stringify({
        name: "fixture-plugin",
        version,
      }), "utf8");
    }
    await mkdir(path.dirname(instancePath), { recursive: true });
    const provider = new LocalCodexPluginUpdateProvider({
      cacheRoots: [cacheRoot],
      catalogRuntime: {
        resolveCommand: async () => "C:\\trusted\\codex.exe",
        execFile: async () => { throw new Error("failed at C:\\Users\\secret-user\\.codex\\plugins"); },
      },
    });
    const service = new UpdateService({ pluginProvider: provider });
    await service.refreshPluginCatalog(["plugin:openai-curated-remote/fixture-plugin"]);
    const result = await service.check({
      logicalSkillId: "plugin-catalog-fail",
      sourceId: "plugin:openai-curated-remote/fixture-plugin",
      installedTag: "1.0.0",
      instancePath,
      locallyModified: false,
      scope: "plugin",
    });
    assert.equal(result.status, "unavailable");
    assert.match(result.summary, /刷新失败/u);
    assert.doesNotMatch(result.summary, /secret-user|[A-Z]:\\/u);
    assert.notEqual(result.availableEvidence, "9.0.0");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("an untrusted plugin marketplace fails closed without invoking Codex", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cso-plugin-catalog-untrusted-"));
  try {
    const cacheRoot = path.join(temporary, "cache");
    const installedRoot = path.join(cacheRoot, "personal", "fixture-plugin", "1.0.0");
    const instancePath = path.join(installedRoot, "skills", "fixture", "SKILL.md");
    await mkdir(path.join(installedRoot, ".codex-plugin"), { recursive: true });
    await mkdir(path.dirname(instancePath), { recursive: true });
    await writeFile(path.join(installedRoot, ".codex-plugin", "plugin.json"), JSON.stringify({
      name: "fixture-plugin",
      version: "1.0.0",
    }), "utf8");
    let commandCalls = 0;
    const provider = new LocalCodexPluginUpdateProvider({
      cacheRoots: [cacheRoot],
      catalogRuntime: {
        resolveCommand: async () => { commandCalls += 1; return "C:\\trusted\\codex.exe"; },
        execFile: async () => { commandCalls += 1; return { stdout: "{}", stderr: "" }; },
      },
    });
    const service = new UpdateService({ pluginProvider: provider });
    await service.refreshPluginCatalog(["plugin:personal/fixture-plugin"]);
    const result = await service.check({
      logicalSkillId: "plugin-catalog-untrusted",
      sourceId: "plugin:personal/fixture-plugin",
      installedTag: "1.0.0",
      instancePath,
      locallyModified: false,
      scope: "plugin",
    });
    assert.equal(commandCalls, 0);
    assert.equal(result.status, "unavailable");
    assert.match(result.summary, /未列入受信任|未发起网络访问/u);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("Codex plugin evidence fails closed when the source appears older or versions are incomparable", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cso-plugin-order-"));
  try {
    const cacheRoot = path.join(temporary, "cache");
    const pluginRoot = path.join(cacheRoot, "fixture-market", "fixture-plugin");
    const installedRoot = path.join(pluginRoot, "3.0.0");
    const instancePath = path.join(installedRoot, "skills", "fixture", "SKILL.md");
    await mkdir(path.join(installedRoot, ".codex-plugin"), { recursive: true });
    await mkdir(path.dirname(instancePath), { recursive: true });
    await writeFile(path.join(installedRoot, ".codex-plugin", "plugin.json"), JSON.stringify({
      name: "fixture-plugin", version: "3.0.0",
    }), "utf8");
    const marketplacePath = path.join(temporary, "marketplace.json");
    await writeFile(marketplacePath, JSON.stringify({
      name: "fixture-market", plugins: [{ name: "fixture-plugin", version: "2.0.0" }],
    }), "utf8");
    const service = new UpdateService({
      pluginCacheRoots: [cacheRoot],
      pluginMarketplaceFiles: [marketplacePath],
      fetchImpl: (() => { throw new Error("plugin evidence must stay local"); }) as typeof fetch,
    });
    const subject: UpdateSubject = {
      logicalSkillId: "plugin-order",
      sourceId: "plugin:fixture-market/fixture-plugin",
      installedTag: "3.0.0",
      instancePath,
      locallyModified: false,
      scope: "plugin",
    };
    const current = await service.check(subject);
    assert.equal(current.status, "up-to-date", "the installed exact version remains the highest cache evidence");
    assert.equal(current.locallyModified, undefined, "version evidence alone must not claim the local content is clean");
    assert.match(current.summary, /修改状态未知/u);

    await writeFile(marketplacePath, JSON.stringify({
      name: "fixture-market", plugins: [{ name: "fixture-plugin", version: "rolling-latest" }],
    }), "utf8");
    const incomparable = await service.check(subject, { forceRefresh: true });
    assert.equal(incomparable.status, "unavailable");
    assert.match(incomparable.summary, /不可排序/u);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("plugin and GitHub evidence fail closed when metadata is missing, private, or conflicting", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cso-plugin-unavailable-"));
  try {
    const pluginService = new UpdateService({
      pluginCacheRoots: [path.join(temporary, "empty-cache")],
      fetchImpl: (() => { throw new Error("plugin lookup must not use network"); }) as typeof fetch,
    });
    const plugin = await pluginService.check({
      logicalSkillId: "missing-plugin",
      sourceId: "plugin:fixture/missing",
      installedTag: "1.0.0",
      locallyModified: false,
      scope: "plugin",
    });
    assert.equal(plugin.status, "unavailable");

    const githubService = new UpdateService({
      fetchImpl: (async () => new Response("", { status: 404 })) as typeof fetch,
    });
    const hidden = await githubService.check(base);
    assert.equal(hidden.status, "unavailable");
    assert.match(hidden.summary, /私有|不存在/u);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
