import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { InventorySnapshot, SkillRecord } from "../src/shared/types.js";

function record(skillId: string, locked: boolean, instances: number): SkillRecord {
  return {
    skillId,
    physicalId: `physical-${skillId}`,
    instanceId: `${skillId}-instance-1`,
    name: skillId === "logical-alpha" ? "Alpha Builder" : skillId === "logical-locked" ? "Locked Auditor" : skillId,
    description: "A deterministic browser fixture skill.",
    scope: "user",
    sourceId: "github:example/skills",
    sourceLabel: "example/skills",
    packageId: "example-skills",
    pluginId: null,
    pluginVersion: null,
    rootId: "codex-home",
    rootLabel: "Codex Home",
    absolutePath: `C:\\fixture\\${skillId}`,
    relativePath: skillId,
    breadcrumb: `Codex Home / ${skillId}`,
    readonly: false,
    aliases: [],
    diagnostics: [],
    automaticClassification: { categoryId: locked ? "security" : "development", tags: [], confidence: 0.95, source: "rules", reason: "fixture rule" },
    categoryId: locked ? "security" : "development",
    tags: locked ? ["user:protected"] : ["user:builder"],
    favorite: false,
    locked,
    hasManualOverride: locked,
    runtimeDiscovered: true,
    runtimeEnabled: true,
    runtimeScope: "user",
    instances: Array.from({ length: instances }, (_, index) => ({
      instanceId: `${skillId}-instance-${index + 1}`,
      logicalSkillId: skillId,
      absolutePath: `C:\\fixture\\${skillId}\\v${index + 1}`,
      rootId: "codex-home",
      rootLabel: "Codex Home",
      breadcrumb: `${skillId} / v${index + 1}`,
      aliases: [],
      pluginVersion: `0.${index + 1}.0`,
      readonly: false,
      managementGranted: true,
      runtimeDiscovered: true,
      runtimeEnabled: true,
      runtimeScope: "user",
      diagnostics: [],
    })),
  };
}

