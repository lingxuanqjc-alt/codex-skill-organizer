import path from "node:path";
import { fileURLToPath } from "node:url";

export interface McpRootLike {
  uri: string;
}

export interface McpRootsClient {
  getClientCapabilities(): { roots?: unknown } | undefined;
  listRoots(
    params?: undefined,
    options?: { timeout?: number },
  ): Promise<{ roots: McpRootLike[] }>;
}

const MAX_PROJECT_ROOTS = 32;

export function localProjectPathFromMcpRoot(
  uri: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== "file:"
    || parsed.username
    || parsed.password
    || parsed.port
    || parsed.hostname
    || parsed.search
    || parsed.hash
  ) return null;

  let decoded: string;
  try {
    decoded = fileURLToPath(parsed, { windows: platform === "win32" });
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;

  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const normalized = pathApi.resolve(decoded);
  if (!pathApi.isAbsolute(normalized)) return null;
  if (platform === "win32" && !/^[A-Za-z]:\\/u.test(normalized)) return null;
  return normalized;
}

export function localProjectPathsFromMcpRoots(
  roots: readonly McpRootLike[],
  platform: NodeJS.Platform = process.platform,
): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const root of roots.slice(0, MAX_PROJECT_ROOTS)) {
    const projectPath = localProjectPathFromMcpRoot(root.uri, platform);
    if (!projectPath) continue;
    const key = platform === "win32" ? projectPath.toLocaleLowerCase("en-US") : projectPath;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(projectPath);
  }
  return result;
}

export async function listLocalMcpProjectPaths(
  client: McpRootsClient,
  platform: NodeJS.Platform = process.platform,
): Promise<string[]> {
  if (!client.getClientCapabilities()?.roots) return [];
  const result = await client.listRoots(undefined, { timeout: 5_000 });
  return localProjectPathsFromMcpRoots(result.roots, platform);
}
