# Release workflow configuration

## Trigger and version source

- A `v0.2.*` tag builds, smoke-tests, and publishes a GitHub Release. The tag
  commit must be part of `origin/main` history, and the tag version must exactly
  match `package.json`.
- A manual `workflow_dispatch` builds the same nine-file release asset set and
  uploads it as a 30-day Actions artifact, but does not create a GitHub Release.
  Its version must also match `package.json`, and all tag-ancestry, fixed-notes,
  and publish steps are skipped.
- Runtime URL, version, npm evidence, and SHA-256 values come only from the
  committed `scripts/release/runtime-lock.json`; no repository variables named
  `NODE_RUNTIME_URL` or `NODE_RUNTIME_SHA256` are read.

## Supply-chain boundary

- Every GitHub Action is pinned to a full commit SHA. The trailing version
  comment documents the official tag used to resolve that SHA; Dependabot may
  propose reviewed updates.
- Every checkout sets `persist-credentials: false`.
- The build-and-smoke job has only `contents: read`. It runs the complete source,
  browser, installer, portable, rollback, dependency-audit, and release-output
  gates before uploading a digest-bearing Actions artifact retained for 30 days.
  That dry-run artifact is not an Immutable GitHub Release.
- The separate publish job is the only job with `contents: write`. It does not
  check out or execute repository code: it downloads the preceding job's
  artifacts, rechecks the exact asset names, SHA-256 coverage, release metadata,
  SBOM metadata, and fixed safety notes, then creates the GitHub Release.

The hosted Windows runner must expose Inno Setup 6 at one of the explicit paths
checked by the workflow. If the runner image changes, the workflow fails instead
of downloading an unpinned installer compiler.

## Repository release immutability

- Repository Immutable Releases must remain enabled immediately before a tag is
  pushed. Because the repository setting is not owner-enforced, the release
  operator rechecks it as a final gate.
- The publish job verifies the downloaded Actions artifact, creates a draft,
  uploads the complete asset set, and publishes only after the remote tag still
  resolves to the built commit.
- Automatic cleanup is limited to an incomplete draft before publication is
  attempted. Once publication starts, an ambiguous command result or later
  verification failure preserves the Release for manual inspection.
- After publication, the Release must report as immutable. Any correction uses
  a new version; the published tag and assets are never replaced.

## Asset contract

Both local and GitHub builds run `scripts/release/Build-Release.ps1`. A complete
snapshot contains:

- the per-user setup EXE and portable ZIP;
- `SHA256SUMS.txt` covering every other release asset;
- the CycloneDX SBOM and generated third-party notices;
- `RELEASE-METADATA.json`;
- portable, base-version, and full-version content manifests.

`scripts/release/Test-ReleaseOutput.ps1` rejects missing or additional top-level
assets and validates their hashes and metadata. To compare a local build with the
GitHub artifact, use `scripts/release/Compare-ContentManifest.ps1` on matching
content manifests. Installer container timestamps may differ; the version
payload and portable file paths, sizes, and SHA-256 values may not.

Snapshots are unsigned during the acquaintance-test phase. The publish job reads
`.github/RELEASE_NOTES.md` into GitHub CLI's documented `--notes` input so it is
prepended to generated release notes. The file must keep the unsigned build,
Windows SmartScreen, `SHA256SUMS.txt`, and non-OpenAI-product warnings visible at
the top of every 0.2.x release.
