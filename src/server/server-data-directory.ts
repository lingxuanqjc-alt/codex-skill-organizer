import path from "node:path";
import { resolveOrganizerDataDirectory } from "../shared/local-data-directory.js";

export const INTERNAL_HEALTH_CHECK_ARGUMENT = "--internal-health-check";
export const INTERNAL_HEALTH_DATA_ROOT_ENV = "CSO_INTERNAL_HEALTH_DATA_ROOT";
export const INTERNAL_HEALTH_PARENT_PID_ENV = "CSO_INTERNAL_HEALTH_PARENT_PID";

interface ServerDataDirectoryOptions {
  argv: string[];
  environment: NodeJS.ProcessEnv;
  homeDirectory: string;
  temporaryDirectory: string;
  parentProcessId: number;
  platform: NodeJS.Platform;
}

function windowsEqual(left: string, right: string): boolean {
  return left.toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US");
}

export function resolveServerDataDirectory(options: ServerDataDirectoryOptions): string {
  const releaseDirectory = resolveOrganizerDataDirectory(options.homeDirectory);
  if (!options.argv.includes(INTERNAL_HEALTH_CHECK_ARGUMENT)) return releaseDirectory;

  if (options.platform !== "win32" || options.argv.length !== 1) {
    throw new Error("Internal health-check startup arguments are invalid");
  }
  const requestedRoot = options.environment[INTERNAL_HEALTH_DATA_ROOT_ENV]?.trim();
  const requestedParent = options.environment[INTERNAL_HEALTH_PARENT_PID_ENV]?.trim();
  const desktopParent = options.environment.CSO_DESKTOP_PID?.trim();
  if (!requestedRoot || !path.isAbsolute(requestedRoot)) {
    throw new Error("Internal health-check data root is missing or not absolute");
  }
  if (!/^\d+$/u.test(requestedParent ?? "")
      || Number(requestedParent) !== options.parentProcessId
      || desktopParent !== requestedParent) {
    throw new Error("Internal health-check parent process does not match the direct desktop parent");
  }

  const healthParent = path.resolve(options.temporaryDirectory, "SkillOrganizerForCodex-health");
  const candidate = path.resolve(requestedRoot);
  if (candidate.startsWith("\\\\")
      || !windowsEqual(path.dirname(candidate), healthParent)
      || !/^[0-9a-f]{32}$/iu.test(path.basename(candidate))) {
    throw new Error("Internal health-check data root is outside the generated local temporary boundary");
  }
  return candidate;
}
