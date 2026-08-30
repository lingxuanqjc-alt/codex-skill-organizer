# Changelog

All notable changes to this project are documented in this file. The format is
based on Keep a Changelog and versions follow Semantic Versioning.

## [0.2.0] - 2026-08-30

### Added

- Portable logical-skill and physical-instance inventory model.
- SQLite-backed personal classification, tags, favourites, locks, views,
  update evidence, quarantine records, and local operation history.
- Bilingual workbench with deterministic classification and Codex-only staged
  suggestions.
- Evidence-only GitHub and Codex plugin update checks.
- Recoverable, confirmation-gated quarantine planning and restore operations.
- Precondition-checked undo for classification and runtime enable changes.
- Per-user Windows installer, portable ZIP, repository-local Codex marketplace,
  SBOM, third-party notices, checksums, and release content manifests.
- MCP UI resource delivery for capable hosts, with an honest paginated text and
  desktop-workbench fallback for hosts without MCP UI support.
- A 5,000-item virtual inventory and deterministic 100-item batches that stop
  and report succeeded, failed, locked, and unexecuted targets separately.
- Repo-scope discovery from official MCP roots, isolated per sidecar session so
  multiple Codex tasks do not share project roots.

### Changed

- Product display name is now `Skill Organizer for Codex`; the stable plugin ID
  remains `codex-skill-organizer`.
- The desktop and MCP entry points use a bundled Node.js 24 runtime instead of
  resolving `node.exe` from `PATH`.
- Version 0.2.0 starts with a new SQLite database. Version 0.1.1 JSON state is
  left untouched and is not imported automatically.
- Desktop visibility and MCP activity now share an expiring service lease;
  hidden windows no longer terminate a backend still in use by an MCP client.
- Clearing the desktop project restores the base working directory and removes
  that project from later app-server requests. MCP roots renew per request and
  are removed on session exit or expiry.
- Quarantine restore can use an explicit conflict-free sibling destination,
  but never overwrites an existing path.

### Security

- External management is disabled until the user enables management mode in the
  desktop workbench.
- Release packaging fails when the desktop payload, pinned Node runtime, license
  material, or version agreement is missing.
- Legacy 0.1.1 plugin adoption requires explicit consent and a verified complete
  backup; modified managed plugins fail closed during upgrade or removal.
- Installer backup and exact-version health validation run before the normal
  file-copy stage. Enforced App Control rejection fails closed without using the
  bundled runtime as a policy bypass.
- Parent Git provenance accepts only exact GitHub remotes whose metadata stays
  inside the authorized root; lookalike hosts and out-of-root links fail closed.
- Future SQLite schemas and non-corruption I/O failures are never replaced by an
  older snapshot. Concurrent write-before snapshots are uniquely and atomically
  published, with only the newest ten completed snapshots retained.
- Codex update evidence is limited to trusted curated marketplaces and exact
  reproducible lock data; draft, placeholder, drifted, private, or ambiguous
  metadata remains `unable to check`.
- Runtime descriptors, snapshots, and service-session roots use bounded
  lifetimes and per-item Windows ACL hardening; model-visible failures redact
  local paths, raw stderr, and executable details.
- MCP booleans cannot impersonate desktop confirmation or enable management
  mode; sensitive runtime, quarantine, restore, and support-bundle actions keep
  their desktop-cookie confirmation boundary.
- Marketplace replacement and installer activation use compensating journals;
  product/data reparse points, modified managed plugins, and partial marker
  commits fail closed without overwriting unrelated personal entries.
- Repository release candidates are scanned for sensitive filenames and
  high-confidence credential formats. Plugin and marketplace bundles must match
  exact five-file and six-file allowlists; extras, links, special files, and
  undecodable unknown binaries fail closed.
- GitHub Actions are pinned to full commits with non-persisted checkout
  credentials. Release building is read-only; a separate publish job is the
  only writer and revalidates downloaded hashes and safety notes before release.

[0.2.0]: https://github.com/lingxuanqjc-alt/codex-skill-organizer/releases/tag/v0.2.0
