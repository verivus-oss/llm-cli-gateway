# Devin Setup

## Support Status

Devin is a verified inbound MCP host when the account has permission to add
custom MCP servers, and it is an outbound validation provider through the local
Devin CLI. Keep those roles separate: inbound setup lets Devin call the
gateway; outbound setup lets the gateway call Devin through `devin_request`.

## Human Instructions

1. For outbound validation, install and authenticate the Devin CLI through
   Devin's official flow.
2. Run `llm-cli-gateway doctor --json` and confirm
   `providers.devin.cli_available` is `true`.
3. For inbound MCP use, expose the gateway through a URL reachable from Devin.
   For cloud/web Devin surfaces, use public HTTPS rather than localhost.
4. In Devin's MCP server settings, add the gateway as an HTTP MCP server at
   `<public-https-url>/mcp` and configure bearer authentication there.
5. Re-run `doctor --json` after setup and verify endpoint exposure before
   claiming readiness.

## Assistant Instructions

Never ask for Devin passwords, API keys, bearer tokens, OAuth tokens, or
credential files. Use generated local snippets or placeholders. If the user does
not have permission to add custom MCP servers in Devin, document inbound setup
as blocked and continue with outbound CLI validation only.

## Config Snippet

```text
Server name: llm-cli-gateway
Transport: HTTP
URL: <public-https-url>/mcp
Authentication: Bearer token configured in Devin MCP settings
```

Do not configure a cloud Devin surface with `127.0.0.1`, LAN-only, or HTTP-only
URLs unless the Devin environment itself is running beside the gateway.

## Verification

In Devin, ask: `validate this sentence with two other models: Devin can call the gateway.`

For outbound validation from another client, call `devin_request` with a small
prompt and confirm the job appears in `llm_job_status` when async jobs are
enabled.

## Known Limitations

Custom MCP server availability can depend on Devin account, organization, and
permission settings. Devin's hosted MCP server is a separate product surface
from this gateway and should not be confused with configuring
`llm-cli-gateway` as an MCP server.
