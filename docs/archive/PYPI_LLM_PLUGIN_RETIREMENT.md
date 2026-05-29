# Retired PyPI plugin description

[![PyPI plugin status](https://img.shields.io/badge/PyPI%20plugin-retired-lightgrey.svg)](https://pypi.org/project/llm-cli-gateway/)

`llm-cli-gateway` no longer ships a PyPI package or `llm` plugin integration
after v1.15.2. The gateway is now distributed through the npm package and
signed GitHub release artifacts only. This removes the runtime dependency on
Simon Willison's `llm` package and keeps the public surface focused on the MCP
server itself.

The previous PyPI package exposed `gateway-claude`, `gateway-codex`, and
`gateway-gemini` model aliases through the `llm` command-line application. That
bridge was useful while the project was proving that a local gateway could sit
between a user and several provider CLIs, but it was not the core product. The
core product is the `llm-cli-gateway` MCP appliance: one local endpoint that
can run Claude Code, Codex, Gemini, Grok, and Mistral Vibe CLIs with consistent
request schemas, durable async jobs, session continuity, retry/circuit-breaker
behavior, and a queryable SQLite flight recorder.

Users should install the gateway from npm or from the signed GitHub release
artifacts:

```bash
npm install -g llm-cli-gateway
```

or use the platform installer assets from:

```text
https://github.com/verivus-oss/llm-cli-gateway/releases
```

The recommended integration path is now direct MCP configuration in the client
that needs the gateway. Use the local HTTP transport for clients that support
remote MCP URLs, or stdio for clients that launch MCP servers as local
processes. The gateway keeps provider credentials on the user's machine and
does not provide hosted multi-tenant credential custody.

Existing users of the retired PyPI package should remove the plugin and
configure their MCP client directly against `llm-cli-gateway`. The historical
PyPI package is left in place only as an archive of the former `llm` plugin
integration; it is no longer the supported install path and should not be used
for new deployments.
