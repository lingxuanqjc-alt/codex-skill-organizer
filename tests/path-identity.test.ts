import assert from "node:assert/strict";
import test from "node:test";
import {
  inspectUnlinkedDirectoryChain,
  UnsafeDirectoryIdentityError,
  type DirectoryIdentityOperations,
  type DirectoryIdentityStats,
} from "../src/core/path-identity.js";

function directoryStats(identity: number, symbolicLink = false): DirectoryIdentityStats {
  return {
    dev: 7,
    ino: identity,
    isDirectory: () => !symbolicLink,
    isSymbolicLink: () => symbolicLink,
  };
}

function windowsFixtureOperations(
  canonicalize: (candidate: string) => string,
  symbolicPaths: ReadonlySet<string> = new Set(),
): DirectoryIdentityOperations {
  const identities = new Map<string, number>();
  const identityFor = (candidate: string): number => {
    const canonical = canonicalize(candidate).toLocaleLowerCase("en-US");
    const existing = identities.get(canonical);
    if (existing !== undefined) return existing;
    const identity = identities.size + 1;
    identities.set(canonical, identity);
    return identity;
  };
  return {
    lstat: async (candidate) => directoryStats(
      identityFor(candidate),
      symbolicPaths.has(candidate.toLocaleLowerCase("en-US")),
    ),
    realpath: async (candidate) => canonicalize(candidate),
  };
}

test("a Windows DOS 8.3 alias is accepted only as the same unlinked physical directory", async () => {
  const declared = "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\project";
  const canonicalize = (candidate: string): string => candidate.replace(
    /\\RUNNER~1(?=\\|$)/iu,
    "\\runneradmin",
  );

  const chain = await inspectUnlinkedDirectoryChain(
    declared,
    windowsFixtureOperations(canonicalize),
    "win32",
  );

  assert.equal(chain.at(-1)?.physicalPath, "C:\\Users\\runneradmin\\AppData\\Local\\Temp\\project");
});

test("a DOS 8.3-shaped alias is rejected when its physical directory identity differs", async () => {
  const declared = "C:\\Users\\RUNNER~1\\project";
  const canonicalize = (candidate: string): string => candidate.replace(
    /\\RUNNER~1(?=\\|$)/iu,
    "\\runneradmin",
  );
  const operations: DirectoryIdentityOperations = {
    lstat: async (candidate) => directoryStats(candidate.includes("RUNNER~1") ? 11 : 12),
    realpath: async (candidate) => canonicalize(candidate),
  };

  await assert.rejects(
    inspectUnlinkedDirectoryChain(declared, operations, "win32"),
    UnsafeDirectoryIdentityError,
  );
});

test("a real junction component remains blocked even when its target can be resolved", async () => {
  const declared = "C:\\workspace\\linked\\project";
  const linked = "C:\\workspace\\linked";
  const canonicalize = (candidate: string): string => candidate.replace(
    /^C:\\workspace\\linked(?=\\|$)/iu,
    "C:\\outside",
  );

  await assert.rejects(
    inspectUnlinkedDirectoryChain(
      declared,
      windowsFixtureOperations(canonicalize, new Set([linked.toLocaleLowerCase("en-US")])),
      "win32",
    ),
    UnsafeDirectoryIdentityError,
  );
});

test("a non-8.3 realpath mismatch fails closed even when an adapter reports matching IDs", async () => {
  const declared = "C:\\workspace\\ordinary-name\\project";
  const canonicalize = (candidate: string): string => candidate.replace(
    /^C:\\workspace\\ordinary-name(?=\\|$)/iu,
    "C:\\outside",
  );

  await assert.rejects(
    inspectUnlinkedDirectoryChain(
      declared,
      windowsFixtureOperations(canonicalize),
      "win32",
    ),
    /无法证明为 DOS 8\.3 别名/u,
  );
});
