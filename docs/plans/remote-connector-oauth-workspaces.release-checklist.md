# Release Checklist: Remote Connector OAuth And Workspaces

## Pre-Release

- [ ] `package.json` version bumped as a minor release.
- [ ] `CHANGELOG.md` documents:
	  - OAuth for remote MCP connectors.
	  - Static client/shared-secret setup.
	  - Workspace registry and provider cwd behavior.
	  - Controlled workspace folder/repo creation under allowed roots.
	  - No-auth ChatGPT path deprecation.
- [ ] `README.md` and setup docs no longer recommend no-auth ChatGPT setup for
      new installs.
- [ ] `setup/status.schema.json` accepts doctor OAuth/workspace blocks.
- [ ] Bootstrapper setup generates OAuth client settings safely.
- [ ] `print-client-config` emits OAuth setup without raw secrets by default.
- [ ] Doctor output redacts secrets and reports OAuth/workspace readiness.
- [ ] Workspace docs explain that provider CLIs do not use the gateway app dir
      as a project cwd.
- [ ] Workspace docs explain allowed roots, admin scope, local `git init`, and
      that remote network clone is not part of this release.

## Required Local Gates

```bash
npm run build
npm run lint
npm run format:check
npm test
npm run upstream:contracts
```

## Live Smoke

- [ ] HTTP gateway starts with OAuth enabled.
- [ ] HTTPS tunnel/reverse proxy reaches `/healthz`.
- [ ] `/mcp` returns 401 and `WWW-Authenticate` includes `resource_metadata`.
- [ ] Protected resource metadata returns current public `/mcp` resource.
- [ ] Authorization server metadata returns issuer, authorize, token, register.
- [ ] Static client or shared-secret registration policy blocks unauthorized
      clients.
- [ ] Authorized client completes code flow and receives Bearer token.
- [ ] MCP initialize succeeds with Bearer token.
- [ ] `workspace_list` returns registered aliases.
- [ ] Admin-scoped `workspace_create` can create a new folder workspace under an
      allowed root and rejects path traversal.
- [ ] Admin-scoped `workspace_create` can create a new local Git repo under an
      allowed root and rejects existing non-empty targets.
- [ ] Provider request with workspace alias spawns in repo root or worktree,
      not `~/.llm-cli-gateway`.

## Public Release

- [ ] No `dist/`, `.sqry/`, local tunnel hostnames, local account names, or
      secret references are committed.
- [ ] Private upstream CI passes.
- [ ] Public mirror CI passes.
- [ ] GitHub release on public mirror runs npm provenance publish.
- [ ] Published npm package contains built OAuth/workspace code and setup
      schemas.
- [ ] Fresh install from npm can configure a remote connector without relying
      on this developer checkout.

## Rollback

- [ ] Operator can disable `[http.oauth].enabled`.
- [ ] Operator can revoke/rotate OAuth client secrets.
- [ ] Operator can stop tunnel exposure.
- [ ] Local bearer clients still work after OAuth rollback.
- [ ] Workspace misconfiguration fails closed before provider spawn.
