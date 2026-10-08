# Security Policy

## Reporting a vulnerability

Email **security@diagrams.so**. Please include a description of the issue, reproduction steps, the SDK language and version, and the `request_id` from any `DiagramsAPIError` if relevant. We acknowledge reports within 3 business days and follow the coordinated-disclosure process in our [Vulnerability Disclosure Policy](https://diagrams.so/policy/vulnerability-disclosure), which includes a safe harbor for good-faith research.

Please do not open public GitHub issues for security reports.

## Scope notes for this repository

- Both SDKs are thin, dependency-free clients for `api.diagrams.so`. They contain no telemetry and store nothing except what you pass them; the optional `login` helper stores credentials at `~/.diagrams-so/credentials.json` with owner-only permissions.
- Never hardcode an API key in source, examples, or tests. Use the `DIAGRAMS_API_KEY` environment variable. If a key may have been exposed, revoke it in the dashboard immediately; revocation is immediate.
- Test-mode keys (`dgz_test_`) are **not** a sandbox: they read and write the same real account — creating, editing and deleting real diagrams — and run real AI calls. The only difference is a lower rate limit (20 requests/minute instead of 60) and `livemode: false` on the ledger rows, so a leaked test key deserves exactly the same urgency as a leaked live key. The offline stub in `local-test/` lets you exercise everything with no account at all.

## Supported versions

Security fixes land in the latest release of each SDK. Please stay current.
