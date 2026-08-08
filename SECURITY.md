# Security policy

## Supported versions

The latest release and the default branch receive security fixes. Older builds may contain retired authentication or provider behavior and should be upgraded before reporting a suspected issue.

## Reporting a vulnerability

Please do not post a credential, signed URL, private image, crash dump, or exploit details in a public issue. Open a private report through the repository’s supported security channel, or contact the maintainer privately before disclosure.

Include only the minimum reproducible information:

- app version and macOS version;
- the affected workflow and whether the mock provider reproduces it;
- sanitized logs with keys, URLs with query strings, local paths, and personal data removed;
- impact and a suggested mitigation if known.

Never send a real API key for debugging. Rotate a key immediately if it was pasted into a log, screenshot, issue, pull request, or chat.

## Privacy design commitments

- Keys are encrypted with Electron `safeStorage` in the main process.
- The renderer receives only key presence and a mask.
- Requests are sent only to the user-configured provider origin.
- The key is never sent to the maintainer, GitHub, OpenAI/Codex, analytics, or an undisclosed service.
- API errors are sanitized before crossing the IPC boundary.
- Local history does not persist remote signed URLs or base64 results.
- There is no telemetry, crash upload, usage analytics, or hidden reporting endpoint.
