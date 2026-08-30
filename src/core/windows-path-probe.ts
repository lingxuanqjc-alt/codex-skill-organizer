import { execFile } from "node:child_process";
import path from "node:path";

export type PathLocation = "local" | "network" | "unknown";
export type PathLocationProbe = (candidate: string) => Promise<PathLocation>;

export interface PathLocationProbeOptions {
  platform?: NodeJS.Platform;
  resolveWindowsDriveType?: (driveRoot: string) => Promise<string>;
}

function isUncPath(candidate: string): boolean {
  return candidate.replaceAll("/", "\\").startsWith("\\\\");
}

async function resolveWindowsDriveType(driveRoot: string): Promise<string> {
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
        timeout: 5_000,
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
    const driveType = await (options.resolveWindowsDriveType ?? resolveWindowsDriveType)(driveRoot);
    if (driveType === "Network") return "network";
    if (["Fixed", "Removable", "Ram"].includes(driveType)) return "local";
    return "unknown";
  } catch {
    return "unknown";
  }
}

export const defaultPathLocationProbe: PathLocationProbe = (candidate) => probePathLocation(candidate);