test("three-section workbench keeps locked skills out of bulk actions and expands exact instances", async ({ page }) => {
  const publicRoot = path.resolve("dist/public");
  const [html, app, styles, premium] = await Promise.all([
    readFile(path.join(publicRoot, "index.html"), "utf8"),
    readFile(path.join(publicRoot, "app.js"), "utf8"),
    readFile(path.join(publicRoot, "styles.css"), "utf8"),
    readFile(path.join(publicRoot, "premium-minimal.css"), "utf8"),
  ]);
  const lockedPlugin: SkillRecord = {
    ...record("logical-locked", true, 1),
    scope: "plugin",
    sourceId: "plugin:openai-curated-remote/audit-plugin",
    sourceLabel: "Audit plugin",
    pluginId: "audit-plugin",
    pluginVersion: "1.0.0",
  };
  const skills = [record("logical-alpha", false, 2), lockedPlugin];
  let configuredRoots: NonNullable<InventorySnapshot["configuredRoots"]> = [{
    rootId: "shared-root",
    label: "Shared Skills",
    absolutePath: "D:\\Shared Skills",
    readonly: true,
    managementAuthorized: false,
  }];
  let selectedProjectPath: string | null = null;
  let savedViews: NonNullable<InventorySnapshot["savedViews"]> = [{
    viewId: "view-security",
    name: "Security review",
    filters: { query: "", category: "security", scope: "all", runtime: "all", tag: "all", duplicatesOnly: false },
  }];
  let customCategories: NonNullable<InventorySnapshot["customCategories"]> = [{
    categoryId: "custom:team-tools",
    label: { zhCN: "团队工具", enUS: "Team tools" },
    sortOrder: 120,
    hidden: false,
  }];
  let categoryPreferences: NonNullable<InventorySnapshot["categoryPreferences"]> = [];
  const snapshot: InventorySnapshot = {
    revision: "revision-1",
    generatedAt: "2026-08-30T00:00:00.000Z",
    skills,
    summary: {
      total: 2, runtimeVisible: 2, cacheOnly: 0, pending: 0, favorites: 0, duplicateNames: 0,
      byScope: { user: 1, agents: 0, system: 0, plugin: 1, repo: 0, custom: 0 },
      byCategory: { development: 1, quality: 0, security: 1, delivery: 0, "data-automation": 0, "docs-knowledge": 0, "design-media": 0, "research-analysis": 0, "finance-trading": 0, "content-social": 0, "agent-workflow": 0, pending: 0 },
    },
    scanErrors: [], orphanOverrideIds: [], runtimeAvailable: true, runtimeError: null, managementMode: false, protocolVersion: "2.0",
    configuredRoots, selectedProjectPath, savedViews, customCategories, categoryPreferences,
  };
  let managementMode = false;
  let revision = snapshot.revision;
  let unitConfirmed = false;
  let quarantineExecuted = false;
  let quarantinePurged = false;
  let confirmedUnitIds: string[] = [];
  let executedPlanId = "";
  let purgedEntryId = "";
  const settingsRequests: Array<{ path: string; method: string; body: Record<string, unknown> }> = [];
  const currentSnapshot = (): InventorySnapshot => ({
    ...snapshot,
    revision,
    managementMode,
    configuredRoots,
    selectedProjectPath,
    savedViews,
    customCategories,
    categoryPreferences,
  });
  const advanceSnapshot = (): InventorySnapshot => {
    const number = Number.parseInt(revision.slice(revision.lastIndexOf("-") + 1), 10) + 1;
    revision = `revision-${number}`;
    return currentSnapshot();
  };

  await page.route("http://organizer.test/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const json = (value: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(value) });
    if (url.pathname === "/") return route.fulfill({ status: 200, contentType: "text/html", body: html });
    if (url.pathname === "/app.js") return route.fulfill({ status: 200, contentType: "text/javascript", body: app });
    if (url.pathname === "/styles.css") return route.fulfill({ status: 200, contentType: "text/css", body: styles });
    if (url.pathname === "/premium-minimal.css") return route.fulfill({ status: 200, contentType: "text/css", body: premium });
    if (url.pathname === "/api/session") return json({ csrf: "csrf-fixture" });
    if (url.pathname === "/api/inventory") return json(currentSnapshot());
    if (url.pathname === "/api/management-mode") {
      if (request.method() === "PUT") managementMode = (request.postDataJSON() as { enabled: boolean }).enabled;
      return json({ enabled: managementMode });
    }
    if (url.pathname === "/api/classification-suggestions") return json({ items: [] });
    if (url.pathname === "/api/quarantine" && request.method() === "GET") return json({
      candidates: [
        {
          installationUnitId: "unit-confirmable",
          label: "Alpha Builder",
          kind: "skill",
          pathHint: "C:\\fixture\\logical-alpha",
          confirmed: unitConfirmed,
          managementAuthorized: true,
          allowed: unitConfirmed,
          skillCount: 1,
          affectedSkillIds: ["logical-alpha"],
          affectedInstanceIds: ["logical-alpha-instance-1", "logical-alpha-instance-2"],
          blockers: [],
          blockedReasons: unitConfirmed ? [] : ["需要用户确认安装单元边界"],
        },
        {
          installationUnitId: "unit-protected",
          label: "Protected System Skill",
          kind: "skill",
          pathHint: "C:\\fixture\\protected",
          confirmed: false,
          managementAuthorized: true,
          allowed: false,
          skillCount: 2,
          affectedSkillIds: ["protected-a", "protected-b"],
          blockers: [{ code: "PROTECTED_SCOPE", message: "包含受保护 Skill" }],
          blockedReasons: ["包含受保护 Skill"],
        },
      ],
      entries: quarantineExecuted && !quarantinePurged ? [{
        quarantineEntryId: "entry-1",
        installationUnitId: "unit-confirmable",
        label: "Alpha Builder",
        originalPathHint: "C:\\fixture\\logical-alpha",
        status: "quarantined",
        quarantinedAt: "2026-08-30T00:01:00.000Z",
      }] : [],
      plans: [],
    });
    if (url.pathname === "/api/installation-units/confirm") {
      const body = request.postDataJSON() as { installationUnitIds: string[]; expectedRevision: string };
      confirmedUnitIds = body.installationUnitIds;
      expect(body.expectedRevision).toBe("revision-1");
      unitConfirmed = true;
      revision = "revision-2";
      return json({ units: [], snapshot: currentSnapshot() });
    }
    if (url.pathname === "/api/quarantine/prepare") {
      const body = request.postDataJSON() as { installationUnitIds: string[]; expectedRevision: string };
      expect(body).toEqual({ installationUnitIds: ["unit-confirmable"], expectedRevision: "revision-2" });
      return json({ plans: [{
        planId: "plan-1",
        inventoryRevision: "revision-2",
        executable: true,
        allowed: true,
        affectedSkillCount: 1,
        summary: "计划已通过安全检查",
        items: [{
          installationUnitId: "unit-confirmable",
          quarantineEntryId: "entry-1",
          sourcePath: "C:\\fixture\\logical-alpha",
          quarantinePath: "C:\\quarantine\\entry-1",
          affectedSkillIds: ["logical-alpha"],
          affectedInstanceIds: ["logical-alpha-instance-1", "logical-alpha-instance-2"],
          tree: [{ relativePath: "SKILL.md", type: "file", sizeBytes: 42 }],
          totalEntries: 1,
          sizeBytes: 42,
          blockers: [],
        }],
      }] });
    }
    if (url.pathname === "/api/quarantine/execute") {
      const body = request.postDataJSON() as { planId: string; confirmed: boolean; expectedRevision: string };
      expect(body).toEqual({ planId: "plan-1", confirmed: true, expectedRevision: "revision-2" });
      executedPlanId = body.planId;
      quarantineExecuted = true;
      revision = "revision-3";
      return json({
        result: { succeeded: ["unit-confirmable"], failed: [], notExecuted: [], entries: [] },
        snapshot: currentSnapshot(),
      });
    }
    if (url.pathname === "/api/quarantine/purge") {
      const body = request.postDataJSON() as { quarantineEntryId: string; confirmed: boolean };
      expect(body).toEqual({ quarantineEntryId: "entry-1", confirmed: true });
      purgedEntryId = body.quarantineEntryId;
      quarantinePurged = true;
      return json({ entry: { quarantineEntryId: body.quarantineEntryId, status: "purged" } });
    }
    if (url.pathname === "/api/roots" && request.method() === "POST") {
      const body = request.postDataJSON() as { absolutePath: string; label: string; expectedRevision: string };
      settingsRequests.push({ path: url.pathname, method: request.method(), body });
      configuredRoots = [...configuredRoots, {
        rootId: "added-root", label: body.label || "Added root", absolutePath: body.absolutePath,
        readonly: true, managementAuthorized: false,
      }];
      return json(advanceSnapshot());
    }
    if (url.pathname === "/api/roots/management" && request.method() === "PATCH") {
      const body = request.postDataJSON() as { rootId: string; managementAuthorized: boolean; expectedRevision: string };
      settingsRequests.push({ path: url.pathname, method: request.method(), body });
      configuredRoots = configuredRoots.map((root) => root.rootId === body.rootId
        ? { ...root, readonly: !body.managementAuthorized, managementAuthorized: body.managementAuthorized }
        : root);
      return json(advanceSnapshot());
    }
    if (url.pathname === "/api/roots" && request.method() === "DELETE") {
      const body = request.postDataJSON() as { rootId: string; expectedRevision: string };
      settingsRequests.push({ path: url.pathname, method: request.method(), body });
      configuredRoots = configuredRoots.filter((root) => root.rootId !== body.rootId);
      return json(advanceSnapshot());
    }
    if (url.pathname === "/api/project" && request.method() === "PUT") {
      const body = request.postDataJSON() as { projectPath: string | null; expectedRevision: string };
      settingsRequests.push({ path: url.pathname, method: request.method(), body });
      selectedProjectPath = body.projectPath;
      return json(advanceSnapshot());
    }
    if (url.pathname === "/api/saved-views" && request.method() === "PUT") {
      const body = request.postDataJSON() as { viewId: string; name: string; filters: Record<string, string | boolean | string[] | null>; expectedRevision: string };
      settingsRequests.push({ path: url.pathname, method: request.method(), body });
      savedViews = [...savedViews.filter((view) => view.viewId !== body.viewId), { viewId: body.viewId, name: body.name, filters: body.filters }];
      return json(advanceSnapshot());
    }
    if (url.pathname === "/api/saved-views" && request.method() === "DELETE") {
      const body = request.postDataJSON() as { viewId: string; expectedRevision: string };
      settingsRequests.push({ path: url.pathname, method: request.method(), body });
      savedViews = savedViews.filter((view) => view.viewId !== body.viewId);
      return json(advanceSnapshot());
    }
    if (url.pathname === "/api/categories" && request.method() === "POST") {
      const body = request.postDataJSON() as { categoryId: `custom:${string}`; label: { zhCN: string; enUS: string }; sortOrder: number; hidden: boolean; expectedRevision: string };
      settingsRequests.push({ path: url.pathname, method: request.method(), body });
      customCategories = [...customCategories, { categoryId: body.categoryId, label: body.label, sortOrder: body.sortOrder, hidden: body.hidden }];
      return json(advanceSnapshot());
    }
    if (url.pathname === "/api/categories" && request.method() === "DELETE") {
      const body = request.postDataJSON() as { sourceCategoryId: `custom:${string}`; targetCategoryId: string; expectedRevision: string };
      settingsRequests.push({ path: url.pathname, method: request.method(), body });
      customCategories = customCategories.filter((category) => category.categoryId !== body.sourceCategoryId);
      return json({ migrated: 0, snapshot: advanceSnapshot() });
    }
    if (url.pathname === "/api/category-preferences" && request.method() === "PUT") {
      const body = request.postDataJSON() as NonNullable<InventorySnapshot["categoryPreferences"]>[number] & { expectedRevision: string };
      settingsRequests.push({ path: url.pathname, method: request.method(), body });
      categoryPreferences = [...categoryPreferences.filter((preference) => preference.categoryId !== body.categoryId), {
        categoryId: body.categoryId, display: body.display, sortOrder: body.sortOrder, hidden: body.hidden,
      }];
      return json(advanceSnapshot());
    }
    if (url.pathname === "/api/diagnostics") return json({ version: "0.2.0", roots: [], runtimeAvailable: true, runtimeError: null, scanErrors: [], orphanOverrideIds: [], counts: snapshot.summary });
    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "fixture route missing" }) });
  });

  await page.goto("http://organizer.test/");
  await expect(page.getByRole("heading", { name: /把每台电脑上不同的 Skill/ })).toBeVisible();

  await page.locator('[data-panel="inventory"]').click();
  await expect(page.getByRole("button", { name: "Alpha Builder" })).toBeVisible();
  const checkboxes = page.locator("#skillTableBody tr.skill-row input[type=checkbox]");
  await expect(checkboxes.nth(0)).toBeEnabled();
  await expect(checkboxes.nth(1)).toBeDisabled();
  await checkboxes.nth(0).check();
  await expect(page.locator("#selectedCount")).toHaveText("1");

  await page.getByRole("button", { name: /展开 2 个实例/ }).click();
  await expect(page.locator(".instance-row:not([hidden]) .instance-card")).toHaveCount(2);
  await expect(page.getByText("C:\\fixture\\logical-alpha\\v2")).toBeVisible();

  await page.locator('[data-panel="management"]').click();
  await expect(page.locator("#managementModeToggle")).not.toBeChecked();
  await expect(page.getByRole("heading", { name: "设置 / 目录" })).toBeVisible();
  await page.locator("#savedViewSelect").selectOption("view-security");
  await page.locator("#applySavedViewButton").click();
  await expect(page.locator("#resultCount")).toHaveText("1 项");
  await expect(page.getByRole("button", { name: "Locked Auditor" })).toBeVisible();
  await page.locator("#sourceFilter").selectOption("value:plugin%3Aopenai-curated-remote%2Faudit-plugin");
  await page.locator("#pluginFilter").selectOption("value:audit-plugin");
  await expect(page.locator("#resultCount")).toHaveText("1 项");
  await page.locator('[data-panel="management"]').click();
  await expect(page.locator("#quarantineCandidates .management-item")).toHaveCount(2);
  const candidateCheckboxes = page.locator("#quarantineCandidates input[type=checkbox]");
  await expect(candidateCheckboxes.nth(0)).toBeEnabled();
  await expect(candidateCheckboxes.nth(1)).toBeDisabled();
  await expect(page.getByText("包含受保护 Skill", { exact: true })).toBeVisible();
  await candidateCheckboxes.nth(0).check();
  await expect(page.locator("#confirmInstallationUnitsButton")).toBeEnabled();
  await expect(page.locator("#prepareQuarantineButton")).toBeDisabled();

  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("共影响 1 个 Skill");
    expect(dialog.message()).toContain("blockers: 无");
    await dialog.accept();
  });
  await page.locator("#confirmInstallationUnitsButton").click();
  await expect.poll(() => confirmedUnitIds).toEqual(["unit-confirmable"]);
  await expect(page.locator("#prepareQuarantineButton")).toBeEnabled();
  await page.locator("#prepareQuarantineButton").click();
  await expect(page.getByRole("button", { name: "确认隔离" })).toBeVisible();
  await expect(page.getByRole("button", { name: "确认隔离" })).toBeDisabled();

  page.once("dialog", (dialog) => void dialog.accept());
  await page.locator(".mode-switch").click();
  await expect(page.locator("#managementStatusText")).toHaveText("管理模式：开启");
  await expect(page.getByRole("button", { name: "确认隔离" })).toBeEnabled();
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("1 个目录、1 个 Skill");
    expect(dialog.message()).toContain("C:\\fixture\\logical-alpha");
    await dialog.accept();
  });
  await page.getByRole("button", { name: "确认隔离" }).click();
  await expect.poll(() => executedPlanId).toBe("plan-1");
  await expect(page.getByRole("button", { name: "恢复" })).toBeVisible();
  await expect(page.getByRole("button", { name: "永久清空" })).toBeVisible();
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("不可恢复");
    expect(dialog.message()).toContain("Alpha Builder");
    await dialog.accept();
  });
  await page.getByRole("button", { name: "永久清空" }).click();
  await expect.poll(() => purgedEntryId).toBe("entry-1");
  await expect(page.getByRole("button", { name: "永久清空" })).toHaveCount(0);
  await expect(page.getByText("0.2.0 从空 SQLite 开始。0.1.1 的 JSON 状态文件只读保留；本界面不提供旧 JSON 导入，也不会暗示已迁移。")).toBeVisible();
  await expect(page.locator("#importButton, #importFile")).toHaveCount(0);

  await page.locator("#rootLabelInput").fill("Team sync");
  await page.locator("#rootPathInput").fill("D:\\Team Skills");
  await page.locator("#addRootButton").click();
  await expect.poll(() => settingsRequests.length).toBe(1);
  await expect(page.locator('[data-root-id="added-root"]')).toContainText("只读扫描");

  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("授权 Organizer 管理目录");
    expect(dialog.message()).toContain("D:\\Shared Skills");
    await dialog.accept();
  });
  await page.locator('[data-root-id="shared-root"]').getByRole("button", { name: "授权管理" }).click();
  await expect.poll(() => settingsRequests.length).toBe(2);
  await expect(page.locator('[data-root-id="shared-root"]')).toContainText("已授权管理");

  await page.locator("#projectPathInput").fill("D:\\Projects\\Fixture");
  await page.locator("#selectProjectButton").click();
  await expect.poll(() => settingsRequests.length).toBe(3);
  await expect(page.locator("#selectedProjectValue")).toHaveText("D:\\Projects\\Fixture");

  await page.locator("#savedViewSelect").selectOption("");
  await page.locator("#savedViewNameInput").fill("Current security view");
  await page.locator("#saveCurrentViewButton").click();
  await expect.poll(() => settingsRequests.length).toBe(4);

  await page.locator("#customCategorySlugInput").fill("ops-team");
  await page.locator("#customCategoryZhInput").fill("运维团队");
  await page.locator("#customCategoryEnInput").fill("Ops team");
  await page.locator("#createCustomCategoryButton").click();
  await expect.poll(() => settingsRequests.length).toBe(5);
  await expect(page.locator('[data-category-id="custom:ops-team"]')).toBeVisible();

  const developmentCategory = page.locator('[data-category-id="development"]');
  await developmentCategory.locator('input[type="text"]').nth(0).fill("工程开发");
  await developmentCategory.locator('input[type="text"]').nth(1).fill("Engineering");
  await developmentCategory.locator('input[type="number"]').fill("5");
  await developmentCategory.getByRole("button", { name: "保存显示" }).click();
  await expect.poll(() => settingsRequests.length).toBe(6);
  await expect(page.locator("#toast")).toHaveText("分类显示设置已保存");

  const migratedCategory = page.locator('[data-category-id="custom:team-tools"]');
  await migratedCategory.locator("select").selectOption("development");
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("迁移到");
    expect(dialog.message()).toContain("然后删除个人分类");
    await dialog.accept();
  });
  await migratedCategory.getByRole("button", { name: "迁移并删除" }).click();
  await expect.poll(() => settingsRequests.length).toBe(7);
  await expect(page.locator('[data-category-id="custom:team-tools"]')).toHaveCount(0);

  await page.locator("#clearProjectButton").click();
  await expect.poll(() => settingsRequests.length).toBe(8);
  await expect(page.locator("#selectedProjectValue")).toHaveText("—");

  page.once("dialog", (dialog) => void dialog.accept());
  await page.locator('[data-root-id="added-root"]').getByRole("button", { name: "移除目录" }).click();
  await expect.poll(() => settingsRequests.length).toBe(9);
  await expect(page.locator('[data-root-id="added-root"]')).toHaveCount(0);

  expect(settingsRequests.map((item) => `${item.method} ${item.path}`)).toEqual([
    "POST /api/roots",
    "PATCH /api/roots/management",
    "PUT /api/project",
    "PUT /api/saved-views",
    "POST /api/categories",
    "PUT /api/category-preferences",
    "DELETE /api/categories",
    "PUT /api/project",
    "DELETE /api/roots",
  ]);
  expect(settingsRequests.map((item) => item.body.expectedRevision)).toEqual([
    "revision-3", "revision-4", "revision-5", "revision-6", "revision-7", "revision-8", "revision-9", "revision-10", "revision-11",
  ]);
  expect(settingsRequests[3]?.body.filters).toMatchObject({
    category: "security",
    source: "value:plugin%3Aopenai-curated-remote%2Faudit-plugin",
    plugin: "value:audit-plugin",
    duplicatesOnly: false,
  });
  expect(settingsRequests[6]?.body).toMatchObject({ sourceCategoryId: "custom:team-tools", targetCategoryId: "development" });

  await page.locator("#languageButton").click();
  await expect(page.getByRole("heading", { name: "Management", exact: true })).toBeVisible();
});

