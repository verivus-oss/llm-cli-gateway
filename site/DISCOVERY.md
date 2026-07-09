# Discovery route matrix

This file is the source of truth for llm-cli-gateway.dev machine-readable
discovery routes. Unknown paths must return 404. If a production probe sees the
homepage for a machine route, diagnose the active Cloudflare Pages fallback
first: `site/_redirects`, `site/_routes.json`, generated Pages config, Pages
SPA/catch-all settings, and deployment logs.

The current checkout has no tracked `_redirects` or `_routes.json`; any live
homepage fallback for missing JSON paths is therefore expected to come from the
Pages project configuration or from a deploy artifact outside these files.

| Path | Purpose | Canonical source | Alias type | Validation mode | Content-Type | Cache-Control | Sitemap | Generator/check |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `/.well-known/agent.json` | Agent metadata | same file | canonical | no-follow | `application/json; charset=utf-8` | `public, max-age=300, must-revalidate` | yes | `npm run site:validate` |
| `/agent.json` | Compatibility agent metadata | `/.well-known/agent.json` | generated-copy | generated-equivalence | `application/json; charset=utf-8` | `public, max-age=300, must-revalidate` | no | `npm run site:generate -- --check` |
| `/.well-known/mcp/server-card.json` | MCP server card | same file | canonical | no-follow | `application/json; charset=utf-8` | `public, max-age=300, must-revalidate` | yes | `npm run site:validate` |
| `/.well-known/mcp.json` | Compatibility MCP descriptor | `/.well-known/mcp/server-card.json` | generated-copy | generated-equivalence | `application/json; charset=utf-8` | `public, max-age=300, must-revalidate` | no | `npm run site:generate -- --check` |
| `/.well-known/api-catalog` | RFC 9727-style linkset catalog | generated catalog source | canonical | no-follow | `application/linkset+json; charset=utf-8` | `public, max-age=300, must-revalidate` | yes | `npm run site:generate -- --check` |
| `/.well-known/ai-catalog.json` | Compatibility AI catalog | `/.well-known/api-catalog` generated source | generated-copy | generated-equivalence | `application/json; charset=utf-8` | `public, max-age=300, must-revalidate` | no | `npm run site:generate -- --check` |
| `/.well-known/integrations.json` | Integration declaration | same file | canonical | no-follow | `application/json; charset=utf-8` | `public, max-age=300, must-revalidate` | yes | `npm run site:validate` |
| `/install.md` | Short install spec | same file | canonical | no-follow | `text/markdown; charset=utf-8` | `public, max-age=300, must-revalidate` | yes | `npm run site:validate` |
| `/agents.md` | Full agent guide | same file | canonical | no-follow | `text/markdown; charset=utf-8` | `public, max-age=300, must-revalidate` | yes | `npm run site:validate` |
| `/tools.md` | Runtime-derived tool index | runtime MCP `tools/list` fixture | generated-copy | generated-equivalence | `text/markdown; charset=utf-8` | `public, max-age=300, must-revalidate` | yes | `npm run site:generate -- --check` |
| `/workflows/cross-model-review.md` | Deterministic workflow demo | same file | canonical | no-follow | `text/markdown; charset=utf-8` | `public, max-age=300, must-revalidate` | yes | `npm run site:validate` |
| `/llms.txt` | Compact retrieval router | same file | canonical | no-follow | `text/plain; charset=utf-8` | `public, max-age=300, must-revalidate` | yes | `npm run site:validate` |

Catalogs and docs may link only to same-deploy existing files or stable external
URLs. `scripts/validate-site-discovery.mjs` resolves catalog and markdown links
and fails on missing internal targets or homepage HTML fallback.
