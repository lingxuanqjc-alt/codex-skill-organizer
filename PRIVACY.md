# Privacy policy

Effective date: 2026-08-30

Skill Organizer for Codex is a local-first Windows application.

## Data processed locally

The application may process limited skill metadata: name, description,
frontmatter category, source/provenance metadata, installation records, and
parent Git remote information. It stores classifications, tags, favourites,
locks, saved views, management settings, update evidence, quarantine records,
and a redacted local operation history in the current user's local application
data directory.

It does not intentionally read skill assets, templates, `.env` files, API keys,
or other secrets. It does not upload skill contents.

## Network access

There is no telemetry, advertising, cloud synchronisation, or external API-key
requirement. Network access occurs only after the user requests an update check
for a verified public GitHub or Codex plugin source. A Codex conversation may
receive only the limited metadata needed for a user-requested classification
suggestion.

## Retention and deletion

Operation history is retained locally for up to 30 days. Database snapshots are
limited to the most recent ten. Quarantined skills are retained until the user
restores or permanently deletes them. Normal uninstall preserves application
data; the uninstaller's explicit full-delete option removes the Organizer data
directory and quarantine records.

## Diagnostics

Ordinary diagnostics redact usernames, absolute paths, and raw process error
output. A full support bundle is generated only after explicit confirmation.

Questions can be filed at:
https://github.com/lingxuanqjc-alt/codex-skill-organizer/issues