test("bulk classification never changes the lock unless an explicit lock control is used", async ({ page }) => {
  const publicRoot = path.resolve("dist/public");
  const [html, app, styles, premium] = await Promise.all([
    readFile(path.join(publicRoot, "index.html"), "utf8"),
    readFile(path.join(publicRoot, "app.js"), "utf8"),
    readFile(path.join(publicRoot, "styles.css"), "utf8"),
    readFile(path.join(publicRoot, "premium-minimal.css"), "utf8"),
  ]);
  const skills = [record("bulk-unlocked", false, 1)];
  let revision = "bulk-revision-1";
  let classificationRequest: Record<string, unknown> | null = null;
  const currentSnapshot = (): InventorySnapshot => ({
    revision,
    generatedAt: "2026-08-30T00:00:00.000Z",
    skills,
    summary: {
      total: 1, runtimeVisible: 1, cacheOnly: 0, pending: 0, favorites: 0, duplicateNames: 0,
      byScope: { user: 1, agents: 0, system: 0, plugin: 0, repo: 0, custom: 0 },
      byCategory: { development: 1, quality: 0, security: 0, delivery: 0, "data-automation": 0, "docs-knowledge": 0, "design-media": 0, "research-analysis": 0, "finance-trading": 0, "content-social": 0, "agent-workflow": 0, pending: 0 },
    },
    scanErrors: [], orphanOverrideIds: [], runtimeAvailable: true, runtimeError: null,
    managementMode: false, protocolVersion: "2.0", configuredRoots: [], selectedProjectPath: null,
    savedViews: [], customCategories: [], categoryPreferences: [],
  });

  await page.route("http://organizer.test/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const json = (value: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(value) });
    if (url.pathname === "/") return route.fulfill({ status: 200, contentType: "text/html", body: html });
    if (url.pathname === "/app.js") return route.fulfill({ status: 200, contentType: "text/javascript", body: app });
    if (url.pathname === "/styles.css") return route.fulfill({ status: 200, contentType: "text/css", body: styles });
    if (url.pathname === "/premium-minimal.css") return route.fulfill({ status: 200, contentType: "text/css", body: premium });
    if (url.pathname === "/api/session") return json({ csrf: "csrf-bulk-fixture" });
    if (url.pathname === "/api/inventory") return json(currentSnapshot());
    if (url.pathname === "/api/management-mode") return json({ enabled: false });
    if (url.pathname === "/api/classification" && request.method() === "PATCH") {
      classificationRequest = request.postDataJSON() as Record<string, unknown>;
      revision = "bulk-revision-2";
      return json(currentSnapshot());
    }
    if (url.pathname === "/api/classification-suggestions") return json({ items: [] });
    if (url.pathname === "/api/quarantine") return json({ candidates: [], entries: [], plans: [] });
    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "fixture route missing" }) });
  });

  await page.goto("http://organizer.test/");
  await page.locator('[data-panel="inventory"]').click();
  await page.locator("#skillTableBody tr.skill-row input[type=checkbox]").check();
  await page.locator("#bulkCategory").selectOption("quality");
  await page.locator("#bulkApplyButton").click();

  await expect.poll(() => classificationRequest).not.toBeNull();
  expect(classificationRequest).toMatchObject({
    skillIds: ["bulk-unlocked"],
    expectedRevision: "bulk-revision-1",
    primaryCategoryId: "quality",
    reason: "bulk-manual-workbench",
  });
  expect(classificationRequest).not.toHaveProperty("locked");
});

