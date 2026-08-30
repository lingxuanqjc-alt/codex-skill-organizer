# Security policy

## Supported versions

Security fixes are provided for the latest `0.2.x` acquaintance-test snapshot.
Older snapshots should be upgraded before a report is reproduced.

## Reporting a vulnerability

Do not include skill contents, secrets, absolute local paths, or personal data
in a public issue. Open a minimal GitHub security advisory for
`lingxuanqjc-alt/codex-skill-organizer`, or contact the repository owner through
their GitHub profile if private advisories are not available.

Include the affected version, Windows version, a redacted reproduction, and the
expected security boundary. You should receive an acknowledgement within seven
days. There is no bug-bounty program.

## Security boundary

The application is designed for one Windows user account. It protects against
accidental browser access, cross-origin requests, unsafe path selection, and
unconfirmed mutations. It does not claim to defend against malware or an
administrator already controlling the same Windows account.

Release builds are per-user, do not require administrator privileges, do not
use the system `node.exe`, and fail closed when the pinned runtime or desktop
payload is absent. Acquaintance-test snapshots are unsigned; verify the
published SHA-256 checksum before deciding whether to continue past a
SmartScreen reputation warning. Do not bypass an enforced Windows App Control
or enterprise Code Integrity policy. Setup health-checks the exact bundled
desktop payload before copying program files and stops when that policy rejects
the executable; a build must be signed by an identity trusted by the device
policy, or explicitly allowed by the device administrator.
