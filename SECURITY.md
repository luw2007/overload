# Security policy

## Supported versions

Security fixes are made on the latest commit on `main` and the latest tagged release.

## Reporting a vulnerability

Do not open a public issue. Report privately to the repository owner through GitHub's private vulnerability reporting feature when it is enabled; otherwise use the contact address listed on the repository profile. Include the affected version, a minimal reproduction, impact, and any suggested mitigation.

Do not attach or paste `~/.overload/ledger.db`, `~/.overload/spool/`, digest files, launchd logs, session dumps, or raw notification payloads. They can contain local paths, branch names, session text, request metadata, and commit identifiers. Redact reproductions to the smallest evidence needed to demonstrate the issue.

The local web server binds only to `127.0.0.1`. Treat any change to that boundary, command execution via the jump endpoint, filesystem path handling, spool ingestion, or secret redaction as security-sensitive.