test("dragging selected skills to a category uses the current revision and excludes locked skills", async ({ page }) => {
  const publicRoot = path.resolve("dist/public");
  const [html, app, styles, premium] = await Promise.all([
    readFile(path.join(publicRoot, "index.html"), "utf8"),
    readFile(path.join(publicRoot, "app.js"), "utf8"),
    readFile(path.join(publicRoot, "styles.css"), "utf8"),
    readFile(path.join(publicRoot, "premium-minimal.css"), "utf8"),
  ]);
  const skills = [record("drag-unlocked", false, 1), record("drag-locked", true, 1)];
  let revision = "drag-revision-1";
  let classificationRequest: Record<string, unknown> | null = null;
  const currentSnapshot = (): InventorySnapshot => ({
    revision,
    generatedAt: "2026-08-30T00:00:00.000Z",
    skills,
    summary: {
      total: 2, runtimeVisible: 2, cacheOnly: 0, pending: 0, favorites: 0, duplicateNames: 0,
      byScope: { user: 2, agents: 0, system: 0, plugin: 0, repo: 0, custom: 0 },
      byCategory: { development: 1, quality: 0, security: 1, delivery: 0, "data-automation": 0, "docs-knowledge": 0, "design-media": 0, "research-analysis": 0, "finance-trading": 0, "content-social": 0, "agent-workflow": 0, pending: 0 },
    },
    scanErrors: [], orphanOverrideIds: [], runtimeAvailable: true, runtimeError: null,
    managementMode: false, protocolVersion: "2.0", configuredRoots: [], selectedProjectPath: null,
    savedViews: [], customCategories: [], categoryPreferences: [],
  });

  await page.route("http://organizer.test/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const json = (value: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(value) });
    if (url.pathname === "/") return route.fulfill({ status: 200, contentType: "text/html", body: html });
    if (url.pathname === "/app.js") return route.fulfill({ status: 200, contentType: "text/javascript", body: app });
    if (url.pathname === "/styles.css") return route.fulfill({ status: 200, contentType: "text/css", body: styles });
    if (url.pathname === "/premium-minimal.css") return route.fulfill({ status: 200, contentType: "text/css", body: premium });
    if (url.pathname === "/api/session") return json({ csrf: "csrf-drag-fixture" });
    if (url.pathname === "/api/inventory") return json(currentSnapshot());
    if (url.pathname === "/api/management-mode") return json({ enabled: false });
    if (url.pathname === "/api/classification" && request.method() === "PATCH") {
      classificationRequest = request.postDataJSON() as Record<string, unknown>;
      revision = "drag-revision-2";
      return json(currentSnapshot());
    }
    if (url.pathname === "/api/classification-suggestions") return json({ items: [] });
    if (url.pathname === "/api/quarantine") return json({ candidates: [], entries: [], plans: [] });
    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "fixture route missing" }) });
  });

  await page.goto("http://organizer.test/");
  await page.locator("#languageButton").click();
  await page.locator('[data-panel="inventory"]').click();
  const unlockedRow = page.locator("#skillTableBody tr.skill-row").filter({ hasText: "drag-unlocked" });
  const lockedRow = page.locator("#skillTableBody tr.skill-row").filter({ hasText: "drag-locked" });
  await expect(lockedRow).toHaveAttribute("draggable", "false");
  await unlockedRow.locator('input[type="checkbox"]').check();
  await expect(unlockedRow).toHaveAttribute("draggable", "true");
  const target = page.locator('[data-drop-category-id="quality"]');
  await expect(target).toHaveAttribute("title", "Classify selected skills as Testing & Quality");
  await unlockedRow.dragTo(target);

  await expect.poll(() => classificationRequest).not.toBeNull();
  expect(classificationRequest).toMatchObject({
    skillIds: ["drag-unlocked"],
    expectedRevision: "drag-revision-1",
    primaryCategoryId: "quality",
    reason: "drag-classification-workbench",
  });
  await expect(page.locator("#dragStatus")).toHaveText("Classified 1 skills as Testing & Quality.");
});

