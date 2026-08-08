# Contributing to LUK Image Workspace

Thanks for helping improve a privacy-first creative tool.

## Before opening a change

- Read the [README](README.md) and [SECURITY.md](SECURITY.md).
- Keep the repository’s BYOK boundary intact: provider keys belong in encrypted main-process storage only.
- Use the mock provider for screenshots and manual testing. Do not use customer assets or a personal API key in a commit, test fixture, issue, pull request, or release artifact.
- Preserve unrelated local changes and keep patches narrow.

## Local checks

```bash
npm ci
npm run typecheck
npm test
npx electron-vite build
```

For an end-to-end local image flow:

```bash
npm run demo:server
npm run dev
```

Configure `http://127.0.0.1:8787/v1`, `demo-local-only`, and `mock-image2` in Settings.

## Pull requests

Please explain:

1. the user-facing behavior;
2. the files and data boundaries affected;
3. the checks you ran;
4. any provider-specific or platform-specific limitation.

Do not include screenshots with API keys, signed URLs, usernames, local paths, customer material, or personal information. Use synthetic fixtures from `docs/media/` or the mock server.
