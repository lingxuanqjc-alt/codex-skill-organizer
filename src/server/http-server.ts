import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { InventoryMutationError, InventoryService, StaleInventoryError } from "../core/inventory-service.js";
import type { CategoryId, ClassificationPatch } from "../shared/types.js";
import { SessionManager } from "./auth.js";
import { createSupportBundle } from "./support-bundle.js";
import type { ServiceLifecycle } from "./service-lifecycle.js";
import {
  DEFAULT_FETCH_SAFE_PORT_ATTEMPTS,
  selectFetchSafeListeningEndpoint,
} from "./safe-listen.js";
import {
  PRODUCT_VERSION,
  PROTOCOL_MAX,
  PROTOCOL_MIN,
  PROTOCOL_VERSION,
  SERVICE_ID,
} from "../shared/version.js";

const MAX_BODY_BYTES = 1024 * 1024;

interface StaticAsset {
  contentType: string;
  body: Buffer;
}

export interface OrganizerHttpServerOptions {
  inventory: InventoryService;
  publicDirectory: string;
  host?: string;
  port?: number;
  version?: string;
  protocolVersion?: string;
  sessionManager?: SessionManager;
  serviceLifecycle?: ServiceLifecycle;
  supportFileProtector?: (targetPath: string) => Promise<void>;
}

export interface RunningOrganizerServer {
  server: Server;
  host: string;
  port: number;
  baseUrl: string;
  bootstrapToken: string;
  close(): Promise<void>;
}

function setSecurityHeaders(response: ServerResponse, isApi: boolean): void {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
  response.setHeader("Cache-Control", isApi ? "no-store" : "no-cache");
}

function json(response: ServerResponse, status: number, payload: unknown): void {
  setSecurityHeaders(response, true);
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(`${JSON.stringify(payload)}\n`);
}

function isAllowedOrigin(request: IncomingMessage, port: number): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === "http:"
      && ["127.0.0.1", "localhost"].includes(parsed.hostname)
      && Number(parsed.port) === port;
  } catch {
    return false;
  }
}

export function redactDiagnosticPath(value: string): string {
  if (!path.isAbsolute(value)) return value.slice(0, 160);
  const home = os.homedir();
  const relativeToHome = path.relative(home, value);
  if (relativeToHome && !relativeToHome.startsWith("..") && !path.isAbsolute(relativeToHome)) {
    return path.join("%USERPROFILE%", relativeToHome);
  }
  if (relativeToHome === "") return "%USERPROFILE%";
  const basename = path.basename(value);
  return basename ? path.join("%LOCAL_PATH%", basename) : "%LOCAL_PATH%";
}

export function sanitizeDiagnosticScanError(error: { path: string; message: string }): {
  path: string;
  code: string;
  message: string;
} {
  const message = error.message.toLocaleUpperCase("en-US");
  if (message.includes("EACCES") || message.includes("EPERM") || message.includes("ACCESS")) {
    return { path: redactDiagnosticPath(error.path), code: "SCAN_ACCESS_DENIED", message: "扫描路径不可访问" };
  }
  if (message.includes("ENOENT") || message.includes("NOT FOUND") || message.includes("不存在")) {
    return { path: redactDiagnosticPath(error.path), code: "SCAN_PATH_MISSING", message: "扫描路径不存在或当前不可用" };
  }
  if (message.includes("SYMLINK") || message.includes("JUNCTION") || message.includes("LINK")) {
    return { path: redactDiagnosticPath(error.path), code: "SCAN_LINK_BLOCKED", message: "扫描路径包含不受支持的链接" };
  }
  if (message.includes("LOOP") || message.includes("CYCLE") || message.includes("循环")) {
    return { path: redactDiagnosticPath(error.path), code: "SCAN_PATH_LOOP", message: "扫描路径存在目录循环" };
  }
  return { path: redactDiagnosticPath(error.path), code: "SCAN_FAILED", message: "扫描未完成，请检查该根目录" };
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new InventoryMutationError("请求体超过 1 MiB 上限");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new InventoryMutationError("请求体不是有效 JSON");
  }
}

