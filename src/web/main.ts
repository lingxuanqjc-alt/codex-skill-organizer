import { CATEGORIES } from "../core/taxonomy.js";
import type {
  BatchOperationResult,
  CategoryId,
  ClassificationPatch,
  InventorySnapshot,
  SkillInstanceView,
  SkillRecord,
  SkillScope,
} from "../shared/types.js";
import {
  FACET_ALL,
  FACET_NO_PLUGIN,
  FACET_UNKNOWN,
  MAX_BATCH_SIZE,
  canConfirmInstallationUnit,
  canExecuteQuarantinePlan,
  canPrepareInstallationUnit,
  chunkAtMost100,
  instanceIdsForSkills,
  safeEvidenceUrl,
  safePluginManagementUrl,
  selectedUnlockedSkillIds,
  selectableSkillIds,
  pluginFacetValue,
  sourceFacetValue,
  supportBundleSummary,
  virtualWindow,
} from "./model.js";
import type { SupportBundleSummary } from "./model.js";

declare global {
  interface Window {
    openai?: {
      toolResponseMetadata?: Record<string, unknown>;
      callTool?: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
      sendFollowUpMessage?: (options: { prompt: string; scrollToBottom?: boolean }) => Promise<void>;
      openExternal?: (options: { href: string; redirectUrl?: string }) => Promise<void>;
    };
  }
}

interface ToolResult {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
  isError?: boolean;
}

class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

interface Diagnostics {
  version: string;
  protocolVersion?: string;
  roots: Array<{ id: string; label: string; path?: string }>;
  cwd?: string;
  runtimeAvailable: boolean;
  runtimeError: string | null;
  scanErrors: Array<{ path?: string; message: string }>;
  orphanOverrideIds: string[];
  counts: InventorySnapshot["summary"];
  appServerStderr?: string[];
}

interface ClassificationSuggestionView {
  suggestionId: string;
  logicalSkillId: string;
  categoryId: CategoryId | null;
  tags: string[];
  confidence: number;
  reason: string;
  status: "pending" | "accepted" | "rejected";
  createdAt?: string;
}

interface UpdateEvidenceView {
  evidenceId?: string;
  instanceId?: string;
  logicalSkillId?: string;
  status?: "up-to-date" | "update-available" | "modified" | "unavailable" | "offline";
  sourceKind?: "github" | "codex-plugin";
  evidenceKind?: string;
  installedReference?: string;
  installedEvidence?: string;
  availableReference?: string;
  availableEvidence?: string;
  comparisonUrl?: string | null;
  compareUrl?: string | null;
  locallyModified?: boolean;
  summary?: string;
  checkedAt?: string;
}

interface QuarantineCandidateView {
  installationUnitId: string;
  label?: string;
  kind?: string;
  pathHint?: string;
  confirmed?: boolean;
  managementAuthorized?: boolean;
  allowed?: boolean;
  skillCount?: number;
  blockedReasons?: string[];
  treeSummary?: string[];
  affectedSkillIds?: string[];
  affectedInstanceIds?: string[];
  blockers?: Array<{ code?: string; message?: string }>;
}

interface QuarantinePlanItemView {
  installationUnitId: string;
  quarantineEntryId?: string;
  sourcePath: string;
  quarantinePath?: string;
  affectedSkillIds: string[];
  affectedInstanceIds?: string[];
  tree?: Array<{ relativePath: string; type: string; sizeBytes: number }>;
  totalEntries?: number;
  sizeBytes?: number;
  blockers: Array<{ code?: string; message?: string }>;
}

interface QuarantinePlanView {
  planId?: string;
  installationUnitId?: string;
  label?: string;
  allowed?: boolean;
  affectedSkillCount?: number;
  affectedSkills?: string[];
  blockedReasons?: string[];
  treeSummary?: string[];
  requiresDesktopConfirmation?: boolean;
  summary?: string;
  inventoryRevision?: string;
  executable?: boolean;
  items?: QuarantinePlanItemView[];
}

interface QuarantineEntryView {
  quarantineEntryId: string;
  installationUnitId: string;
  label?: string;
  originalPathHint?: string;
  status: "quarantined" | "restored" | "purged";
  quarantinedAt?: string;
  restoredAt?: string | null;
  restoredPath?: string | null;
}

interface QuarantineRestoreResult {
  succeeded: string[];
  failed: Array<{ quarantineEntryId: string; message: string }>;
  notExecuted: string[];
  restoredTo?: Record<string, string>;
}

interface QuarantinePayload {
  candidates: QuarantineCandidateView[];
  entries: QuarantineEntryView[];
  plans: QuarantinePlanView[];
  unavailable?: boolean;
}

interface UndoActionView {
  operationId: string;
  kind: "classification" | "runtime-enabled";
  targetIds: string[];
  occurredAt: string;
  available: boolean;
  unavailableReason: string | null;
  sensitive?: boolean;
}

type ConfiguredRootView = NonNullable<InventorySnapshot["configuredRoots"]>[number];
type SavedViewRecord = NonNullable<InventorySnapshot["savedViews"]>[number];
type CustomCategoryView = NonNullable<InventorySnapshot["customCategories"]>[number];
type CategoryPreferenceView = NonNullable<InventorySnapshot["categoryPreferences"]>[number];

interface CategoryDefinitionView {
  id: CategoryId;
  baseLabel: { zhCN: string; enUS: string };
  display: { zhCN?: string; enUS?: string };
  sortOrder: number;
  hidden: boolean;
  custom: boolean;
}

interface OrganizerTransport {
  readonly mode: "http" | "mcp";
  initialize(): Promise<InventorySnapshot>;
  getInventory(): Promise<InventorySnapshot>;
  rescan(): Promise<InventorySnapshot>;
  applyClassification(patch: ClassificationPatch): Promise<InventorySnapshot>;
  setEnabled(skillIds: string[], enabled: boolean, expectedRevision: string, confirmedSensitive: boolean): Promise<BatchOperationResult>;
  diagnostics(): Promise<Diagnostics>;
  createSupportBundle(): Promise<SupportBundleSummary>;
  openPluginManagement(): Promise<void>;
  getManagementMode(): Promise<boolean>;
  setManagementMode(enabled: boolean): Promise<boolean>;
  listSuggestions(): Promise<ClassificationSuggestionView[]>;
  resolveSuggestions(suggestionIds: string[], status: "accepted" | "rejected", expectedRevision: string): Promise<unknown>;
  checkUpdates(instanceIds: string[], expectedRevision: string): Promise<UpdateEvidenceView[]>;
  getQuarantine(): Promise<QuarantinePayload>;
  confirmInstallationUnits(installationUnitIds: string[], expectedRevision: string): Promise<unknown>;
  prepareQuarantine(installationUnitIds: string[], expectedRevision: string): Promise<QuarantinePlanView[]>;
  executeQuarantine(planId: string, expectedRevision: string): Promise<unknown>;
  restoreQuarantine(quarantineEntryIds: string[], restoreTargets?: Record<string, string>): Promise<QuarantineRestoreResult>;
  purgeQuarantine(quarantineEntryId: string): Promise<unknown>;
  addRoot(absolutePath: string, label: string, expectedRevision: string): Promise<InventorySnapshot>;
  setRootManagement(rootId: string, managementAuthorized: boolean, expectedRevision: string): Promise<InventorySnapshot>;
  removeRoot(rootId: string, expectedRevision: string): Promise<InventorySnapshot>;
  selectProject(projectPath: string | null, expectedRevision: string): Promise<InventorySnapshot>;
  saveView(viewId: string, name: string, filters: Record<string, string | boolean | string[] | null>, expectedRevision: string): Promise<InventorySnapshot>;
  deleteView(viewId: string, expectedRevision: string): Promise<InventorySnapshot>;
  createCategory(categoryId: `custom:${string}`, label: { zhCN: string; enUS: string }, sortOrder: number, expectedRevision: string): Promise<InventorySnapshot>;
  deleteCategory(sourceCategoryId: `custom:${string}`, targetCategoryId: CategoryId, expectedRevision: string): Promise<unknown>;
  setCategoryPreference(categoryId: CategoryId, display: { zhCN?: string; enUS?: string }, sortOrder: number | null, hidden: boolean, expectedRevision: string): Promise<InventorySnapshot>;
  listUndoActions(): Promise<UndoActionView[]>;
  undoOperations(operationIds: string[], expectedRevision: string, confirmedSensitive: boolean): Promise<unknown>;
  openDesktop(): Promise<void>;
  openExternal(href: string): Promise<void>;
}

function normalizeArray<T>(value: unknown, keys: string[]): T[] {
  if (Array.isArray(value)) return value as T[];
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  for (const key of keys) if (Array.isArray(record[key])) return record[key] as T[];
  return [];
}

class HttpTransport implements OrganizerTransport {
  readonly mode = "http" as const;
  #csrf = "";

  async initialize(): Promise<InventorySnapshot> {
    const fragment = new URLSearchParams(location.hash.replace(/^#/, ""));
    const bootstrap = fragment.get("bootstrap");
    const response = await fetch("/api/session", bootstrap ? {
      method: "POST",
      headers: { Authorization: `Bearer ${bootstrap}` },
      credentials: "same-origin",
    } : { credentials: "same-origin" });
    const payload = await this.#readJson<{ csrf?: string; error?: string }>(response);
    if (!response.ok || !payload.csrf) throw new ApiError(response.status, payload.error ?? "Session unavailable");
    this.#csrf = payload.csrf;
    if (bootstrap) history.replaceState(null, "", `${location.pathname}${location.search}`);
    return this.getInventory();
  }

  getInventory(): Promise<InventorySnapshot> { return this.#request("/api/inventory"); }
  rescan(): Promise<InventorySnapshot> { return this.#request("/api/rescan", { method: "POST" }); }
  applyClassification(patch: ClassificationPatch): Promise<InventorySnapshot> {
    return this.#request("/api/classification", { method: "PATCH", body: JSON.stringify(patch) });
  }
  setEnabled(skillIds: string[], enabled: boolean, expectedRevision: string, confirmedSensitive: boolean): Promise<BatchOperationResult> {
    return this.#request("/api/runtime-enabled", {
      method: "POST",
      body: JSON.stringify({ skillIds, enabled, expectedRevision, confirmedSensitive }),
    });
  }
  diagnostics(): Promise<Diagnostics> { return this.#request("/api/diagnostics"); }
  async createSupportBundle(): Promise<SupportBundleSummary> {
    const summary = supportBundleSummary(await this.#request<unknown>("/api/support-bundle", {
      method: "POST",
      body: JSON.stringify({ confirmed: true, includeSensitiveDiagnostics: true }),
    }));
    if (!summary) throw new ApiError(502, "The service returned an invalid support bundle receipt");
    return summary;
  }
  async openPluginManagement(): Promise<void> {
    const result = await this.#request<{ href?: unknown }>("/api/plugin-management-link");
    const href = safePluginManagementUrl(result.href);
    if (!href) throw new ApiError(502, "The service returned an invalid Codex plugin management link");
    window.open(href, "_blank", "noopener,noreferrer");
  }
  async getManagementMode(): Promise<boolean> {
    const result = await this.#request<{ enabled?: boolean; managementMode?: boolean }>("/api/management-mode");
    return result.enabled ?? result.managementMode ?? false;
  }
  async setManagementMode(enabled: boolean): Promise<boolean> {
    const result = await this.#request<{ enabled?: boolean; managementMode?: boolean }>("/api/management-mode", {
      method: "PUT",
      body: JSON.stringify({ enabled }),
    });
    return result.enabled ?? result.managementMode ?? enabled;
  }
  async listSuggestions(): Promise<ClassificationSuggestionView[]> {
    return normalizeArray(await this.#request<unknown>("/api/classification-suggestions"), ["items", "suggestions"]);
  }
  resolveSuggestions(suggestionIds: string[], status: "accepted" | "rejected", expectedRevision: string): Promise<unknown> {
    return this.#request("/api/classification-suggestions/resolve", {
      method: "POST",
      body: JSON.stringify({ suggestionIds, status, expectedRevision }),
    });
  }
  async checkUpdates(instanceIds: string[], expectedRevision: string): Promise<UpdateEvidenceView[]> {
    const result = await this.#request<unknown>("/api/update-check", {
      method: "POST",
      body: JSON.stringify({ instanceIds, expectedRevision, forceRefresh: true }),
    });
    return normalizeArray(result, ["items", "results", "evidence"]);
  }
  async getQuarantine(): Promise<QuarantinePayload> {
    const value = await this.#request<unknown>("/api/quarantine");
    if (Array.isArray(value)) return { candidates: [], entries: value as QuarantineEntryView[], plans: [] };
    const record = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
    return {
      candidates: normalizeArray(record.candidates, []),
      entries: normalizeArray(record.entries, []),
      plans: normalizeArray(record.plans, []),
    };
  }
  async prepareQuarantine(installationUnitIds: string[], expectedRevision: string): Promise<QuarantinePlanView[]> {
    const result = await this.#request<unknown>("/api/quarantine/prepare", {
      method: "POST",
      body: JSON.stringify({ installationUnitIds, expectedRevision }),
    });
    return normalizeArray(result, ["items", "plans"]);
  }
  confirmInstallationUnits(installationUnitIds: string[], expectedRevision: string): Promise<unknown> {
    return this.#request("/api/installation-units/confirm", {
      method: "POST",
      body: JSON.stringify({ installationUnitIds, expectedRevision }),
    });
  }
  executeQuarantine(planId: string, expectedRevision: string): Promise<unknown> {
    return this.#request("/api/quarantine/execute", {
      method: "POST",
      body: JSON.stringify({ planId, confirmed: true, expectedRevision }),
    });
  }
  restoreQuarantine(quarantineEntryIds: string[], restoreTargets?: Record<string, string>): Promise<QuarantineRestoreResult> {
    return this.#request("/api/quarantine/restore", {
      method: "POST",
      body: JSON.stringify({ quarantineEntryIds, restoreTargets, confirmed: true }),
    });
  }
  purgeQuarantine(quarantineEntryId: string): Promise<unknown> {
    return this.#request("/api/quarantine/purge", {
      method: "POST",
      body: JSON.stringify({ quarantineEntryId, confirmed: true }),
    });
  }
  addRoot(absolutePath: string, label: string, expectedRevision: string): Promise<InventorySnapshot> {
    return this.#request("/api/roots", { method: "POST", body: JSON.stringify({ absolutePath, label, expectedRevision }) });
  }
  setRootManagement(rootId: string, managementAuthorized: boolean, expectedRevision: string): Promise<InventorySnapshot> {
    return this.#request("/api/roots/management", { method: "PATCH", body: JSON.stringify({ rootId, managementAuthorized, expectedRevision }) });
  }
  removeRoot(rootId: string, expectedRevision: string): Promise<InventorySnapshot> {
    return this.#request("/api/roots", { method: "DELETE", body: JSON.stringify({ rootId, expectedRevision }) });
  }
  selectProject(projectPath: string | null, expectedRevision: string): Promise<InventorySnapshot> {
    return this.#request("/api/project", { method: "PUT", body: JSON.stringify({ projectPath, expectedRevision }) });
  }
  saveView(viewId: string, name: string, filters: Record<string, string | boolean | string[] | null>, expectedRevision: string): Promise<InventorySnapshot> {
    return this.#request("/api/saved-views", { method: "PUT", body: JSON.stringify({ viewId, name, filters, expectedRevision }) });
  }
  deleteView(viewId: string, expectedRevision: string): Promise<InventorySnapshot> {
    return this.#request("/api/saved-views", { method: "DELETE", body: JSON.stringify({ viewId, expectedRevision }) });
  }
  createCategory(categoryId: `custom:${string}`, label: { zhCN: string; enUS: string }, sortOrder: number, expectedRevision: string): Promise<InventorySnapshot> {
    return this.#request("/api/categories", { method: "POST", body: JSON.stringify({ categoryId, label, sortOrder, hidden: false, expectedRevision }) });
  }
  deleteCategory(sourceCategoryId: `custom:${string}`, targetCategoryId: CategoryId, expectedRevision: string): Promise<unknown> {
    return this.#request("/api/categories", { method: "DELETE", body: JSON.stringify({ sourceCategoryId, targetCategoryId, expectedRevision }) });
  }
  setCategoryPreference(categoryId: CategoryId, display: { zhCN?: string; enUS?: string }, sortOrder: number | null, hidden: boolean, expectedRevision: string): Promise<InventorySnapshot> {
    return this.#request("/api/category-preferences", { method: "PUT", body: JSON.stringify({ categoryId, display, sortOrder, hidden, expectedRevision }) });
  }
  async listUndoActions(): Promise<UndoActionView[]> {
    return normalizeArray(await this.#request<unknown>("/api/undo-actions"), ["actions"]);
  }
  undoOperations(operationIds: string[], expectedRevision: string, confirmedSensitive: boolean): Promise<unknown> {
    return this.#request("/api/undo-actions/execute", {
      method: "POST",
      body: JSON.stringify({ operationIds, expectedRevision, confirmedSensitive }),
    });
  }
  async openDesktop(): Promise<void> { window.open(location.href, "_blank", "noopener"); }
  async openExternal(href: string): Promise<void> { window.open(href, "_blank", "noopener,noreferrer"); }

  async #request<T>(url: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    if (init.body) headers.set("Content-Type", "application/json");
    if (init.method && !["GET", "HEAD"].includes(init.method)) headers.set("X-CSO-CSRF", this.#csrf);
    const response = await fetch(url, { ...init, headers, credentials: "same-origin" });
    const payload = await this.#readJson<T & { error?: string }>(response);
    if (!response.ok) throw new ApiError(response.status, payload.error ?? `Request failed (${response.status})`);
    return payload;
  }

  async #readJson<T>(response: Response): Promise<T> {
    try { return await response.json() as T; }
    catch { throw new ApiError(response.status, "The service returned invalid JSON"); }
  }
}

class McpTransport implements OrganizerTransport {
  readonly mode = "mcp" as const;
  #desktopUrl = "";
  #lastSnapshot: InventorySnapshot | null = null;