test("desktop diagnostics require explicit support consent and open only the exact native plugin link", async ({ page }) => {
  const publicRoot = path.resolve("dist/public");
  const [html, app, styles, premium] = await Promise.all([
    readFile(path.join(publicRoot, "index.html"), "utf8"),
    readFile(path.join(publicRoot, "app.js"), "utf8"),
    readFile(path.join(publicRoot, "styles.css"), "utf8"),
    readFile(path.join(publicRoot, "premium-minimal.css"), "utf8"),
  ]);
  const skills = [record("support-fixture", false, 1)];
  const snapshot: InventorySnapshot = {
    revision: "support-revision-1",
    generatedAt: "2026-08-30T00:00:00.000Z",
    skills,
    summary: {
      total: 1, runtimeVisible: 1, cacheOnly: 0, pending: 0, favorites: 0, duplicateNames: 0,
      byScope: { user: 1, agents: 0, system: 0, plugin: 0, repo: 0, custom: 0 },
      byCategory: { development: 1, quality: 0, security: 0, delivery: 0, "data-automation": 0, "docs-knowledge": 0, "design-media": 0, "research-analysis": 0, "finance-trading": 0, "content-social": 0, "agent-workflow": 0, pending: 0 },
    },
    scanErrors: [], orphanOverrideIds: [], runtimeAvailable: true, runtimeError: null,
    managementMode: false, protocolVersion: "2.0", configuredRoots: [], selectedProjectPath: null,
    savedViews: [], customCategories: [], categoryPreferences: [],
  };
  const pluginHref = "codex://plugins/codex-skill-organizer?marketplacePath=C%3A%5CUsers%5Cfixture%5C.agents%5Cplugins%5Cmarketplace.json";
  let supportRequest: { body: Record<string, unknown>; csrf: string | undefined } | null = null;
  let pluginLinkRequests = 0;
  await page.addInitScript(() => {
    const target = window as unknown as { __openedUrls: string[]; open: typeof window.open };
    target.__openedUrls = [];
    target.open = ((url?: string | URL) => {
      target.__openedUrls.push(String(url));
      return null;
    }) as typeof window.open;
  });
  await page.route("http://organizer.test/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const json = (value: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
    if (url.pathname === "/") return route.fulfill({ status: 200, contentType: "text/html", body: html });
    if (url.pathname === "/app.js") return route.fulfill({ status: 200, contentType: "text/javascript", body: app });
    if (url.pathname === "/styles.css") return route.fulfill({ status: 200, contentType: "text/css", body: styles });
    if (url.pathname === "/premium-minimal.css") return route.fulfill({ status: 200, contentType: "text/css", body: premium });
    if (url.pathname === "/api/session") return json({ csrf: "csrf-support-fixture" });
    if (url.pathname === "/api/inventory") return json(snapshot);
    if (url.pathname === "/api/management-mode") return json({ enabled: false });
    if (url.pathname === "/api/classification-suggestions") return json({ items: [] });
    if (url.pathname === "/api/quarantine") return json({ candidates: [], entries: [], plans: [] });
    if (url.pathname === "/api/diagnostics") return json({ version: "0.2.0", roots: [], runtimeAvailable: true, runtimeError: null, scanErrors: [], orphanOverrideIds: [], counts: snapshot.summary });
    if (url.pathname === "/api/support-bundle" && request.method() === "POST") {
      supportRequest = { body: request.postDataJSON() as Record<string, unknown>, csrf: request.headers()["x-cso-csrf"] };
      return json({
        path: "C:\\Users\\private-user\\AppData\\Local\\SkillOrganizerForCodex\\support-bundles\\support-2026-08-30.json",
        sizeBytes: 1_024,
        sha256: "a".repeat(64),
        createdAt: "2026-08-30T00:00:00.000Z",
      }, 201);
    }
    if (url.pathname === "/api/plugin-management-link") {
      pluginLinkRequests += 1;
      return json({ href: pluginHref });
    }
    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "fixture route missing" }) });
  });

  await page.goto("http://organizer.test/");
  await page.locator('[data-panel="inventory"]').click();
  await page.locator("#diagnosticsButton").click();
  await expect(page.locator("#pluginManagementButton")).toBeFocused();
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("用户名、绝对路径和原始 stderr");
    expect(dialog.message()).toContain("不会包含 token、cookie、CSRF");
    await dialog.accept();
  });
  await page.locator("#supportBundleButton").click();
  await expect.poll(() => supportRequest).not.toBeNull();
  expect(supportRequest).toEqual({
    body: { confirmed: true, includeSensitiveDiagnostics: true },
    csrf: "csrf-support-fixture",
  });
  await expect(page.locator("#supportBundleResult")).toBeVisible();
  await expect(page.locator("#supportBundleResult")).toBeFocused();
  await expect(page.locator("#supportBundleFileName")).toHaveText("support-2026-08-30.json");
  await expect(page.locator("#supportBundleSize")).toHaveText("1,024 B");
  await expect(page.locator("#supportBundleSha")).toHaveText("a".repeat(64));
  await expect(page.locator("#supportBundleResult")).not.toContainText("private-user");

  await page.locator("#pluginManagementButton").click();
  await expect.poll(() => pluginLinkRequests).toBe(1);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __openedUrls: string[] }).__openedUrls)).toEqual([pluginHref]);
});

