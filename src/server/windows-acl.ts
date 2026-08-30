import { execFile as execFileCallback } from "node:child_process";
import { access, lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export function resolveTrustedWindowsSystemExecutable(
  name: "whoami.exe" | "icacls.exe",
  systemRoot = process.env.SystemRoot,
): string {
  if (!systemRoot?.trim() || !path.isAbsolute(systemRoot.trim()) || systemRoot.trim().startsWith("\\\\")) {
    throw new Error("Windows system root is missing or is not a local absolute path");
  }
  return path.join(path.resolve(systemRoot.trim()), "System32", name);
}

async function trustedSystemExecutable(name: "whoami.exe" | "icacls.exe"): Promise<string> {
  const candidate = resolveTrustedWindowsSystemExecutable(name);
  const systemDirectory = path.dirname(candidate);
  const [candidateInfo, directoryInfo, physicalCandidate, physicalDirectory] = await Promise.all([
    lstat(candidate),
    lstat(systemDirectory),
    realpath(candidate),
    realpath(systemDirectory),
  ]);
  if (!candidateInfo.isFile()
      || candidateInfo.isSymbolicLink()
      || !directoryInfo.isDirectory()
      || directoryInfo.isSymbolicLink()
      || path.dirname(physicalCandidate).toLocaleLowerCase("en-US")
        !== physicalDirectory.toLocaleLowerCase("en-US")) {
    throw new Error(`Windows system executable boundary is invalid: ${name}`);
  }
  await access(candidate);
  return physicalCandidate;
}

async function currentUserSid(): Promise<string> {
  const { stdout } = await execFile(await trustedSystemExecutable("whoami.exe"), ["/user", "/fo", "csv", "/nh"], {
    windowsHide: true,
    encoding: "utf8",
    timeout: 5_000,
  });
  const sid = /"(S-\d-(?:\d+-)+\d+)"/u.exec(stdout)?.[1];
  if (!sid) throw new Error("无法解析当前 Windows 用户 SID");
  return sid;
}

async function collectPhysicalTargets(targetPath: string, recursive: boolean): Promise<Array<{
  path: string;
  directory: boolean;
}>> {
  const info = await lstat(targetPath);
  if (info.isSymbolicLink()) throw new Error("Runtime ACL boundary cannot contain a link");
  const targets = [{ path: targetPath, directory: info.isDirectory() }];
  if (!recursive || !info.isDirectory()) return targets;
  const entries = await readdir(targetPath, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, "en-US"));
  for (const entry of entries) {
    const childPath = path.join(targetPath, entry.name);
    if (entry.isSymbolicLink()) throw new Error("Runtime ACL boundary cannot contain a link");
    targets.push(...await collectPhysicalTargets(childPath, true));
  }
  return targets;
}

async function restrictSingleTarget(targetPath: string, directory: boolean, sid: string, icacls: string): Promise<void> {
  const userGrant = directory ? `*${sid}:(OI)(CI)F` : `*${sid}:F`;
  const systemGrant = directory ? "*S-1-5-18:(OI)(CI)F" : "*S-1-5-18:F";
  const aclArguments = [
    targetPath,
    "/inheritance:r",
    "/grant:r",
    userGrant,
    systemGrant,
  ];
  await execFile(icacls, aclArguments, {
    windowsHide: true,
    encoding: "utf8",
    timeout: 10_000,
  });
}

export async function restrictRuntimeAcl(targetPath: string, options: { recursive?: boolean } = {}): Promise<void> {
  if (process.platform !== "win32") return;
  const [sid, icacls, targets] = await Promise.all([
    currentUserSid(),
    trustedSystemExecutable("icacls.exe"),
    collectPhysicalTargets(targetPath, options.recursive === true),
  ]);
  for (const target of targets) {
    await restrictSingleTarget(target.path, target.directory, sid, icacls);
  }
}
