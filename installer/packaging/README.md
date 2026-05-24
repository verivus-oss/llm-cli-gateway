# Release Packaging

Status: Layer 7 (U13) packaging contract
Builder: `installer/build-release.sh`

This directory documents how `llm-cli-gateway` is built into a non-developer
release: the local Linux self-hosted runner builds Linux Go bootstrapper
binaries, GitHub-hosted Windows and macOS runners build their platform
binaries, and each OS runner packages its platform bundle. The final Linux job
publishes combined checksums and metadata.

## Artifact set

After the release workflow runs, `installer/dist/` contains:

- `llm-cli-gateway-<version>-darwin-arm64`
- `llm-cli-gateway-<version>-darwin-amd64`
- `llm-cli-gateway-<version>-linux-amd64`
- `llm-cli-gateway-<version>-linux-arm64`
- `llm-cli-gateway-<version>-windows-amd64.exe`
- `llm-cli-gateway-bundle-<version>-darwin-arm64.tar.gz`
- `llm-cli-gateway-bundle-<version>-darwin-amd64.tar.gz`
- `llm-cli-gateway-bundle-<version>-linux-amd64.tar.gz`
- `llm-cli-gateway-bundle-<version>-linux-arm64.tar.gz`
- `llm-cli-gateway-bundle-<version>-windows-amd64.tar.gz`
- `install-windows.ps1`
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
invokes the script from the Linux self-hosted runner and GitHub-hosted
Windows/macOS runners, passing explicit `--target` values for the artifacts
owned by that runner.

Options:

| Flag             | Effect                                                       |
| ---------------- | ------------------------------------------------------------ |
| `--version VER`  | Override release version (default: `package.json#version`).  |
| `--skip-bundle`  | Build only the Go binaries; skip platform bundle tarballs.    |
| `--skip-binaries` | Package platform bundles/metadata without building Go binaries. |
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

Windows PowerShell:

```powershell
$Version = '<version>'
$Base = "https://github.com/verivus-oss/llm-cli-gateway/releases/download/v$Version"
$InstallDir = Join-Path (Join-Path $env:LOCALAPPDATA 'Programs') 'llm-cli-gateway'
$Exe = Join-Path $InstallDir 'llm-cli-gateway.exe'
New-Item -ItemType Directory -Force $InstallDir | Out-Null
Invoke-WebRequest -UseBasicParsing "$Base/llm-cli-gateway-$Version-windows-amd64.exe" -OutFile $Exe
$env:RVWR_GATEWAY_BUNDLE_URL = "$Base/llm-cli-gateway-bundle-$Version-windows-amd64.tar.gz"
$env:RVWR_GATEWAY_BUNDLE_SHA256 = '<bundle-sha256-from-SHA256SUMS>'
& $Exe setup
& $Exe stop
& $Exe install-bundle
& $Exe start
& $Exe status
& $Exe doctor
```

The release manifest includes a pinned Windows PowerShell command with the
exact artifact version and SHA256 values. The install flow downloads the
Windows bootstrapper, installs the checksummed Windows platform bundle, starts
the gateway, and runs `doctor`. It also writes a stable `llm-cli-gateway.exe`
command to
`%LOCALAPPDATA%\Programs\llm-cli-gateway`, adds that directory to the user PATH,
and uses that stable command for future `start`, `stop`, `status`, and `doctor`
operations.

```bash
chmod +x llm-cli-gateway-<version>-<os>-<arch>
./llm-cli-gateway-<version>-<os>-<arch> setup
./llm-cli-gateway-<version>-<os>-<arch> install-bundle  # if a remote bundle is configured
./llm-cli-gateway-<version>-<os>-<arch> start
./llm-cli-gateway-<version>-<os>-<arch> doctor
```

Required environment for `install-bundle`:

- `RVWR_GATEWAY_BUNDLE_URL` — pinned URL of `llm-cli-gateway-bundle-<version>-<os>-<arch>.tar.gz`
- `RVWR_GATEWAY_BUNDLE_SHA256` — the bundle's SHA256 from `SHA256SUMS`

The binary refuses to install an unverified bundle. The platform bundle
contains the compiled gateway, production `node_modules`, setup assets, and a
managed Node runtime; users do not install Node globally for the happy path.

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