test("MCP panel exposes portable settings as read-only and never offers desktop writes", async ({ page }) => {
  const publicRoot = path.resolve("dist/public");
  const [html, app, styles, premium] = await Promise.all([
    readFile(path.join(publicRoot, "index.html"), "utf8"),
    readFile(path.join(publicRoot, "app.js"), "utf8"),
    readFile(path.join(publicRoot, "styles.css"), "utf8"),
    readFile(path.join(publicRoot, "premium-minimal.css"), "utf8"),
  ]);
  const skills = [record("logical-alpha", false, 1)];
  const snapshot: InventorySnapshot = {
    revision: "mcp-revision-1",
    generatedAt: "2026-08-30T00:00:00.000Z",
    skills,
    summary: {
      total: 1, runtimeVisible: 1, cacheOnly: 0, pending: 0, favorites: 0, duplicateNames: 0,
      byScope: { user: 1, agents: 0, system: 0, plugin: 0, repo: 0, custom: 0 },
      byCategory: { development: 1, quality: 0, security: 0, delivery: 0, "data-automation": 0, "docs-knowledge": 0, "design-media": 0, "research-analysis": 0, "finance-trading": 0, "content-social": 0, "agent-workflow": 0, pending: 0 },
    },
    scanErrors: [], orphanOverrideIds: [], runtimeAvailable: true, runtimeError: null,
    managementMode: false, protocolVersion: "2.0",
    configuredRoots: [{ rootId: "mcp-root", label: "Shared Skills", absolutePath: "D:\\Shared Skills", readonly: true, managementAuthorized: false }],
    selectedProjectPath: "D:\\Projects\\ReadOnly",
    savedViews: [{ viewId: "mcp-view", name: "Review", filters: { category: "development" } }],
    customCategories: [{ categoryId: "custom:team-tools", label: { zhCN: "团队工具", enUS: "Team tools" }, sortOrder: 120, hidden: false }],
    categoryPreferences: [],
  };
  await page.addInitScript((initialSnapshot) => {
    const target = window as unknown as { openai: unknown; __openedExternal: string[] };
    target.__openedExternal = [];
    target.openai = {
      toolResponseMetadata: { snapshot: initialSnapshot, desktopUrl: "http://organizer.test/" },
      callTool: async () => ({ content: [], structuredContent: { snapshot: initialSnapshot }, isError: false }),
      openExternal: async ({ href }: { href: string }) => { target.__openedExternal.push(href); },
    };
  }, snapshot);
  await page.route("http://organizer.test/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/") return route.fulfill({ status: 200, contentType: "text/html", body: html });
    if (url.pathname === "/app.js") return route.fulfill({ status: 200, contentType: "text/javascript", body: app });
    if (url.pathname === "/styles.css") return route.fulfill({ status: 200, contentType: "text/css", body: styles });
    if (url.pathname === "/premium-minimal.css") return route.fulfill({ status: 200, contentType: "text/css", body: premium });
    return route.fulfill({ status: 404, body: "missing fixture" });
  });

  await page.goto("http://organizer.test/");
  await page.locator('[data-panel="management"]').click();
  await expect(page.locator("#settingsCapabilityBadge")).toHaveText("Codex 面板只读");
  await expect(page.locator("#addRootButton")).toBeHidden();
  await expect(page.locator("#selectProjectButton")).toBeHidden();
  await expect(page.locator("#saveCurrentViewButton")).toBeHidden();
  await expect(page.locator("#createCustomCategoryButton")).toBeHidden();
  await expect(page.locator('[data-root-id="mcp-root"] button')).toHaveCount(0);
  await expect(page.locator("#categorySettingsList .category-setting-row")).toHaveCount(0);
  await expect(page.locator("#categorySettingsList .category-setting-readonly")).toHaveCount(12);
  await expect(page.getByRole("button", { name: /永久清空|Delete permanently/ })).toHaveCount(0);
  await expect(page.locator("#managementModeToggle")).toBeDisabled();
  await page.locator('[data-panel="inventory"]').click();
  await page.locator("#diagnosticsButton").click();
  await expect(page.locator("#supportBundleButton")).toHaveText("到桌面生成支持包");
  await expect(page.locator("#pluginManagementButton")).toHaveText("到桌面打开插件管理");
  await page.locator("#supportBundleButton").click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __openedExternal: string[] }).__openedExternal)).toEqual(["http://organizer.test/"]);
});

