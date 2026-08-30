const SENSITIVE_PATH_KEYS = new Set([
  "absolutePath",
  "sourcePath",
  "quarantinePath",
  "originalPath",
  "pathHint",
  "originalPathHint",
  "restoredPath",
  "restoredPathHint",
  "rootPath",
  "physicalPath",
  "installRoot",
  "cwd",
]);

const EMBEDDED_LOCAL_PATH = /(?:^|[\s("'`])(?:[a-z]:[\\/]|\\\\|\/(?:users|home|tmp|var|private|mnt|volumes)\/)/iu;

function sanitizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !SENSITIVE_PATH_KEYS.has(key))
        .map(([key, entry]) => [key, sanitizeValue(entry)]),
    );
  }
  if (typeof value === "string" && EMBEDDED_LOCAL_PATH.test(value)) return "[local path redacted]";
  return value;
}

/** Keep opaque IDs and relative impact data while excluding host filesystem paths from the model boundary. */
export function sanitizeQuarantinePayloadForModel(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return sanitizeValue(payload) as Record<string, unknown>;
}
