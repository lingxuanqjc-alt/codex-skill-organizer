import { execFile } from "node:child_process";
import path from "node:path";

export type PathLocation = "local" | "network" | "unknown";
export type PathLocationProbe = (candidate: string) => Promise<PathLocation>;
type WindowsDriveTypeResolver = (driveRoot: string, timeoutMs: number) => Promise<string>;

const WINDOWS_DRIVE_TYPE_PROBE_TIMEOUT_MS = 15_000;

export interface PathLocationProbeOptions {
  platform?: NodeJS.Platform;
  resolveWindowsDriveType?: WindowsDriveTypeResolver;
}

function isUncPath(candidate: string): boolean {
  return candidate.replaceAll("/", "\\").startsWith("\\\\");
}

async function resolveWindowsDriveType(driveRoot: string, timeoutMs: number): Promise<string> {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
  const powershell = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script = [
    "$root = $env:CSO_PATH_PROBE_ROOT",
    "if ([string]::IsNullOrWhiteSpace($root)) { exit 65 }",
    "$drive = [System.IO.DriveInfo]::new($root)",
    "[Console]::Out.Write($drive.DriveType.ToString())",
  ].join("; ");
  return new Promise((resolve, reject) => {
    execFile(
      powershell,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      {
        encoding: "utf8",
        env: { ...process.env, CSO_PATH_PROBE_ROOT: driveRoot },
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 16 * 1024,
      },
      (error, stdout) => error ? reject(error) : resolve(stdout.trim()),
    );
  });
}

/**
 * Resolves Windows mapped drives through DriveInfo instead of trusting the path
 * spelling. Any unsupported drive type or probe failure stays unknown so callers
 * can fail closed before granting management access.
 */
export async function probePathLocation(
  candidate: string,
  options: PathLocationProbeOptions = {},
): Promise<PathLocation> {
  if (isUncPath(candidate)) return "network";
  if ((options.platform ?? process.platform) !== "win32") return "local";

  const driveRoot = path.win32.parse(candidate).root;
  if (!/^[A-Za-z]:\\$/u.test(driveRoot)) return "unknown";
  try {
    // A cold Windows PowerShell process on hosted or enterprise-controlled
    // machines can take more than five seconds before DriveInfo executes.
    const driveType = await (options.resolveWindowsDriveType ?? resolveWindowsDriveType)(
      driveRoot,
      WINDOWS_DRIVE_TYPE_PROBE_TIMEOUT_MS,
    );
    if (driveType === "Network") return "network";
    if (["Fixed", "Removable", "Ram"].includes(driveType)) return "local";
    return "unknown";
  } catch {
    return "unknown";
  }
}

export const defaultPathLocationProbe: PathLocationProbe = (candidate) => probePathLocation(candidate);
