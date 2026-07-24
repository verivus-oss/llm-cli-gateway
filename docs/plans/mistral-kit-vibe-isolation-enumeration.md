# Mistral Kit M1 step 0: Vibe ambient-config read-surface enumeration

Authoritative, source-verified list of every place Mistral Vibe 2.22.0 reads ambient
configuration. This is the correctness basis for `src/mistral-kit-isolation.ts`: any location
not covered by a lever below is an isolation LEAK. Verified against the installed source at
`/home/werner/.local/share/uv/tools/mistral-vibe/lib/python3.13/site-packages/vibe` (2026-07-24).

Levers: **H** = redirect `HOME`; **V** = redirect `VIBE_HOME`; **E** = control `VIBE_*` / bare-name env;
**C** = run in the gateway cwd left UNTRUSTED (no `--trust`, no `--add-dir`, empty trust store).

## Master table

| #   | Location                                                                                                                                                                                                                                     | Base                           | Lever                                                                                                              |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| 1   | `$VIBE_HOME/{config.toml, hooks.toml, AGENTS.md, .env, tools/, skills/, agents/, prompts/, skills-registry-cache/, cache.toml, projects.toml, trusted_folders.toml, logs/, worktrees/, plans/, vibehistory, connector_bootstrap_cache.json}` | VIBE_HOME-rel                  | **V**                                                                                                              |
| 2   | **`~/.agents/skills`** (`_agents_home.py:7`, `harness_files/_paths.py:12`, user skill source `_harness_manager.py:97-104`)                                                                                                                   | HOME-rel, NO env override      | **H only** (V does NOT cover)                                                                                      |
| 3   | `~/.vibe/logs/acp/messages.jsonl` (`acp_logger.py:17`, hardcoded `Path.home()/.vibe`)                                                                                                                                                        | HOME-rel                       | **H only**; also gated off unless `VIBE_ACP_LOGGING_ENABLED`                                                       |
| 4   | Project `.vibe/{config.toml,hooks.toml,tools,skills,agents,prompts}`, `.agents/skills`, AGENTS.md walk-up (`_local_config_files.py`, `_harness_manager.py:38-228`)                                                                           | PROJECT/CWD-rel                | **C** (untrusted cwd => not read in headless `-p`)                                                                 |
| 5   | `$VIBE_HOME/trusted_folders.toml` (the trust store, `trusted_folders.py:196`)                                                                                                                                                                | VIBE_HOME-rel                  | **V** (fresh empty store => cwd untrusted, closes #4)                                                              |
| 6   | Config-declared ABSOLUTE `skill_paths`/`tool_paths`/`agent_paths`/`session_logging.save_dir`, MCP stdio `cwd/env/command` (`vibe_schema.py:290-378`, `models.py:59-304`)                                                                     | ABSOLUTE                       | controlled by owning the config CONTENTS (gateway-written config.toml under V; untrusted cwd => no project config) |
| 7   | **Bare-name `BaseSettings` env** (no `VIBE_` prefix): `SAVE_DIR, SESSION_PREFIX, ENABLED, ENABLE, API_HOST, CLIENT_KEY, DEFAULT_COMMIT_COUNT, TIMEOUT_SECONDS` (`models.py:39-64`)                                                           | env (unprefixed)               | **E: SCRUB these exact names** (VIBE_* lever does NOT cover)                                                       |
| 8   | `MISTRAL_API_KEY` (+ MCP `api_key_env`); `$VIBE_HOME/.env`; OS keyring service `ai.mistral.vibe` (`vibe_schema.py:93-100`, `keyring.py`)                                                                                                     | env / VIBE_HOME/.env / keyring | provide `MISTRAL_API_KEY` in env + `VIBE_TEST_DISABLE_KEYRING=1` to forbid keyring fallback                        |
| 9   | Ambient spawn env inherited by the bash tool's children `{**os.environ}` (`bash.py:133`)                                                                                                                                                     | env                            | sanitize the child env (allowlist)                                                                                 |

## The lever set the isolation module MUST apply

1. **Redirect BOTH `HOME` and `VIBE_HOME`** to a gateway-owned ephemeral dir. HOME is mandatory:
   it is the ONLY lever that neutralizes `~/.agents/skills` (#2) and the hardcoded acp log dir (#3),
   and it moves the keyring home-scoped DB. VIBE_HOME covers all of #1 and gives a fresh empty trust
   store (#5), which makes the cwd untrusted and closes the project-local surface (#4).
2. **Do NOT pass `--trust` or `--add-dir`.** With an empty trust store the headless `-p` run treats
   the cwd as untrusted, so project `.vibe/.agents/AGENTS.md/hooks.toml` are inert.
3. **Write a gateway-owned `config.toml` in the redirected `VIBE_HOME`** carrying the Kit baseline:
   `[session_logging] enabled = true` (so `meta.json` is written for the M0 native-id capture),
   the mistral provider with `api_key_env = "MISTRAL_API_KEY"`, and NO absolute `skill_paths` /
   `tool_paths` / `agent_paths` (closes #6). Everything else off.
4. **Force config fields via `VIBE_*`** (belt-and-suspenders over the file): `VIBE_INCLUDE_PROJECT_CONTEXT=false`,
   `VIBE_INCLUDE_PROMPT_DETAIL=false`, `VIBE_EXPERIMENTAL_ENABLE_REGISTRY_SKILLS=false`, and an
   `enabled_skills` allowlist that matches nothing (builtins are always compiled in, `manager.py:85`,
   so a match-nothing allowlist is the only way to zero the skill set).
5. **`VIBE_TEST_DISABLE_KEYRING=1`** + provide `MISTRAL_API_KEY` explicitly in the child env (#8);
   never persist it to a durable Kit store.
6. **Scrub the bare-name env vars** in #7 from the child env; sanitize the inherited env to an
   allowlist (reuse `spawn-env-isolation.ts`) so #9 and #7 cannot leak.
7. **Full-manifest fail-closed:** after construction, assert the redirected `HOME` and `VIBE_HOME`
   contain EXACTLY the gateway-written files (no `.agents/`, no ambient `config.toml`, no extra
   dirs), and that the env fragment carries the exact lever set above. Throw a fail-closed error
   otherwise. This positive construction guarantee substitutes for vibe's absent prompt-inspection.

## Leaks the design gate (round 1) did NOT capture, now folded in

- **#7 bare-name env** (`SAVE_DIR`/`ENABLED`/... read without the `VIBE_` prefix): the `VIBE_*`
  lever cannot force these; they must be scrubbed. New.
- **#3 `~/.vibe/logs/acp`** hardcoded to `Path.home()/.vibe`: escapes a `VIBE_HOME` redirect; the
  `HOME` redirect covers it. New (write-only, low risk, but real).
- **Keyring fallback + always-present builtin skills:** need `VIBE_TEST_DISABLE_KEYRING=1` and a
  match-nothing `enabled_skills`, not a directory lever. New.

Net: the controlled-environment model holds, but the module must additionally (a) scrub the
bare-name env vars, (b) disable the keyring, and (c) zero skills via `enabled_skills`, not just
by emptying directories.
