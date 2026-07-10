# supply-chain-guard verification notes

Live-code confirmation of the spec's seams, done at implementation time on branch
`feat/supply-chain-guard` (off `master` at the 2.16.0 release). Line numbers are
current-tree, not the spec's `2c56762` base.

## Phase 0: seam audit

### Prod-closure generator (`scripts/make-prod-shrinkwrap.mjs`)

- Hardcoded input: `LOCKFILE_PATH = join(REPO_ROOT, "package-lock.json")` (`:37`);
  `argv[2]` is the output path only (`:39-45`). Confirms the spec's finding that a
  subprocess against a temp tree would read the operator lock, hence the shared
  `prodFilter` refactor.
- Filter: drop `meta.dev === true` (`:63`); root `""` strips `devDependencies`
  (`:66-74`); all other keys + source order preserved verbatim (`:49-56`, `:80`).

### Name derivation (single source of truth)

`meta.name ?? path.split(/node_modules\//).pop()` appears at:
`pre-release.sh:43`, `release-security-audit.sh:151`, `:190`, `:235`. The scanner
MUST use this exact regex form; `split("/node_modules/")` leaves the
`node_modules/` prefix on top-level entries (masked the `tar-stream@2.2.0`
consumer finding in 1.17.7; `release-security-audit.sh:150`).

### Existing release gate (`scripts/release-security-audit.sh`)

- `npm audit --omit=dev --audit-level=moderate` (`:8`).
- Shrinkwrap byte-parity: `cmp -s "${EXPECTED_SHRINKWRAP}" npm-shrinkwrap.json`
  (`:117`).
- Version blocklist over the prod graph, `tar-stream` set `{2.2.0,2.1.4,2.0.0}`
  (`:133`).
- Hono floor tripwire, does NOT skip dev entries (`:167-203`, filter at `:191`).
- Packed-consumer any-version `tar-stream` ban (`:222-256`, distinct from the
  versioned blocklist).
- Fetch-in-dist heuristic (later in the file).

### Coarse count band (pre-release only)

`scripts/verify-registry-install.sh`: `EXPECTED_REIFIED_MIN=92`,
`EXPECTED_REIFIED_MAX=96` (`:46-47`); assertion at `:274-276` (94 observed). Not
in `ci.yml` `security:audit`; a single new package passes.

### Lockfile counts (authoritative, current tree)

```json
{"total":320,"nonDevInclRoot":93,"nonDevNodeModules":92,"withMetaName":0,
 "rootHasResolved":false,"rootHasIntegrity":false,"rootName":"llm-cli-gateway"}
```

Confirms: 92 non-root prod instances, 0 carry `meta.name` (all path-derived), root
lacks `resolved`/`integrity` (must be excluded from classification).

### Internal-only proof

`package.json` `files` allowlist contains neither `scripts/` nor `docs/`
(confirmed programmatically), so the guard never ships in the tarball.
