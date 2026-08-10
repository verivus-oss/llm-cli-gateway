# how each evidence file was captured

The `// captured-by:` prefix these files used to carry made them invalid
JSON, so nothing could parse them. The commands live here instead and the
JSON files are now plain JSON. Re-run a command and diff to check a capture.

- `attestation-hono@4.12.34.json`
  ```
  curl -sS -m 60 https://registry.npmjs.org/-/npm/v1/attestations/hono@4.12.34
  ```
- `attestation-ip-address@10.3.1.json`
  ```
  curl -sS -m 60 https://registry.npmjs.org/-/npm/v1/attestations/ip-address@10.3.1
  ```
- `compare-fast-uri-3.1.4-3.1.5.json`
  ```
  gh api repos/fastify/fast-uri/compare/v3.1.4...v3.1.5 \
  --jq '{files: [.files[] | {status, filename, additions, deletions}], commits: [.commits[] | {sha: .sha, message: .commit.message, author: .commit.author.name, date: .commit.author.date}]}'
  ```
- `compare-hono-4.12.31-4.12.34.json`
  ```
  gh api repos/honojs/hono/compare/v4.12.31...v4.12.34 \
  --jq '{files: [.files[] | {status, filename, additions, deletions}], commits: [.commits[] | {sha: .sha, message: .commit.message, author: .commit.author.name, date: .commit.author.date}]}'
  ```
- `compare-ip-address-10.2.0-10.3.1.json`
  ```
  gh api repos/beaugunderson/ip-address/compare/v10.2.0...v10.3.1 \
  --jq '{files: [.files[] | {status, filename, additions, deletions}], commits: [.commits[] | {sha: .sha, message: .commit.message, author: .commit.author.name, date: .commit.author.date}]}'
  ```
- `osv-GHSA-22jq-vg5j-6vgg.json`
  ```
  curl -sS -m 30 https://api.osv.dev/v1/vulns/GHSA-22jq-vg5j-6vgg
  ```
- `osv-GHSA-28wg-ghj8-5hjv.json`
  ```
  curl -sS -m 30 https://api.osv.dev/v1/vulns/GHSA-28wg-ghj8-5hjv
  ```
- `osv-GHSA-2v37-7h3g-55p8.json`
  ```
  curl -sS -m 30 https://api.osv.dev/v1/vulns/GHSA-2v37-7h3g-55p8
  ```
- `osv-GHSA-4xrf-jv44-h6hh.json`
  ```
  curl -sS -m 30 https://api.osv.dev/v1/vulns/GHSA-4xrf-jv44-h6hh
  ```
- `osv-GHSA-54fx-42gc-7vw4.json`
  ```
  curl -sS -m 30 https://api.osv.dev/v1/vulns/GHSA-54fx-42gc-7vw4
  ```
- `osv-GHSA-79qm-7rj5-m7r9.json`
  ```
  curl -sS -m 30 https://api.osv.dev/v1/vulns/GHSA-79qm-7rj5-m7r9
  ```
- `osv-GHSA-7p8r-x3mc-p8w7.json`
  ```
  curl -sS -m 30 https://api.osv.dev/v1/vulns/GHSA-7p8r-x3mc-p8w7
  ```
- `osv-GHSA-8j4g-w8fx-2239.json`
  ```
  curl -sS -m 30 https://api.osv.dev/v1/vulns/GHSA-8j4g-w8fx-2239
  ```
- `osv-GHSA-f23p-vx2j-j53r.json`
  ```
  curl -sS -m 30 https://api.osv.dev/v1/vulns/GHSA-f23p-vx2j-j53r
  ```
- `osv-GHSA-fxqj-rqcc-2cmp.json`
  ```
  curl -sS -m 30 https://api.osv.dev/v1/vulns/GHSA-fxqj-rqcc-2cmp
  ```
- `osv-GHSA-mwp4-54f8-5fhr.json`
  ```
  curl -sS -m 30 https://api.osv.dev/v1/vulns/GHSA-mwp4-54f8-5fhr
  ```
- `osv-GHSA-rgw5-rvv9-x895.json`
  ```
  curl -sS -m 30 https://api.osv.dev/v1/vulns/GHSA-rgw5-rvv9-x895
  ```
- `registry-fast-uri@3.1.4.json`
  ```
  curl -sS -m 30 https://registry.npmjs.org/fast-uri/3.1.4
  ```
- `registry-fast-uri@3.1.5.json`
  ```
  curl -sS -m 30 https://registry.npmjs.org/fast-uri/3.1.5
  ```
- `registry-hono@4.12.31.json`
  ```
  curl -sS -m 30 https://registry.npmjs.org/hono/4.12.31
  ```
- `registry-hono@4.12.34.json`
  ```
  curl -sS -m 30 https://registry.npmjs.org/hono/4.12.34
  ```
