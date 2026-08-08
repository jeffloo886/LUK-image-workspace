# OSS evidence checklist

This document is a privacy-safe record for the public trial of LUK Image Workspace. Fill it with aggregate counts only; never add API keys, customer assets, signed URLs, local paths, usernames, or raw prompts.

## Current release evidence

- Latest public release: `v0.3.1`.
- Validation includes the TypeScript check, the test suite, the deterministic mock Images API, and an arm64 DMG layout check.
- No adoption numbers are claimed until real testers have completed the trial. Do not infer usage from stars, downloads, or synthetic demos.
- The mock provider and all README visuals are synthetic and contain no real credentials or customer material.

## Trial plan

- Window: 2–4 weeks after the public `v0.3.1` release
- Testers: 3–10 volunteers
- Audiences: independent creators and small product/content teams
- Provider: each tester uses their own compatible Images API or the local mock server

## Weekly log

| Week | Active testers | Successful local tasks | Provider compatibility issues | Issues opened | Issues closed | Release / patch |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| 1 |  |  |  |  |  |  |
| 2 |  |  |  |  |  |  |
| 3 |  |  |  |  |  |  |
| 4 |  |  |  |  |  |  |

## Evidence to keep public

- Reproducible Issue reports with sanitized logs and synthetic screenshots.
- Pull requests showing the fix, review, and verification commands.
- Release notes that identify compatibility changes and known limitations.
- Aggregate counts such as testers, successful local tasks, issue response time, and release cadence.
- A short note explaining which provider behaviors were verified: `b64_json`, temporary `url`, multipart edits, multiple inputs, and unsupported edits capability.

## Evidence to keep private

- API keys and provider account details.
- Real product/customer images, personal information, local file paths, and raw prompts that identify a customer.
- Signed result URLs, crash dumps, private provider responses, and any Codex or application conversation containing secrets.

## Application-material checklist

- [ ] Link only the public repository, release notes, and sanitized Issues/PRs.
- [ ] Describe the BYOK boundary accurately: the key goes to the provider selected by the user and nowhere else.
- [ ] Report aggregate usage and maintenance evidence, never individual credentials or assets.
- [ ] State that the mock server and Showcase visuals are synthetic.