test("a 5,000-skill inventory keeps the DOM bounded while virtual scrolling reaches the final item", async ({ page }) => {
  const publicRoot = path.resolve("dist/public");
  const [html, app, styles, premium] = await Promise.all([
    readFile(path.join(publicRoot, "index.html"), "utf8"),
    readFile(path.join(publicRoot, "app.js"), "utf8"),
    readFile(path.join(publicRoot, "styles.css"), "utf8"),
    readFile(path.join(publicRoot, "premium-minimal.css"), "utf8"),
  ]);
  const skills = Array.from({ length: 5_000 }, (_, index) => record(`skill-${String(index).padStart(4, "0")}`, false, 1));
  const snapshot: InventorySnapshot = {
    revision: "large-revision-1",
    generatedAt: "2026-08-30T00:00:00.000Z",
    skills,
    summary: {
      total: 5_000, runtimeVisible: 5_000, cacheOnly: 0, pending: 0, favorites: 0, duplicateNames: 0,
      byScope: { user: 5_000, agents: 0, system: 0, plugin: 0, repo: 0, custom: 0 },
      byCategory: { development: 5_000, quality: 0, security: 0, delivery: 0, "data-automation": 0, "docs-knowledge": 0, "design-media": 0, "research-analysis": 0, "finance-trading": 0, "content-social": 0, "agent-workflow": 0, pending: 0 },
    },
    scanErrors: [], orphanOverrideIds: [], runtimeAvailable: true, runtimeError: null,
    managementMode: false, protocolVersion: "2.0", configuredRoots: [], selectedProjectPath: null,
    savedViews: [], customCategories: [], categoryPreferences: [],
  };
  await page.route("http://organizer.test/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const json = (value: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(value) });
    if (url.pathname === "/") return route.fulfill({ status: 200, contentType: "text/html", body: html });
    if (url.pathname === "/app.js") return route.fulfill({ status: 200, contentType: "text/javascript", body: app });
    if (url.pathname === "/styles.css") return route.fulfill({ status: 200, contentType: "text/css", body: styles });
    if (url.pathname === "/premium-minimal.css") return route.fulfill({ status: 200, contentType: "text/css", body: premium });
    if (url.pathname === "/api/session") return json({ csrf: "csrf-large-fixture" });
    if (url.pathname === "/api/inventory") return json(snapshot);
    if (url.pathname === "/api/management-mode") return json({ enabled: false });
    if (url.pathname === "/api/classification-suggestions") return json({ items: [] });
    if (url.pathname === "/api/quarantine") return json({ candidates: [], entries: [], plans: [] });
    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "fixture route missing" }) });
  });

  await page.goto("http://organizer.test/");
  await page.locator('[data-panel="inventory"]').click();
  await expect.poll(() => page.locator("#skillTableBody tr.skill-row").count()).toBeGreaterThan(0);
  expect(await page.locator("#skillTableBody tr.skill-row").count()).toBeLessThanOrEqual(24);
  expect(await page.locator("#skillTableBody tr").count()).toBeLessThanOrEqual(50);
  await expect(page.locator("#pageLabel")).toContainText("/ 5000");
  const virtualDimensions = await page.locator("#tableWrap").evaluate((element) => ({ scrollHeight: element.scrollHeight, clientHeight: element.clientHeight }));
  expect(virtualDimensions.scrollHeight).toBeGreaterThan(virtualDimensions.clientHeight * 100);

  await page.locator("#searchInput").fill("skill-4999");
  await expect(page.locator("#skillTableBody tr.skill-row")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "skill-4999", exact: true })).toBeVisible();

  await page.locator("#searchInput").fill("");
  await expect(page.getByRole("button", { name: "skill-0000", exact: true })).toBeVisible();
  const endPosition = await page.locator("#tableWrap").evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event("scroll"));
    return { scrollTop: element.scrollTop, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight };
  });
  expect(endPosition.scrollTop).toBeGreaterThan(endPosition.clientHeight * 100);
  await expect(page.getByRole("button", { name: "skill-4999", exact: true })).toBeVisible();
  await expect(page.locator("#pageLabel")).toContainText("5000 / 5000");
  expect(await page.locator("#skillTableBody tr.skill-row").count()).toBeLessThanOrEqual(24);
  expect(await page.locator("#skillTableBody tr").count()).toBeLessThanOrEqual(50);
});

