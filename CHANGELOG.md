# Changelog

## 0.3.0 — 2026-08-08

### Added

- Local-first Showcase with English-first / Chinese-supporting product presentation.
- BYOK settings for API Base URL, encrypted API Key, Image2 model, connection test, and key clearing.
- OpenAI-compatible `/models`, `/images/generations`, and `/images/edits` bridge.
- Immediate local result materialization with SHA-256 metadata and restart recovery.
- Deterministic mock Images API under `examples/mock-openai-server`.
- Privacy, security, contribution, release, and OSS evidence documentation.

### Removed

- Login, account, credits, recharge, membership, remote history, remote task polling, and private provider endpoints.
- Browser-side API request fallback and implicit upload flow.

### Notes

This release intentionally does not include real credentials, customer assets, signed URLs, telemetry, or private service configuration.
