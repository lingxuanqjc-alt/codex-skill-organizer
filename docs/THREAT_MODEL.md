# Threat model

This document describes the security boundary for Skill Organizer for Codex
0.2.x. The application is a single-user, local-first Windows tool. It does not
claim to isolate data from malware or an administrator that already controls
the same Windows account.

## Assets

- Third-party skill directories and their timestamps, links, and Git state.
- The SQLite database, ten rotating snapshots, quarantine area, and operation
  history under `%LOCALAPPDATA%\SkillOrganizerForCodex`.
- The user's personal Codex marketplace file and an Organizer plugin directory.
- The Codex runtime enable/disable state addressed by exact `SKILL.md` path.
- Loopback bootstrap tokens, session cookies, CSRF values, and runtime
  descriptors.
- Release integrity: the pinned Node runtime, desktop executable, installer,
  manifests, SBOM, notices, and published SHA-256 values.

Skill bodies, assets, templates, `.env` files, and credentials are explicitly
outside the application's intended data set.

## Trust boundaries

1. **Untrusted skill metadata to scanner.** Skill paths, directory entries,
   manifests, Git metadata, and YAML frontmatter may be malformed or hostile.
2. **Browser/WebView2 to loopback service.** Other local pages can attempt
   cross-origin requests; bootstrap URLs may be copied or replayed.
3. **Codex MCP sidecar to shared service.** The model can request only the
   declared tools and cannot substitute tool arguments for desktop consent.
4. **Workbench to filesystem and app-server.** Classification writes affect
   only Organizer state; runtime, quarantine, restore, and purge cross a
   separate management boundary.
5. **Installer to existing program, data, marketplace, and plugin.** A failed
   preflight or activation must preserve the previous byte state and keep the
   optional plugin boundary separate.
6. **Explicit update check to network.** Only public GitHub API endpoints and
   exact Codex plugin metadata are eligible; results are evidence, never an
   instruction to overwrite local files.

## Threats and controls

| Threat | Required control |
|---|---|
| Path traversal, junction escape, directory loop, or root replacement | Resolve and compare physical paths; reject network roots and root-external links; bind quarantine plans to root/source/restore-parent physical identity and revalidate immediately before a move. |
| A same-size or same-timestamp file is changed after quarantine | Record and verify a content SHA-256 before restore; stop on any mismatch or destination conflict. |
| Skill content or secrets are collected while indexing | Read only the bounded frontmatter envelope and small source manifests; never traverse assets as business data or inspect `.env`. |
| Same-name skills are merged or a write targets the wrong copy | Logical identity includes source/package/relative path; uncertain identities remain separate; runtime and management writes use opaque instance or installation-unit IDs plus an inventory revision. |
| Stale UI performs a mutation | Compare the supplied inventory revision and relevant precondition; stop a batch after the first failure and report success, failure, and not-executed items separately. |
| Model directly changes classification or enables management | Model output enters a suggestion staging area; locked items are excluded; only the desktop workbench can enable management mode or confirm sensitive filesystem actions. |
| Cross-site request or stolen bootstrap URL | Bind to dynamic `127.0.0.1`; use a one-time random bootstrap token, HttpOnly/SameSite cookie, absolute session TTL, Origin validation, CSRF token, CSP, and no-store API responses. |
| Runtime descriptor or SQLite recovery is torn on EFS/EXDEV | Use durable copy, flush, size/hash readback, publication locks, whole-group db/wal/shm staging, and rollback on every injected failure. |
| Update status is guessed from a name or mutable description | Require exact public repository identity plus tag/release/commit ancestry, or exact sortable Codex plugin versions; mark private, ambiguous, older, offline, or incomparable evidence unavailable. |
| Local changes are overwritten | 0.2.0 never performs an update; exact install-hash or Git dirty evidence marks an item modified and blocks overwrite claims. |
| Plugin installation overwrites a personal marketplace or unknown directory | Merge one exact entry transactionally; require a managed sentinel and file hashes; preserve unrelated entries; legacy 0.1.1 adoption requires separate explicit consent and a verified backup. |
| Installer preflight or activation fails | Run the exact bundled health check before normal copy, snapshot SQLite, capture rollback state, restore stable launcher/current pointer/version/uninstaller/registry/shortcuts, and return a non-zero code before the plugin stage. |
| Unsigned code is blocked by enterprise policy | Fail closed before copying program files. Do not invoke the bundled Node runtime as a policy bypass. Require a signer trusted by device policy or an administrator allow rule. |
| Diagnostics disclose usernames, paths, or stderr | Redact ordinary diagnostics. A full local support bundle requires an explicit desktop confirmation and contains no token, cookie, skill body, or secret file. |

## Residual risks

- A process already running as the same user can read or alter local application
  data and can race filesystem operations outside Organizer's locks.
- On EFS volumes that reject atomic rename, durable fallback publication has a
  very short copy window. Built-in readers treat incomplete JSON as not ready
  and retry; unrelated readers that ignore the publication lock may observe an
  invalid intermediate document.
- Unsigned acquaintance-test builds can trigger SmartScreen and can be blocked
  outright by App Control. A checksum proves downloaded bytes, not publisher
  identity.
- Public GitHub metadata and Codex marketplace snapshots can be unavailable,
  rate-limited, or stale. The product reports this as unavailable/offline and
  does not infer an update.
- Permanent quarantine purge is intentionally irreversible after explicit user
  confirmation.

## Release security checks

Before a snapshot is published, CI and the physical Windows acceptance device
must verify type checking, unit/browser tests, plugin validation, locked
dependencies, `npm audit`, installer preflight/rollback, default and full-data
uninstall behavior, release contents, SBOM/notices, and hashes. Scan/update
tests compare the original skill tree before and after all read-only paths.