async function loadStaticAssets(publicDirectory: string): Promise<Map<string, StaticAsset>> {
  const definitions: Array<[string, string, string]> = [
    ["/", "index.html", "text/html; charset=utf-8"],
    ["/index.html", "index.html", "text/html; charset=utf-8"],
    ["/app.js", "app.js", "text/javascript; charset=utf-8"],
    ["/styles.css", "styles.css", "text/css; charset=utf-8"],
    ["/premium-minimal.css", "premium-minimal.css", "text/css; charset=utf-8"],
  ];
  const assets = new Map<string, StaticAsset>();
  for (const [route, fileName, contentType] of definitions) {
    assets.set(route, { contentType, body: await readFile(path.join(publicDirectory, fileName)) });
  }
  return assets;
}

function validateClassificationBody(value: unknown): ClassificationPatch {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InventoryMutationError("classification 请求体无效");
  }
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.skillIds) || !record.skillIds.every((item) => typeof item === "string")) {
    throw new InventoryMutationError("skillIds 必须是字符串数组");
  }
  if (typeof record.expectedRevision !== "string") throw new InventoryMutationError("缺少 expectedRevision");
  return record as unknown as ClassificationPatch;
}

function isSavedViewFilters(value: unknown): value is Record<string, string | boolean | string[] | null> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every((item) => (
    item === null
    || typeof item === "string"
    || typeof item === "boolean"
    || (Array.isArray(item) && item.every((entry) => typeof entry === "string"))
  ));
}

