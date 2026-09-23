# Contributing

## Development

Requirements: macOS for launchd and notification paths; Bun for TypeScript tests. Optional adapters (`herdr`, `orca`, `cmux`, pi-family agents, Claude Code) must be installed only when changing their integration.

```sh
bun test
```

Run the smallest relevant test while editing, then run the full suite before submitting a pull request. Tests must exercise observable behavior, not source text.

## Boundaries

- Keep the ledger local and append-only. Do not add a network service, queue, or remote database for a contribution without an accepted design.
- The web dashboard is loopback-only. Do not expose it beyond `127.0.0.1` without authentication and an explicit security review.
- Q1 acknowledgement cancels local Overload notification state only. It must not be represented as an approval or an upstream agent resume.
- Integration changes need evidence from the real installed CLI or hook payload and a deterministic fixture covering its parsed shape.

## Sensitive material

Never commit `~/.overload/`, `ledger.db*`, `*.ndjson`, digests, launchd logs, session transcripts, local configuration, credentials, or machine-specific paths. Redact issue and pull-request reproductions.

## Pull requests

Describe the user-visible behavior, the affected integration contract, and the exact verification command and output. Keep unrelated refactors out of the change.
