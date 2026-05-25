# llm-cli-gateway Installer Bootstrapper

Status: Layer 2 scaffold

This Go bootstrapper is the non-developer install primitive for the Personal MCP Appliance MVP. It is intentionally small: it manages local config, verifies/downloads platform bundles, starts the gateway with the managed Node runtime installed from that bundle, exposes a local setup UI, and prints machine-readable diagnostics.

## Commands

- `setup`: create the user-owned app directory and gateway auth token.
- `doctor --json`: print safe diagnostic JSON.
- `start`: start the gateway over Streamable HTTP.
- `stop`: stop the gateway process recorded by the bootstrapper.
- `status`: print process status.
- `repair`: idempotently recreate missing managed state.
- `print-client-config`: print a Streamable HTTP client snippet with the local URL and a redacted bearer header.
- `setup-ui`: start the local setup UI on `127.0.0.1:3340`.
- `install-bundle`: download `RVWR_GATEWAY_BUNDLE_URL`, verify `RVWR_GATEWAY_BUNDLE_SHA256`, and install a zip or tar.gz platform bundle that contains `gateway/dist/index.js` and `runtime/node`.

## Bundle Policy

The bootstrapper must not run an unverified remote bundle. Layer 2 provides the checksum-enforced download path and only replaces the managed gateway/runtime directories after the verified bundle unpacks to a startable `gateway/dist/index.js` and managed Node runtime. Host Node is a developer fallback only when `RVWR_ALLOW_HOST_NODE=1` is explicitly set.

## Safety Rules

- Commands are idempotent and safe to rerun from assistant instructions.
- Provider passwords are never requested.
- Auth tokens are generated locally and stored under the user's app directory.
- Setup exports redact bearer tokens and authorization headers.
- Future config writers must create backups before modifying provider client config.
