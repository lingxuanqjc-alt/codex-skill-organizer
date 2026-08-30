# Third-party notices

Skill Organizer for Codex is distributed under the MIT License. Its JavaScript
dependencies and bundled Node.js runtime retain their respective licenses.

Each release must include:

- `THIRD_PARTY_NOTICES.txt`, generated from the installed dependency tree;
- `skill-organizer-for-codex.cdx.json`, a CycloneDX SBOM;
- the license files distributed with the pinned Node.js runtime; and
- `SHA256SUMS.txt`, covering every downloadable release artifact.

This repository-level file is intentionally not a substitute for the generated
release notices. Release creation fails when dependency metadata or the Node.js
runtime license directory is missing.
