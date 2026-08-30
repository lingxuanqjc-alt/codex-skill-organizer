# Installer build contract

`SkillOrganizerForCodex.iss` is a fail-closed Inno Setup source for a current-user
Windows 10/11 x64 install. It is not a substitute for the desktop payload.
Skill Organizer for Codex is an independent MIT project and is not an OpenAI
product. Acquaintance-test installers are unsigned and may trigger SmartScreen.
An enforced Windows App Control or enterprise Code Integrity policy can instead
block the unsigned desktop executable outright. That is not a browser-fallback
condition: setup must fail during pre-copy health validation and must not launch
the bundled Node.js runtime as a policy workaround.

The release build must provide these preprocessor inputs:

| Define | Required content |
| --- | --- |
| `AppVersion` | Strict semantic version matching `package.json` and `plugin.json`. |
| `VersionPayloadRoot` | `SkillOrganizerForCodex.exe`, `runtime/node.exe`, `app/dist/server.mjs`, `app/dist/mcp-sidecar.mjs`, and `tools/backup-state.mjs`. |
| `PluginSourceRoot` | Validated `codex-skill-organizer` plugin source. |
| `MarketplaceHelperSource` | `installer/tools/manage-personal-marketplace.mjs`. |
| `LicenseFile` | Repository `LICENSE`. |
| `SetupIconFileSource` | Reproducibly generated seven-image original ICO. |
| `OutputDirectory` | Existing release output directory. |

The supported local entry point is `npm run build:release`. It obtains
`AppVersion` from `package.json`, publishes the desktop payload, and resolves the
exact Node.js runtime pinned by `scripts/release/runtime-lock.json`. Explicit
PowerShell parameters may relocate inputs but may not bypass version/runtime
hash validation. The release script rejects an installer larger than 150 MB.

The desktop executable contract is:

- In a version directory it resolves only that directory's bundled runtime and
  application bundle.
- At the stable product root it reads `current.json` schema 1, rejects absolute
  or parent-traversing `relativePath`, and forwards all arguments to the active
  version.
- `--health-check` validates the service and protocol without showing UI, then
  stops only a backend process started by that health check.
- `--mcp` launches the version-local `runtime/node.exe` with
  `app/dist/mcp-sidecar.mjs`, inherits stdio, and returns the sidecar exit code.
- `--complete-plugin-install` attempts the Codex CLI install only when a trusted,
  explicit CLI path can be resolved. It never terminates Codex and records a
  pending action when an old task holds the plugin cache.

Before Inno Setup enters its normal file-copy stage, the installer extracts the
canonical version payload to its setup-owned temporary directory, creates and
verifies the SQLite upgrade backup, and runs the exact bundled `--health-check`.
A failed preflight returns Inno Setup's preparation-failure code and writes no
program files. The installer activates `current.json` only after preflight
succeeds. A later activation failure restores the previous launcher, current
pointer, same-version payload, uninstall metadata, registry entry, and shortcuts,
then returns exit code 70 only when that rollback completed. An incomplete
rollback returns exit code 74 and uses a distinct log message; callers must not
interpret it as a restored previous version.
The stable launcher is created on first install and remains untouched on ordinary
upgrades; version-specific code lives under `versions/<version>`.

`TestActivationFault` is a compile-time-only release-gate define. It injects a
failure after the stable launcher replacement and before `current.json` commit,
so CI can exercise clean-first-install, old-to-new, and same-version rollback.
`Build-Release.ps1` must never pass this define, and the production installer has
no command-line, environment-variable, file-system, or registry switch that can
enable the fixture.

The destructive installer matrix is restricted to an ephemeral GitHub Actions
runner. It also installs and removes `/TYPE=desktop`, `/TYPE=full`, explicit
custom `/COMPONENTS`, and `/LOADINF` selections, proving that `InitializeWizard`
does not replace a silent caller's explicit component choice. It must not run on
the physical acceptance machine or another user's profile.

The optional plugin component copies source through a bounded Node helper. That
helper preserves unrelated marketplace entries, refuses a same-name entry with a
different source, blocks links, backs up a replaced plugin directory, and stages
locked updates as `plugin-update-pending.json` for a Codex restart.

The runtime payload contains only the pinned `node.exe` and its `LICENSE` from
the verified official archive. npm, corepack, and system `PATH` content are not
distributed or used at runtime.

Normal uninstall preserves `%LOCALAPPDATA%\SkillOrganizerForCodex`. The custom
uninstall checkbox (or silent `/PURGEDATA`) is the only path that removes that
data directory. Version 0.1.1 data under `%LOCALAPPDATA%\CodexSkillOrganizer`,
including `state.v1.json`, is never imported or deleted by the 0.2 installer.

The desktop workbench component is fixed and cannot be deselected. The Codex
plugin component is optional; detecting Codex only changes its default
selection. Plugin replacement/removal requires the installer ownership marker,
so an unowned same-name directory remains untouched.
