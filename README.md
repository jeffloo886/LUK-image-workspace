# AI Image Workspace

A macOS desktop studio for AI image generation workflows, built with **Electron + Vue 3 + Vite**.

It turns a single product photo into a full commercial visual package: detail-page scene plans, batch remakes, batch SKUs, localized scene editing, layered PSD export, and an 8-angle product turntable — all from a native desktop app with a clean, keyboard-friendly UI.

> **Note on the backend**: this app talks to a self-hosted "image generation" backend (accounts, credits, generation tasks, top-ups) over the JSON API protocol defined in [`src/renderer/src/api.ts`](src/renderer/src/api.ts). The repository ships with **placeholder API/base and tenant settings** — nothing is hardcoded to any particular hosted service. You must point it at your own compatible backend before it becomes usable (see [Backend configuration](#backend-configuration)).

## Features

- **Text-to-image** and **image-to-image** with up to 4 reference images
- **One-click detail page 4.0**: plan 8 scene options from one product photo, edit the plan, then batch-generate
- **Batch remake**: transfer composition/lighting/style from up to 20 reference images
- **Batch SKU**: reuse one visual template across many SKU variants
- **Localized scene editing**: paint a region to refine, then feather-blend the result back into the original (scene edit modal + pixel-accurate compositing)
- **Image → PSD** with layered masks, subject protection and optional mask editing — powered by local ONNX models (BiRefNet lite matting + LaMa background inpainting + PP-OCRv4 text detection), with a graceful fallback to macOS Vision compatibility mode when models are missing
- **Embedded Photopea editing**: open local PSD/images in an in-app Photopea window; files never leave your machine
- **Turntable studio**: 8-angle fake turntable from a single photo, with in-app spin preview and WebM loop export
- **Voice-to-prompt** via a local macOS Speech recognizer
- Persistent login session (encrypted via `safeStorage`), credit/usage dashboard, paginated task history synced with web/mini-program clients
- Theme, output directory and auto-download settings; system notifications; single-instance lock
- **Self-hosted auto-update**: Ed25519-signed update manifests (no Apple Developer ID required)

## Screenshots

(TBD — add your own screenshots before publishing.)

## Tech stack

| Layer | Technology |
|-------|------------|
| UI | Vue 3, custom components (`App.vue`, `WorkflowStudio.vue`, `TurntableStudio.vue`, …) |
| Desktop shell | Electron 37, electron-vite, context-isolated preload bridge |
| Image processing | `sharp`, `ag-psd`, `onnxruntime-node` |
| Local AI | BiRefNet lite ONNX, LaMa ONNX, PP-OCRv4 ONNX (downloaded via `npm run download:models`, gitignored) |
| Native helpers | Objective-C helpers compiled with clang: `VisionSegmenter` (macOS Vision subject/text detection) and `SpeechRecognizer` (macOS Speech) |

## Requirements

- macOS 14+
- Node.js 20+ and npm
- Xcode Command Line Tools (`xcrun clang`) for building the native helpers

## Quick start

```bash
npm install
npm run dev          # launch in development mode
```

Build a distributable (downloads AI models first, builds native helpers, type-checks):

```bash
npm run build
npm run package:arm64   # unpacked .app in build/release/
npm run dist:arm64      # signed-DMG-less .dmg + update artifact (see release section)
```

## Backend configuration

The app is intentionally not bound to any specific hosted service. Before it can log in and generate, configure a compatible backend:

1. **Main process** (`src/main/index.ts`): `API_BASE_URL` / `TENANT_SN` constants, or override at runtime via environment variables:

   ```bash
   IMAGE_WORKSPACE_API_BASE_URL=https://your-backend.example.com \
   IMAGE_WORKSPACE_TENANT_SN=your-tenant-sn \
   npm run dev
   ```

2. **Renderer fallback** (`src/renderer/src/api.ts`): same two constants, used only when the app runs outside Electron (browser preview) — keep them in sync with step 1.

The backend must implement the API protocol used by this app — see `ALLOWED_API_PATHS` in `src/main/index.ts` for the whitelisted endpoints (auth, config, providers, credits, generate, task polling/history, top-up packages/orders).

## Local AI models (Image → PSD)

The PSD pipeline uses three ONNX models (~417 MB total) downloaded from public mirrors (Hugging Face / jsDelivr) via `scripts/download-models.mjs`. The `build` script runs it automatically; models are gitignored and embedded into the installer via `extraResources`. If models are missing at runtime, the app falls back to Vision-compatible mode (indicated by a "兼容模式" badge).

## Self-hosted auto-update

No Apple Developer ID, no Squirrel.Mac — updates use a signed manifest + zip swap:

1. Generate an Ed25519 keypair: `npm run gen-update-key` (prints the **public key**, writes the **private key** base64 to `update-private-key.b64`, gitignored). Import the private key into Keychain: `security add-generic-password -a "$USER" -s image-workspace-update-key -w "$(cat update-private-key.b64)"`, then delete the file and back it up offline.
2. Paste the public key into `src/main/updater/keys.ts` (`UPDATE_PUBLIC_KEY_PEM`) and set `UPDATE_MANIFEST_URL` / `UPDATE_RELEASES_PAGE` / `EXPECTED_BUNDLE_ID` to your release repo and bundle id.
3. Configure `RELEASE_REPO` in `scripts/release.mjs`, bump `version` in `package.json`, commit with a clean worktree.
4. `npm run release` — builds, packages, signs. Review artifacts in `build/release/`, then `npm run release -- --publish` to tag, push and upload via `gh release create`.

Never commit `update-private-key.*`; regenerating a key invalidates updates for all installed clients.

## Project layout

```
src/
  main/          Electron main process: API whitelist proxy, session/settings, updater, PSD & crop pipelines, Photopea host, native helper management
  preload/       contextBridge exposure (window.desktop)
  renderer/      Vue 3 UI (App.vue + feature components), api client, Photopea host page
resources/
  vision-helper/ VisionSegmenter.m + compiled binary (macOS Vision)
  speech-helper/ SpeechRecognizer.m + compiled binary (macOS Speech)
  ai-models/     ONNX models (gitignored, downloaded by script)
  icons/         App icon
scripts/
  release.mjs        full release pipeline (build → package → sign → publish)
  download-models.mjs  fetches ONNX models
  gen-update-key.mjs    generates the Ed25519 update keypair
  after-pack.mjs         post-pack hardening (fuses, dylib cleanup)
```

## Security notes

- Renderer runs with `contextIsolation: true`, `nodeIntegration: false`; filesystem and network access goes through a small, explicitly whitelisted IPC surface.
- The main process only proxies a fixed allowlist of API paths, refuses cross-origin requests, and validates every IPC sender.
- Session tokens are encrypted with the OS keychain-backed `safeStorage`.
- Remote images, uploads, and update packages are size/SHA-256 verified; updates additionally require an Ed25519 signature.
- Without a paid Apple Developer ID the app is unsigned: first launch may require a manual "Open Anyway" in System Settings.

## License

MIT — see [LICENSE](LICENSE).
