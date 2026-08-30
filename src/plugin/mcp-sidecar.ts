import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { RootsListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { CATEGORIES } from "../core/taxonomy.js";
import { CATEGORY_IDS, type ClassificationPatch, type InventorySnapshot, type SkillRecord } from "../shared/types.js";
import { OrganizerServiceBridge } from "./service-bridge.js";
import { PRODUCT_NAME, PRODUCT_VERSION } from "../shared/version.js";
import { classificationCandidatePage } from "./classification-candidates.js";
import { sanitizeQuarantinePayloadForModel } from "./quarantine-model-boundary.js";
import { listLocalMcpProjectPaths } from "./mcp-project-roots.js";
import { sanitizeBatchOperationResultForModel, skillSummaryForModel } from "./model-visible-boundary.js";

const UI_URI = "ui://codex-skill-organizer/workbench.html";
const UI_CSP = { connectDomains: [], resourceDomains: [] };
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const widgetPath = path.join(moduleDirectory, "widget.html");
const bridge = new OrganizerServiceBridge();
const server = new McpServer({ name: "codex-skill-organizer", version: PRODUCT_VERSION });
const categoryIdSchema = z.union([
  z.enum(CATEGORY_IDS),
  z.string().regex(/^custom:[\p{L}\p{N}][\p{L}\p{N}._-]{0,63}$/u),
]);

bridge.setSessionProjectRootsProvider(() => listLocalMcpProjectPaths({
  getClientCapabilities: () => server.server.getClientCapabilities(),
  listRoots: (_params, options) => server.server.listRoots(undefined, options),
}));

async function refreshSessionProjectRoots(): Promise<void> {
  try {
    await bridge.sessionProjectRootsChanged();
  } catch {
    // Keep unresolved or decoded roots pending. The next tool request or roots
    // notification retries whichever discovery/registration stage failed.
    console.warn("Skill Organizer 暂时无法注册 Codex 会话项目根；将在后续请求重试");
  }
}

server.server.oninitialized = refreshSessionProjectRoots;
server.server.setNotificationHandler(
  RootsListChangedNotificationSchema,
  refreshSessionProjectRoots,
);

function toolText(text: string): Array<{ type: "text"; text: string }> {
  return [{ type: "text", text }];
}

function filterSkills(snapshot: InventorySnapshot, input: {
  query?: string;
  categoryId?: string | null;
  scope?: string;
  runtime?: string;
  duplicateOnly?: boolean;
}): SkillRecord[] {
  const query = input.query?.normalize("NFC").trim().toLocaleLowerCase("zh-CN") ?? "";
  return snapshot.skills.filter((skill) => {
    if (input.categoryId === "pending" && skill.categoryId !== null) return false;
    if (input.categoryId && input.categoryId !== "pending" && skill.categoryId !== input.categoryId) return false;
    if (input.scope && input.scope !== "all" && skill.scope !== input.scope) return false;
    if (input.runtime === "enabled" && skill.runtimeEnabled !== true) return false;
    if (input.runtime === "disabled" && skill.runtimeEnabled !== false) return false;
    if (input.runtime === "cache" && skill.runtimeDiscovered) return false;
    if (input.duplicateOnly && !skill.diagnostics.some((item) => item.code === "DUPLICATE_NAME")) return false;
    if (!query) return true;
    return [skill.name, skill.description, skill.sourceLabel, skill.packageId, skill.relativePath, ...skill.tags]
      .join(" ").normalize("NFC").toLocaleLowerCase("zh-CN").includes(query);
  });
}

function sensitiveRuntimeTargets(snapshot: InventorySnapshot, requestedIds: string[]): string[] {
  const targets = new Map<string, { skill: SkillRecord; runtimeScope: string | null }>();
  for (const skill of snapshot.skills) {
    const runtimeInstances = (skill.instances ?? []).filter((instance) => instance.runtimeDiscovered);
    for (const instance of runtimeInstances) {
      targets.set(instance.instanceId, { skill, runtimeScope: instance.runtimeScope });
    }
    if (runtimeInstances.length === 1) {
      targets.set(skill.skillId, { skill, runtimeScope: runtimeInstances[0]!.runtimeScope });
    }
  }
  return [...new Set(requestedIds)].filter((targetId) => {
    const target = targets.get(targetId);
    return target !== undefined && (
      target.skill.scope === "system"
      || target.skill.scope === "plugin"
      || target.runtimeScope === "system"
      || target.runtimeScope === "admin"
    );
  });
}

registerAppResource(
  server,
  `${PRODUCT_NAME} Workbench`,
  UI_URI,
  {
    description: "Local-first virtual skill classification workbench",
    _meta: { ui: { csp: UI_CSP } },
  },
  async () => ({
    contents: [{
      uri: UI_URI,
      mimeType: RESOURCE_MIME_TYPE,
      text: await readFile(widgetPath, "utf8"),
      _meta: { ui: { csp: UI_CSP } },
    }],
  }),
);

registerAppTool(
  server,
  "open_skill_organizer",
  {
    title: "打开 Skill Organizer",
    description: "宿主支持 MCP Apps UI 时打开会话内工作台；否则请使用 list_skills 分页文本结果，并按需打开桌面工作台；不修改原生 Skills 页面。",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { ui: { resourceUri: UI_URI, visibility: ["model"] } },
  },
  async () => {
    const snapshot = await bridge.getInventory();
    return {
      content: toolText(
        `Skill Organizer 已就绪：${snapshot.summary.total} 个物理项，${snapshot.summary.runtimeVisible} 个 Codex 运行时可见项，${snapshot.summary.pending} 个待整理项。若宿主不支持会话内面板，请双击桌面的 Codex Skill Organizer 快捷方式。`,
      ),
      structuredContent: {
        summary: snapshot.summary,
        revision: snapshot.revision,
        runtimeAvailable: snapshot.runtimeAvailable,
        categories: CATEGORIES,
      },
      _meta: {
        snapshot,
        desktopUrl: await bridge.desktopUrl(),
        capabilitySummary: "分类、标签、收藏、更新证据、隔离计划、精确实例启停和诊断；管理模式只能在桌面工作台开启，原生 Skills 页面保持不变。",
      },
    };
  },
);

server.registerTool(
  "list_skills",
  {
    title: "列出 Skills",
    description: "分页列出 Skill 的必要摘要；支持分类、来源、运行状态、同名冲突和全文筛选。",
    inputSchema: {
      query: z.string().max(200).optional(),
      categoryId: z.union([categoryIdSchema, z.literal("pending")]).optional(),
      scope: z.enum(["all", "user", "agents", "system", "plugin", "repo", "custom"]).optional(),
      runtime: z.enum(["all", "enabled", "disabled", "cache"]).optional(),
      duplicateOnly: z.boolean().optional(),
      page: z.number().int().min(1).default(1),
      pageSize: z.number().int().min(1).max(100).default(25),
      refresh: z.boolean().optional(),
      uiRequest: z.boolean().optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async (input) => {
    const snapshot = await bridge.getInventory(input.refresh === true);
    const filtered = filterSkills(snapshot, input);
    const start = (input.page - 1) * input.pageSize;
    const items = filtered.slice(start, start + input.pageSize).map(skillSummaryForModel);
    return {
      content: toolText(`找到 ${filtered.length} 项；返回第 ${input.page} 页的 ${items.length} 项。清单 revision：${snapshot.revision}。`),
      structuredContent: {
        revision: snapshot.revision,
        total: filtered.length,
        page: input.page,
        pageSize: input.pageSize,
        items,
      },
      _meta: input.uiRequest ? { snapshot } : undefined,
    };
  },
);

server.registerTool(
  "apply_classification",
  {
    title: "应用 Skill 分类",
    description: "按 opaque skill ID 写入分类、标签、收藏和人工锁定；从不按名称寻址。",
    inputSchema: {
      skillIds: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1).max(100),
      expectedRevision: z.string().min(1),
      primaryCategoryId: categoryIdSchema.nullable().optional(),
      addTagIds: z.array(z.string()).max(100).optional(),
      removeTagIds: z.array(z.string()).max(100).optional(),
      favorite: z.boolean().optional(),
      locked: z.boolean().optional(),
      restoreAutomatic: z.boolean().optional(),
      reason: z.string().max(500).optional(),
      confidence: z.number().min(0).max(1).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async (input) => {
    const snapshot = await bridge.applyClassification(input as unknown as ClassificationPatch);
    return {
      content: toolText(`已保存 ${input.skillIds.length} 个精确 Skill ID；新 revision：${snapshot.revision}。`),
      structuredContent: { revision: snapshot.revision, changedSkillIds: input.skillIds, summary: snapshot.summary },
      _meta: { snapshot },
    };
  },
);

server.registerTool(
  "list_classification_candidates",
  {
    title: "读取智能分类候选",
    description: "只返回模型分类所需的名称、description、来源和已有 category；不会暴露标签、路径、运行状态或 Skill 正文。",
    inputSchema: {
      skillIds: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1).max(100).optional(),
      pendingOnly: z.boolean().default(true),
      page: z.number().int().min(1).default(1),
      pageSize: z.number().int().min(1).max(100).default(25),
      refresh: z.boolean().optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async (input) => {
    const snapshot = await bridge.getInventory(input.refresh === true);
    const result = classificationCandidatePage(snapshot, input);
    const allowedCategoryIds = [
      ...CATEGORY_IDS,
      ...(snapshot.customCategories ?? []).map((category) => category.categoryId),
    ];
    return {
      content: toolText(`返回 ${result.items.length} 个最小化分类候选；共 ${result.total} 项。已排除 ${result.excludedLockedCount} 个锁定项，锁定项未发送给模型。只可选择 allowedCategoryIds 中的分类。`),
      structuredContent: { ...result, allowedCategoryIds },
    };
  },
);

server.registerTool(
  "set_skill_enabled",
  {
    title: "设置 Skill 启用状态",
    description: "通过 Codex app-server 按最新清单中的精确实例启停并回读验证。普通实例可在管理模式开启后处理；系统或插件等敏感实例必须打开桌面工作台确认。",
    inputSchema: {
      skillIds: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1).max(100),
      enabled: z.boolean(),
      expectedRevision: z.string().min(1),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  async (input) => {
    const before = await bridge.getInventory();
    if (before.revision !== input.expectedRevision) throw new Error("清单已变化，请刷新后重试");
    const sensitiveIds = sensitiveRuntimeTargets(before, input.skillIds);
    if (sensitiveIds.length > 0) {
      return {
        content: toolText("所选系统或插件等敏感实例必须打开桌面工作台，由用户对精确目标进行确认；本次 MCP 调用未改变运行状态。"),
        structuredContent: {
          requiresDesktopConfirmation: true,
          requestedSkillIds: input.skillIds,
          sensitiveSkillIds: sensitiveIds,
          revision: before.revision,
        },
        _meta: { snapshot: before, desktopUrl: await bridge.desktopUrl() },
      };
    }
    const result = await bridge.setEnabled(input.skillIds, input.enabled, input.expectedRevision);
    const snapshot = await bridge.getInventory();
    const modelVisibleResult = sanitizeBatchOperationResultForModel(result, {
      errorCode: "RUNTIME_WRITE_FAILED",
      message: "Codex runtime 写入失败；详细原因仅在桌面工作台中可见。",
    });
    return {
      content: toolText(`成功 ${result.succeeded.length} 项，失败 ${result.failed.length} 项，未执行 ${result.notExecuted.length} 项；已回读 Codex 运行状态。`),
      structuredContent: modelVisibleResult,
      _meta: { snapshot },
    };
  },
);

server.registerTool(
  "diagnose_skill_organizer",
  {
    title: "诊断 Skill Organizer",
    description: "报告扫描根、版本、解析错误、未关联覆盖项、运行时能力和 app-server 警告。",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async () => {
    const diagnostics = await bridge.diagnostics();
    return {
      content: toolText(
        `Organizer ${diagnostics.version}：${diagnostics.counts.total} 项，扫描错误 ${diagnostics.scanErrors.length}，失联覆盖 ${diagnostics.orphanOverrideIds.length}，运行时${diagnostics.runtimeAvailable ? "可用" : "不可用"}。`,
      ),
      structuredContent: { ...diagnostics },
    };
  },
);

server.registerTool(
  "submit_classification_suggestions",
  {
    title: "暂存 Skill 分类建议",
    description: "只把模型建议写入待确认区；不会直接改变最终分类。必须先使用 list_classification_candidates 获取最小化候选。",
    inputSchema: {
      expectedRevision: z.string().min(1),
      suggestions: z.array(z.object({
        skillId: z.string().regex(/^[a-f0-9]{64}$/),
        categoryId: categoryIdSchema.nullable(),
        tags: z.array(z.string()).max(20).optional(),
        confidence: z.number().min(0).max(1),
        reason: z.string().min(1).max(500),
      })).min(1).max(100),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async (input) => {
    const result = await bridge.submitSuggestions(input);
    return {
      content: toolText("分类建议已进入工作台暂存区，尚未改变任何最终分类。"),
      structuredContent: result,
    };
  },
);

server.registerTool(
  "check_skill_updates",
  {
    title: "检查 Skill 更新证据",
    description: "仅在用户明确要求时检查公开 GitHub 或 Codex 插件来源；只返回 tag/release/commit/install-hash 证据，不下载 Skill 正文。",
    inputSchema: {
      instanceIds: z.array(z.string().min(1).max(128)).min(1).max(100),
      expectedRevision: z.string().min(1),
      forceRefresh: z.literal(true).default(true),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async (input) => {
    const result = await bridge.checkUpdates(input);
    return { content: toolText("更新证据检查完成；未下载 Skill 正文，也未执行更新。"), structuredContent: result };
  },
);

server.registerTool(
  "prepare_skill_quarantine",
  {
    title: "准备 Skill 隔离计划",
    description: "生成安装单元影响计划；不会移动文件。实际隔离必须在桌面工作台中确认。",
    inputSchema: {
      installationUnitIds: z.array(z.string().min(1).max(128)).max(100).default([]),
      expectedRevision: z.string().min(1),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async (input) => {
    if (input.installationUnitIds.length === 0) {
      const inventory = await bridge.quarantineInventory();
      return {
        content: toolText("已返回未确认安装单元候选和现有隔离记录；实际确认或移动仍必须在桌面工作台完成。"),
        structuredContent: sanitizeQuarantinePayloadForModel(inventory),
      };
    }
    const result = await bridge.prepareQuarantine(input);
    return {
      content: toolText("已生成隔离影响计划；请在桌面工作台检查边界并确认。"),
      structuredContent: sanitizeQuarantinePayloadForModel(result),
    };
  },
);

server.registerTool(
  "restore_quarantined_skill",
  {
    title: "恢复已隔离 Skill",
    description: "返回桌面恢复确认入口；MCP 不执行文件移动。实际恢复必须由用户在桌面工作台确认，路径冲突时停止且绝不覆盖。",
    inputSchema: {
      quarantineEntryIds: z.array(z.string().min(1).max(128)).min(1).max(100),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async (input) => {
    return {
      content: toolText("隔离恢复必须打开桌面工作台，由用户确认精确隔离记录；本次 MCP 调用未移动任何文件。"),
      structuredContent: {
        requiresDesktopConfirmation: true,
        quarantineEntryIds: input.quarantineEntryIds,
      },
      _meta: { desktopUrl: await bridge.desktopUrl() },
    };
  },
);

const transport = new StdioServerTransport();
let sessionCleanupStarted = false;
function clearSessionProjectsOnExit(): void {
  if (sessionCleanupStarted) return;
  sessionCleanupStarted = true;
  void bridge.clearSessionProjects();
}
transport.onclose = clearSessionProjectsOnExit;
process.stdin.once("end", clearSessionProjectsOnExit);
process.once("beforeExit", clearSessionProjectsOnExit);
await server.connect(transport);