- `registry-ip-address@10.2.0.json`
  ```
  curl -sS -m 30 https://registry.npmjs.org/ip-address/10.2.0
  ```
- `registry-ip-address@10.3.1.json`
  ```
  curl -sS -m 30 https://registry.npmjs.org/ip-address/10.3.1
  ```

The `.diff` files keep their prefix comment, since a diff has no parser to
break and the provenance line is useful inline.

## tarball capture (ip-address)

`tarball-dist-ip-address-10.2.0-10.3.1.diff` is the diff of the two published
npm artifacts, not of tagged source. Reproduce it with:

```sh
for v in 10.2.0 10.3.1; do
  curl -sS -o "ip-address-$v.tgz" \
    "https://registry.npmjs.org/ip-address/-/ip-address-$v.tgz"
  # verify before extracting; compare against dist.integrity in
  # registry-ip-address@$v.json
  echo "sha512-$(openssl dgst -sha512 -binary "ip-address-$v.tgz" | base64 -w0)"
  mkdir -p "x$v" && tar xzf "ip-address-$v.tgz" -C "x$v"
done
diff -ru \
  --label ip-address-10.2.0/package/dist \
  --label ip-address-10.3.1/package/dist \
  x10.2.0/package/dist x10.3.1/package/dist -x '*.js.map'
```

Expected integrity values, both confirmed before extraction:

- 10.2.0 `sha512-/+S6j4E9AHvW9SWMSEY9Xfy66O5PWvVEJ08O0y5JGyEKQpojb0K0GKpz/v5HJ/G0vi3D2sjGK78119oXZeE0qA==`
- 10.3.1 `sha512-1e9d3kb97NHJTIJDZW9rKqW2h6+dFa50Dy0fpPSMQp2ADje5gvKsXmdiK6dwY5t76TaTt5+P5N1Y/LoToIxP6g==`

`-x '*.js.map'` excludes the **five** changed source-map files (`common`,
`ipv4`, `ipv6`, `v4/constants`, `v6/constants`), disclosed here rather than
silently dropped.

An earlier version of this note said there were four, and said their embedded
sources merely duplicate `patch-*.diff`. Both were wrong, and Codex caught them.
The maps do **not** duplicate the tag patch: 10.2.0's maps embed *stale,
pre-tag* sources, which is precisely the evidence for the tag-versus-artifact
divergence recorded in `../ip-address@10.3.1.md`. They are excluded from the
committed diff only for size, since each carries a full TypeScript source copy.
Drop the `-x` to see them, or compare a single map against its tag directly:

```sh
python3 - <<'EOF'
import json, pathlib
m = json.loads(pathlib.Path("x10.2.0/package/dist/v6/constants.js.map").read_text())
print(m["sourcesContent"][0])
EOF
gh api repos/beaugunderson/ip-address/contents/src/v6/constants.ts?ref=v10.2.0   --jq '.content' | base64 -d
```

The `--label` arguments exist so the committed diff carries no absolute machine
path or local account name. Codex flagged the first version of this file for
leaking both.

## a note on `gh`

These are written as plain `gh api`. On the machine that captured them the
invocation was `gh-as <account> api ...`, a local wrapper that selects a
credential; the API path and `--jq` projection are identical either way.

## patch-*.diff capture

The three `patch-<pkg>-<from>-<to>.diff` files carry their provenance as a first
line, which for a diff breaks no parser. That line was prose rather than a
runnable command; the exact projection is:

```
gh api repos/<owner>/<repo>/compare/<from-tag>...<to-tag> \
  --jq '.files[] | select(.filename|test("^(src|index\\.js)")) |
        "########## \(.filename) (+\(.additions)/-\(.deletions))\n\(.patch)\n"'
```

with `<owner>/<repo>` and tags being `fastify/fast-uri v3.1.4...v3.1.5`,
`honojs/hono v4.12.31...v4.12.34`, and
`beaugunderson/ip-address v10.2.0...v10.3.1`.

The `select` filter is why these capture `src/` (and fast-uri's top-level
`index.js`) and nothing else. Completeness of the ip-address capture was checked
by comparing each file's captured added and removed line counts against the
`additions` and `deletions` the compare API reports: all five match exactly.
That check is what establishes that the missing canonicalisation is genuinely
absent from the tagged-source diff rather than lost in capture, which is the
foundation of the tag-versus-artifact finding.

## on reproducing these captures exactly

A recorded command reproduces the same *content*, not necessarily the same
bytes. Grok pointed out that `gh` pretty-prints and colourises its output
depending on version and on whether a TTY or `FORCE_COLOR` is in play, so a
re-run can differ in formatting while being semantically identical. On the
capturing host the fast-uri compare command did reproduce byte-identically;
treat that as a property of that host, not a guarantee. Compare parsed JSON
rather than raw bytes if you are checking one of these.