export async function startOrganizerHttpServer(
  options: OrganizerHttpServerOptions,
): Promise<RunningOrganizerServer> {
  const host = options.host ?? "127.0.0.1";
  if (host !== "127.0.0.1") throw new Error("安全限制：服务只能绑定 127.0.0.1");
  const version = options.version ?? PRODUCT_VERSION;
  const protocolVersion = options.protocolVersion ?? PROTOCOL_VERSION;
  const sessions = options.sessionManager ?? new SessionManager();
  const assets = await loadStaticAssets(options.publicDirectory);
  let actualPort = 0;

  const requestListener = async (request: IncomingMessage, response: ServerResponse) => {
    const requestUrl = new URL(request.url ?? "/", `http://${host}:${actualPort || 80}`);
    const pathname = requestUrl.pathname;
    try {
      if (!isAllowedOrigin(request, actualPort)) {
        json(response, 403, { error: "请求来源不受信任" });
        return;
      }
      options.serviceLifecycle?.recordRequest();

      if (request.method === "GET" && pathname === "/api/health") {
        const credentialsExpired = sessions.credentialsExpired;
        json(response, credentialsExpired ? 503 : 200, {
          ok: !credentialsExpired,
          service: SERVICE_ID,
          version,
          protocolVersion,
          protocolMin: PROTOCOL_MIN,
          protocolMax: PROTOCOL_MAX,
          pid: process.pid,
          ...(credentialsExpired ? { error: "本地服务凭据已到期，正在轮换" } : {}),
        });
        return;
      }

      if (pathname === "/api/session" && request.method === "POST") {
        const authorization = request.headers.authorization;
        const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
        const session = sessions.exchangeBootstrapToken(token);
        if (!session) {
          json(response, 401, { error: "启动令牌无效" });
          return;
        }
        sessions.setSessionCookie(response, session);
        json(response, 200, { csrf: session.csrf });
        return;
      }

      if (pathname === "/api/session" && request.method === "GET") {
        const auth = sessions.authenticate(request);
        if (!auth || auth.mode !== "cookie") {
          json(response, 401, { error: "会话不可用，请从桌面快捷方式重新打开" });
          return;
        }
        json(response, 200, { csrf: auth.csrf });
        return;
      }

      if (pathname.startsWith("/api/")) {
        const auth = sessions.authenticate(request);
        if (!auth) {
          json(response, 401, { error: "未授权" });
          return;
        }
        const mutating = !["GET", "HEAD"].includes(request.method ?? "GET");
        if (mutating && !sessions.validateCsrf(request, auth)) {
          json(response, 403, { error: "CSRF 校验失败" });
          return;
        }

        if (request.method === "PUT" && pathname === "/api/desktop-lease") {
          if (auth.mode !== "bearer" || !options.serviceLifecycle) {
            json(response, 403, { error: "桌面租约只能由已安装的桌面壳更新" });
            return;
          }
          const body = await readJsonBody(request) as Record<string, unknown>;
          if (
            typeof body.leaseId !== "string"
            || typeof body.active !== "boolean"
            || !Number.isSafeInteger(body.generation)
          ) throw new InventoryMutationError("桌面租约请求无效");
          json(response, 200, options.serviceLifecycle.updateDesktopLease(
            body.leaseId,
            body.active,
            body.generation as number,
          ));
          return;
        }

        if (request.method === "GET" && pathname === "/api/inventory") {
          json(response, 200, options.inventory.snapshot);
          return;
        }
        if (request.method === "POST" && pathname === "/api/rescan") {
          json(response, 200, await options.inventory.refresh(true));
          return;
        }
        if (request.method === "GET" && pathname === "/api/management-mode") {
          json(response, 200, { enabled: options.inventory.managementMode });
          return;
        }
        if (request.method === "PUT" && pathname === "/api/management-mode") {
          if (auth.mode !== "cookie") {
            json(response, 403, { error: "管理模式只能由用户在桌面工作台中开启或关闭" });
            return;
          }
          const body = await readJsonBody(request) as Record<string, unknown>;
          if (typeof body.enabled !== "boolean") throw new InventoryMutationError("enabled 必须是布尔值");
          json(response, 200, await options.inventory.setManagementMode(body.enabled));
          return;
        }
        if (request.method === "POST" && pathname === "/api/roots") {
          if (auth.mode !== "cookie") {
            json(response, 403, { error: "自定义根只能由用户在桌面工作台添加" });
            return;
          }
          const body = await readJsonBody(request) as Record<string, unknown>;
          if (
            typeof body.absolutePath !== "string"
            || typeof body.label !== "string"
            || typeof body.expectedRevision !== "string"
          ) throw new InventoryMutationError("自定义根请求无效");
          json(response, 200, await options.inventory.addCustomRoot(
            body.absolutePath,
            body.label,
            body.expectedRevision,
          ));
          return;
        }
        if (request.method === "PATCH" && pathname === "/api/roots/management") {
          if (auth.mode !== "cookie") {
            json(response, 403, { error: "自定义根管理授权只能在桌面工作台修改" });
            return;
          }
          const body = await readJsonBody(request) as Record<string, unknown>;
          if (
            typeof body.rootId !== "string"
            || typeof body.managementAuthorized !== "boolean"
            || typeof body.expectedRevision !== "string"
          ) throw new InventoryMutationError("自定义根授权请求无效");
          json(response, 200, await options.inventory.setCustomRootManagement(
            body.rootId,
            body.managementAuthorized,
            body.expectedRevision,
          ));
          return;
        }
        if (request.method === "DELETE" && pathname === "/api/roots") {
          if (auth.mode !== "cookie") {
            json(response, 403, { error: "自定义根只能由用户在桌面工作台移除" });
            return;
          }
          const body = await readJsonBody(request) as Record<string, unknown>;
          if (typeof body.rootId !== "string" || typeof body.expectedRevision !== "string") {
            throw new InventoryMutationError("自定义根移除请求无效");
          }
          json(response, 200, await options.inventory.removeCustomRoot(body.rootId, body.expectedRevision));
          return;
        }
        if (request.method === "PUT" && pathname === "/api/project") {
          if (auth.mode !== "cookie") {
            json(response, 403, { error: "项目选择只能由用户在桌面工作台修改" });
            return;
          }
          const body = await readJsonBody(request) as Record<string, unknown>;
          if (
            body.projectPath !== null
            && typeof body.projectPath !== "string"
          ) throw new InventoryMutationError("projectPath 必须是绝对路径或 null");
          if (typeof body.expectedRevision !== "string") throw new InventoryMutationError("缺少 expectedRevision");
          json(response, 200, await options.inventory.selectProject(
            body.projectPath as string | null,
            body.expectedRevision,
          ));
          return;
        }
        if (request.method === "POST" && pathname === "/api/session-project") {
          if (auth.mode !== "bearer") {
            json(response, 403, { error: "会话项目上下文只能由已安装的 Codex 插件传入" });
            return;
          }
          const body = await readJsonBody(request) as Record<string, unknown>;
          if (typeof body.projectPath === "string") {
            json(response, 200, await options.inventory.registerSessionProject(body.projectPath));
            return;
          }
          if (
            typeof body.sessionId !== "string"
            || !Array.isArray(body.projectPaths)
            || body.projectPaths.some((candidate) => typeof candidate !== "string")
          ) throw new InventoryMutationError("会话 projectPaths 无效");
          json(response, 200, await options.inventory.replaceSessionProjects(
            body.sessionId,
            body.projectPaths as string[],
          ));
          return;
        }
        if (request.method === "PUT" && pathname === "/api/saved-views") {
          if (auth.mode !== "cookie") {
            json(response, 403, { error: "保存视图只能在桌面工作台修改" });
            return;
          }
          const body = await readJsonBody(request) as Record<string, unknown>;
          if (
            typeof body.viewId !== "string"
            || typeof body.name !== "string"
            || !isSavedViewFilters(body.filters)
            || typeof body.expectedRevision !== "string"
          ) throw new InventoryMutationError("保存视图请求无效");
          json(response, 200, await options.inventory.saveView({
            viewId: body.viewId,
            name: body.name,
            filters: body.filters,
          }, body.expectedRevision));
          return;
        }
        if (request.method === "DELETE" && pathname === "/api/saved-views") {
          if (auth.mode !== "cookie") {
            json(response, 403, { error: "保存视图只能在桌面工作台删除" });
            return;
          }
          const body = await readJsonBody(request) as Record<string, unknown>;
          if (typeof body.viewId !== "string" || typeof body.expectedRevision !== "string") {
            throw new InventoryMutationError("删除保存视图请求无效");
          }
          json(response, 200, await options.inventory.deleteView(body.viewId, body.expectedRevision));
          return;
        }
        if (request.method === "POST" && pathname === "/api/categories") {
          if (auth.mode !== "cookie") {
            json(response, 403, { error: "个人一级分类只能在桌面工作台创建" });
            return;
          }
          const body = await readJsonBody(request) as Record<string, unknown>;
          const label = body.label as Record<string, unknown> | undefined;
          if (
            typeof body.categoryId !== "string"
            || !body.categoryId.startsWith("custom:")
            || !label
            || typeof label.zhCN !== "string"
            || typeof label.enUS !== "string"
            || !Number.isSafeInteger(body.sortOrder)
            || typeof body.hidden !== "boolean"
            || typeof body.expectedRevision !== "string"
          ) throw new InventoryMutationError("个人分类请求无效");
          json(response, 200, await options.inventory.createCustomCategory({
            categoryId: body.categoryId as `custom:${string}`,
            label: { zhCN: label.zhCN, enUS: label.enUS },
            sortOrder: body.sortOrder as number,
            hidden: body.hidden,
          }, body.expectedRevision));
          return;
        }
        if (request.method === "DELETE" && pathname === "/api/categories") {
          if (auth.mode !== "cookie") {
            json(response, 403, { error: "个人一级分类只能在桌面工作台删除" });
            return;
          }
          const body = await readJsonBody(request) as Record<string, unknown>;
          if (
            typeof body.sourceCategoryId !== "string"
            || !body.sourceCategoryId.startsWith("custom:")
            || typeof body.targetCategoryId !== "string"
            || typeof body.expectedRevision !== "string"
          ) throw new InventoryMutationError("删除个人分类请求无效");
          json(response, 200, await options.inventory.deleteCustomCategory(
            body.sourceCategoryId as `custom:${string}`,
            body.targetCategoryId as CategoryId,
            body.expectedRevision,
          ));
          return;
        }
        if (request.method === "PUT" && pathname === "/api/category-preferences") {
          if (auth.mode !== "cookie") {
            json(response, 403, { error: "分类显示设置只能在桌面工作台修改" });
            return;
          }
          const body = await readJsonBody(request) as Record<string, unknown>;
          const display = body.display as Record<string, unknown> | undefined;
          if (
            typeof body.categoryId !== "string"
            || !display
            || (display.zhCN !== undefined && typeof display.zhCN !== "string")
            || (display.enUS !== undefined && typeof display.enUS !== "string")
            || (body.sortOrder !== null && !Number.isSafeInteger(body.sortOrder))
            || typeof body.hidden !== "boolean"
            || typeof body.expectedRevision !== "string"
          ) throw new InventoryMutationError("分类显示设置请求无效");
          json(response, 200, await options.inventory.setCategoryPreference({
            categoryId: body.categoryId as CategoryId,
            display: {
              ...(typeof display.zhCN === "string" ? { zhCN: display.zhCN } : {}),
              ...(typeof display.enUS === "string" ? { enUS: display.enUS } : {}),
            },
            sortOrder: body.sortOrder as number | null,
            hidden: body.hidden,
          }, body.expectedRevision));
          return;
        }
        if (request.method === "PATCH" && pathname === "/api/classification") {
          const body = validateClassificationBody(await readJsonBody(request));
          json(response, 200, await options.inventory.applyClassification(body));
          return;
        }
        if (request.method === "POST" && pathname === "/api/runtime-enabled") {
          const body = await readJsonBody(request) as Record<string, unknown>;
          if (!Array.isArray(body.skillIds) || !body.skillIds.every((item) => typeof item === "string")) {
            throw new InventoryMutationError("skillIds 必须是字符串数组");
          }
          if (typeof body.enabled !== "boolean" || typeof body.expectedRevision !== "string") {
            throw new InventoryMutationError("enabled/expectedRevision 无效");
          }
          if (auth.mode === "bearer" && body.confirmedSensitive === true) {
            json(response, 403, { error: "系统或插件 skill 的启停只能由用户在桌面工作台中确认" });
            return;
          }
          json(response, 200, await options.inventory.setSkillEnabled(
            body.skillIds,
            body.enabled,
            body.expectedRevision,
            auth.mode === "cookie" && body.confirmedSensitive === true,
          ));
          return;
        }
        if (request.method === "GET" && pathname === "/api/undo-actions") {
          if (auth.mode !== "cookie") {
            json(response, 403, { error: "撤销清单只能由桌面工作台读取" });
            return;
          }
          json(response, 200, { actions: options.inventory.listUndoActions() });
          return;
        }
        if (request.method === "POST" && pathname === "/api/undo-actions/execute") {
          if (auth.mode !== "cookie") {
            json(response, 403, { error: "撤销只能由用户在桌面工作台中确认" });
            return;
          }
          const body = await readJsonBody(request) as Record<string, unknown>;
          if (
            !Array.isArray(body.operationIds)
            || !body.operationIds.every((item) => typeof item === "string")
            || typeof body.expectedRevision !== "string"
          ) throw new InventoryMutationError("撤销请求无效");
          json(response, 200, await options.inventory.undoOperations(
            body.operationIds as string[],
            body.expectedRevision,
            body.confirmedSensitive === true,
          ));
          return;
        }
        if (request.method === "GET" && pathname === "/api/classification-suggestions") {
          json(response, 200, { suggestions: options.inventory.listClassificationSuggestions() });
          return;
        }
        if (request.method === "POST" && pathname === "/api/classification-suggestions") {
          const body = await readJsonBody(request) as Record<string, unknown>;
          if (typeof body.expectedRevision !== "string" || !Array.isArray(body.suggestions)) {
            throw new InventoryMutationError("expectedRevision/suggestions 无效");
          }
          json(response, 200, await options.inventory.submitClassificationSuggestions(
            body.expectedRevision,
            body.suggestions as Parameters<InventoryService["submitClassificationSuggestions"]>[1],
          ));
          return;
        }
        if (request.method === "POST" && pathname === "/api/classification-suggestions/resolve") {
          const body = await readJsonBody(request) as Record<string, unknown>;
          if (
            typeof body.expectedRevision !== "string"
            || !Array.isArray(body.suggestionIds)
            || !body.suggestionIds.every((item) => typeof item === "string")
            || (body.status !== "accepted" && body.status !== "rejected")
          ) throw new InventoryMutationError("建议处理请求无效");
          json(response, 200, await options.inventory.resolveClassificationSuggestions(
            body.suggestionIds as string[],
            body.status,
            body.expectedRevision,
          ));
          return;
        }
        if (request.method === "POST" && pathname === "/api/update-check") {
          const body = await readJsonBody(request) as Record<string, unknown>;
          if (
            typeof body.expectedRevision !== "string"
            || body.forceRefresh !== true
            || !Array.isArray(body.instanceIds)
            || !body.instanceIds.every((item) => typeof item === "string")
          ) throw new InventoryMutationError("更新检查请求无效");
          json(response, 200, await options.inventory.checkSkillUpdates({
            instanceIds: body.instanceIds as string[],
            expectedRevision: body.expectedRevision,
            forceRefresh: true,
          }));
          return;
        }
        if (request.method === "GET" && pathname === "/api/quarantine") {
          const candidates = await options.inventory.discoverInstallationUnits();
          json(response, 200, {
            candidates: candidates.map((candidate) => ({
              ...candidate,
              label: path.basename(candidate.absolutePath),
              pathHint: candidate.absolutePath,
              skillCount: candidate.affectedSkillIds.length,
              allowed: candidate.confirmed && candidate.managementAuthorized && candidate.blockers.length === 0,
              blockedReasons: [
                ...(!candidate.confirmed ? ["需要用户确认安装单元边界"] : []),
                ...(!candidate.managementAuthorized ? ["根目录未授权管理"] : []),
                ...candidate.blockers.map((blocker) => blocker.message),
              ],
            })),
            entries: options.inventory.listQuarantineEntries().map((entry) => ({
              ...entry,
              label: path.basename(entry.originalPath),
              originalPathHint: entry.originalPath,
            })),
            plans: [],
          });
          return;
        }
        if (request.method === "POST" && pathname === "/api/installation-units/confirm") {
          if (auth.mode !== "cookie") {
            json(response, 403, { error: "安装单元边界只能由用户在桌面工作台确认" });
            return;
          }
          const body = await readJsonBody(request) as Record<string, unknown>;
          if (
            typeof body.expectedRevision !== "string"
            || !Array.isArray(body.installationUnitIds)
            || !body.installationUnitIds.every((item) => typeof item === "string")
          ) throw new InventoryMutationError("安装单元确认请求无效");
          json(response, 200, await options.inventory.confirmInstallationUnits(
            body.installationUnitIds as string[],
            body.expectedRevision,
          ));
          return;
        }
        if (request.method === "POST" && pathname === "/api/quarantine/prepare") {
          const body = await readJsonBody(request) as Record<string, unknown>;
          if (
            typeof body.expectedRevision !== "string"
            || !Array.isArray(body.installationUnitIds)
            || !body.installationUnitIds.every((item) => typeof item === "string")
          ) throw new InventoryMutationError("隔离计划请求无效");
          const plan = await options.inventory.prepareSkillQuarantine(
            body.installationUnitIds as string[],
            body.expectedRevision,
          );
          json(response, 200, {
            plans: [{
              ...plan,
              allowed: plan.executable,
              affectedSkillCount: new Set(plan.items.flatMap((item) => item.affectedSkillIds)).size,
              blockedReasons: plan.items.flatMap((item) => item.blockers.map((blocker) => blocker.message)),
              treeSummary: plan.items.flatMap((item) => item.tree.map((entry) => `${item.sourcePath} › ${entry.relativePath}`)),
              summary: plan.executable ? "计划已通过安全检查，仍需桌面二次确认" : "计划包含安全阻断项",
            }],
          });
          return;
        }
        if (request.method === "POST" && pathname === "/api/quarantine/execute") {
          if (auth.mode !== "cookie") {
            json(response, 403, { error: "实际隔离只能由用户在桌面工作台确认" });
            return;
          }
          const body = await readJsonBody(request) as Record<string, unknown>;
          if (
            typeof body.planId !== "string"
            || body.confirmed !== true
            || typeof body.expectedRevision !== "string"
          ) throw new InventoryMutationError("隔离执行确认无效");
          json(response, 200, await options.inventory.executeSkillQuarantine(
            body.planId,
            true,
            body.expectedRevision,
          ));
          return;
        }
        if (request.method === "POST" && pathname === "/api/quarantine/restore") {
          if (auth.mode !== "cookie") {
            json(response, 403, { error: "隔离恢复只能由用户在桌面工作台中确认" });
            return;
          }
          const body = await readJsonBody(request) as Record<string, unknown>;
          if (
            body.confirmed !== true
            || !Array.isArray(body.quarantineEntryIds)
            || !body.quarantineEntryIds.every((item) => typeof item === "string")
            || (body.restoreTargets !== undefined && (
              !body.restoreTargets
              || typeof body.restoreTargets !== "object"
              || Array.isArray(body.restoreTargets)
              || !Object.entries(body.restoreTargets as Record<string, unknown>)
                .every(([key, value]) => key.length > 0 && typeof value === "string")
            ))
          ) throw new InventoryMutationError("隔离恢复请求无效");
          json(response, 200, await options.inventory.restoreQuarantinedSkills(
            body.quarantineEntryIds as string[],
            true,
            body.restoreTargets as Record<string, string> | undefined,
          ));
          return;
        }
        if (request.method === "POST" && pathname === "/api/quarantine/purge") {
          if (auth.mode !== "cookie") {
            json(response, 403, { error: "永久清空只能由用户在桌面工作台确认" });
            return;
          }
          const body = await readJsonBody(request) as Record<string, unknown>;
          if (typeof body.quarantineEntryId !== "string" || body.confirmed !== true) {
            throw new InventoryMutationError("永久清空确认无效");
          }
          json(response, 200, await options.inventory.purgeQuarantinedSkill(body.quarantineEntryId, true));
          return;
        }
        if (request.method === "GET" && pathname === "/api/diagnostics") {
          const snapshot = options.inventory.snapshot;
          json(response, 200, {
            version,
            protocolVersion,
            roots: options.inventory.roots.map((root) => ({ id: root.id, label: root.label, path: redactDiagnosticPath(root.path) })),
            cwd: redactDiagnosticPath(options.inventory.cwd),
            runtimeAvailable: snapshot.runtimeAvailable,
            runtimeError: snapshot.runtimeError ? "[redacted runtime error]" : null,
            scanErrors: snapshot.scanErrors.map(sanitizeDiagnosticScanError),
            orphanOverrideIds: snapshot.orphanOverrideIds,
            counts: snapshot.summary,
            appServerStderr: [],
          });
          return;
        }
        if (request.method === "POST" && pathname === "/api/support-bundle") {
          if (auth.mode !== "cookie") {
            json(response, 403, { error: "完整支持包只能由用户在桌面工作台中明确确认" });
            return;
          }
          const body = await readJsonBody(request) as Record<string, unknown>;
          if (body.confirmed !== true || body.includeSensitiveDiagnostics !== true) {
            throw new InventoryMutationError("必须明确确认支持包将包含用户名、绝对路径和原始 stderr");
          }
          json(response, 201, await createSupportBundle({
            inventory: options.inventory,
            version,
            protocolVersion,
            protectPath: options.supportFileProtector,
          }));
          return;
        }
        if (request.method === "GET" && pathname === "/api/plugin-management-link") {
          if (auth.mode !== "cookie") {
            json(response, 403, { error: "Codex 原生插件管理入口只提供给桌面工作台" });
            return;
          }
          const href = new URL("codex://plugins/codex-skill-organizer");
          href.searchParams.set("marketplacePath", path.join(os.homedir(), ".agents", "plugins", "marketplace.json"));
          json(response, 200, { href: href.toString() });
          return;
        }
        json(response, 404, { error: "API 路径不存在" });
        return;
      }

      if (request.method === "GET" || request.method === "HEAD") {
        const asset = assets.get(pathname);
        if (asset) {
          setSecurityHeaders(response, false);
          response.statusCode = 200;
          response.setHeader("Content-Type", asset.contentType);
          response.end(request.method === "HEAD" ? undefined : asset.body);
          return;
        }
      }

      json(response, 404, { error: "路径不存在" });
    } catch (error) {
      const status = error instanceof StaleInventoryError
        ? 409
        : error instanceof InventoryMutationError
          ? 400
          : 500;
      const message = error instanceof Error ? error.message : String(error);
      json(response, status, { error: status === 500 ? "本地服务发生内部错误，请打开诊断查看脱敏信息" : message });
    }
  };

  const requestedPort = options.port ?? 0;
  const maxAttempts = requestedPort === 0 ? DEFAULT_FETCH_SAFE_PORT_ATTEMPTS : 1;
  const endpoint = await selectFetchSafeListeningEndpoint(async () => {
    const candidate = createServer(requestListener);
    try {
      await listenHttpServer(candidate, requestedPort, host);
      const address = candidate.address();
      if (!address || typeof address === "string") {
        await closeHttpServer(candidate);
        throw new Error("无法读取本地服务端口");
      }
      return {
        resource: candidate,
        port: address.port,
        close: () => closeHttpServer(candidate),
      };
    } catch (error) {
      await closeHttpServer(candidate).catch(() => undefined);
      throw error;
    }
  }, maxAttempts);
  const server = endpoint.resource;
  actualPort = endpoint.port;

  return {
    server,
    host,
    port: actualPort,
    baseUrl: `http://${host}:${actualPort}`,
    bootstrapToken: sessions.bootstrapToken,
    close: () => closeHttpServer(server),
  };
}

async function listenHttpServer(server: Server, port: number, host: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      server.off("error", onError);
      server.off("listening", onListening);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onListening = (): void => {
      cleanup();
      resolve();
    };

    server.once("error", onError);
    server.once("listening", onListening);
    try {
      server.listen(port, host);
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

async function closeHttpServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
