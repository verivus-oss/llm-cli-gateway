# Single-Binary Installer Feasibility

Status: Layer 1 decision record  
Verified: 2026-05-19

## Decision

Use a Go bootstrapper for the MVP unless a later native-runtime requirement makes Rust materially better.

The bootstrapper should supervise the existing Node gateway rather than rewrite gateway behavior. It must either embed a version-pinned gateway bundle or download a version-pinned bundle after checksum/signature verification. If Node remains a host prerequisite, the product must not describe the happy path as a self-contained single-binary install.

## Required Command Surface

The MVP binary should expose these idempotent commands:

- `setup`: create config directories, generate token material, and open local setup UI.
- `doctor --json`: print machine-readable diagnostics without mutating state.
- `start`: start or restart the gateway process.
- `stop`: stop the supervised gateway process.
- `status`: print human-readable status.
- `repair`: fix known local state drift after confirmation and backups.
- `print-client-config`: print generated client snippets for supported targets.
- `upgrade`: fetch and verify a pinned gateway bundle.
- `uninstall`: remove managed service/process state without deleting provider credentials.

All commands must be safe to paste from an assistant conversation and safe to run repeatedly.

## Go vs Rust

| Capability | Go | Rust |
| --- | --- | --- |
| Static cross-platform binaries | Straightforward with `CGO_ENABLED=0` for the bootstrapper core. | Strong, but fully static builds are target/toolchain dependent. |
| Embedded HTTP setup UI | Simple standard-library `net/http` path. | Strong with ecosystem crates, but more dependencies for equivalent ergonomics. |
| Process supervision | Simple `os/exec`, signal handling, and platform-specific service wrappers. | Strong control, more code for common service/install plumbing. |
| Config editing | Standard JSON/TOML/file APIs are adequate. | Strong typed parsing and safety, more compile-time ceremony. |
| Cross-platform distribution | Mature Linux self-hosted and GitHub-hosted Windows/macOS builds with explicit `GOOS/GOARCH` targets. | Mature, but target setup and linker details are more involved. |
| Long-lived native runtime | Adequate, but not the reason to pick Go. | Stronger if the bootstrapper becomes the gateway runtime. |

Go is preferred because the MVP bootstrapper is mostly filesystem edits, process supervision, local HTTP setup UI, archive verification, and service registration. Rust remains a fallback if U08 expands into a long-lived native runtime with more demanding memory-safety or concurrency requirements.

## Packaging Architecture

Recommended MVP path:

1. Build the TypeScript gateway with `npm run build` in release CI.
2. Package `dist/`, `package.json`, lockfile metadata, and required runtime assets into a compressed bundle.
3. Publish the bundle with SHA-256 checksums and a release signature.
4. Build Go bootstrappers on the Linux self-hosted runner and GitHub-hosted Windows/macOS runners, with each runner owning its OS artifacts.
5. On first run, the bootstrapper verifies and unpacks the embedded or downloaded bundle into a user-owned application directory.
6. The bootstrapper starts the Node gateway with managed environment variables and keeps provider credentials in their official local stores.

The MVP should prefer embedding the gateway bundle when release artifact size remains reasonable. Download-and-verify is acceptable only when the binary prints the exact version, checksum, and URL before fetching and can resume or repair a partial install.

## Node Runtime Decision

Current decision: the bootstrapper may supervise the existing Node gateway, but the happy path is not self-contained unless Node is embedded or provided as a verified runtime bundle.

Acceptable release modes:

- Self-contained: Go bootstrapper embeds or installs a verified Node runtime and a verified gateway bundle.
- Verified bundle: Go bootstrapper embeds or downloads the gateway bundle, and the bundle includes all JavaScript dependencies needed at runtime.
- Host Node fallback: Go bootstrapper requires an existing compatible Node installation. This is not a self-contained single-binary happy path and must be labeled as fallback or developer mode.

## Feasibility Evidence

Local environment evidence from 2026-05-19:

- `go version`: failed with `go: command not found`.
- `rustc --version`: `rustc 1.94.1 (e408947bf 2026-03-25)`.
- `cargo --version`: `cargo 1.94.1 (29ea6fb6a 2026-03-24)`.
- `node --version`: `v24.15.0`.
- `npm --version`: `11.12.1`.
- Built gateway bundle size after `npm run build`: `dist/` is 452K; `dist/index.js` is 118K.

Because the current workspace does not have Go installed globally, the prototype used a disposable official Go toolchain in `/tmp`:

- downloaded toolchain: `go1.26.3.linux-amd64.tar.gz`
- source URL: `https://go.dev/dl/go1.26.3.linux-amd64.tar.gz`
- verified SHA-256: `2b2cfc7148493da5e73981bffbf3353af381d5f93e789c82c79aff64962eb556`
- archive size: 66,862,230 bytes

Prototype build result:

- prototype: minimal `rvwr-bootstrapper-prototype` with `doctor --json` output.
- target: `linux/amd64`
- command: `CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w"`
- build time: 1,839 ms
- binary size: 1,855,650 bytes
- compressed binary size: 811,968 bytes with `gzip -9`
- startup time for `doctor --json`: 2 ms
- `doctor --json` output: `{"ok":true,"command":"doctor --json","os":"linux","arch":"amd64"}`

This proves the recommended Go bootstrapper path can produce a small static diagnostic binary for the MVP command surface. U08 must replace this throwaway prototype with the repository bootstrapper scaffold and repeat the measurements in release CI for every target platform.

## First-Run Payload Size

Measured current payload baseline:

- Prototype bootstrapper payload in self-contained mode: one 1,855,650-byte binary; no first-run download for `doctor --json`.
- Prototype bootstrapper payload in compressed/download mode: 811,968 bytes.
- Gateway JavaScript build output after `npm run build`: 452K.
- The gateway baseline does not include `node_modules` or a Node runtime.

Release packaging must measure these before publishing:

- compressed gateway bundle size including runtime dependencies;
- optional embedded Node runtime size per target platform;
- total first-run download size when using download-and-verify mode;
- installed size under the user-owned application directory.

## Release Targets

Required MVP targets:

- macOS arm64
- macOS x64
- Linux x64
- Linux arm64
- Windows x64

## Non-Negotiable Release Rules

- The happy path must not require npm, git, or Docker.
- The bootstrapper must not collect provider passwords.
- Provider credentials remain in provider-owned local auth stores or user-owned volumes.
- Config edits require backups and must be reversible.
- Every setup step must have human-readable docs and machine-readable task form.
- If Node is not embedded or verified by the bootstrapper, do not call the happy path self-contained.
