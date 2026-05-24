# Release Packaging

Status: Layer 7 (U13) packaging contract
Builder: `installer/build-release.sh`

This directory documents how `llm-cli-gateway` is built into a non-developer
release: local Linux, Windows, and macOS runners build the Go bootstrapper
binaries, then a Linux packaging job publishes the checksummed Node gateway
bundle the bootstrapper installs via `install-bundle`.

## Artifact set

After the release workflow runs, `installer/dist/` contains:

- `llm-cli-gateway-<version>-darwin-arm64`
- `llm-cli-gateway-<version>-darwin-amd64`
- `llm-cli-gateway-<version>-linux-amd64`
- `llm-cli-gateway-<version>-linux-arm64`
- `llm-cli-gateway-<version>-windows-amd64.exe`
- `llm-cli-gateway-bundle-<version>.tar.gz`
- `SHA256SUMS`
- `release-manifest.json`

Every artifact has a line in `SHA256SUMS`. Users MUST verify before
execution; release notes and assistant prompts must instruct verification
before running the binary.

## Build

From the repository root:

```bash
installer/build-release.sh
```

Direct local runs build only the current host target by default. Release CI
invokes the script from local self-hosted Linux, Windows, and macOS runners and
passes explicit `--target` values for the artifacts owned by that runner.

Options:

| Flag             | Effect                                                       |
| ---------------- | ------------------------------------------------------------ |
| `--version VER`  | Override release version (default: `package.json#version`).  |
| `--skip-bundle`  | Build only the Go binaries; skip the Node bundle tarball.    |
| `--skip-binaries` | Package the Node bundle and metadata without building Go binaries. |
| `--target os/arch` | Restrict to one target (repeatable).                       |
| `--all-targets`  | Build the full target list from the current host; for local testing only, not release CI. |

Environment:

| Variable                  | Effect                                                          |
| ------------------------- | --------------------------------------------------------------- |
| `RVWR_RELEASE_VERSION`    | Same as `--version`.                                            |
| `RVWR_RELEASE_DIR`        | Override output directory (default: `installer/dist`).          |
| `RVWR_RELEASE_PUBLIC_BASE`| Optional public download base, written into `release-manifest.json`. Never put auth tokens in this URL. |
| `RVWR_RELEASE_ALL_TARGETS`| Set to `1` to match `--all-targets`; for local testing only.     |

## Verification (what end users run)

```bash
# Linux
sha256sum --check SHA256SUMS

# macOS
shasum -a 256 --check SHA256SUMS

# Windows PowerShell
Get-FileHash llm-cli-gateway-<version>-windows-amd64.exe -Algorithm SHA256
```

If verification fails, **do not run the binary**; redownload and reverify.

## Install / upgrade / uninstall (binary contract)

The bootstrapper binary is idempotent. Commands are safe to rerun from
assistant-led instructions.

### Install

```bash
chmod +x llm-cli-gateway-<version>-<os>-<arch>
./llm-cli-gateway-<version>-<os>-<arch> setup
./llm-cli-gateway-<version>-<os>-<arch> install-bundle  # if a remote bundle is configured
./llm-cli-gateway-<version>-<os>-<arch> start
./llm-cli-gateway-<version>-<os>-<arch> doctor
```

Required environment for `install-bundle`:

- `RVWR_GATEWAY_BUNDLE_URL` — pinned URL of `llm-cli-gateway-bundle-<version>.tar.gz`
- `RVWR_GATEWAY_BUNDLE_SHA256` — the bundle's SHA256 from `SHA256SUMS`

The binary refuses to install an unverified bundle.

### Upgrade

```bash
# Replace the binary with the new version, then run upgrade. The
# bootstrapper stops the running gateway, runs install-bundle with the
# new RVWR_GATEWAY_BUNDLE_* env vars, and prompts you to restart.
RVWR_GATEWAY_BUNDLE_URL=... RVWR_GATEWAY_BUNDLE_SHA256=... \
  ./llm-cli-gateway-<new-version>-<os>-<arch> upgrade
./llm-cli-gateway-<new-version>-<os>-<arch> start
./llm-cli-gateway-<new-version>-<os>-<arch> doctor
```

Upgrade preserves the local auth token, the managed app directory, and
provider client config; it only rotates the gateway bundle.

### Uninstall

`uninstall` is intentionally explicit. Without `--yes` it dry-runs.

```bash
# Dry run — prints what would be deleted.
./llm-cli-gateway-<version>-<os>-<arch> uninstall

# Real removal.
./llm-cli-gateway-<version>-<os>-<arch> uninstall --yes
```

The command stops the running gateway, removes the managed app
directory (`~/.llm-cli-gateway` by default, including the auth token and
gateway dist), and is safe to rerun when the directory is already gone.

### Repair

Repair is also idempotent. It recreates missing managed state without
overwriting existing files.

```bash
./llm-cli-gateway-<version>-<os>-<arch> repair
```

## Docker fallback

The single binary is the primary install path. Docker Compose remains a
documented fallback for users who already manage containers:

```bash
docker compose -f docker-compose.personal.yml up -d
docker compose -f docker-compose.personal.yml exec gateway node dist/index.js doctor --json
```

Volume mounts in `docker-compose.personal.yml` keep provider credentials
and the app directory on the host so the user retains custody.

## Release-manifest.json

`release-manifest.json` is the machine-readable index a target-LLM
assistant can consume:

```json
{
  "schema_version": "release-manifest.v1",
  "version": "<ver>",
  "checksums_file": "SHA256SUMS",
  "artifacts": [ ... ],
  "setup_commands": {
    "verify_checksum_linux": "sha256sum --check SHA256SUMS",
    "install_unix_oneliner": "...",
    "upgrade_unix_oneliner": "...",
    "uninstall_unix_oneliner": "...",
    "docker_fallback": "..."
  }
}
```

The `setup_commands` are copy/paste-safe and never embed auth tokens; the
auth token is generated locally by `setup`.

## Signing (next step)

Layer 7 ships with SHA256 verification. Signed artifacts (cosign /
sigstore or codesign / Authenticode) are tracked as follow-up work and
will land before the public-release announcement; the verify step in
`release-manifest.json` is forward-compatible with adding a
`signatures_file` field.

## Notes for assistants

Target-LLM assistants helping a user install/upgrade/uninstall should:

- Always quote the verification command, not the binary command first.
- Never paste tokens into chat. The bootstrapper writes the token to a
  user-owned file; `doctor --json` reports `auth.token_configured` without
  echoing the value.
- Prefer the single-binary path; mention Docker only when the user has
  already chosen container deployment.
- After every step, ask for fresh `doctor --json`.
