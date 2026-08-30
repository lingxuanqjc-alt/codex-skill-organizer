import { createHash, randomUUID } from "node:crypto";
import { open, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { InventoryService } from "../core/inventory-service.js";
import { PRODUCT_NAME, PRODUCT_VERSION, PROTOCOL_VERSION } from "../shared/version.js";
import { restrictRuntimeAcl } from "./windows-acl.js";

const MAX_SUPPORT_BUNDLE_BYTES = 25 * 1024 * 1024;
const SENSITIVE_STDERR_MARKER = /(?:authorization|bearer|token|cookie|csrf|secret|password|passwd|api[_-]?key)/iu;
const CREDENTIAL_URL = /\b(https?|socks5?):\/\/[^\s/@]+:[^\s/@]+@/giu;
const ENV_ASSIGNMENT = /\b([A-Z][A-Z0-9_]{2,})=[^\s]+/gu;

export function sanitizeSupportBundleStderr(line: string): string {
  const bounded = line.trim().slice(0, 2_000);
  if (!bounded) return "";
  if (SENSITIVE_STDERR_MARKER.test(bounded)) return "[redacted sensitive stderr line]";
  return bounded
    .replace(CREDENTIAL_URL, "$1://[credentials-redacted]@")
    .replace(ENV_ASSIGNMENT, "$1=[redacted]");
}

export interface SupportBundleResult {
  path: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
}

export interface CreateSupportBundleOptions {
  inventory: InventoryService;
  version?: string;
  protocolVersion?: string;
  now?: () => Date;
  protectPath?: (targetPath: string) => Promise<void>;
}

export async function createSupportBundle(options: CreateSupportBundleOptions): Promise<SupportBundleResult> {
  const now = options.now ?? (() => new Date());
  const createdAt = now().toISOString();
  const snapshot = options.inventory.snapshot;
  const payload = {
    schemaVersion: 1,
    product: PRODUCT_NAME,
    version: options.version ?? PRODUCT_VERSION,
    protocolVersion: options.protocolVersion ?? PROTOCOL_VERSION,
    createdAt,
    explicitSensitiveDiagnosticsConsent: true,
    environment: {
      platform: process.platform,
      architecture: process.arch,
      windowsRelease: os.release(),
      nodeVersion: process.version,
    },
    database: {
      path: options.inventory.statePath,
      schemaVersion: options.inventory.store.schemaVersion,
      managementMode: options.inventory.managementMode,
    },
    inventory: {
      revision: snapshot.revision,
      generatedAt: snapshot.generatedAt,
      cwd: options.inventory.cwd,
      summary: snapshot.summary,
      runtimeAvailable: snapshot.runtimeAvailable,
      runtimeError: snapshot.runtimeError,
      roots: options.inventory.roots.map((root) => ({
        id: root.id,
        label: root.label,
        path: root.path,
        kind: root.kind,
        readonly: root.readonly ?? false,
        managementGranted: root.managementGranted ?? false,
      })),
      scanErrors: snapshot.scanErrors,
      orphanOverrideIds: snapshot.orphanOverrideIds,
      skills: snapshot.skills.map((skill) => ({
        logicalSkillId: skill.skillId,
        name: skill.name,
        sourceId: skill.sourceId,
        scope: skill.scope,
        categoryId: skill.categoryId,
        locked: skill.locked,
        diagnosticCodes: skill.diagnostics.map((diagnostic) => diagnostic.code),
        instances: (skill.instances ?? []).map((instance) => ({
          instanceId: instance.instanceId,
          path: instance.absolutePath,
          rootId: instance.rootId,
          readonly: instance.readonly,
          runtimeDiscovered: instance.runtimeDiscovered,
          runtimeEnabled: instance.runtimeEnabled,
          runtimeScope: instance.runtimeScope,
          pluginVersion: instance.pluginVersion,
          diagnosticCodes: instance.diagnostics.map((diagnostic) => diagnostic.code),
        })),
      })),
    },
    appServerStderr: [...(options.inventory.appServer?.stderrTail ?? [])]
      .map(sanitizeSupportBundleStderr)
      .filter(Boolean),
    exclusions: [
      "bootstrap tokens, cookies, and CSRF values",
      "process environment variables",
      "SKILL.md bodies and descriptions",
      "skill assets, templates, .env files, and credentials",
    ],
  };
  const contents = Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, "utf8");
  if (contents.byteLength > MAX_SUPPORT_BUNDLE_BYTES) {
    throw new Error("支持包超过 25 MiB 安全上限；请先缩小已配置的 skill 根目录");
  }

  const supportDirectory = path.join(path.dirname(options.inventory.statePath), "support-bundles");
  const timestamp = createdAt.replace(/[:.]/gu, "-");
  const supportPath = path.join(supportDirectory, `support-${timestamp}-${randomUUID().slice(0, 8)}.json`);
  const protectPath = options.protectPath ?? restrictRuntimeAcl;
  await mkdir(supportDirectory, { recursive: true });
  await protectPath(supportDirectory);
  let handle;
  try {
    handle = await open(supportPath, "wx", 0o600);
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await protectPath(supportPath);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(supportPath, { force: true }).catch(() => undefined);
    throw error;
  }
  return {
    path: supportPath,
    sizeBytes: contents.byteLength,
    sha256: createHash("sha256").update(contents).digest("hex"),
    createdAt,
  };
}