  async initialize(): Promise<InventorySnapshot> {
    const metadata = window.openai?.toolResponseMetadata;
    if (typeof metadata?.desktopUrl === "string") this.#desktopUrl = metadata.desktopUrl;
    const initial = this.#snapshotFrom({ _meta: metadata }, false);
    if (initial) { this.#lastSnapshot = initial; return initial; }
    return this.getInventory();
  }
  async getInventory(): Promise<InventorySnapshot> {
    const result = await this.#call("list_skills", { page: 1, pageSize: 100, uiRequest: true });
    return this.#captureSnapshot(result);
  }
  async rescan(): Promise<InventorySnapshot> {
    const result = await this.#call("list_skills", { page: 1, pageSize: 100, uiRequest: true, refresh: true });
    return this.#captureSnapshot(result);
  }
  async applyClassification(patch: ClassificationPatch): Promise<InventorySnapshot> {
    return this.#captureSnapshot(await this.#call("apply_classification", patch as unknown as Record<string, unknown>));
  }
  async setEnabled(skillIds: string[], enabled: boolean, expectedRevision: string, _confirmedSensitive: boolean): Promise<BatchOperationResult> {
    const result = await this.#call("set_skill_enabled", { skillIds, enabled, expectedRevision });
    const next = this.#snapshotFrom(result, false);
    if (next) this.#lastSnapshot = next;
    const structured = result.structuredContent as { requiresDesktopConfirmation?: boolean } | undefined;
    if (structured?.requiresDesktopConfirmation) {
      if (typeof result._meta?.desktopUrl === "string") this.#desktopUrl = result._meta.desktopUrl;
      await this.openDesktop();
      throw new ApiError(403, "Sensitive runtime changes require confirmation in the desktop workbench");
    }
    return result.structuredContent as unknown as BatchOperationResult;
  }
  async diagnostics(): Promise<Diagnostics> {
    return (await this.#call("diagnose_skill_organizer", {})).structuredContent as unknown as Diagnostics;
  }
  createSupportBundle(): Promise<SupportBundleSummary> { return this.#desktopSettingsUnavailable(); }
  openPluginManagement(): Promise<void> { return this.#desktopSettingsUnavailable(); }
  async getManagementMode(): Promise<boolean> { return this.#lastSnapshot?.managementMode ?? false; }
  setManagementMode(): Promise<boolean> {
    return Promise.reject(new ApiError(501, "Management mode can only be changed in the desktop workbench"));
  }
  async listSuggestions(): Promise<ClassificationSuggestionView[]> { return []; }
  resolveSuggestions(): Promise<unknown> {
    return Promise.reject(new ApiError(501, "Review staged suggestions in the desktop workbench"));
  }
  async checkUpdates(instanceIds: string[], expectedRevision: string): Promise<UpdateEvidenceView[]> {
    const result = await this.#call("check_skill_updates", { instanceIds, expectedRevision, forceRefresh: true });
    return normalizeArray(result.structuredContent, ["items", "results", "evidence"]);
  }
  async getQuarantine(): Promise<QuarantinePayload> {
    if (!this.#lastSnapshot) return { candidates: [], entries: [], plans: [], unavailable: true };
    const result = await this.#call("prepare_skill_quarantine", {
      installationUnitIds: [],
      expectedRevision: this.#lastSnapshot.revision,
    });
    const record = (result.structuredContent && typeof result.structuredContent === "object"
      ? result.structuredContent
      : {}) as Record<string, unknown>;
    return {
      candidates: normalizeArray(record.candidates, []),
      entries: normalizeArray(record.entries, []),
      plans: normalizeArray(record.plans, []),
    };
  }
  confirmInstallationUnits(): Promise<unknown> {
    return Promise.reject(new ApiError(501, "Installation boundaries can only be confirmed in the desktop workbench"));
  }
  async prepareQuarantine(installationUnitIds: string[], expectedRevision: string): Promise<QuarantinePlanView[]> {
    const result = await this.#call("prepare_skill_quarantine", { installationUnitIds, expectedRevision });
    return normalizeArray(result.structuredContent, ["items", "plans"]);
  }
  executeQuarantine(): Promise<unknown> {
    return Promise.reject(new ApiError(501, "Actual quarantine can only be confirmed in the desktop workbench"));
  }
  async restoreQuarantine(quarantineEntryIds: string[]): Promise<QuarantineRestoreResult> {
    const result = await this.#call("restore_quarantined_skill", { quarantineEntryIds });
    if (typeof result._meta?.desktopUrl === "string") this.#desktopUrl = result._meta.desktopUrl;
    await this.openDesktop();
    throw new ApiError(403, "Quarantine restore requires confirmation in the desktop workbench");
  }
  purgeQuarantine(): Promise<unknown> {
    return Promise.reject(new ApiError(501, "Permanent quarantine deletion is only available in the desktop workbench"));
  }
  addRoot(): Promise<InventorySnapshot> { return this.#desktopSettingsUnavailable(); }
  setRootManagement(): Promise<InventorySnapshot> { return this.#desktopSettingsUnavailable(); }
  removeRoot(): Promise<InventorySnapshot> { return this.#desktopSettingsUnavailable(); }
  selectProject(): Promise<InventorySnapshot> { return this.#desktopSettingsUnavailable(); }
  saveView(): Promise<InventorySnapshot> { return this.#desktopSettingsUnavailable(); }
  deleteView(): Promise<InventorySnapshot> { return this.#desktopSettingsUnavailable(); }
  createCategory(): Promise<InventorySnapshot> { return this.#desktopSettingsUnavailable(); }
  deleteCategory(): Promise<unknown> { return this.#desktopSettingsUnavailable(); }
  setCategoryPreference(): Promise<InventorySnapshot> { return this.#desktopSettingsUnavailable(); }
  async listUndoActions(): Promise<UndoActionView[]> { return []; }
  undoOperations(): Promise<unknown> { return this.#desktopSettingsUnavailable(); }
  async openDesktop(): Promise<void> {
    if (!this.#desktopUrl) {
      const result = await this.#call("open_skill_organizer", {});
      if (typeof result._meta?.desktopUrl === "string") this.#desktopUrl = result._meta.desktopUrl;
    }
    if (!this.#desktopUrl) throw new ApiError(500, "No secure desktop workbench URL was returned");
    if (window.openai?.openExternal) await window.openai.openExternal({ href: this.#desktopUrl });
    else window.open(this.#desktopUrl, "_blank", "noopener");
  }
  async openExternal(href: string): Promise<void> {
    if (window.openai?.openExternal) await window.openai.openExternal({ href });
    else window.open(href, "_blank", "noopener,noreferrer");
  }

  async #call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    if (!window.openai?.callTool) throw new ApiError(501, "The host does not provide an MCP tool bridge");
    const result = await window.openai.callTool(name, args);
    if (result.isError) {
      const message = result.content?.find((item) => item.type === "text")?.text ?? `${name} failed`;
      throw new ApiError(message.includes("清单已变化") || message.toLocaleLowerCase().includes("stale") ? 409 : 400, message);
    }
    return result;
  }
  #desktopSettingsUnavailable<T>(): Promise<T> {
    return Promise.reject(new ApiError(501, "Desktop settings are read-only in the Codex MCP panel"));
  }
  #captureSnapshot(result: ToolResult): InventorySnapshot {
    const next = this.#snapshotFrom(result);
    this.#lastSnapshot = next;
    return next;
  }
  #snapshotFrom(result: ToolResult | { _meta?: Record<string, unknown> }, required?: true): InventorySnapshot;
  #snapshotFrom(result: ToolResult | { _meta?: Record<string, unknown> }, required: false): InventorySnapshot | null;
  #snapshotFrom(result: ToolResult | { _meta?: Record<string, unknown> }, required = true): InventorySnapshot | null {
    const structured = "structuredContent" in result ? result.structuredContent : undefined;
    const candidate = result._meta?.snapshot ?? structured?.snapshot;
    if (candidate && typeof candidate === "object" && typeof (candidate as InventorySnapshot).revision === "string" && Array.isArray((candidate as InventorySnapshot).skills)) {
      return candidate as InventorySnapshot;
    }
    if (required) throw new ApiError(500, "The MCP tool did not return a complete Organizer inventory");
    return null;
  }
}

type Locale = "zh-CN" | "en-US";
type PanelName = "overview" | "inventory" | "management";

const I18N: Record<Locale, Record<string, string>> = {
  "zh-CN": {
    brandSubtitle: "本机 Skill 分类、整理与管理", runtimeConnecting: "正在连接 Codex…", managementOff: "管理模式：关闭", managementOn: "管理模式：开启",
    openDesktop: "打开桌面工作台", rescan: "重新扫描", overview: "概览", inventory: "Skill 清单", management: "管理", functionalCategories: "功能分类", sourceScope: "来源范围",
    localFirst: "本机优先", localFirstNote: "分类写入独立 SQLite；扫描不会改写 SKILL.md。外部管理动作只有在管理模式开启并再次确认后才可执行。",
    overviewTitle: "把每台电脑上不同的 Skill，整理成同一套工作视图", overviewLead: "逻辑 Skill 聚合展示；分类与个人偏好跨实例共享，启停、更新证据和隔离始终命中具体实例或安装单元。",
    classificationHealth: "分类健康度", reviewInventory: "检查 Skill 清单", stagedSuggestions: "建议暂存区", suggestionBoundary: "模型建议不会直接改变分类，必须在工作台中接受或拒绝。", reviewSuggestions: "审核建议",
    managementBoundary: "管理边界", managementBoundaryNote: "更新检查只读取精确证据；隔离先生成影响计划，工作台不会从计划页直接移动文件。", openManagement: "打开管理",
    freshDatabase: "0.2.0 使用全新数据库", freshDatabaseNote: "本版本从空 SQLite 数据库开始，不导入 0.1.1 JSON。旧状态文件原样保留，不会被删除或改写。",
    inventoryTitle: "Skill 清单", inventoryLead: "每一行代表一个逻辑 Skill；展开后查看本机的具体路径、插件版本和运行状态。", smartSort: "智能整理待分类项", diagnostics: "诊断",
    search: "搜索", searchPlaceholder: "名称、说明、来源、路径或标签", runtimeState: "运行状态", sourceFilter: "具体来源", pluginFilter: "插件", all: "全部", enabled: "已启用", disabled: "已停用", physicalOnly: "仅物理实例", tags: "标签", allTags: "全部标签", allPlugins: "全部插件", noPlugin: "非插件 Skill", unknownSource: "未知来源", unknownPlugin: "未知插件", duplicateOnly: "只看同名冲突", clearFilters: "清除筛选",
    selectedEligible: "项已选择（已排除锁定项）", bulkCategory: "批量分类", chooseCategory: "选择分类", bulkTagPlaceholder: "标签，逗号分隔", applyCategoryTags: "应用分类与标签", favorite: "收藏", enable: "启用", disable: "停用", restoreAutomatic: "恢复自动分类",
    loadingInventory: "正在恢复本机状态并扫描 Skill…", emptyInventory: "没有符合当前筛选条件的 Skill。", skill: "Skill", classificationAndTags: "分类与标签", sourceAndInstances: "来源与实例", codexRuntime: "Codex 运行状态", jumpStart: "跳到顶部", jumpEnd: "跳到末尾", virtualRange: "显示 {start}–{end} / {total}", virtualInventory: "虚拟滚动 Skill 清单", virtualNavigation: "虚拟清单导航", selectVisibleSkills: "选择当前可见且未锁定的 Skill",
    managementTitle: "管理", managementLead: "分类和标签始终可保存；启停、隔离与恢复必须先由用户在桌面工作台开启管理模式。", refreshManagement: "刷新管理数据", managementMode: "管理模式", closed: "已关闭", opened: "已开启", refresh: "刷新", acceptSelected: "接受所选", rejectSelected: "拒绝所选",
    settingsDirectory: "设置 / 目录", settingsBoundary: "目录、项目、保存视图和分类显示设置保存在本机 SQLite。新增目录默认只读，管理授权必须单独开启。", desktopWritable: "桌面可编辑", mcpReadonly: "Codex 面板只读", rootsAndProject: "目录与项目", rootLabel: "目录名称", rootLabelPlaceholder: "例如：团队 Skills", absoluteRootPath: "本机绝对路径", addReadonlyRoot: "添加只读目录", selectedProject: "当前项目", selectProject: "选择项目", clearProject: "清除项目", readonlyRoot: "只读扫描", managedRoot: "已授权管理", authorizeManagement: "授权管理", revokeManagement: "撤销授权", removeRoot: "移除目录",
    savedViews: "保存视图", savedViewsNote: "保存当前分类、来源、运行状态、标签、搜索和冲突筛选；数据不再写入浏览器 localStorage。", savedView: "已保存视图", viewName: "视图名称", viewNamePlaceholder: "例如：待审核安全 Skills", applyView: "应用视图", saveCurrentView: "保存当前视图", deleteView: "删除视图", noSavedViews: "没有保存视图", viewApplied: "已应用保存视图", viewSaved: "视图已保存到 SQLite",
    categorySettings: "分类显示与个人分类", categorySlug: "个人分类 ID", chineseName: "中文名", englishName: "英文名", createCategory: "创建个人分类", displayOrder: "顺序", hiddenCategory: "隐藏", saveDisplay: "保存显示", migrateTo: "删除前迁移到", deleteCategory: "迁移并删除", builtinCategory: "内置", personalCategory: "个人", categoryCreated: "个人分类已创建", categoryPreferenceSaved: "分类显示设置已保存", categoryDeleted: "个人分类已迁移并删除",
    suggestionBoundaryLong: "这里只保存模型判断的名称、description、来源、已有 category、理由与置信度；锁定项不能接受建议。", updateEvidence: "更新证据", checkSelectedUpdates: "检查清单中所选实例", updateBoundary: "每次点击都强制刷新，仅访问已验证的公开 GitHub/Codex 来源，不下载 Skill 正文，也不执行更新。",
    tagManagement: "标签管理", tagBoundary: "仅管理个人标签。锁定项自动排除；单批最多 100 项，失败即停止。", sourceTag: "来源标签", targetTag: "目标标签", targetTagPlaceholder: "新标签名", renameOrMerge: "重命名 / 合并", deleteTag: "删除标签",
    quarantine: "可恢复隔离", confirmSelectedBoundaries: "确认所选管理边界", prepareSelectedPlan: "为所选候选生成计划", quarantineBoundary: "此页先确认安装边界，再生成影响计划。只有桌面 HTTP 工作台、管理模式开启且计划可执行时，才会出现实际隔离确认；路径冲突时恢复会停止，绝不覆盖。", installationCandidates: "安装单元候选", plansAndRecords: "计划与隔离记录",
    safeUndo: "安全撤销", safeUndoBoundary: "只有当前分类语义状态或精确 runtime 状态仍等于操作后状态时才可撤销；runtime 撤销仍需管理模式和敏感项二次确认。", noUndoActions: "最近 30 天没有可撤销动作。", undoNow: "撤销", undoUnavailable: "前置状态已变化", classificationUndo: "分类批次", runtimeUndo: "Runtime 启停", undoComplete: "安全撤销已完成。",
    legacyState: "旧版状态不会迁移", legacyStateNote: "0.2.0 从空 SQLite 开始。0.1.1 的 JSON 状态文件只读保留；本界面不提供旧 JSON 导入，也不会暗示已迁移。", notWritten: "尚未写入本机分类数据", skillDetail: "Skill 详情", diagnosticsBoundary: "默认诊断隐藏用户名、绝对路径和原始 stderr。", supportBundleBoundary: "完整支持包会包含用户名、绝对路径和原始 stderr；只有明确二次确认后才在本机生成。", supportBundleCreated: "完整支持包已生成", fileName: "文件名", fileSize: "大小", openPluginManagement: "打开 Codex 插件管理", createSupportBundle: "生成完整支持包", openDesktopForPlugin: "到桌面打开插件管理", openDesktopForSupport: "到桌面生成支持包", supportBundleConfirm: "完整支持包将包含用户名、绝对路径和原始 stderr，可能暴露本机目录结构。它不会包含 token、cookie、CSRF、环境变量、SKILL.md 正文或 description。确认只在本机生成？", supportBundleCreatedToast: "完整支持包已在本机生成。", pluginManagementOpened: "已请求打开 Codex 原生插件管理。", desktopCapabilityGuidance: "此能力只能在桌面工作台中由你明确确认。", close: "关闭",
    runtimeConnected: "Codex 运行时已连接", runtimeUnavailable: "Codex 运行时不可用", logicalSkills: "逻辑 Skill", liveDiscovery: "本次实时发现", physicalInstances: "物理实例", exactPaths: "具体路径", pending: "待整理", noForcedOther: "不强行归入其他", locked: "锁定", excludedFromBulk: "排除批量操作", allSkills: "全部 Skill", allSources: "全部来源",
    userSkills: "我的技能", agentsSkills: "Agents 技能", systemSkills: "系统内置", pluginCache: "插件缓存", currentProject: "当前项目", customRoot: "自定义根", items: "项", page: "第 {current} / {total} 页",
    pendingReview: "待审核", noSuggestions: "没有待审核建议。", unavailableInPanel: "此能力需要桌面工作台。", noEvidence: "尚未检查更新证据。请先在 Skill 清单中选择项目。", noCandidates: "没有可管理的安装单元候选，或当前面板无权读取。", noPlans: "尚未生成隔离计划。", noEntries: "没有可恢复的隔离记录。",
    managementOffExplanation: "管理模式关闭：分类、标签、收藏和设置仍可保存；启停、隔离与恢复会被拒绝。", managementOnExplanation: "管理模式开启：外部动作仍需精确目标、最新 revision 和操作确认。", mcpManagementExplanation: "Codex 工具不能开启管理模式。请在桌面工作台明确开启或关闭。",
    categorizedCount: "{categorized} / {total} 已归类", instances: "{count} 个实例", expandInstances: "展开 {count} 个实例", collapseInstances: "收起实例", cacheOnly: "仅物理实例，无运行时开关", multipleRuntime: "多个实例，展开后逐一管理", managementRequired: "请先在桌面工作台开启管理模式", lockedExplicit: "已锁定；必须先显式解锁", unlock: "解锁", saveDetails: "保存详情", automatic: "自动分类", pendingCategory: "待整理", customTags: "个人标签，逗号分隔", automaticSuggestion: "自动建议", sourceRuntime: "来源与具体实例", noDiagnostics: "未发现诊断项。",
    updateChecked: "更新证据检查完成；没有下载正文。", boundaryConfirmed: "安装单元管理边界已确认；尚未移动任何文件。", planPrepared: "隔离计划已生成；尚未移动任何文件。", executeQuarantine: "确认隔离", quarantineExecuted: "隔离操作已停止并分别报告结果。", restore: "恢复", purge: "永久清空", purgeComplete: "隔离项已永久清空", desktopConfirm: "需在桌面确认", boundaryUnconfirmed: "边界待确认", blocked: "已阻止", eligible: "可生成计划", noPersonalTags: "没有个人标签。", selectionLimit: "每次最多选择 100 项。", lockedExcluded: "锁定项已排除。", noSelection: "请先选择至少一项。", dragSelectionReady: "已选择 {count} 个未锁定 Skill；可拖到左侧功能分类，也可使用批量分类控件。", dragStarted: "正在拖动 {count} 个未锁定 Skill。放到功能分类以应用分类。", dragTarget: "把所选 Skill 分类到 {category}", dragApplied: "已将 {count} 个 Skill 分类到 {category}。", dragStale: "清单版本已变化；已取消拖拽，请重试。", dragUnavailable: "拖拽仅处理当前已选择且未锁定的 Skill。",
  },
  "en-US": {
    brandSubtitle: "Local skill classification, organization, and management", runtimeConnecting: "Connecting to Codex…", managementOff: "Management: Off", managementOn: "Management: On",
    openDesktop: "Open desktop", rescan: "Rescan", overview: "Overview", inventory: "Skill inventory", management: "Management", functionalCategories: "Functional categories", sourceScope: "Source scope",
    localFirst: "Local first", localFirstNote: "Classification is stored in a separate SQLite database. Scans never rewrite SKILL.md. External actions require management mode and explicit confirmation.",
    overviewTitle: "Organize different skill lists into one consistent work view", overviewLead: "Logical skills are grouped; classification and preferences are shared, while enablement, update evidence, and quarantine target exact instances or installation units.",
    classificationHealth: "Classification health", reviewInventory: "Review inventory", stagedSuggestions: "Staged suggestions", suggestionBoundary: "Model suggestions never change final classification until you accept or reject them.", reviewSuggestions: "Review suggestions",
    managementBoundary: "Management boundary", managementBoundaryNote: "Update checks read exact evidence only. Quarantine starts with an impact plan and never moves files from the plan screen.", openManagement: "Open management",
    freshDatabase: "0.2.0 starts with a new database", freshDatabaseNote: "This version starts with an empty SQLite database and does not import 0.1.1 JSON. The old file remains untouched.",
    inventoryTitle: "Skill inventory", inventoryLead: "Each row is one logical skill. Expand it to inspect exact paths, plugin versions, and runtime states.", smartSort: "Smart-sort pending", diagnostics: "Diagnostics",
    search: "Search", searchPlaceholder: "Name, description, source, path, or tag", runtimeState: "Runtime state", sourceFilter: "Exact source", pluginFilter: "Plugin", all: "All", enabled: "Enabled", disabled: "Disabled", physicalOnly: "Physical only", tags: "Tags", allTags: "All tags", allPlugins: "All plugins", noPlugin: "Non-plugin skills", unknownSource: "Unknown source", unknownPlugin: "Unknown plugin", duplicateOnly: "Duplicate names only", clearFilters: "Clear filters",
    selectedEligible: "selected (locked skills excluded)", bulkCategory: "Bulk category", chooseCategory: "Choose category", bulkTagPlaceholder: "Tags, comma separated", applyCategoryTags: "Apply category & tags", favorite: "Favorite", enable: "Enable", disable: "Disable", restoreAutomatic: "Restore automatic",
    loadingInventory: "Restoring local state and scanning skills…", emptyInventory: "No skills match the current filters.", skill: "Skill", classificationAndTags: "Classification & tags", sourceAndInstances: "Source & instances", codexRuntime: "Codex runtime", jumpStart: "Jump to start", jumpEnd: "Jump to end", virtualRange: "Showing {start}–{end} / {total}", virtualInventory: "Virtualized skill inventory", virtualNavigation: "Virtual inventory navigation", selectVisibleSkills: "Select visible unlocked skills",
    managementTitle: "Management", managementLead: "Classification and tags are always writable. Enablement, quarantine, and restore require management mode enabled in the desktop workbench.", refreshManagement: "Refresh management data", managementMode: "Management mode", closed: "Off", opened: "On", refresh: "Refresh", acceptSelected: "Accept selected", rejectSelected: "Reject selected",
    settingsDirectory: "Settings / directories", settingsBoundary: "Directories, project, saved views, and category display settings live in local SQLite. New roots are read-only until management is authorized separately.", desktopWritable: "Editable on desktop", mcpReadonly: "Read-only in Codex panel", rootsAndProject: "Directories & project", rootLabel: "Directory label", rootLabelPlaceholder: "e.g. Team Skills", absoluteRootPath: "Local absolute path", addReadonlyRoot: "Add read-only directory", selectedProject: "Current project", selectProject: "Select project", clearProject: "Clear project", readonlyRoot: "Read-only scan", managedRoot: "Management authorized", authorizeManagement: "Authorize management", revokeManagement: "Revoke authorization", removeRoot: "Remove directory",
    savedViews: "Saved views", savedViewsNote: "Save category, source, runtime, tag, search, and conflict filters. View data is no longer written to browser localStorage.", savedView: "Saved view", viewName: "View name", viewNamePlaceholder: "e.g. Security review", applyView: "Apply view", saveCurrentView: "Save current view", deleteView: "Delete view", noSavedViews: "No saved views", viewApplied: "Saved view applied", viewSaved: "View saved to SQLite",
    categorySettings: "Category display & personal categories", categorySlug: "Personal category ID", chineseName: "Chinese name", englishName: "English name", createCategory: "Create personal category", displayOrder: "Order", hiddenCategory: "Hidden", saveDisplay: "Save display", migrateTo: "Migrate before deletion", deleteCategory: "Migrate & delete", builtinCategory: "Built-in", personalCategory: "Personal", categoryCreated: "Personal category created", categoryPreferenceSaved: "Category display settings saved", categoryDeleted: "Personal category migrated and deleted",
    suggestionBoundaryLong: "Only name, description, source, existing category, reason, and confidence are staged. Locked skills cannot accept suggestions.", updateEvidence: "Update evidence", checkSelectedUpdates: "Check selected instances", updateBoundary: "Every click forces a refresh against verified public GitHub/Codex sources. No skill body is downloaded and no update is installed.",
    tagManagement: "Tag management", tagBoundary: "Personal tags only. Locked skills are excluded; each batch is capped at 100 and stops on failure.", sourceTag: "Source tag", targetTag: "Target tag", targetTagPlaceholder: "New tag", renameOrMerge: "Rename / merge", deleteTag: "Delete tag",
    quarantine: "Reversible quarantine", confirmSelectedBoundaries: "Confirm selected boundaries", prepareSelectedPlan: "Prepare plan for selected", quarantineBoundary: "Confirm installation boundaries first, then prepare an impact plan. Actual quarantine appears only in the desktop HTTP workbench when management mode is on and the plan is executable. Restore stops on conflicts and never overwrites.", installationCandidates: "Installation candidates", plansAndRecords: "Plans and records",
    safeUndo: "Safe undo", safeUndoBoundary: "Undo is available only while the current classification semantics or exact runtime state still equals the recorded after-state. Runtime undo still requires management mode and sensitive-item confirmation.", noUndoActions: "No undoable actions in the last 30 days.", undoNow: "Undo", undoUnavailable: "Precondition changed", classificationUndo: "Classification batch", runtimeUndo: "Runtime enablement", undoComplete: "Safe undo completed.",
    legacyState: "Legacy state is not migrated", legacyStateNote: "0.2.0 starts from an empty SQLite database. The 0.1.1 JSON file is preserved read-only; this UI neither imports it nor claims migration.", notWritten: "No local classification writes yet", skillDetail: "Skill details", diagnosticsBoundary: "Default diagnostics hide usernames, absolute paths, and raw stderr.", supportBundleBoundary: "A full support bundle contains usernames, absolute paths, and raw stderr. It is generated locally only after a second explicit confirmation.", supportBundleCreated: "Full support bundle created", fileName: "File name", fileSize: "Size", openPluginManagement: "Open Codex plugin management", createSupportBundle: "Create full support bundle", openDesktopForPlugin: "Open desktop for plugin management", openDesktopForSupport: "Open desktop to create support bundle", supportBundleConfirm: "The full support bundle contains usernames, absolute paths, and raw stderr, which may expose your local directory structure. It excludes tokens, cookies, CSRF values, environment variables, SKILL.md bodies, and descriptions. Create it locally now?", supportBundleCreatedToast: "The full support bundle was created locally.", pluginManagementOpened: "Requested Codex native plugin management.", desktopCapabilityGuidance: "You must explicitly confirm this capability in the desktop workbench.", close: "Close",
    runtimeConnected: "Codex runtime connected", runtimeUnavailable: "Codex runtime unavailable", logicalSkills: "Logical skills", liveDiscovery: "Live discovery", physicalInstances: "Physical instances", exactPaths: "Exact paths", pending: "Pending", noForcedOther: "Never forced into Other", locked: "Locked", excludedFromBulk: "Excluded from bulk actions", allSkills: "All skills", allSources: "All sources",
    userSkills: "My skills", agentsSkills: "Agents skills", systemSkills: "Built-in system", pluginCache: "Plugin cache", currentProject: "Current project", customRoot: "Custom root", items: "items", page: "Page {current} / {total}",
    pendingReview: "Pending review", noSuggestions: "No staged suggestions to review.", unavailableInPanel: "This capability requires the desktop workbench.", noEvidence: "No update evidence checked yet. Select skills in the inventory first.", noCandidates: "No manageable installation candidates, or this panel cannot read them.", noPlans: "No quarantine plans prepared.", noEntries: "No quarantined entries can be restored.",
    managementOffExplanation: "Management is off: classification, tags, favorites, and settings remain writable; enablement, quarantine, and restore are refused.", managementOnExplanation: "Management is on: external actions still require exact targets, a current revision, and explicit confirmation.", mcpManagementExplanation: "Codex tools cannot enable management mode. Open the desktop workbench to change it.",
    categorizedCount: "{categorized} / {total} categorized", instances: "{count} instances", expandInstances: "Expand {count} instances", collapseInstances: "Collapse instances", cacheOnly: "Physical instance only; no runtime switch", multipleRuntime: "Multiple instances; expand to manage each", managementRequired: "Enable management mode in the desktop workbench first", lockedExplicit: "Locked; explicitly unlock before editing", unlock: "Unlock", saveDetails: "Save details", automatic: "Automatic", pendingCategory: "Pending", customTags: "Personal tags, comma separated", automaticSuggestion: "Automatic suggestion", sourceRuntime: "Source and exact instances", noDiagnostics: "No diagnostics found.",
    updateChecked: "Update evidence checked without downloading skill content.", boundaryConfirmed: "Installation boundaries confirmed; no files were moved.", planPrepared: "Quarantine plan prepared; no files were moved.", executeQuarantine: "Confirm quarantine", quarantineExecuted: "Quarantine stopped safely and reported each outcome.", restore: "Restore", purge: "Delete permanently", purgeComplete: "Quarantined item permanently deleted", desktopConfirm: "Desktop confirmation required", boundaryUnconfirmed: "Boundary unconfirmed", blocked: "Blocked", eligible: "Plan eligible", noPersonalTags: "No personal tags.", selectionLimit: "You can select at most 100 items at a time.", lockedExcluded: "Locked skills were excluded.", noSelection: "Select at least one item first.", dragSelectionReady: "{count} unlocked skills selected. Drag them to a functional category or use the bulk category control.", dragStarted: "Dragging {count} unlocked skills. Drop on a functional category to classify them.", dragTarget: "Classify selected skills as {category}", dragApplied: "Classified {count} skills as {category}.", dragStale: "The inventory revision changed. Dragging was cancelled; try again.", dragUnavailable: "Dragging only includes currently selected, unlocked skills.",
  },
};

const ENGLISH_CATEGORIES: Record<CategoryId, string> = {
  development: "Development & Engineering", quality: "Testing & Quality", security: "Security & Governance", delivery: "Delivery & Operations", "data-automation": "Data & Automation", "docs-knowledge": "Docs & Knowledge", "design-media": "Design & Media", "research-analysis": "Research & Analysis", "finance-trading": "Finance & Trading", "content-social": "Content & Social", "agent-workflow": "Agents & Workflows",
};

interface ViewState {
  query: string;
  category: "all" | "pending" | CategoryId;
  scope: "all" | SkillScope;
  source: string;
  plugin: string;
  runtime: "all" | "enabled" | "disabled" | "cache";
  tag: string;
  duplicatesOnly: boolean;
}

const transport: OrganizerTransport = window.openai?.callTool ? new McpTransport() : new HttpTransport();
const selected = new Set<string>();
const expanded = new Set<string>();
const selectedSuggestions = new Set<string>();
const selectedInstallationUnits = new Set<string>();
const VIRTUAL_ROW_HEIGHT = 108;
const VIRTUAL_OVERSCAN = 6;
let snapshot: InventorySnapshot | null = null;
let locale = loadLocale();
let activePanel: PanelName = "overview";
let managementMode = false;
let suggestions: ClassificationSuggestionView[] = [];
let updateEvidence: UpdateEvidenceView[] = [];
let quarantine: QuarantinePayload = { candidates: [], entries: [], plans: [] };
let undoActions: UndoActionView[] = [];
let openSkillId: string | null = null;
let toastTimer: number | null = null;
let renderedSkillIds: string[] = [];
let virtualScrollFrame: number | null = null;
let dragSelection: { skillIds: string[]; expectedRevision: string } | null = null;
const channel = transport.mode === "http" && "BroadcastChannel" in window ? new BroadcastChannel("codex-skill-organizer-v2") : null;
const defaultView: ViewState = { query: "", category: "all", scope: "all", source: FACET_ALL, plugin: FACET_ALL, runtime: "all", tag: "all", duplicatesOnly: false };
let view: ViewState = { ...defaultView };

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing UI element #${id}`);
  return element as T;
}

function make<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function t(key: string, values: Record<string, string | number> = {}): string {
  let result = I18N[locale][key] ?? I18N["zh-CN"][key] ?? key;
  for (const [name, value] of Object.entries(values)) result = result.replaceAll(`{${name}}`, String(value));
  return result;
}

function loadLocale(): Locale {
  return localStorage.getItem("cso-locale-v2") === "en-US" ? "en-US" : "zh-CN";
}

function applyLocale(): void {
  document.documentElement.lang = locale;
  document.querySelectorAll<HTMLElement>("[data-i18n]").forEach((element) => { element.textContent = t(element.dataset.i18n!); });
  document.querySelectorAll<HTMLInputElement>("[data-i18n-placeholder]").forEach((element) => { element.placeholder = t(element.dataset.i18nPlaceholder!); });
  document.querySelectorAll<HTMLElement>("[data-i18n-aria-label]").forEach((element) => { element.setAttribute("aria-label", t(element.dataset.i18nAriaLabel!)); });
  byId("languageButton").textContent = locale === "zh-CN" ? "EN" : "中文";
  document.title = "Skill Organizer for Codex";
  renderDiagnosticsCapabilities();
  renderBulkCategorySelect();
  if (snapshot) renderAll();
  renderManagementData();
}

function showToast(message: string, kind: "normal" | "error" = "normal"): void {
  const toast = byId<HTMLDivElement>("toast");
  toast.textContent = message;
  toast.classList.toggle("error", kind === "error");
  toast.hidden = false;
  if (toastTimer !== null) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { toast.hidden = true; }, 4_800);
}

function setSaveStatus(message: string): void { byId("saveStatus").textContent = message; }

function renderDiagnosticsCapabilities(): void {
  const desktopOnly = transport.mode === "mcp";
  const pluginButton = byId<HTMLButtonElement>("pluginManagementButton");
  const supportButton = byId<HTMLButtonElement>("supportBundleButton");
  pluginButton.textContent = t(desktopOnly ? "openDesktopForPlugin" : "openPluginManagement");
  supportButton.textContent = t(desktopOnly ? "openDesktopForSupport" : "createSupportBundle");
  pluginButton.title = desktopOnly ? t("desktopCapabilityGuidance") : "";
  supportButton.title = desktopOnly ? t("desktopCapabilityGuidance") : "";
}

function renderSupportBundleReceipt(summary: SupportBundleSummary): void {
  byId("supportBundleFileName").textContent = summary.fileName;
  byId("supportBundleSize").textContent = `${summary.sizeBytes.toLocaleString(locale)} B`;
  byId("supportBundleSha").textContent = summary.sha256;
  const result = byId("supportBundleResult");
  result.hidden = false;
  result.focus();
}

async function openDesktopCapability(): Promise<void> {
  showToast(t("desktopCapabilityGuidance"), "error");
  try { await transport.openDesktop(); }
  catch (error) { showToast(error instanceof Error ? error.message : String(error), "error"); }
}

async function createFullSupportBundle(): Promise<void> {
  if (transport.mode === "mcp") { await openDesktopCapability(); return; }
  if (!window.confirm(t("supportBundleConfirm"))) return;
  const button = byId<HTMLButtonElement>("supportBundleButton");
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  byId("supportBundleResult").hidden = true;
  try {
    const summary = await transport.createSupportBundle();
    renderSupportBundleReceipt(summary);
    showToast(t("supportBundleCreatedToast"));
  } catch (error) {
    if (error instanceof ApiError && [403, 404, 501].includes(error.status)) showToast(t("desktopCapabilityGuidance"), "error");
    else showToast(error instanceof Error ? error.message : String(error), "error");
  } finally {
    button.disabled = false;
    button.removeAttribute("aria-busy");
  }
}

async function openNativePluginManagement(): Promise<void> {
  if (transport.mode === "mcp") { await openDesktopCapability(); return; }
  const button = byId<HTMLButtonElement>("pluginManagementButton");
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  try {
    await transport.openPluginManagement();
    showToast(t("pluginManagementOpened"));
  } catch (error) {
    if (error instanceof ApiError && [403, 404, 501].includes(error.status)) showToast(t("desktopCapabilityGuidance"), "error");
    else showToast(error instanceof Error ? error.message : String(error), "error");
  } finally {
    button.disabled = false;
    button.removeAttribute("aria-busy");
  }
}

function categoryLabel(categoryId: CategoryId | null): string {
  if (!categoryId) return t("pendingCategory");
  const definition = categoryDefinitions(true).find((item) => item.id === categoryId);
  if (!definition) return categoryId;
  return locale === "en-US"
    ? definition.display.enUS ?? definition.baseLabel.enUS
    : definition.display.zhCN ?? definition.baseLabel.zhCN;
}

function categoryDefinitions(includeHidden = false): CategoryDefinitionView[] {
  const preferences = new Map((snapshot?.categoryPreferences ?? []).map((preference) => [preference.categoryId, preference]));
  const builtins: CategoryDefinitionView[] = CATEGORIES.map((category, index) => {
    const preference = preferences.get(category.id);
    return {
      id: category.id,
      baseLabel: { zhCN: category.label, enUS: ENGLISH_CATEGORIES[category.id] ?? category.id },
      display: preference?.display ?? {},
      sortOrder: preference?.sortOrder ?? index * 10,
      hidden: preference?.hidden ?? false,
      custom: false,
    };
  });
  const custom: CategoryDefinitionView[] = (snapshot?.customCategories ?? []).map((category) => {
    const preference = preferences.get(category.categoryId);
    return {
      id: category.categoryId,
      baseLabel: category.label,
      display: preference?.display ?? {},
      sortOrder: preference?.sortOrder ?? category.sortOrder,
      hidden: preference?.hidden ?? category.hidden,
      custom: true,
    };
  });
  return [...builtins, ...custom]
    .filter((category) => includeHidden || !category.hidden)
    .sort((left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id, "en-US"));
}

function scopeLabel(scope: SkillScope): string {
  return t(({ user: "userSkills", agents: "agentsSkills", system: "systemSkills", plugin: "pluginCache", repo: "currentProject", custom: "customRoot" } satisfies Record<SkillScope, string>)[scope]);
}

function skillInstances(skill: SkillRecord): SkillInstanceView[] {
  if (skill.instances?.length) return skill.instances;
  return [{
    instanceId: skill.instanceId ?? skill.skillId,
    logicalSkillId: skill.skillId,
    absolutePath: skill.absolutePath,
    rootId: skill.rootId,
    rootLabel: skill.rootLabel,
    breadcrumb: skill.breadcrumb,
    aliases: skill.aliases,
    pluginVersion: skill.pluginVersion,
    version: skill.version,
    readonly: skill.readonly,
    managementGranted: !skill.readonly,
    runtimeDiscovered: skill.runtimeDiscovered,
    runtimeEnabled: skill.runtimeEnabled,
    runtimeScope: skill.runtimeScope,
    diagnostics: skill.diagnostics,
  }];
}

interface FacetOption {
  value: string;
  label: string;
  count: number;
}

function sourceFacetOptions(): FacetOption[] {
  if (!snapshot) return [];
  const facets = new Map<string, FacetOption>();
  for (const skill of snapshot.skills) {
    const value = sourceFacetValue(skill.sourceId);
    const sourceLabel = typeof skill.sourceLabel === "string" ? skill.sourceLabel.normalize("NFC").trim() : "";
    const sourceId = typeof skill.sourceId === "string" ? skill.sourceId.normalize("NFC").trim() : "";
    const label = value === FACET_UNKNOWN
      ? t("unknownSource")
      : sourceLabel || sourceId || t("unknownSource");
    const existing = facets.get(value);
    if (existing) existing.count += 1;
    else facets.set(value, { value, label, count: 1 });
  }
  return [...facets.values()].sort((left, right) => left.label.localeCompare(right.label, locale) || left.value.localeCompare(right.value, "en-US"));
}

function pluginFacetOptions(): FacetOption[] {
  if (!snapshot) return [];
  const facets = new Map<string, FacetOption>();
  for (const skill of snapshot.skills) {
    const value = pluginFacetValue(skill.pluginId);
    const label = value === FACET_NO_PLUGIN
      ? t("noPlugin")
      : value === FACET_UNKNOWN
        ? t("unknownPlugin")
        : typeof skill.pluginId === "string" ? skill.pluginId.normalize("NFC").trim() : t("unknownPlugin");
    const existing = facets.get(value);
    if (existing) existing.count += 1;
    else facets.set(value, { value, label, count: 1 });
  }
  return [...facets.values()].sort((left, right) => {
    if (left.value === FACET_NO_PLUGIN) return -1;
    if (right.value === FACET_NO_PLUGIN) return 1;
    return left.label.localeCompare(right.label, locale) || left.value.localeCompare(right.value, "en-US");
  });
}

function renderFacetFilters(): void {
  if (!snapshot) return;
  const sources = sourceFacetOptions();
  const source = byId<HTMLSelectElement>("sourceFilter");
  source.replaceChildren(
    new Option(`${t("allSources")} (${snapshot.skills.length})`, FACET_ALL),
    ...sources.map((item) => new Option(`${item.label} (${item.count})`, item.value)),
  );
  if (!sources.some((item) => item.value === view.source)) view.source = FACET_ALL;
  source.value = view.source;

  const plugins = pluginFacetOptions();
  const plugin = byId<HTMLSelectElement>("pluginFilter");
  plugin.replaceChildren(
    new Option(`${t("allPlugins")} (${snapshot.skills.length})`, FACET_ALL),
    ...plugins.map((item) => new Option(`${item.label} (${item.count})`, item.value)),
  );
  if (!plugins.some((item) => item.value === view.plugin)) view.plugin = FACET_ALL;
  plugin.value = view.plugin;
}

function currentSkills(): SkillRecord[] {
  if (!snapshot) return [];
  const query = view.query.normalize("NFC").trim().toLocaleLowerCase(locale);
  return snapshot.skills.filter((skill) => {
    if (view.category !== "all" && (view.category === "pending" ? skill.categoryId !== null : skill.categoryId !== view.category)) return false;
    if (view.scope !== "all" && skill.scope !== view.scope) return false;
    if (view.source !== FACET_ALL && sourceFacetValue(skill.sourceId) !== view.source) return false;
    if (view.plugin !== FACET_ALL && pluginFacetValue(skill.pluginId) !== view.plugin) return false;
    if (view.runtime === "enabled" && !skillInstances(skill).some((item) => item.runtimeEnabled === true)) return false;
    if (view.runtime === "disabled" && !skillInstances(skill).some((item) => item.runtimeEnabled === false)) return false;
    if (view.runtime === "cache" && skillInstances(skill).some((item) => item.runtimeDiscovered)) return false;
    if (view.tag !== "all" && !skill.tags.includes(view.tag)) return false;
    if (view.duplicatesOnly && !skill.diagnostics.some((item) => item.code === "DUPLICATE_NAME")) return false;
    if (!query) return true;
    return [skill.name, skill.description, skill.sourceLabel, skill.breadcrumb, ...skill.tags, ...skillInstances(skill).map((item) => item.breadcrumb)]
      .join(" ").normalize("NFC").toLocaleLowerCase(locale).includes(query);
  });
}

function switchPanel(panel: PanelName): void {
  activePanel = panel;
  document.querySelectorAll<HTMLElement>("[data-panel-content]").forEach((element) => {
    const active = element.dataset.panelContent === panel;
    element.hidden = !active;
    element.classList.toggle("active", active);
  });
  document.querySelectorAll<HTMLButtonElement>("[data-panel]").forEach((button) => {
    const active = button.dataset.panel === panel;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current");
  });
  byId("inventoryFilters").hidden = panel !== "inventory";
  if (panel === "inventory") window.requestAnimationFrame(renderTable);
  if (panel === "management") void refreshManagementData();
}

function renderMetrics(): void {
  if (!snapshot) return;
  const instanceCount = snapshot.skills.reduce((total, skill) => total + skillInstances(skill).length, 0);
  const lockedCount = snapshot.skills.filter((skill) => skill.locked).length;
  const metrics: Array<[string, number, string]> = [
    [t("logicalSkills"), snapshot.skills.length, t("liveDiscovery")],
    [t("physicalInstances"), instanceCount, t("exactPaths")],
    [t("pending"), snapshot.summary.pending, t("noForcedOther")],
    [t("locked"), lockedCount, t("excludedFromBulk")],
  ];
  byId<HTMLDListElement>("metrics").replaceChildren(...metrics.map(([label, value, note]) => {
    const wrapper = make("div", "metric");
    const dd = make("dd");
    dd.append(make("span", "metric-value", String(value)), make("span", "metric-note", note));
    wrapper.append(make("dt", "", label), dd);
    return wrapper;
  }));
  const categorized = Math.max(0, snapshot.skills.length - snapshot.summary.pending);
  const percentage = snapshot.skills.length ? Math.round(categorized / snapshot.skills.length * 100) : 100;
  byId("classificationHealth").textContent = `${percentage}%`;
  byId("classificationHealthNote").textContent = t("categorizedCount", { categorized, total: snapshot.skills.length });
  byId("suggestionMetric").textContent = String(suggestions.filter((item) => item.status === "pending").length);
  byId("managementMetric").textContent = managementMode ? t("opened") : t("closed");
}

function renderFilterNav(): void {
  if (!snapshot) return;
  const categories: Array<{ id: ViewState["category"]; label: string; count: number }> = [
    { id: "all", label: t("allSkills"), count: snapshot.skills.length },
    ...categoryDefinitions().map((category) => ({ id: category.id, label: categoryLabel(category.id), count: snapshot!.summary.byCategory[category.id] ?? 0 })),
    { id: "pending", label: t("pending"), count: snapshot.summary.pending },
  ];
  byId("categoryNav").replaceChildren(...categories.map((item) => {
    const button = make("button", `filter-button${view.category === item.id ? " active" : ""}`);
    button.type = "button";
    button.append(make("span", "", item.label), make("span", "filter-count", String(item.count)));
    button.addEventListener("click", () => { view.category = item.id; resetVirtualViewport(); renderAll(); });
    if (item.id !== "all") bindCategoryDropTarget(button, item.id, item.label);
    return button;
  }));
  const scopes = (["user", "agents", "system", "plugin", "repo", "custom"] as const).map((scope) => ({ id: scope, label: scopeLabel(scope), count: snapshot!.summary.byScope[scope] ?? 0 }));
  const scopeItems: Array<{ id: ViewState["scope"]; label: string; count: number }> = [{ id: "all", label: t("allSources"), count: snapshot.skills.length }, ...scopes];
  byId("scopeNav").replaceChildren(...scopeItems.map((item) => {
    const button = make("button", `filter-button${view.scope === item.id ? " active" : ""}`);
    button.type = "button";
    button.append(make("span", "", item.label), make("span", "filter-count", String(item.count)));
    button.addEventListener("click", () => { view.scope = item.id; resetVirtualViewport(); renderAll(); });
    return button;
  }));
}

function fillCategorySelect(select: HTMLSelectElement, includeAutomatic = false, includeHidden = false): void {
  const previous = select.value;
  const options: HTMLOptionElement[] = [];
  if (includeAutomatic) options.push(new Option(t("automatic"), "__auto"));
  options.push(...categoryDefinitions(includeHidden).map((category) => new Option(`${categoryLabel(category.id)}${category.hidden ? ` (${t("hiddenCategory")})` : ""}`, category.id)), new Option(t("pendingCategory"), "__pending"));
  select.replaceChildren(...options);
  if ([...select.options].some((option) => option.value === previous)) select.value = previous;
}

function renderBulkCategorySelect(): void {
  const select = byId<HTMLSelectElement>("bulkCategory");
  const previous = select.value;
  fillCategorySelect(select);
  select.insertBefore(new Option(t("chooseCategory"), ""), select.firstChild);
  select.value = [...select.options].some((option) => option.value === previous) ? previous : "";
}

function renderTagFilter(): void {
  if (!snapshot) return;
  const select = byId<HTMLSelectElement>("tagFilter");
  const tags = [...new Set(snapshot.skills.flatMap((skill) => skill.tags))].sort((a, b) => a.localeCompare(b, locale));
  select.replaceChildren(new Option(t("allTags"), "all"), ...tags.map((tag) => new Option(tag, tag)));
  select.value = tags.includes(view.tag) ? view.tag : "all";
  view.tag = select.value;
  renderTagManager();
}

function addSelected(skillId: string): boolean {
  if (selected.has(skillId)) return true;
  if (selected.size >= MAX_BATCH_SIZE) { showToast(t("selectionLimit"), "error"); return false; }
  selected.add(skillId);
  return true;
}

function setDragStatus(message: string): void {
  byId("dragStatus").textContent = message;
}

function clearCategoryDropState(): void {
  document.querySelectorAll(".category-drop-target").forEach((element) => element.classList.remove("drag-ready", "drag-over"));
}

function startSkillDrag(event: DragEvent): void {
  if (!snapshot) { event.preventDefault(); return; }
  const skillIds = selectedUnlockedSkillIds(snapshot.skills, selected);
  if (!skillIds.length) {
    event.preventDefault();
    setDragStatus(t("dragUnavailable"));
    return;
  }
  dragSelection = { skillIds, expectedRevision: snapshot.revision };
  event.dataTransfer?.setData("text/plain", "codex-skill-organizer:selected-skills");
  if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
  document.querySelectorAll(".category-drop-target").forEach((element) => element.classList.add("drag-ready"));
  setDragStatus(t("dragStarted", { count: skillIds.length }));
}

function finishSkillDrag(): void {
  dragSelection = null;
  clearCategoryDropState();
}

function bindCategoryDropTarget(
  button: HTMLButtonElement,
  categoryId: Exclude<ViewState["category"], "all">,
  label: string,
): void {
  button.classList.add("category-drop-target");
  button.dataset.dropCategoryId = categoryId;
  button.setAttribute("aria-describedby", "dragStatus");
  button.title = t("dragTarget", { category: label });
  button.addEventListener("dragenter", (event) => {
    if (!dragSelection) return;
    event.preventDefault();
    button.classList.add("drag-over");
  });
  button.addEventListener("dragover", (event) => {
    if (!dragSelection) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  });
  button.addEventListener("dragleave", (event) => {
    if (event.relatedTarget instanceof Node && button.contains(event.relatedTarget)) return;
    button.classList.remove("drag-over");
  });
  button.addEventListener("drop", (event) => {
    if (!dragSelection) return;
    event.preventDefault();
    const target = categoryId === "pending" ? null : categoryId;
    void applyDraggedClassification(target, label);
  });
}

async function applyDraggedClassification(categoryId: CategoryId | null, label: string): Promise<void> {
  const pendingDrag = dragSelection;
  clearCategoryDropState();
  dragSelection = null;
  if (!snapshot || !pendingDrag) return;
  if (snapshot.revision !== pendingDrag.expectedRevision) {
    setDragStatus(t("dragStale"));
    showToast(t("dragStale"), "error");
    return;
  }
  const pendingIds = new Set(pendingDrag.skillIds.filter((skillId) => selected.has(skillId)));
  const eligibleIds = selectedUnlockedSkillIds(snapshot.skills, pendingIds);
  if (!eligibleIds.length) {
    setDragStatus(t("dragUnavailable"));
    showToast(t("dragUnavailable"), "error");
    return;
  }
  const message = t("dragApplied", { count: eligibleIds.length, category: label });
  const applied = await mutateClassification({
    skillIds: eligibleIds,
    expectedRevision: pendingDrag.expectedRevision,
    primaryCategoryId: categoryId,
    reason: "drag-classification-workbench",
  }, message);
  setDragStatus(applied ? message : t("dragStale"));
}

function createInstanceCard(skill: SkillRecord, instance: SkillInstanceView): HTMLElement {
  const card = make("div", "instance-card");
  const text = make("div");
  const version = instance.pluginVersion ?? instance.version;
  text.append(make("div", "instance-title", `${instance.rootLabel}${version ? ` · ${version}` : ""}`));
  text.append(make("div", "instance-path", instance.absolutePath));
  const meta = make("div", "source-meta", `${instance.runtimeDiscovered ? instance.runtimeEnabled ? t("enabled") : t("disabled") : t("physicalOnly")} · ${instance.readonly ? "read-only" : instance.managementGranted ? "managed" : "unconfirmed"}`);
  text.append(meta);
  if (instance.diagnostics.length) {
    const diagnostics = make("div", "tags");
    diagnostics.append(...instance.diagnostics.map((item) => make("span", "diagnostic-chip", item.code)));
    text.append(diagnostics);
  }
  const actions = make("div", "inline-actions");
  if (instance.runtimeDiscovered && instance.runtimeEnabled !== null) {
    const toggle = make("button", `button compact runtime-button ${instance.runtimeEnabled ? "enabled" : "disabled"}`, instance.runtimeEnabled ? t("disable") : t("enable"));
    toggle.type = "button";
    toggle.disabled = !managementMode;
    toggle.title = managementMode ? "" : t("managementRequired");
    toggle.addEventListener("click", () => void toggleRuntime([instance.instanceId], !instance.runtimeEnabled, skill));
    actions.append(toggle);
  }
  card.append(text, actions);
  return card;
}

function createSkillRows(skill: SkillRecord): [HTMLTableRowElement, HTMLTableRowElement] {
  const row = make("tr", `skill-row${selected.has(skill.skillId) ? " selected" : ""}${skill.locked ? " locked" : ""}`);
  row.draggable = selected.has(skill.skillId) && !skill.locked;
  row.addEventListener("dragstart", startSkillDrag);
  row.addEventListener("dragend", finishSkillDrag);
  const selectCell = make("td");
  const checkbox = make("input") as HTMLInputElement;
  checkbox.type = "checkbox";
  checkbox.checked = selected.has(skill.skillId);
  checkbox.disabled = skill.locked;
  checkbox.title = skill.locked ? t("lockedExplicit") : "";
  checkbox.setAttribute("aria-label", `Select ${skill.name}`);
  checkbox.addEventListener("change", () => {
    if (checkbox.checked && !addSelected(skill.skillId)) checkbox.checked = false;
    if (!checkbox.checked) selected.delete(skill.skillId);
    renderTable(); renderBulkBar();
  });
  selectCell.append(checkbox);

  const skillCell = make("td");
  const skillLayout = make("div", "skill-cell");
  const favorite = make("button", `favorite-button${skill.favorite ? " active" : ""}`, skill.favorite ? "★" : "☆");
  favorite.type = "button";
  favorite.disabled = skill.locked;
  favorite.title = skill.locked ? t("lockedExplicit") : t("favorite");
  favorite.addEventListener("click", () => void mutateClassification({ skillIds: [skill.skillId], expectedRevision: snapshot!.revision, favorite: !skill.favorite }, t("favorite")));
  const identity = make("div");
  const name = make("button", "skill-name-button", skill.name);
  name.type = "button";
  name.addEventListener("click", () => openDrawer(skill.skillId));
  identity.append(name, make("p", "skill-description", skill.description || "—"));
  if (skill.locked) {
    const lock = make("span", "tag lock-tag", `🔒 ${t("locked")}`);
    const lockWrap = make("div", "tags");
    lockWrap.append(lock);
    identity.append(lockWrap);
  }
  skillLayout.append(favorite, identity);
  skillCell.append(skillLayout);

  const classificationCell = make("td");
  classificationCell.append(make("strong", "", categoryLabel(skill.categoryId)));
  const tags = make("div", "tags");
  tags.append(...skill.tags.map((tag) => make("span", "tag", tag)));
  classificationCell.append(tags);
  classificationCell.append(make("div", "source-meta", skill.hasManualOverride ? "manual" : `${skill.automaticClassification.source} · ${Math.round(skill.automaticClassification.confidence * 100)}%`));

  const sourceCell = make("td");
  const instances = skillInstances(skill);
  sourceCell.append(make("div", "source-label", skill.sourceLabel));
  sourceCell.append(make("div", "source-meta", `${scopeLabel(skill.scope)} · ${t("instances", { count: instances.length })}`));
  const expand = make("button", "expand-button", expanded.has(skill.skillId) ? t("collapseInstances") : t("expandInstances", { count: instances.length }));
  expand.type = "button";
  expand.setAttribute("aria-expanded", String(expanded.has(skill.skillId)));
  expand.addEventListener("click", () => { expanded.has(skill.skillId) ? expanded.delete(skill.skillId) : expanded.add(skill.skillId); renderTable(); });
  sourceCell.append(expand);

  const runtimeCell = make("td");
  const runtimeInstances = instances.filter((item) => item.runtimeDiscovered && item.runtimeEnabled !== null);
  if (runtimeInstances.length === 1) {
    const instance = runtimeInstances[0]!;
    const toggle = make("button", `button runtime-button ${instance.runtimeEnabled ? "enabled" : "disabled"}`, instance.runtimeEnabled ? t("enabled") : t("disabled"));
    toggle.type = "button";
    toggle.disabled = !managementMode;
    toggle.title = managementMode ? "" : t("managementRequired");
    toggle.addEventListener("click", () => void toggleRuntime([instance.instanceId], !instance.runtimeEnabled, skill));
    runtimeCell.append(toggle);
  } else if (runtimeInstances.length > 1) runtimeCell.append(make("span", "runtime-unavailable", t("multipleRuntime")));
  else runtimeCell.append(make("span", "runtime-unavailable", t("cacheOnly")));

  row.append(selectCell, skillCell, classificationCell, sourceCell, runtimeCell);

  const detailRow = make("tr", "instance-row");
  detailRow.hidden = !expanded.has(skill.skillId);
  const detailCell = make("td");
  detailCell.colSpan = 5;
  const grid = make("div", "instance-grid");
  grid.append(...instances.map((instance) => createInstanceCard(skill, instance)));
  detailCell.append(grid);
  detailRow.append(detailCell);
  return [row, detailRow];
}

function createVirtualSpacer(heightPx: number): HTMLTableRowElement | null {
  if (heightPx <= 0) return null;
  const row = make("tr", "virtual-spacer");
  row.setAttribute("aria-hidden", "true");
  const cell = make("td");
  cell.colSpan = 5;
  const block = make("div", "virtual-spacer-block");
  block.style.height = `${heightPx}px`;
  cell.append(block);
  row.append(cell);
  return row;
}

function resetVirtualViewport(): void {
  const wrap = document.getElementById("tableWrap");
  if (wrap) wrap.scrollTop = 0;
}

function renderTable(): void {
  const filtered = currentSkills();
  const tableWrap = byId("tableWrap");
  const hasResults = filtered.length !== 0;
  byId("resultCount").textContent = `${filtered.length} ${t("items")}`;
  byId("emptyState").hidden = hasResults;
  tableWrap.hidden = !hasResults;
  byId("pagination").hidden = !hasResults;
  const body = byId("skillTableBody");
  if (!hasResults) {
    body.replaceChildren();
    renderedSkillIds = [];
    byId("pageLabel").textContent = t("virtualRange", { start: 0, end: 0, total: 0 });
    const selectPage = byId<HTMLInputElement>("selectPage");
    selectPage.checked = false;
    selectPage.indeterminate = false;
    selectPage.disabled = true;
    return;
  }

  const scrollTop = tableWrap.scrollTop;
  const range = virtualWindow(filtered.length, scrollTop, tableWrap.clientHeight || 648, VIRTUAL_ROW_HEIGHT, VIRTUAL_OVERSCAN);
  const windowSkills = filtered.slice(range.start, range.end);
  renderedSkillIds = windowSkills.map((skill) => skill.skillId);
  body.replaceChildren();
  const topSpacer = createVirtualSpacer(range.topSpacerPx);
  if (topSpacer) body.append(topSpacer);
  windowSkills.forEach((skill, index) => {
    const [row, detailRow] = createSkillRows(skill);
    row.setAttribute("aria-rowindex", String(range.start + index + 2));
    body.append(row, detailRow);
  });
  const bottomSpacer = createVirtualSpacer(range.bottomSpacerPx);
  if (bottomSpacer) body.append(bottomSpacer);
  body.closest("table")?.setAttribute("aria-rowcount", String(filtered.length + 1));

  const start = range.start + 1;
  const end = range.end;
  byId("pageLabel").textContent = t("virtualRange", { start, end, total: filtered.length });
  byId<HTMLButtonElement>("previousPage").disabled = range.start === 0;
  byId<HTMLButtonElement>("nextPage").disabled = range.end >= filtered.length;
  const eligible = selectableSkillIds(windowSkills);
  const selectPage = byId<HTMLInputElement>("selectPage");
  selectPage.checked = eligible.length > 0 && eligible.every((skillId) => selected.has(skillId));
  selectPage.indeterminate = eligible.some((skillId) => selected.has(skillId)) && !selectPage.checked;
  selectPage.disabled = eligible.length === 0;
}

function renderBulkBar(): void {
  byId("bulkBar").hidden = selected.size === 0;
  byId("selectedCount").textContent = String(selected.size);
  if (!dragSelection) setDragStatus(selected.size ? t("dragSelectionReady", { count: selected.size }) : "");
  for (const element of document.querySelectorAll<HTMLButtonElement>(".management-action")) {
    element.disabled = !managementMode;
    element.title = managementMode ? "" : t("managementRequired");
  }
}

function renderManagementMode(): void {
  const button = byId("managementStatusButton");
  button.className = `management-status ${managementMode ? "on" : "off"}`;
  byId("managementStatusText").textContent = t(managementMode ? "managementOn" : "managementOff");
  const toggle = byId<HTMLInputElement>("managementModeToggle");
  toggle.checked = managementMode;
  toggle.disabled = transport.mode === "mcp";
  byId("managementToggleLabel").textContent = t(managementMode ? "opened" : "closed");
  byId("managementModeExplanation").textContent = t(transport.mode === "mcp" ? "mcpManagementExplanation" : managementMode ? "managementOnExplanation" : "managementOffExplanation");
  byId("managementMetric").textContent = t(managementMode ? "opened" : "closed");
  renderBulkBar();
  renderQuarantine();
  renderUndoActions();
}

function renderAll(): void {
  if (!snapshot) return;
  renderMetrics();
  renderFilterNav();
  renderFacetFilters();
  renderTagFilter();
  renderTable();
  renderBulkBar();
  renderManagementMode();
  renderSettings();
  byId("runtimeBadge").textContent = t(snapshot.runtimeAvailable ? "runtimeConnected" : "runtimeUnavailable");
  byId("runtimeBadge").className = `status-chip ${snapshot.runtimeAvailable ? "" : "warning"}`;
  byId("generatedAt").textContent = new Date(snapshot.generatedAt).toLocaleString(locale);
  byId("loadingState").hidden = true;
  byId("errorState").hidden = true;
  if (openSkillId) {
    const current = snapshot.skills.find((skill) => skill.skillId === openSkillId);
    if (current) renderDrawer(current); else closeDrawer();
  }
}

function acceptSnapshot(next: InventorySnapshot, broadcast = false): void {
  snapshot = next;
  if (typeof next.managementMode === "boolean") managementMode = next.managementMode;
  for (const skillId of [...selected]) {
    const current = next.skills.find((skill) => skill.skillId === skillId);
    if (!current || current.locked) selected.delete(skillId);
  }
  renderAll();
  if (broadcast) channel?.postMessage({ revision: next.revision });
}

function snapshotFromResponse(value: unknown): InventorySnapshot | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const candidate = record.snapshot;
  return candidate
    && typeof candidate === "object"
    && typeof (candidate as InventorySnapshot).revision === "string"
    && Array.isArray((candidate as InventorySnapshot).skills)
    ? candidate as InventorySnapshot
    : null;
}

async function mutateClassification(patch: ClassificationPatch, successMessage: string): Promise<boolean> {
  if (!patch.skillIds.length || patch.skillIds.length > MAX_BATCH_SIZE) { showToast(t("selectionLimit"), "error"); return false; }
  setSaveStatus(locale === "zh-CN" ? "正在保存到本机…" : "Saving locally…");
  try {
    acceptSnapshot(await transport.applyClassification(patch), true);
    setSaveStatus(locale === "zh-CN" ? "已保存到本机 SQLite" : "Saved to local SQLite");
    showToast(successMessage);
    return true;
  } catch (error) {
    await handleMutationError(error);
    return false;
  }
}

async function handleMutationError(error: unknown): Promise<void> {
  setSaveStatus(locale === "zh-CN" ? "本机保存失败" : "Local save failed");
  if (error instanceof ApiError && error.status === 409) {
    try {
      acceptSnapshot(await transport.getInventory());
      showToast(locale === "zh-CN" ? "清单已变化并刷新，请重试刚才的操作" : "Inventory changed and was refreshed; retry the operation", "error");
      return;
    } catch { /* surface original error */ }
  }
  showToast(error instanceof Error ? error.message : String(error), "error");
}

function requireManagementMode(): boolean {
  if (managementMode) return true;
  switchPanel("management");
  showToast(t("managementRequired"), "error");
  return false;
}

async function toggleRuntime(targetIds: string[], enabled: boolean, skill?: SkillRecord): Promise<void> {
  if (!snapshot || !requireManagementMode()) return;
  if (!targetIds.length || targetIds.length > MAX_BATCH_SIZE) { showToast(t("selectionLimit"), "error"); return; }
  const sensitive = skill ? skill.scope === "system" || skill.scope === "plugin" : snapshot.skills.some((item) => selected.has(item.skillId) && (item.scope === "system" || item.scope === "plugin"));
  if (sensitive && !window.confirm(locale === "zh-CN" ? `所选项包含系统或插件 Skill。确认${enabled ? "启用" : "停用"}？` : `The selection contains system or plugin skills. Confirm ${enabled ? "enable" : "disable"}?`)) return;
  try {
    const result = await transport.setEnabled(targetIds, enabled, snapshot.revision, sensitive);
    acceptSnapshot(await transport.getInventory(), true);
    selected.clear();
    renderAll();
    if (result.failed.length) showToast(`Succeeded ${result.succeeded.length}; failed ${result.failed.length}; not executed ${result.notExecuted.length}`, "error");
    else showToast(locale === "zh-CN" ? `已回读确认 ${result.succeeded.length} 项` : `Verified ${result.succeeded.length} runtime changes`);
  } catch (error) { await handleMutationError(error); }
}

function renderDrawer(skill: SkillRecord): void {
  byId("drawerTitle").textContent = skill.name;
  const content = byId("drawerContent");
  content.replaceChildren();
  const overview = make("section", "drawer-section");
  overview.append(make("p", "drawer-description", skill.description || "—"));
  if (skill.locked) overview.append(make("p", "boundary-note warning-note", t("lockedExplicit")));

  const classification = make("section", "drawer-section");
  classification.append(make("h3", "", t("classificationAndTags")));
  const category = make("select") as HTMLSelectElement;
  fillCategorySelect(category, true, true);
  category.value = skill.hasManualOverride ? skill.categoryId ?? "__pending" : "__auto";
  const customTags = make("input") as HTMLInputElement;
  customTags.type = "text";
  customTags.value = skill.tags.filter((tag) => tag.startsWith("user:")).map((tag) => tag.slice(5)).join(", ");
  customTags.placeholder = t("customTags");
  const favoriteLabel = make("label", "check-field");
  const favorite = make("input") as HTMLInputElement;
  favorite.type = "checkbox"; favorite.checked = skill.favorite;
  favoriteLabel.append(favorite, make("span", "", t("favorite")));
  const lockLabel = make("label", "check-field");
  const locked = make("input") as HTMLInputElement;
  locked.type = "checkbox"; locked.checked = skill.locked;
  lockLabel.append(locked, make("span", "", skill.locked ? t("unlock") : t("locked")));
  category.disabled = skill.locked; customTags.disabled = skill.locked; favorite.disabled = skill.locked;
  classification.append(category, customTags, favoriteLabel, lockLabel);
  classification.append(make("p", "source-meta", `${t("automaticSuggestion")}: ${categoryLabel(skill.automaticClassification.categoryId)} · ${skill.automaticClassification.reason}`));
  const actions = make("div", "drawer-actions");
  const save = make("button", "button primary", skill.locked ? t("unlock") : t("saveDetails"));
  save.type = "button";
  save.addEventListener("click", () => {
    if (skill.locked) {
      if (locked.checked) { showToast(locale === "zh-CN" ? "请先取消勾选锁定" : "Uncheck Locked first", "error"); return; }
      void mutateClassification({ skillIds: [skill.skillId], expectedRevision: snapshot!.revision, locked: false }, t("unlock"));
      return;
    }
    const desired = new Set(customTags.value.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean).map(normalizePersonalTag));
    const current = new Set(skill.tags.filter((tag) => tag.startsWith("user:")));
    const patch: ClassificationPatch = {
      skillIds: [skill.skillId], expectedRevision: snapshot!.revision,
      addTagIds: [...desired].filter((tag) => !current.has(tag)), removeTagIds: [...current].filter((tag) => !desired.has(tag)),
      favorite: favorite.checked, locked: locked.checked, reason: "manual-workbench-detail",
    };
    if (category.value === "__auto") patch.restoreAutomatic = true;
    else patch.primaryCategoryId = category.value === "__pending" ? null : category.value as CategoryId;
    void mutateClassification(patch, t("saveDetails"));
  });
  actions.append(save);
  if (!skill.locked) {
    const restore = make("button", "button ghost", t("restoreAutomatic"));
    restore.type = "button";
    restore.addEventListener("click", () => void mutateClassification({ skillIds: [skill.skillId], expectedRevision: snapshot!.revision, restoreAutomatic: true }, t("restoreAutomatic")));
    actions.append(restore);
  }
  classification.append(actions);

  const provenance = make("section", "drawer-section");
  provenance.append(make("h3", "", t("sourceRuntime")));
  provenance.append(make("p", "", `${skill.sourceLabel} · ${scopeLabel(skill.scope)}`));
  for (const instance of skillInstances(skill)) provenance.append(createDrawerInstance(skill, instance));

  const diagnostics = make("section", "drawer-section");
  diagnostics.append(make("h3", "", t("diagnostics")));
  const allDiagnostics = [...skill.diagnostics, ...skillInstances(skill).flatMap((instance) => instance.diagnostics)];
  if (!allDiagnostics.length) diagnostics.append(make("p", "source-meta", t("noDiagnostics")));
  else {
    const list = make("ul");
    for (const item of allDiagnostics) list.append(make("li", "", `${item.code}: ${item.message}`));
    diagnostics.append(list);
  }
  content.append(overview, classification, provenance, diagnostics);
}

function createDrawerInstance(skill: SkillRecord, instance: SkillInstanceView): HTMLElement {
  const wrapper = make("div", "drawer-instance");
  wrapper.append(make("strong", "", `${instance.rootLabel}${instance.pluginVersion ? ` · ${instance.pluginVersion}` : ""}`));
  wrapper.append(make("div", "instance-path", instance.absolutePath));
  const meta = instance.runtimeDiscovered ? instance.runtimeEnabled ? t("enabled") : t("disabled") : t("physicalOnly");
  wrapper.append(make("div", "source-meta", meta));
  if (instance.runtimeDiscovered && instance.runtimeEnabled !== null) {
    const button = make("button", "button ghost compact", instance.runtimeEnabled ? t("disable") : t("enable"));
    button.type = "button"; button.disabled = !managementMode;
    button.addEventListener("click", () => void toggleRuntime([instance.instanceId], !instance.runtimeEnabled, skill));
    wrapper.append(button);
  }
  return wrapper;
}

function openDrawer(skillId: string): void {
  const skill = snapshot?.skills.find((item) => item.skillId === skillId);
  if (!skill) return;
  openSkillId = skillId; renderDrawer(skill);
  byId("detailDrawer").classList.add("open");
  byId("detailDrawer").setAttribute("aria-hidden", "false");
  byId("drawerBackdrop").hidden = false;
}

function closeDrawer(): void {
  openSkillId = null;
  byId("detailDrawer").classList.remove("open");
  byId("detailDrawer").setAttribute("aria-hidden", "true");
  byId("drawerBackdrop").hidden = true;
}

function normalizePersonalTag(value: string): string {
  const normalized = value.normalize("NFC").trim().toLocaleLowerCase("en-US").replace(/\s+/g, "-").slice(0, 75);
  return normalized.startsWith("user:") ? normalized : `user:${normalized}`;
}

function parseBulkTags(): string[] {
  return byId<HTMLInputElement>("bulkTags").value.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean).map(normalizePersonalTag);
}

function renderSuggestions(): void {
  const list = byId("suggestionsList");
  const pending = suggestions.filter((item) => item.status === "pending");
  byId("suggestionMetric").textContent = String(pending.length);
  for (const id of [...selectedSuggestions]) if (!pending.some((item) => item.suggestionId === id)) selectedSuggestions.delete(id);
  if (!pending.length) {
    list.replaceChildren(make("div", "empty-management", transport.mode === "mcp" ? t("unavailableInPanel") : t("noSuggestions")));
    return;
  }
  list.replaceChildren(...pending.map((suggestion) => {
    const skill = snapshot?.skills.find((item) => item.skillId === suggestion.logicalSkillId);
    const locked = skill?.locked === true;
    const row = make("div", "management-item");
    const checkbox = make("input") as HTMLInputElement;
    checkbox.type = "checkbox"; checkbox.checked = selectedSuggestions.has(suggestion.suggestionId); checkbox.disabled = locked;
    checkbox.addEventListener("change", () => checkbox.checked ? selectedSuggestions.add(suggestion.suggestionId) : selectedSuggestions.delete(suggestion.suggestionId));
    const content = make("div");
    content.append(make("div", "management-item-title", skill?.name ?? suggestion.logicalSkillId));
    content.append(make("div", "management-item-meta", `${categoryLabel(suggestion.categoryId)} · ${Math.round(suggestion.confidence * 100)}%${locked ? ` · ${t("locked")}` : ""}`));
    content.append(make("p", "management-item-reason", suggestion.reason));
    if (suggestion.tags.length) { const tags = make("div", "tags"); tags.append(...suggestion.tags.map((tag) => make("span", "tag", tag))); content.append(tags); }
    row.append(checkbox, content, make("span", "status-chip muted", t("pendingReview")));
    return row;
  }));
}

function renderUpdateEvidence(): void {
  const list = byId("updateEvidenceList");
  if (!updateEvidence.length) { list.replaceChildren(make("div", "empty-management", t("noEvidence"))); return; }
  list.replaceChildren(...updateEvidence.map((evidence) => {
    const row = make("div", "management-item no-check");
    const content = make("div");
    const target = evidence.logicalSkillId ?? evidence.instanceId ?? evidence.evidenceId ?? "Skill";
    const skill = snapshot?.skills.find((item) => item.skillId === target || skillInstances(item).some((instance) => instance.instanceId === target));
    content.append(make("div", "management-item-title", skill?.name ?? target));
    content.append(make("div", "management-item-meta", `${evidence.evidenceKind ?? "none"}${evidence.checkedAt ? ` · ${new Date(evidence.checkedAt).toLocaleString(locale)}` : ""}`));
    content.append(make("p", "management-item-reason", evidence.summary ?? (evidence.locallyModified ? "Locally modified" : "Evidence recorded")));
    const references = [evidence.installedReference ?? evidence.installedEvidence, evidence.availableReference ?? evidence.availableEvidence].filter(Boolean).join(" → ");
    if (references) content.append(make("div", "instance-path", references));
    const actions = make("div", "inline-actions");
    const status = evidence.status ?? (evidence.locallyModified ? "modified" : "up-to-date");
    actions.append(make("span", `evidence-status ${status}`, status));
    const href = safeEvidenceUrl(evidence.comparisonUrl ?? evidence.compareUrl);
    if (href) {
      const link = make("button", "button ghost compact", locale === "zh-CN" ? "比较" : "Compare");
      link.type = "button"; link.addEventListener("click", () => void transport.openExternal(href)); actions.append(link);
    }
    row.append(content, actions);
    return row;
  }));
}

function renderQuarantine(): void {
  const candidates = byId("quarantineCandidates");
  for (const unitId of [...selectedInstallationUnits]) {
    if (!quarantine.candidates.some((candidate) => candidate.installationUnitId === unitId)) selectedInstallationUnits.delete(unitId);
  }
  if (!quarantine.candidates.length) candidates.replaceChildren(make("div", "empty-management", t("noCandidates")));
  else candidates.replaceChildren(...quarantine.candidates.map((candidate) => {
    const confirmable = canConfirmInstallationUnit(candidate);
    const preparable = canPrepareInstallationUnit(candidate);
    const hardBlockers = candidate.blockers?.map((blocker) => blocker.message ?? blocker.code ?? "blocked") ?? [];
    const selectable = confirmable || preparable;
    const row = make("div", "management-item");
    const checkbox = make("input") as HTMLInputElement;
    checkbox.type = "checkbox"; checkbox.checked = selectedInstallationUnits.has(candidate.installationUnitId); checkbox.disabled = !selectable;
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) {
        if (selectedInstallationUnits.size >= MAX_BATCH_SIZE) { checkbox.checked = false; showToast(t("selectionLimit"), "error"); return; }
        selectedInstallationUnits.add(candidate.installationUnitId);
      } else selectedInstallationUnits.delete(candidate.installationUnitId);
      renderQuarantine();
    });
    const content = make("div");
    content.append(make("div", "management-item-title", candidate.label ?? candidate.installationUnitId));
    const affectedCount = candidate.skillCount ?? candidate.affectedSkillIds?.length ?? 0;
    content.append(make("div", "management-item-meta", `${candidate.kind ?? "unknown"} · ${affectedCount} Skill · ${candidate.confirmed ? "confirmed" : "unconfirmed"}`));
    if (candidate.pathHint) content.append(make("div", "instance-path", candidate.pathHint));
    const displayedBlockers = hardBlockers.length ? hardBlockers : candidate.blockedReasons ?? [];
    content.append(make("p", "management-item-reason", displayedBlockers.length ? displayedBlockers.join(" · ") : (candidate.confirmed ? t("eligible") : t("boundaryUnconfirmed"))));
    const state = preparable ? "eligible" : confirmable ? "boundaryUnconfirmed" : "blocked";
    row.append(checkbox, content, make("span", state === "blocked" ? "diagnostic-chip" : state === "eligible" ? "status-chip" : "status-chip warning", t(state)));
    return row;
  }));

  const selectedCandidates = quarantine.candidates.filter((candidate) => selectedInstallationUnits.has(candidate.installationUnitId));
  byId<HTMLButtonElement>("confirmInstallationUnitsButton").disabled = !selectedCandidates.some(canConfirmInstallationUnit) || transport.mode !== "http";
  byId<HTMLButtonElement>("prepareQuarantineButton").disabled = !selectedCandidates.some(canPrepareInstallationUnit);

  const plans = byId("quarantinePlans");
  if (!quarantine.plans.length) plans.replaceChildren(make("div", "empty-management", t("noPlans")));
  else plans.replaceChildren(...quarantine.plans.map((plan) => {
    const row = make("div", "management-item no-check");
    const content = make("div");
    content.append(make("div", "management-item-title", plan.label ?? plan.installationUnitId ?? plan.planId ?? "Plan"));
    const items = plan.items ?? [];
    const affectedSkills = new Set(items.flatMap((item) => item.affectedSkillIds));
    const affectedCount = plan.affectedSkillCount ?? plan.affectedSkills?.length ?? affectedSkills.size;
    const blockers = [...(plan.blockedReasons ?? []), ...items.flatMap((item) => item.blockers.map((blocker) => blocker.message ?? blocker.code ?? "blocked"))];
    const executable = plan.executable ?? plan.allowed === true;
    content.append(make("div", "management-item-meta", `${affectedCount} Skill · ${items.length} ${locale === "zh-CN" ? "个目录" : "directories"} · ${executable ? t("desktopConfirm") : t("blocked")}`));
    content.append(make("p", "management-item-reason", blockers.length ? blockers.join(" · ") : plan.summary ?? t("planPrepared")));
    const sourcePaths = items.map((item) => item.sourcePath);
    const treeLines = plan.treeSummary?.length ? plan.treeSummary : items.flatMap((item) => item.tree?.map((entry) => `${item.sourcePath} › ${entry.relativePath}`) ?? []);
    if (sourcePaths.length) content.append(make("div", "instance-path", sourcePaths.join("\n")));
    if (treeLines.length) { const tree = make("div", "instance-path", treeLines.slice(0, 12).join("\n")); tree.style.whiteSpace = "pre-wrap"; content.append(tree); }
    const actions = make("div", "inline-actions");
    actions.append(make("span", executable ? "status-chip warning" : "diagnostic-chip", t(executable ? "desktopConfirm" : "blocked")));
    if (transport.mode === "http" && executable && items.length > 0) {
      const execute = make("button", "button primary compact", t("executeQuarantine"));
      execute.type = "button";
      execute.disabled = !canExecuteQuarantinePlan(transport.mode, managementMode, plan);
      execute.title = managementMode ? "" : t("managementRequired");
      execute.addEventListener("click", () => void executeQuarantinePlan(plan));
      actions.append(execute);
    }
    row.append(content, actions);
    return row;
  }));

  const entries = byId("quarantineEntries");
  const restorable = quarantine.entries.filter((entry) => entry.status === "quarantined");
  if (!restorable.length) entries.replaceChildren(make("div", "empty-management", t("noEntries")));
  else entries.replaceChildren(...restorable.map((entry) => {
    const row = make("div", "management-item no-check");
    const content = make("div");
    content.append(make("div", "management-item-title", entry.label ?? entry.installationUnitId));
    content.append(make("div", "management-item-meta", entry.quarantinedAt ? new Date(entry.quarantinedAt).toLocaleString(locale) : entry.status));
    if (entry.originalPathHint) content.append(make("div", "instance-path", entry.originalPathHint));
    const actions = make("div", "inline-actions");
    const restore = make("button", "button ghost compact", t("restore"));
    restore.type = "button"; restore.disabled = !managementMode;
    restore.addEventListener("click", () => void restoreQuarantineEntry(entry));
    actions.append(restore);
    if (transport.mode === "http") {
      const purge = make("button", "button danger-text compact", t("purge"));
      purge.type = "button"; purge.disabled = !managementMode;
      purge.addEventListener("click", () => void purgeQuarantineEntry(entry));
      actions.append(purge);
    }
    row.append(content, actions);
    return row;
  }));
}

function renderTagManager(): void {
  if (!snapshot) return;
  const source = byId<HTMLSelectElement>("tagManagerSource");
  const current = source.value;
  const personalTags = [...new Set(snapshot.skills.flatMap((skill) => skill.tags.filter((tag) => tag.startsWith("user:"))))].sort((a, b) => a.localeCompare(b, locale));
  source.replaceChildren(...(personalTags.length ? personalTags.map((tag) => new Option(tag, tag)) : [new Option(t("noPersonalTags"), "")]));
  if (personalTags.includes(current)) source.value = current;
  source.disabled = personalTags.length === 0;
  const tag = source.value;
  const matches = tag ? snapshot.skills.filter((skill) => skill.tags.includes(tag)) : [];
  const locked = matches.filter((skill) => skill.locked).length;
  byId("tagManagerSummary").textContent = tag ? `${matches.length} ${t("items")} · ${locked} ${t("locked")}` : t("noPersonalTags");
}

function currentViewFilters(): Record<string, string | boolean | string[] | null> {
  return {
    query: view.query,
    category: view.category,
    scope: view.scope,
    source: view.source,
    plugin: view.plugin,
    runtime: view.runtime,
    tag: view.tag,
    duplicatesOnly: view.duplicatesOnly,
  };
}

function viewFromSavedFilters(filters: SavedViewRecord["filters"]): ViewState {
  const categoryIds = new Set<string>(categoryDefinitions(true).map((category) => category.id));
  const category = typeof filters.category === "string"
    && (["all", "pending"].includes(filters.category) || categoryIds.has(filters.category))
    ? filters.category as ViewState["category"] : "all";
  const scope = typeof filters.scope === "string" && ["all", "user", "agents", "system", "plugin", "repo", "custom"].includes(filters.scope)
    ? filters.scope as ViewState["scope"] : "all";
  const runtime = typeof filters.runtime === "string" && ["all", "enabled", "disabled", "cache"].includes(filters.runtime)
    ? filters.runtime as ViewState["runtime"] : "all";
  const sourceValues = new Set([FACET_ALL, ...sourceFacetOptions().map((item) => item.value)]);
  const pluginValues = new Set([FACET_ALL, ...pluginFacetOptions().map((item) => item.value)]);
  return {
    query: typeof filters.query === "string" ? filters.query.slice(0, 200) : "",
    category,
    scope,
    source: typeof filters.source === "string" && sourceValues.has(filters.source) ? filters.source : FACET_ALL,
    plugin: typeof filters.plugin === "string" && pluginValues.has(filters.plugin) ? filters.plugin : FACET_ALL,
    runtime,
    tag: typeof filters.tag === "string" ? filters.tag : "all",
    duplicatesOnly: filters.duplicatesOnly === true,
  };
}

function syncFilterControls(): void {
  byId<HTMLInputElement>("searchInput").value = view.query;
  byId<HTMLSelectElement>("runtimeFilter").value = view.runtime;
  byId<HTMLSelectElement>("sourceFilter").value = view.source;
  byId<HTMLSelectElement>("pluginFilter").value = view.plugin;
  byId<HTMLInputElement>("duplicateFilter").checked = view.duplicatesOnly;
  const tag = byId<HTMLSelectElement>("tagFilter");
  if ([...tag.options].some((option) => option.value === view.tag)) tag.value = view.tag;
}

function renderConfiguredRoots(): void {
  const roots = snapshot?.configuredRoots ?? [];
  const list = byId("configuredRootsList");
  if (!roots.length) {
    list.replaceChildren(make("div", "empty-management", locale === "zh-CN" ? "没有额外目录" : "No additional directories"));
    return;
  }
  list.replaceChildren(...roots.map((root) => {
    const row = make("div", "root-setting-item");
    row.dataset.rootId = root.rootId;
    const content = make("div");
    content.append(make("div", "management-item-title", root.label));
    content.append(make("div", "instance-path", root.absolutePath));
    content.append(make("div", "management-item-meta", t(root.managementAuthorized ? "managedRoot" : "readonlyRoot")));
    row.append(content);
    if (transport.mode === "http") {
      const actions = make("div", "inline-actions");
      const authorize = make("button", "button ghost compact", t(root.managementAuthorized ? "revokeManagement" : "authorizeManagement"));
      authorize.type = "button";
      authorize.addEventListener("click", () => void setRootManagement(root, !root.managementAuthorized));
      const remove = make("button", "button danger-text compact", t("removeRoot"));
      remove.type = "button";
      remove.addEventListener("click", () => void removeConfiguredRoot(root));
      actions.append(authorize, remove);
      row.append(actions);
    }
    return row;
  }));
}

function renderSavedViews(): void {
  const views = snapshot?.savedViews ?? [];
  const select = byId<HTMLSelectElement>("savedViewSelect");
  const previous = select.value;
  select.replaceChildren(new Option(t("noSavedViews"), ""), ...views.map((item) => new Option(item.name, item.viewId)));
  if (views.some((item) => item.viewId === previous)) select.value = previous;
  const selectedView = views.find((item) => item.viewId === select.value);
  if (selectedView && document.activeElement !== byId("savedViewNameInput")) byId<HTMLInputElement>("savedViewNameInput").value = selectedView.name;
  byId<HTMLButtonElement>("applySavedViewButton").disabled = !selectedView;
  byId<HTMLButtonElement>("deleteSavedViewButton").disabled = !selectedView || transport.mode !== "http";
}

function renderCategorySettings(): void {
  const list = byId("categorySettingsList");
  const definitions = categoryDefinitions(true);
  if (transport.mode === "mcp") {
    list.replaceChildren(...definitions.map((category) => {
      const row = make("div", "category-setting-readonly");
      row.dataset.categoryId = category.id;
      row.append(make("span", "", categoryLabel(category.id)), make("span", "source-meta", `${category.custom ? t("personalCategory") : t("builtinCategory")} · ${category.sortOrder}${category.hidden ? ` · ${t("hiddenCategory")}` : ""}`));
      return row;
    }));
    return;
  }
  list.replaceChildren(...definitions.map((category) => {
    const row = make("div", "category-setting-row");
    row.dataset.categoryId = category.id;
    const labels = make("div", "category-label-fields");
    const zh = make("input") as HTMLInputElement;
    zh.type = "text"; zh.value = category.display.zhCN ?? category.baseLabel.zhCN; zh.setAttribute("aria-label", `${category.id} zh-CN`);
    const en = make("input") as HTMLInputElement;
    en.type = "text"; en.value = category.display.enUS ?? category.baseLabel.enUS; en.setAttribute("aria-label", `${category.id} en-US`);
    labels.append(zh, en);
    const order = make("input") as HTMLInputElement;
    order.type = "number"; order.value = String(category.sortOrder); order.setAttribute("aria-label", `${category.id} ${t("displayOrder")}`);
    const hiddenLabel = make("label", "check-field");
    const hidden = make("input") as HTMLInputElement;
    hidden.type = "checkbox"; hidden.checked = category.hidden;
    hiddenLabel.append(hidden, make("span", "", t("hiddenCategory")));
    const actions = make("div", "inline-actions");
    const save = make("button", "button ghost compact", t("saveDisplay"));
    save.type = "button";
    save.addEventListener("click", () => void saveCategoryPreference(category, zh.value, en.value, order.value, hidden.checked));
    actions.append(save);
    if (category.custom) {
      const target = make("select") as HTMLSelectElement;
      target.setAttribute("aria-label", `${category.id} ${t("migrateTo")}`);
      target.replaceChildren(new Option(t("migrateTo"), ""), ...definitions.filter((candidate) => candidate.id !== category.id).map((candidate) => new Option(categoryLabel(candidate.id), candidate.id)));
      const remove = make("button", "button danger-text compact", t("deleteCategory"));
      remove.type = "button"; remove.disabled = true;
      target.addEventListener("change", () => { remove.disabled = !target.value; });
      remove.addEventListener("click", () => void deleteCustomCategory(category.id as `custom:${string}`, target.value as CategoryId));
      actions.append(target, remove);
    }
    row.append(labels, order, hiddenLabel, actions);
    return row;
  }));
}

function renderSettings(): void {
  const readOnly = transport.mode === "mcp";
  byId("settingsCapabilityBadge").textContent = t(readOnly ? "mcpReadonly" : "desktopWritable");
  byId("settingsCapabilityBadge").className = `status-chip ${readOnly ? "warning" : ""}`;
  document.querySelectorAll<HTMLElement>(".desktop-setting-write").forEach((element) => { element.hidden = readOnly; });
  renderConfiguredRoots();
  byId("selectedProjectValue").textContent = snapshot?.selectedProjectPath ?? "—";
  if (document.activeElement !== byId("projectPathInput")) byId<HTMLInputElement>("projectPathInput").value = snapshot?.selectedProjectPath ?? "";
  renderSavedViews();
  renderCategorySettings();
}

async function applySettingsSnapshot(operation: () => Promise<InventorySnapshot>, successMessage: string): Promise<void> {
  try {
    acceptSnapshot(await operation(), true);
    showToast(successMessage);
  } catch (error) { await handleMutationError(error); }
}

async function addConfiguredRoot(): Promise<void> {
  if (!snapshot || transport.mode !== "http") return;
  const label = byId<HTMLInputElement>("rootLabelInput").value.normalize("NFC").trim();
  const absolutePath = byId<HTMLInputElement>("rootPathInput").value.trim();
  if (!absolutePath) { showToast(locale === "zh-CN" ? "请输入本机绝对路径" : "Enter a local absolute path", "error"); return; }
  await applySettingsSnapshot(
    () => transport.addRoot(absolutePath, label, snapshot!.revision),
    locale === "zh-CN" ? "只读目录已添加" : "Read-only directory added",
  );
  byId<HTMLInputElement>("rootLabelInput").value = "";
  byId<HTMLInputElement>("rootPathInput").value = "";
}

async function setRootManagement(root: ConfiguredRootView, authorized: boolean): Promise<void> {
  if (!snapshot || transport.mode !== "http") return;
  if (authorized && !window.confirm(locale === "zh-CN"
    ? `授权 Organizer 管理目录“${root.label}”？这不会自动开启全局管理模式；隔离仍需安装边界、计划和二次确认。\n${root.absolutePath}`
    : `Authorize Organizer to manage “${root.label}”? This does not enable global management mode; quarantine still requires a confirmed boundary, plan, and second consent.\n${root.absolutePath}`)) return;
  await applySettingsSnapshot(
    () => transport.setRootManagement(root.rootId, authorized, snapshot!.revision),
    t(authorized ? "managedRoot" : "readonlyRoot"),
  );
}

async function removeConfiguredRoot(root: ConfiguredRootView): Promise<void> {
  if (!snapshot || transport.mode !== "http") return;
  if (!window.confirm(locale === "zh-CN"
    ? `从扫描清单移除目录“${root.label}”？不会删除目录或其中的 Skill。\n${root.absolutePath}`
    : `Remove “${root.label}” from scanning? The directory and its skills will not be deleted.\n${root.absolutePath}`)) return;
  await applySettingsSnapshot(
    () => transport.removeRoot(root.rootId, snapshot!.revision),
    locale === "zh-CN" ? "目录已从扫描清单移除" : "Directory removed from scanning",
  );
}

async function updateSelectedProject(projectPath: string | null): Promise<void> {
  if (!snapshot || transport.mode !== "http") return;
  await applySettingsSnapshot(
    () => transport.selectProject(projectPath, snapshot!.revision),
    projectPath ? t("selectProject") : t("clearProject"),
  );
}

async function saveCurrentView(): Promise<void> {
  if (!snapshot || transport.mode !== "http") return;
  const select = byId<HTMLSelectElement>("savedViewSelect");
  const name = byId<HTMLInputElement>("savedViewNameInput").value.normalize("NFC").trim();
  if (!name) { showToast(locale === "zh-CN" ? "请输入视图名称" : "Enter a view name", "error"); return; }
  const viewId = select.value || (typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `view-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`);
  await applySettingsSnapshot(
    () => transport.saveView(viewId, name, currentViewFilters(), snapshot!.revision),
    t("viewSaved"),
  );
  byId<HTMLSelectElement>("savedViewSelect").value = viewId;
  renderSavedViews();
}

function applySelectedView(): void {
  const saved = snapshot?.savedViews?.find((item) => item.viewId === byId<HTMLSelectElement>("savedViewSelect").value);
  if (!saved) { showToast(t("noSavedViews"), "error"); return; }
  view = viewFromSavedFilters(saved.filters);
  resetVirtualViewport();
  syncFilterControls();
  renderAll();
  switchPanel("inventory");
  showToast(t("viewApplied"));
}

async function deleteSelectedView(): Promise<void> {
  if (!snapshot || transport.mode !== "http") return;
  const saved = snapshot.savedViews?.find((item) => item.viewId === byId<HTMLSelectElement>("savedViewSelect").value);
  if (!saved) return;
  if (!window.confirm(locale === "zh-CN" ? `删除保存视图“${saved.name}”？` : `Delete saved view “${saved.name}”?`)) return;
  await applySettingsSnapshot(() => transport.deleteView(saved.viewId, snapshot!.revision), t("deleteView"));
  byId<HTMLInputElement>("savedViewNameInput").value = "";
}

async function createCustomCategory(): Promise<void> {
  if (!snapshot || transport.mode !== "http") return;
  const slug = byId<HTMLInputElement>("customCategorySlugInput").value.normalize("NFC").trim().toLocaleLowerCase("en-US");
  const zhCN = byId<HTMLInputElement>("customCategoryZhInput").value.normalize("NFC").trim();
  const enUS = byId<HTMLInputElement>("customCategoryEnInput").value.normalize("NFC").trim();
  if (!/^[\p{L}\p{N}][\p{L}\p{N}._-]{0,63}$/u.test(slug) || !zhCN || !enUS) {
    showToast(locale === "zh-CN" ? "个人分类 ID、中文名和英文名均需有效填写" : "Enter a valid personal category ID, Chinese name, and English name", "error");
    return;
  }
  const categoryId = `custom:${slug}` as const;
  const sortOrder = Math.max(100, ...categoryDefinitions(true).map((category) => category.sortOrder + 10));
  await applySettingsSnapshot(
    () => transport.createCategory(categoryId, { zhCN, enUS }, sortOrder, snapshot!.revision),
    t("categoryCreated"),
  );
  byId<HTMLInputElement>("customCategorySlugInput").value = "";
  byId<HTMLInputElement>("customCategoryZhInput").value = "";
  byId<HTMLInputElement>("customCategoryEnInput").value = "";
}

async function saveCategoryPreference(
  category: CategoryDefinitionView,
  zhCN: string,
  enUS: string,
  sortOrderValue: string,
  hidden: boolean,
): Promise<void> {
  if (!snapshot || transport.mode !== "http") return;
  const normalizedZh = zhCN.normalize("NFC").trim();
  const normalizedEn = enUS.normalize("NFC").trim();
  if (!normalizedZh || !normalizedEn) { showToast(locale === "zh-CN" ? "中英文显示名不能为空" : "Both display names are required", "error"); return; }
  const parsedOrder = sortOrderValue.trim() === "" ? null : Number(sortOrderValue);
  if (parsedOrder !== null && !Number.isSafeInteger(parsedOrder)) { showToast(locale === "zh-CN" ? "顺序必须是整数" : "Order must be an integer", "error"); return; }
  await applySettingsSnapshot(
    () => transport.setCategoryPreference(category.id, { zhCN: normalizedZh, enUS: normalizedEn }, parsedOrder, hidden, snapshot!.revision),
    t("categoryPreferenceSaved"),
  );
}

async function deleteCustomCategory(sourceCategoryId: `custom:${string}`, targetCategoryId: CategoryId): Promise<void> {
  if (!snapshot || transport.mode !== "http" || !targetCategoryId || sourceCategoryId === targetCategoryId) return;
  const count = snapshot.summary.byCategory[sourceCategoryId] ?? 0;
  if (!window.confirm(locale === "zh-CN"
    ? `把“${categoryLabel(sourceCategoryId)}”中的 ${count} 个 Skill 迁移到“${categoryLabel(targetCategoryId)}”，然后删除个人分类？锁定项会使整个操作停止。`
    : `Migrate ${count} skills from “${categoryLabel(sourceCategoryId)}” to “${categoryLabel(targetCategoryId)}”, then delete the personal category? Locked skills stop the entire operation.`)) return;
  try {
    const response = await transport.deleteCategory(sourceCategoryId, targetCategoryId, snapshot.revision);
    const next = snapshotFromResponse(response);
    if (!next) throw new ApiError(500, "Category deletion did not return an inventory snapshot");
    if (view.category === sourceCategoryId) view.category = targetCategoryId;
    acceptSnapshot(next, true);
    const migrated = response && typeof response === "object" && typeof (response as Record<string, unknown>).migrated === "number"
      ? (response as Record<string, unknown>).migrated : count;
    showToast(`${t("categoryDeleted")} · ${migrated}`);
  } catch (error) { await handleMutationError(error); }
}

function renderManagementData(): void {
  renderUndoActions();
  renderSuggestions();
  renderUpdateEvidence();
  renderQuarantine();
  renderTagManager();
  renderManagementMode();
}

function renderUndoActions(): void {
  const list = byId("undoActionsList");
  if (transport.mode !== "http") {
    list.replaceChildren(make("div", "empty-management", t("unavailableInPanel")));
    return;
  }
  if (!undoActions.length) {
    list.replaceChildren(make("div", "empty-management", t("noUndoActions")));
    return;
  }
  list.replaceChildren(...undoActions.map((action) => {
    const row = make("div", "management-item no-check");
    const content = make("div");
    content.append(make("div", "management-item-title", t(action.kind === "classification" ? "classificationUndo" : "runtimeUndo")));
    content.append(make("div", "management-item-meta", `${new Date(action.occurredAt).toLocaleString(locale)} · ${action.targetIds.length} ${t("items")}`));
    if (!action.available && action.unavailableReason) content.append(make("p", "management-item-reason", action.unavailableReason));
    const actions = make("div", "inline-actions");
    if (action.available) {
      const undo = make("button", "button ghost compact", t("undoNow"));
      undo.type = "button";
      undo.disabled = action.kind === "runtime-enabled" && !managementMode;
      undo.title = undo.disabled ? t("managementRequired") : "";
      undo.addEventListener("click", () => void executeUndo(action));
      actions.append(undo);
    } else {
      actions.append(make("span", "diagnostic-chip", t("undoUnavailable")));
    }
    row.append(content, actions);
    return row;
  }));
}

async function refreshUndoActions(): Promise<void> {
  try { undoActions = await transport.listUndoActions(); }
  catch (error) { undoActions = []; if (!(error instanceof ApiError && error.status === 404)) showToast(error instanceof Error ? error.message : String(error), "error"); }
  renderUndoActions();
}

async function refreshSuggestions(): Promise<void> {
  try { suggestions = await transport.listSuggestions(); }
  catch (error) { suggestions = []; if (!(error instanceof ApiError && error.status === 404)) showToast(error instanceof Error ? error.message : String(error), "error"); }
  renderSuggestions(); renderMetrics();
}

async function refreshQuarantine(): Promise<void> {
  try { quarantine = await transport.getQuarantine(); }
  catch (error) { quarantine = { candidates: [], entries: [], plans: [], unavailable: true }; if (!(error instanceof ApiError && error.status === 404)) showToast(error instanceof Error ? error.message : String(error), "error"); }
  renderQuarantine();
}

async function refreshManagementData(): Promise<void> {
  try { managementMode = await transport.getManagementMode(); }
  catch { managementMode = snapshot?.managementMode ?? false; }
  await Promise.all([refreshSuggestions(), refreshQuarantine(), refreshUndoActions()]);
  renderManagementData();
}

async function executeUndo(action: UndoActionView): Promise<void> {
  if (!snapshot || transport.mode !== "http" || !action.available) return;
  if (action.kind === "runtime-enabled" && !requireManagementMode()) return;
  const sensitiveNote = action.sensitive
    ? (locale === "zh-CN" ? "\n这是系统或插件 Skill；请再次确认精确实例的 runtime 撤销。" : "\nThis is a system or plugin skill. Confirm the exact runtime instance again.")
    : "";
  const confirmed = window.confirm(locale === "zh-CN"
    ? `仅当当前状态仍与记录一致时，撤销这项${t(action.kind === "classification" ? "classificationUndo" : "runtimeUndo")}操作？${sensitiveNote}`
    : `Undo this ${t(action.kind === "classification" ? "classificationUndo" : "runtimeUndo")} only if its current state still matches the record?${sensitiveNote}`);
  if (!confirmed) return;
  try {
    const response = await transport.undoOperations([action.operationId], snapshot.revision, action.sensitive === true);
    const next = snapshotFromResponse(response);
    if (next) acceptSnapshot(next, true); else acceptSnapshot(await transport.getInventory(), true);
    await refreshUndoActions();
    const result = response && typeof response === "object" ? response as Record<string, unknown> : {};
    const failed = Array.isArray(result.failed) ? result.failed.length : 0;
    showToast(failed ? String((result.failed as Array<{ message?: string }>)[0]?.message ?? t("undoUnavailable")) : t("undoComplete"), failed ? "error" : "normal");
  } catch (error) { await handleMutationError(error); await refreshUndoActions(); }
}

async function resolveSuggestions(status: "accepted" | "rejected"): Promise<void> {
  if (!snapshot) return;
  const ids = [...selectedSuggestions].slice(0, MAX_BATCH_SIZE);
  if (!ids.length) { showToast(t("noSelection"), "error"); return; }
  try {
    await transport.resolveSuggestions(ids, status, snapshot.revision);
    acceptSnapshot(await transport.getInventory(), true);
    selectedSuggestions.clear();
    await refreshSuggestions();
    showToast(status === "accepted" ? t("acceptSelected") : t("rejectSelected"));
  } catch (error) { await handleMutationError(error); }
}

async function checkSelectedUpdates(): Promise<void> {
  if (!snapshot) return;
  const skills = snapshot.skills.filter((skill) => selected.has(skill.skillId));
  const instanceIds = instanceIdsForSkills(skills);
  if (!instanceIds.length) { showToast(t("noSelection"), "error"); switchPanel("inventory"); return; }
  if (instanceIds.length > MAX_BATCH_SIZE) { showToast(t("selectionLimit"), "error"); return; }
  const button = byId<HTMLButtonElement>("checkUpdatesButton"); button.disabled = true;
  try {
    updateEvidence = await transport.checkUpdates(instanceIds, snapshot.revision);
    renderUpdateEvidence(); showToast(t("updateChecked"));
  } catch (error) { await handleMutationError(error); }
  finally { button.disabled = false; }
}

async function confirmSelectedInstallationUnits(): Promise<void> {
  if (!snapshot || transport.mode !== "http") {
    showToast(t("unavailableInPanel"), "error");
    return;
  }
  const selectedCandidates = quarantine.candidates.filter((candidate) => selectedInstallationUnits.has(candidate.installationUnitId));
  const candidates = selectedCandidates.filter(canConfirmInstallationUnit);
  if (!candidates.length) { showToast(t("noSelection"), "error"); return; }
  if (candidates.length > MAX_BATCH_SIZE) { showToast(t("selectionLimit"), "error"); return; }
  const affectedSkills = new Set(candidates.flatMap((candidate) => candidate.affectedSkillIds ?? []));
  const lines = candidates.map((candidate) => {
    const count = candidate.skillCount ?? candidate.affectedSkillIds?.length ?? 0;
    const blockers = candidate.blockers?.map((blocker) => blocker.message ?? blocker.code ?? "blocked") ?? [];
    return `${candidate.label ?? candidate.installationUnitId} · ${count} Skill · blockers: ${blockers.length ? blockers.join(" / ") : locale === "zh-CN" ? "无" : "none"}${candidate.pathHint ? `\n${candidate.pathHint}` : ""}`;
  });
  const confirmed = window.confirm(locale === "zh-CN"
    ? `确认以下 ${candidates.length} 个安装单元的管理边界？共影响 ${affectedSkills.size || candidates.reduce((sum, candidate) => sum + (candidate.skillCount ?? 0), 0)} 个 Skill。此操作只保存边界，不移动文件。\n\n${lines.join("\n\n")}`
    : `Confirm management boundaries for ${candidates.length} installation units affecting ${affectedSkills.size || candidates.reduce((sum, candidate) => sum + (candidate.skillCount ?? 0), 0)} skills? This saves boundaries only and moves no files.\n\n${lines.join("\n\n")}`);
  if (!confirmed) return;
  try {
    const result = await transport.confirmInstallationUnits(candidates.map((candidate) => candidate.installationUnitId), snapshot.revision);
    const next = snapshotFromResponse(result);
    if (next) acceptSnapshot(next, true); else acceptSnapshot(await transport.getInventory(), true);
    await refreshQuarantine();
    const notExecuted = selectedCandidates.length - candidates.length;
    showToast(`${t("boundaryConfirmed")} ${candidates.length}${notExecuted ? ` · ${notExecuted} not executed` : ""}`);
  } catch (error) { await handleMutationError(error); }
}

async function prepareQuarantine(): Promise<void> {
  if (!snapshot) return;
  const selectedCandidates = quarantine.candidates.filter((candidate) => selectedInstallationUnits.has(candidate.installationUnitId));
  const ids = selectedCandidates.filter(canPrepareInstallationUnit).map((candidate) => candidate.installationUnitId);
  if (!ids.length) { showToast(t("noSelection"), "error"); return; }
  if (ids.length > MAX_BATCH_SIZE) { showToast(t("selectionLimit"), "error"); return; }
  try {
    const plans = await transport.prepareQuarantine(ids, snapshot.revision);
    quarantine.plans = plans;
    renderQuarantine(); showToast(t("planPrepared"));
    if (transport.mode === "mcp") await transport.openDesktop();
  } catch (error) { await handleMutationError(error); }
}

async function executeQuarantinePlan(plan: QuarantinePlanView): Promise<void> {
  if (!snapshot || !canExecuteQuarantinePlan(transport.mode, managementMode, plan) || !requireManagementMode()) return;
  if (!plan.planId || !plan.items?.length) { showToast(t("blocked"), "error"); return; }
  if (plan.inventoryRevision && plan.inventoryRevision !== snapshot.revision) {
    acceptSnapshot(await transport.getInventory());
    showToast(locale === "zh-CN" ? "清单 revision 已变化，请重新生成隔离计划" : "Inventory revision changed; prepare a new quarantine plan", "error");
    return;
  }
  const affectedSkills = new Set(plan.items.flatMap((item) => item.affectedSkillIds));
  const blockers = plan.items.flatMap((item) => item.blockers.map((blocker) => blocker.message ?? blocker.code ?? "blocked"));
  if (blockers.length) { showToast(blockers.join(" · "), "error"); return; }
  const directories = plan.items.map((item) => item.sourcePath);
  const confirmed = window.confirm(locale === "zh-CN"
    ? `确认将以下 ${directories.length} 个目录、${affectedSkills.size} 个 Skill 移入可恢复隔离区？\n\n${directories.join("\n")}\n\n批量途中失败会立即停止，未执行项保持原位。`
    : `Move these ${directories.length} directories and ${affectedSkills.size} skills into reversible quarantine?\n\n${directories.join("\n")}\n\nThe batch stops on first failure; unexecuted items stay in place.`);
  if (!confirmed) return;
  try {
    const response = await transport.executeQuarantine(plan.planId, snapshot.revision);
    const record = response && typeof response === "object" ? response as Record<string, unknown> : {};
    const result = record.result && typeof record.result === "object" ? record.result as Record<string, unknown> : {};
    const succeeded = Array.isArray(result.succeeded) ? result.succeeded.length : 0;
    const failed = Array.isArray(result.failed) ? result.failed.length : 0;
    const notExecuted = Array.isArray(result.notExecuted) ? result.notExecuted.length : 0;
    const next = snapshotFromResponse(response);
    if (next) acceptSnapshot(next, true); else acceptSnapshot(await transport.getInventory(), true);
    quarantine.plans = quarantine.plans.filter((candidate) => candidate.planId !== plan.planId);
    selectedInstallationUnits.clear();
    await refreshQuarantine();
    showToast(`${t("quarantineExecuted")} ${succeeded} succeeded · ${failed} failed · ${notExecuted} not executed`, failed ? "error" : "normal");
  } catch (error) { await handleMutationError(error); }
}

async function restoreQuarantineEntry(entry: QuarantineEntryView): Promise<void> {
  if (!requireManagementMode()) return;
  const confirmed = window.confirm(locale === "zh-CN" ? "确认按隔离记录恢复？路径冲突时会停止，绝不覆盖。" : "Restore from this quarantine record? Path conflicts stop without overwriting.");
  if (!confirmed) return;
  try {
    let result = await transport.restoreQuarantine([entry.quarantineEntryId]);
    const conflict = result.failed.find((failure) => failure.message.includes("[RESTORE_PATH_CONFLICT]"));
    if (conflict && entry.originalPathHint) {
      const alternative = window.prompt(
        locale === "zh-CN"
          ? "原路径已被占用且不会覆盖。可输入同一父目录下的新绝对路径；取消则继续保留隔离项。"
          : "The original path is occupied and will not be overwritten. Enter a new absolute path under the same parent, or cancel to keep the item quarantined.",
        `${entry.originalPathHint}.restored`,
      );
      if (!alternative?.trim()) {
        showToast(locale === "zh-CN" ? "恢复已停止；隔离项保持不变" : "Restore stopped; the item remains quarantined", "error");
        return;
      }
      result = await transport.restoreQuarantine(
        [entry.quarantineEntryId],
        { [entry.quarantineEntryId]: alternative.trim() },
      );
    }
    if (result.failed.length > 0) {
      const detail = result.failed[0]?.message ?? "restore failed";
      showToast(locale === "zh-CN"
        ? `恢复失败：${detail}；${result.notExecuted.length} 项未执行`
        : `Restore failed: ${detail}; ${result.notExecuted.length} not executed`, "error");
      await refreshQuarantine();
      return;
    }
    acceptSnapshot(await transport.getInventory(), true);
    await refreshQuarantine();
    const restoredTo = result.restoredTo?.[entry.quarantineEntryId];
    showToast(restoredTo ? `${t("restore")} · ${restoredTo}` : t("restore"));
  } catch (error) { await handleMutationError(error); }
}

async function purgeQuarantineEntry(entry: QuarantineEntryView): Promise<void> {
  if (transport.mode !== "http" || !requireManagementMode()) return;
  const confirmed = window.confirm(locale === "zh-CN"
    ? `永久清空隔离项“${entry.label ?? entry.installationUnitId}”？此操作不可恢复，隔离目录及其中的全部内容会被永久删除。`
    : `Permanently delete “${entry.label ?? entry.installationUnitId}”? This cannot be undone; the quarantine directory and all of its contents will be permanently deleted.`);
  if (!confirmed) return;
  try {
    await transport.purgeQuarantine(entry.quarantineEntryId);
    await refreshQuarantine();
    showToast(t("purgeComplete"));
  } catch (error) { await handleMutationError(error); }
}

async function applyTagOperation(deleteOnly: boolean): Promise<void> {
  if (!snapshot) return;
  const source = byId<HTMLSelectElement>("tagManagerSource").value;
  if (!source) { showToast(t("noPersonalTags"), "error"); return; }
  const targetInput = byId<HTMLInputElement>("tagManagerTarget");
  const target = deleteOnly ? null : normalizePersonalTag(targetInput.value);
  if (!deleteOnly && (!targetInput.value.trim() || target === source)) { showToast(locale === "zh-CN" ? "请输入不同的目标标签" : "Enter a different target tag", "error"); return; }
  if (deleteOnly && !window.confirm(locale === "zh-CN" ? `确认删除标签 ${source}？锁定项不会改变。` : `Delete tag ${source}? Locked skills remain unchanged.`)) return;
  const eligible = snapshot.skills.filter((skill) => skill.tags.includes(source) && !skill.locked);
  const lockedCount = snapshot.skills.filter((skill) => skill.tags.includes(source) && skill.locked).length;
  if (!eligible.length) { showToast(t("lockedExcluded"), "error"); return; }
  let next = snapshot;
  let succeeded = 0;
  const batches = chunkAtMost100(eligible);
  for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
    const batch = batches[batchIndex]!;
    try {
      next = await transport.applyClassification({
        skillIds: batch.map((skill) => skill.skillId), expectedRevision: next.revision,
        removeTagIds: [source], addTagIds: target ? [target] : [], reason: deleteOnly ? "tag-delete" : "tag-rename-or-merge",
      });
      succeeded += batch.length;
    } catch (error) {
      try { acceptSnapshot(await transport.getInventory(), true); } catch { /* keep the last verified snapshot */ }
      const notExecuted = eligible.length - succeeded - batch.length;
      const detail = error instanceof Error ? error.message : String(error);
      showToast(locale === "zh-CN"
        ? `标签操作已停止：${succeeded} 项成功，当前 ${batch.length} 项失败或状态未知，${notExecuted} 项未执行。${detail}`
        : `Tag operation stopped: ${succeeded} succeeded, ${batch.length} in the current batch failed or are unknown, ${notExecuted} were not executed. ${detail}`, "error");
      return;
    }
  }
  acceptSnapshot(next, true); targetInput.value = "";
  showToast(`${eligible.length} ${t("items")}${lockedCount ? ` · ${lockedCount} ${t("lockedExcluded")}` : ""}`);
}

function bindEvents(): void {
  document.querySelectorAll<HTMLButtonElement>("[data-panel]").forEach((button) => button.addEventListener("click", () => switchPanel(button.dataset.panel as PanelName)));
  document.querySelectorAll<HTMLButtonElement>("[data-target-panel]").forEach((button) => button.addEventListener("click", () => switchPanel(button.dataset.targetPanel as PanelName)));
  byId("managementStatusButton").addEventListener("click", () => switchPanel("management"));
  byId("languageButton").addEventListener("click", () => { locale = locale === "zh-CN" ? "en-US" : "zh-CN"; localStorage.setItem("cso-locale-v2", locale); applyLocale(); });

  const desktopButton = byId<HTMLButtonElement>("desktopButton");
  desktopButton.hidden = transport.mode !== "mcp";
  desktopButton.addEventListener("click", () => void transport.openDesktop().catch((error) => showToast(error instanceof Error ? error.message : String(error), "error")));

  const search = byId<HTMLInputElement>("searchInput"); search.value = view.query;
  search.addEventListener("input", () => { view.query = search.value; resetVirtualViewport(); renderTable(); });
  const runtimeFilter = byId<HTMLSelectElement>("runtimeFilter"); runtimeFilter.value = view.runtime;
  runtimeFilter.addEventListener("change", () => { view.runtime = runtimeFilter.value as ViewState["runtime"]; resetVirtualViewport(); renderTable(); });
  byId<HTMLSelectElement>("sourceFilter").addEventListener("change", (event) => { view.source = (event.currentTarget as HTMLSelectElement).value; resetVirtualViewport(); renderTable(); });
  byId<HTMLSelectElement>("pluginFilter").addEventListener("change", (event) => { view.plugin = (event.currentTarget as HTMLSelectElement).value; resetVirtualViewport(); renderTable(); });
  byId<HTMLSelectElement>("tagFilter").addEventListener("change", (event) => { view.tag = (event.currentTarget as HTMLSelectElement).value; resetVirtualViewport(); renderTable(); });
  const duplicate = byId<HTMLInputElement>("duplicateFilter"); duplicate.checked = view.duplicatesOnly;
  duplicate.addEventListener("change", () => { view.duplicatesOnly = duplicate.checked; resetVirtualViewport(); renderTable(); });
  byId("resetFiltersButton").addEventListener("click", () => { view = { ...defaultView }; resetVirtualViewport(); syncFilterControls(); renderAll(); });
  const tableWrap = byId("tableWrap");
  tableWrap.addEventListener("scroll", () => {
    if (virtualScrollFrame !== null) return;
    virtualScrollFrame = window.requestAnimationFrame(() => {
      virtualScrollFrame = null;
      renderTable();
    });
  }, { passive: true });
  window.addEventListener("resize", () => {
    if (activePanel === "inventory") window.requestAnimationFrame(renderTable);
  }, { passive: true });
  byId("previousPage").addEventListener("click", () => { tableWrap.scrollTop = 0; renderTable(); tableWrap.focus(); });
  byId("nextPage").addEventListener("click", () => { tableWrap.scrollTop = tableWrap.scrollHeight; renderTable(); tableWrap.focus(); });
  byId<HTMLInputElement>("selectPage").addEventListener("change", (event) => {
    const checked = (event.currentTarget as HTMLInputElement).checked;
    const visibleIds = new Set(renderedSkillIds);
    const visibleSkills = (snapshot?.skills ?? []).filter((skill) => visibleIds.has(skill.skillId) && !skill.locked);
    for (const skill of visibleSkills) {
      if (checked && !addSelected(skill.skillId)) break;
      if (!checked) selected.delete(skill.skillId);
    }
    renderTable(); renderBulkBar();
  });

  const bulkCategory = byId<HTMLSelectElement>("bulkCategory");
  renderBulkCategorySelect();
  byId("bulkApplyButton").addEventListener("click", () => {
    if (!snapshot) return;
    const tags = parseBulkTags(); const value = bulkCategory.value;
    if (!value && !tags.length) { showToast(locale === "zh-CN" ? "请选择分类或填写标签" : "Choose a category or enter tags", "error"); return; }
    const patch: ClassificationPatch = { skillIds: [...selected], expectedRevision: snapshot.revision, addTagIds: tags, reason: "bulk-manual-workbench" };
    if (value) patch.primaryCategoryId = value === "__pending" ? null : value as CategoryId;
    void mutateClassification(patch, `${selected.size} ${t("items")}`);
  });
  byId("bulkFavoriteButton").addEventListener("click", () => snapshot && void mutateClassification({ skillIds: [...selected], expectedRevision: snapshot.revision, favorite: true }, t("favorite")));
  byId("bulkRestoreButton").addEventListener("click", () => snapshot && void mutateClassification({ skillIds: [...selected], expectedRevision: snapshot.revision, restoreAutomatic: true }, t("restoreAutomatic")));
  byId("bulkEnableButton").addEventListener("click", () => {
    if (!snapshot) return;
    const ids = snapshot.skills.filter((skill) => selected.has(skill.skillId))
      .flatMap((skill) => skillInstances(skill).filter((instance) => instance.runtimeDiscovered).map((instance) => instance.instanceId));
    void toggleRuntime(ids, true);
  });
  byId("bulkDisableButton").addEventListener("click", () => {
    if (!snapshot) return;
    const ids = snapshot.skills.filter((skill) => selected.has(skill.skillId))
      .flatMap((skill) => skillInstances(skill).filter((instance) => instance.runtimeDiscovered).map((instance) => instance.instanceId));
    void toggleRuntime(ids, false);
  });

  byId("rescanButton").addEventListener("click", async () => {
    const button = byId<HTMLButtonElement>("rescanButton"); button.disabled = true;
    try { acceptSnapshot(await transport.rescan(), true); showToast(t("rescan")); }
    catch (error) { await handleMutationError(error); }
    finally { button.disabled = false; }
  });
  byId("smartSortButton").addEventListener("click", async () => {
    if (window.openai?.sendFollowUpMessage) {
      await window.openai.sendFollowUpMessage({
        prompt: "请先使用 list_classification_candidates 获取当前待整理 Skill 的最小化元数据，再使用 submit_classification_suggestions 生成暂存建议。只能读取候选工具返回的名称、description、来源和已有 category；只能从 allowedCategoryIds 中选择。非法、冲突或置信度低于 0.8 的结果保持待整理，不得直接改写最终分类。",
        scrollToBottom: true,
      });
    } else showToast(locale === "zh-CN" ? "智能判断只在 Codex 会话内运行；桌面版可审核暂存建议。" : "Model classification runs only inside a Codex conversation; staged suggestions are reviewed on desktop.", "error");
  });
  byId("diagnosticsButton").addEventListener("click", async () => {
    try {
      byId("diagnosticsContent").textContent = JSON.stringify(await transport.diagnostics(), null, 2);
      byId<HTMLDialogElement>("diagnosticsDialog").showModal();
      byId<HTMLButtonElement>("pluginManagementButton").focus();
    }
    catch (error) { showToast(error instanceof Error ? error.message : String(error), "error"); }
  });
  byId("supportBundleButton").addEventListener("click", () => void createFullSupportBundle());
  byId("pluginManagementButton").addEventListener("click", () => void openNativePluginManagement());

  byId<HTMLInputElement>("managementModeToggle").addEventListener("change", async (event) => {
    const toggle = event.currentTarget as HTMLInputElement;
    if (transport.mode === "mcp") { toggle.checked = managementMode; await transport.openDesktop(); return; }
    const desired = toggle.checked;
    if (desired && !window.confirm(locale === "zh-CN" ? "开启后允许精确启停、隔离与恢复。所有高风险动作仍会再次确认。是否开启？" : "Enable exact runtime, quarantine, and restore actions? High-risk actions still require confirmation.")) { toggle.checked = false; return; }
    toggle.disabled = true;
    try { managementMode = await transport.setManagementMode(desired); if (snapshot) snapshot.managementMode = managementMode; renderManagementMode(); showToast(t(managementMode ? "managementOn" : "managementOff")); }
    catch (error) { toggle.checked = managementMode; showToast(error instanceof Error ? error.message : String(error), "error"); }
    finally { toggle.disabled = false; }
  });
  byId("refreshManagementButton").addEventListener("click", () => void refreshManagementData());
  byId("addRootButton").addEventListener("click", () => void addConfiguredRoot());
  byId("selectProjectButton").addEventListener("click", () => {
    const projectPath = byId<HTMLInputElement>("projectPathInput").value.trim();
    if (!projectPath) {
      showToast(locale === "zh-CN" ? "请输入本机项目绝对路径" : "Enter a local absolute project path", "error");
      return;
    }
    void updateSelectedProject(projectPath);
  });
  byId("clearProjectButton").addEventListener("click", () => void updateSelectedProject(null));
  byId<HTMLSelectElement>("savedViewSelect").addEventListener("change", renderSavedViews);
  byId("applySavedViewButton").addEventListener("click", applySelectedView);
  byId("saveCurrentViewButton").addEventListener("click", () => void saveCurrentView());
  byId("deleteSavedViewButton").addEventListener("click", () => void deleteSelectedView());
  byId("createCustomCategoryButton").addEventListener("click", () => void createCustomCategory());
  byId("refreshSuggestionsButton").addEventListener("click", () => void refreshSuggestions());
  byId("acceptSuggestionsButton").addEventListener("click", () => void resolveSuggestions("accepted"));
  byId("rejectSuggestionsButton").addEventListener("click", () => void resolveSuggestions("rejected"));
  byId("checkUpdatesButton").addEventListener("click", () => void checkSelectedUpdates());
  byId("confirmInstallationUnitsButton").addEventListener("click", () => void confirmSelectedInstallationUnits());
  byId("prepareQuarantineButton").addEventListener("click", () => void prepareQuarantine());
  byId("tagManagerSource").addEventListener("change", renderTagManager);
  byId("renameTagButton").addEventListener("click", () => void applyTagOperation(false));
  byId("deleteTagButton").addEventListener("click", () => void applyTagOperation(true));

  byId("closeDrawer").addEventListener("click", closeDrawer);
  byId("drawerBackdrop").addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && openSkillId) closeDrawer(); });
}

channel?.addEventListener("message", async (event) => {
  if (!snapshot || event.data?.revision === snapshot.revision) return;
  try { acceptSnapshot(await transport.getInventory()); showToast(locale === "zh-CN" ? "另一个窗口已修改数据，当前清单已同步" : "Inventory synchronized after another window changed data"); }
  catch { /* stale revision remains fail-closed */ }
});

async function start(): Promise<void> {
  applyLocale();
  bindEvents();
  try {
    acceptSnapshot(await transport.initialize());
    try { managementMode = await transport.getManagementMode(); } catch { managementMode = snapshot?.managementMode ?? false; }
    renderManagementMode();
    setSaveStatus(locale === "zh-CN" ? "0.2 SQLite 状态已加载；旧版 JSON 未迁移" : "0.2 SQLite loaded; legacy JSON was not migrated");
    void refreshManagementData();
  } catch (error) {
    byId("loadingState").hidden = true;
    const panel = byId("errorState"); panel.hidden = false;
    panel.textContent = `${error instanceof Error ? error.message : String(error)}. ${locale === "zh-CN" ? "请从桌面快捷方式重新打开工作台。" : "Reopen the workbench from the desktop shortcut."}`;
    switchPanel("inventory");
  }
}

void start();