test("tag rename stops after the second batch fails and reports locked, failed, and unexecuted items", async ({ page }) => {
  const publicRoot = path.resolve("dist/public");
  const [html, app, styles, premium] = await Promise.all([
    readFile(path.join(publicRoot, "index.html"), "utf8"),
    readFile(path.join(publicRoot, "app.js"), "utf8"),
    readFile(path.join(publicRoot, "styles.css"), "utf8"),
    readFile(path.join(publicRoot, "premium-minimal.css"), "utf8"),
  ]);
  const sourceTag = "user:bulk-source";
  const unlocked = Array.from({ length: 201 }, (_, index) => ({
    ...record(`tag-skill-${String(index).padStart(3, "0")}`, false, 1),
    tags: [sourceTag],
  }));
  const locked = { ...record("tag-skill-locked", true, 1), tags: [sourceTag] };
  let skills = [...unlocked, locked];
  let revision = "tag-revision-1";
  const requests: Array<Record<string, unknown>> = [];
  const currentSnapshot = (): InventorySnapshot => ({
    revision,
    generatedAt: "2026-08-30T00:00:00.000Z",
    skills,
    summary: {
      total: skills.length, runtimeVisible: skills.length, cacheOnly: 0, pending: 0, favorites: 0, duplicateNames: 0,
      byScope: { user: skills.length, agents: 0, system: 0, plugin: 0, repo: 0, custom: 0 },
      byCategory: { development: 201, quality: 0, security: 1, delivery: 0, "data-automation": 0, "docs-knowledge": 0, "design-media": 0, "research-analysis": 0, "finance-trading": 0, "content-social": 0, "agent-workflow": 0, pending: 0 },
    },
    scanErrors: [], orphanOverrideIds: [], runtimeAvailable: true, runtimeError: null,
    managementMode: false, protocolVersion: "2.0", configuredRoots: [], selectedProjectPath: null,
    savedViews: [], customCategories: [], categoryPreferences: [],
  });

  await page.route("http://organizer.test/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const json = (value: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
    if (url.pathname === "/") return route.fulfill({ status: 200, contentType: "text/html", body: html });
    if (url.pathname === "/app.js") return route.fulfill({ status: 200, contentType: "text/javascript", body: app });
    if (url.pathname === "/styles.css") return route.fulfill({ status: 200, contentType: "text/css", body: styles });
    if (url.pathname === "/premium-minimal.css") return route.fulfill({ status: 200, contentType: "text/css", body: premium });
    if (url.pathname === "/api/session") return json({ csrf: "csrf-tag-fixture" });
    if (url.pathname === "/api/inventory") return json(currentSnapshot());
    if (url.pathname === "/api/management-mode") return json({ enabled: false });
    if (url.pathname === "/api/classification-suggestions") return json({ items: [] });
    if (url.pathname === "/api/quarantine") return json({ candidates: [], entries: [], plans: [] });
    if (url.pathname === "/api/classification" && request.method() === "PATCH") {
      const body = request.postDataJSON() as Record<string, unknown>;
      requests.push(body);
      if (requests.length === 2) return json({ error: "fixture second batch failure" }, 409);
      const changedIds = new Set(body.skillIds as string[]);
      skills = skills.map((skill) => changedIds.has(skill.skillId)
        ? { ...skill, tags: ["user:bulk-target"] }
        : skill);
      revision = "tag-revision-2";
      return json(currentSnapshot());
    }
    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "fixture route missing" }) });
  });

  await page.goto("http://organizer.test/");
  await page.locator("#languageButton").click();
  await page.locator('[data-panel="management"]').click();
  await page.locator("#tagManagerSource").selectOption(sourceTag);
  await page.locator("#tagManagerTarget").fill("bulk-target");
  await page.locator("#renameTagButton").click();

  await expect.poll(() => requests.length).toBe(2);
  expect(requests[0]).toMatchObject({ expectedRevision: "tag-revision-1", removeTagIds: [sourceTag], addTagIds: ["user:bulk-target"] });
  expect(requests[1]).toMatchObject({ expectedRevision: "tag-revision-2", removeTagIds: [sourceTag], addTagIds: ["user:bulk-target"] });
  expect(requests[0]?.skillIds).toHaveLength(100);
  expect(requests[1]?.skillIds).toHaveLength(100);
  await expect(page.locator("#toast")).toContainText("100 succeeded, 100 in the current batch failed or are unknown, 1 were not executed");
  await expect(page.locator("#toast")).toHaveClass(/error/);
  expect(requests.flatMap((request) => request.skillIds as string[])).not.toContain("tag-skill-locked");
});
