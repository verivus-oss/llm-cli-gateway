// Offline unit tests for the consumer dependency-tree tripwire. Pure
// classification over injected `npm ls --all --json` fixtures; no network, no
// npm install, no verdaccio.
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  copyFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  EXPECTED_TREE_PROBLEMS,
  REVIEWED_CONSUMER_VERSIONS,
  OK_MARKER,
  classifyConsumerTree,
  collectInvalidNodes,
  collectPackageVersions,
  reviewedVersionProblems,
  formatConsumerTreeReport,
  isDirectInvocation,
  parseInvalid,
} from "./check-consumer-tree.mjs";

const MODULE_PATH = fileURLToPath(new URL("./check-consumer-tree.mjs", import.meta.url));

// The shape npm emits in OUR repo tree (sdk is a direct dependency).
const HONO_INVALID = '"^1.19.9" from node_modules/@modelcontextprotocol/sdk';
// The shape npm emits in a REAL consumer, where our package is nested. This
// is what the live verdaccio gate produced and what an exact-string matcher
// got wrong; the two must be treated as the same reviewed pin.
const HONO_INVALID_NESTED =
  '"^1.19.9" from node_modules/llm-cli-gateway/node_modules/@modelcontextprotocol/sdk';

// The classifier tests below exercise the matching logic against a representative
// reviewed pin. They pass this sample EXPLICITLY rather than leaning on the
// production EXPECTED_TREE_PROBLEMS, which is now empty: the SDK broadened its
// @hono/node-server range to `^1.19.9 || ^2.0.5`, so the 2.0.11 pin is in-range
// and no longer surfaces as an `invalid` marker to review (see the module's own
// header). Keeping the sample local keeps this coverage stable across future
// edits to the production list.
const SAMPLE_REVIEWED = [
  {
    name: "@hono/node-server",
    version: "2.0.11",
    range: "^1.19.9",
    requiredBy: "@modelcontextprotocol/sdk",
    reason: "GHSA-frvp-7c67-39w9 security pin; see package.json#overrides",
  },
];

/** Build a consumer tree shaped like real `npm ls --all --json` output. */
function treeOf({ honoServer, extraDeps = {}, problems = [] } = {}) {
  return {
    name: "consumer",
    version: "1.0.0",
    problems,
    dependencies: {
      "llm-cli-gateway": {
        version: "3.0.0",
        dependencies: {
          "@modelcontextprotocol/sdk": {
            version: "1.29.0",
            dependencies: honoServer ? { "@hono/node-server": honoServer } : {},
          },
          ...extraDeps,
        },
      },
    },
  };
}

const pinnedTree = () => treeOf({ honoServer: { version: "2.0.11", invalid: HONO_INVALID } });

describe("collectInvalidNodes", () => {
  it("finds an out-of-range node nested under a dependency", () => {
    const found = collectInvalidNodes(pinnedTree());
    expect(found).toEqual([
      { name: "@hono/node-server", version: "2.0.11", invalid: HONO_INVALID },
    ]);
  });

  it("returns nothing for a tree with no invalid nodes", () => {
    expect(collectInvalidNodes(treeOf({ honoServer: { version: "1.19.15" } }))).toEqual([]);
  });

  it("deduplicates a node npm reports at several tree positions", () => {
    // npm renders a deduped package under every requiring parent, so the same
    // invalid instance can appear more than once in one --all tree.
    const tree = treeOf({ honoServer: { version: "2.0.11", invalid: HONO_INVALID } });
    tree.dependencies["llm-cli-gateway"].dependencies["some-other-dep"] = {
      version: "1.0.0",
      dependencies: { "@hono/node-server": { version: "2.0.11", invalid: HONO_INVALID } },
    };
    expect(collectInvalidNodes(tree)).toHaveLength(1);
  });

  it("tolerates a tree with no dependencies at all", () => {
    expect(collectInvalidNodes({ name: "empty" })).toEqual([]);
  });
});

describe("classifyConsumerTree", () => {
  it("accepts the tree that carries exactly the reviewed security pin", () => {
    const result = classifyConsumerTree(pinnedTree(), SAMPLE_REVIEWED);
    expect(result.ok).toBe(true);
    expect(result.unexpected).toEqual([]);
    expect(result.missing).toEqual([]);
    expect(result.otherProblems).toEqual([]);
  });

  it("fails when the security pin stopped reaching consumers", () => {
    // The override was dropped, so npm resolved the SDK's own ^1.19.9 range.
    // The tree is now internally consistent, which a plain `npm ls` exit-0
    // check would happily pass while the advisory pin silently stopped shipping.
    const result = classifyConsumerTree(
      treeOf({ honoServer: { version: "1.19.15" } }),
      SAMPLE_REVIEWED
    );
    expect(result.ok).toBe(false);
    expect(result.missing).toHaveLength(1);
    expect(result.missing[0].name).toBe("@hono/node-server");
    expect(result.unexpected).toEqual([]);

    const { errors } = formatConsumerTreeReport(result);
    expect(errors.join("\n")).toContain("NO LONGER reaching consumers");
  });

  it("fails when the pinned version drifts to an unreviewed one", () => {
    const result = classifyConsumerTree(
      treeOf({ honoServer: { version: "2.0.12", invalid: HONO_INVALID } }),
      SAMPLE_REVIEWED
    );
    expect(result.ok).toBe(false);
    expect(result.unexpected.map(e => e.version)).toEqual(["2.0.12"]);
    expect(result.missing.map(e => e.version)).toEqual(["2.0.11"]);
  });

  it("fails when an unrelated package is out of range", () => {
    const result = classifyConsumerTree(
      treeOf({
        honoServer: { version: "2.0.11", invalid: HONO_INVALID },
        extraDeps: {
          "some-pkg": { version: "9.9.9", invalid: '"^1.0.0" from node_modules/llm-cli-gateway' },
        },
      }),
      SAMPLE_REVIEWED
    );
    expect(result.ok).toBe(false);
    expect(result.unexpected.map(e => e.name)).toEqual(["some-pkg"]);
    expect(result.missing).toEqual([]);
  });

  it("fails on a genuinely missing dependency", () => {
    const result = classifyConsumerTree(
      treeOf({
        honoServer: { version: "2.0.11", invalid: HONO_INVALID },
        problems: ["missing: smol-toml@1.7.0, required by llm-cli-gateway@3.0.0"],
      }),
      SAMPLE_REVIEWED
    );
    expect(result.ok).toBe(false);
    expect(result.otherProblems).toHaveLength(1);
  });

  it("ignores the root-level duplicate of an invalid it already accounts for", () => {
    // npm lists each invalid in the root `problems` array too; that duplicate
    // must not be double-counted as a separate non-invalid defect.
    const result = classifyConsumerTree(
      treeOf({
        honoServer: { version: "2.0.11", invalid: HONO_INVALID },
        problems: [
          "invalid: @hono/node-server@2.0.11 /tmp/consumer/node_modules/@hono/node-server",
        ],
      }),
      SAMPLE_REVIEWED
    );
    expect(result.ok).toBe(true);
    expect(result.otherProblems).toEqual([]);
  });
});

describe("isDirectInvocation", () => {
  // Two fail-OPEN bugs have lived in this guard, both from comparing two
  // spellings of the same file. It now canonicalizes through realpathSync, so
  // these use REAL files on disk: a string-only fixture cannot exercise it and
  // would assert nothing meaningful.
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cct-guard-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Create a real file at `name` under the temp dir and return its path. */
  function realFile(name) {
    const p = join(dir, name);
    writeFileSync(p, "// fixture\n");
    return p;
  }

  it("recognises a direct run from a plain path", () => {
    const p = realFile("entry.mjs");
    expect(isDirectInvocation(pathToFileURL(p).href, p)).toBe(true);
  });

  it("recognises a direct run from a path containing spaces", () => {
    // Bug 1: `file://${argv1}` left the space unencoded while import.meta.url
    // percent-encoded it, so the guard skipped the body entirely.
    const p = realFile("entry with space.mjs");
    expect(isDirectInvocation(pathToFileURL(p).href, p)).toBe(true);
    expect(pathToFileURL(p).href).not.toBe(`file://${p}`);
  });

  it("recognises a direct run from other URL-escaped characters", () => {
    for (const name of ["re#po.mjs", "re?po.mjs", "ünïcode.mjs", "a%20b.mjs"]) {
      const p = realFile(name);
      expect(isDirectInvocation(pathToFileURL(p).href, p)).toBe(true);
    }
  });

  it("recognises a direct run reached through a SYMLINK", () => {
    // Bug 2: node canonicalizes import.meta.url but pathToFileURL(argv1) does
    // not, so a symlinked path (or /proc/self/cwd, or a repo under a symlinked
    // checkout) skipped the body and exited 0 having verified nothing.
    const realDir = join(dir, "real");
    mkdirSync(realDir);
    const target = join(realDir, "entry.mjs");
    writeFileSync(target, "// fixture\n");
    const linkDir = join(dir, "link");
    symlinkSync(realDir, linkDir);
    const viaLink = join(linkDir, "entry.mjs");

    // node would report the canonical URL for import.meta.url.
    expect(isDirectInvocation(pathToFileURL(target).href, viaLink)).toBe(true);
  });

  it("reports false when the module is merely imported", () => {
    const a = realFile("module.mjs");
    const b = realFile("other-entry.mjs");
    expect(isDirectInvocation(pathToFileURL(a).href, b)).toBe(false);
  });

  it("reports false when there is no argv[1] at all", () => {
    const p = realFile("entry.mjs");
    expect(isDirectInvocation(pathToFileURL(p).href, undefined)).toBe(false);
    expect(isDirectInvocation(pathToFileURL(p).href, "")).toBe(false);
  });
});

// End-to-end guard on the actual CLI process. These spawn node so they cover
// the real entry-point detection, which unit-level assertions on
// isDirectInvocation cannot: both fail-open bugs were about how the RUNNING
// process spells its own path.
describe("CLI process (fail-closed under path aliasing)", () => {
  let dir;
  const BAD_TREE = {
    name: "consumer",
    problems: [],
    dependencies: {
      "llm-cli-gateway": {
        version: "3.0.0",
        // An UNREVIEWED out-of-range package: nothing in EXPECTED_TREE_PROBLEMS
        // (now empty) accounts for it, so the gate MUST reject this regardless of
        // the path the CLI was invoked through.
        dependencies: {
          "@modelcontextprotocol/sdk": {
            version: "1.29.0",
            dependencies: { "@hono/node-server": { version: "2.0.11", invalid: HONO_INVALID } },
          },
        },
      },
    },
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cct-cli-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Run the checker at `scriptPath`; return {status, out}. */
  function runChecker(scriptPath, treeFile) {
    try {
      const out = execFileSync(process.execPath, [scriptPath, treeFile], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { status: 0, out };
    } catch (err) {
      return { status: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
    }
  }

  it("rejects a tree with an unreviewed out-of-range package when run through a SYMLINKED path", () => {
    // Regression: pathToFileURL(argv[1]) preserves symlinks while node
    // canonicalizes import.meta.url, so the guard skipped the whole body and
    // exited 0 having verified nothing. bash's logical `pwd` in ROOT_DIR
    // produces exactly this whenever the repo sits under a symlinked path.
    const real = join(dir, "real");
    mkdirSync(real);
    const script = join(real, "check-consumer-tree.mjs");
    copyFileSync(MODULE_PATH, script);
    const link = join(dir, "link");
    symlinkSync(real, link);

    const treeFile = join(dir, "tree.json");
    writeFileSync(treeFile, JSON.stringify(BAD_TREE));

    const viaLink = runChecker(join(link, "check-consumer-tree.mjs"), treeFile);
    expect(viaLink.status).not.toBe(0);
    expect(viaLink.out).toContain("UNREVIEWED out-of-range");
    expect(viaLink.out).not.toContain(OK_MARKER);
  });

  it("rejects a tree with an unreviewed out-of-range package when run through a path with spaces", () => {
    const spaced = join(dir, "dir with space");
    mkdirSync(spaced);
    const script = join(spaced, "check-consumer-tree.mjs");
    copyFileSync(MODULE_PATH, script);

    const treeFile = join(dir, "tree.json");
    writeFileSync(treeFile, JSON.stringify(BAD_TREE));

    const res = runChecker(script, treeFile);
    expect(res.status).not.toBe(0);
    expect(res.out).not.toContain(OK_MARKER);
  });

  it("prints the OK marker only when a tree really was classified and passed", () => {
    const treeFile = join(dir, "good.json");
    writeFileSync(
      treeFile,
      JSON.stringify({
        name: "consumer",
        problems: [],
        dependencies: {
          "llm-cli-gateway": {
            version: "3.0.0",
            dependencies: {
              "@modelcontextprotocol/sdk": {
                version: "1.29.0",
                dependencies: {
                  // In-range (valid) now that the SDK accepts ^2.0.5: a clean
                  // tree with no reviewed problems is the only thing that passes.
                  "@hono/node-server": { version: "2.0.11" },
                },
              },
            },
          },
        },
      })
    );
    const res = runChecker(MODULE_PATH, treeFile);
    expect(res.status).toBe(0);
    expect(res.out).toContain(OK_MARKER);
  });

  it("never prints the OK marker on a degenerate tree", () => {
    for (const body of ["{}", "null", "[]", "", "not json"]) {
      const treeFile = join(dir, "degenerate.json");
      writeFileSync(treeFile, body);
      const res = runChecker(MODULE_PATH, treeFile);
      expect(res.status).not.toBe(0);
      expect(res.out).not.toContain(OK_MARKER);
    }
  });

  it("rejects a vulnerable in-range @hono/node-server that carries no invalid marker", () => {
    // End-to-end proof of the positive pin assertion: 1.19.14 satisfies the
    // SDK's ^1.19.9, so npm reports no `invalid` and the empty
    // EXPECTED_TREE_PROBLEMS would let it through, but it is affected by
    // GHSA-frvp (< 1.19.15). The CLI must fail and NOT print the OK marker.
    const treeFile = join(dir, "vulnerable.json");
    writeFileSync(
      treeFile,
      JSON.stringify({
        name: "consumer",
        problems: [],
        dependencies: {
          "llm-cli-gateway": {
            version: "3.2.1",
            dependencies: {
              "@modelcontextprotocol/sdk": {
                version: "1.30.0",
                dependencies: { "@hono/node-server": { version: "1.19.14" } },
              },
            },
          },
        },
      })
    );
    const res = runChecker(MODULE_PATH, treeFile);
    expect(res.status).not.toBe(0);
    expect(res.out).toContain("is not the reviewed pin");
    expect(res.out).not.toContain(OK_MARKER);
  });
});

describe("EXPECTED_TREE_PROBLEMS", () => {
  it("documents a justification for every tolerated entry", () => {
    // The list is currently empty (see the module header: the SDK broadened its
    // @hono/node-server range to `^1.19.9 || ^2.0.5`, so the 2.0.11 pin is in
    // range and no longer surfaces as an `invalid` marker to review). That is a
    // valid state: the tripwire still rejects any UNEXPECTED marker. If an entry
    // is ever added back, it must carry its advisory rationale, because an entry
    // without a reason is an undocumented exception.
    for (const entry of EXPECTED_TREE_PROBLEMS) {
      expect(entry.name).toBeTruthy();
      expect(entry.version).toMatch(/^\d+\.\d+\.\d+/);
      // Keyed on the range and the requiring package, never on npm's raw
      // path string, which varies with how a consumer nests the package.
      expect(entry.range).toBeTruthy();
      expect(entry.requiredBy).toBeTruthy();
      expect(entry.invalid).toBeUndefined();
      expect(entry.reason && entry.reason.length).toBeGreaterThan(10);
    }
  });

  it("keeps the @hono/node-server override at or above the GHSA-frvp-7c67-39w9 patched floor", () => {
    // Ratchet moved to the override itself. The advisory range is `< 2.0.5`;
    // package.json#overrides pins @hono/node-server, and lowering that pin below
    // 2.0.5 would ship a flagged version, so assert the floor here rather than on
    // the (now empty) reviewed list.
    const pkgPath = fileURLToPath(new URL("../package.json", import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    const pinned = pkg.overrides?.["@hono/node-server"];
    expect(pinned).toBeTruthy();
    const [major, minor, patch] = String(pinned)
      .replace(/^[^\d]*/, "")
      .split(".")
      .map(Number);
    expect(major).toBeGreaterThanOrEqual(2);
    expect(major > 2 || minor > 0 || patch >= 5).toBe(true);
  });
});

describe("reviewedVersionProblems (positive pin assertion)", () => {
  const pinned = REVIEWED_CONSUMER_VERSIONS["@hono/node-server"];

  it("accepts the reviewed pin at its exact version", () => {
    const tree = treeOf({ honoServer: { version: pinned } });
    expect(reviewedVersionProblems(tree)).toEqual([]);
    expect(collectPackageVersions(tree, "@hono/node-server")).toEqual([pinned]);
  });

  it("rejects a vulnerable in-range resolution the SDK's ^1.19.9 still admits", () => {
    // The differential that the invalid-marker check used to catch and the
    // empty EXPECTED_TREE_PROBLEMS would otherwise miss: 1.19.14 satisfies
    // ^1.19.9, carries no `invalid` marker, but is affected by GHSA-frvp
    // (< 1.19.15).
    const tree = treeOf({ honoServer: { version: "1.19.14" } });
    const problems = reviewedVersionProblems(tree);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("1.19.14");
    expect(problems[0]).toContain(pinned);
  });

  it("rejects a patched-but-unreviewed drift (e.g. 2.1.1)", () => {
    const problems = reviewedVersionProblems(treeOf({ honoServer: { version: "2.1.1" } }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("2.1.1");
  });

  it("rejects the pin being absent entirely", () => {
    const tree = treeOf({});
    expect(collectPackageVersions(tree, "@hono/node-server")).toEqual([]);
    const problems = reviewedVersionProblems(tree);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("absent");
  });
});

describe("parseInvalid / nesting independence", () => {
  it("extracts the range and requiring package regardless of nesting depth", () => {
    expect(parseInvalid(HONO_INVALID)).toEqual({
      range: "^1.19.9",
      requiredBy: "@modelcontextprotocol/sdk",
    });
    expect(parseInvalid(HONO_INVALID_NESTED)).toEqual({
      range: "^1.19.9",
      requiredBy: "@modelcontextprotocol/sdk",
    });
  });

  it("accepts the reviewed pin in a REAL consumer tree, where our package is nested", () => {
    // Regression: the live verdaccio gate failed here. npm reports the
    // requiring path as node_modules/llm-cli-gateway/node_modules/... in a
    // consumer, and an exact-string match against the repo-local spelling
    // reported the pin as BOTH unreviewed and missing.
    const result = classifyConsumerTree(
      treeOf({ honoServer: { version: "2.0.11", invalid: HONO_INVALID_NESTED } }),
      SAMPLE_REVIEWED
    );
    expect(result.ok).toBe(true);
    expect(result.unexpected).toEqual([]);
    expect(result.missing).toEqual([]);
  });

  it("still rejects the same package demanded by a DIFFERENT parent", () => {
    // Nesting depth may vary; which package demanded the range may not.
    const result = classifyConsumerTree(
      treeOf({
        honoServer: {
          version: "2.0.11",
          invalid: '"^1.19.9" from node_modules/some-other-pkg',
        },
      }),
      SAMPLE_REVIEWED
    );
    expect(result.ok).toBe(false);
    expect(result.unexpected).toHaveLength(1);
    expect(result.missing).toHaveLength(1);
  });

  it("still rejects a different range from the same parent", () => {
    const result = classifyConsumerTree(
      treeOf({
        honoServer: {
          version: "2.0.11",
          invalid:
            '"^3.0.0" from node_modules/llm-cli-gateway/node_modules/@modelcontextprotocol/sdk',
        },
      }),
      SAMPLE_REVIEWED
    );
    expect(result.ok).toBe(false);
  });

  it("degrades safely on an unparseable invalid string", () => {
    expect(parseInvalid("garbage")).toEqual({ range: "garbage", requiredBy: "" });
    expect(parseInvalid(undefined)).toEqual({ range: "", requiredBy: "" });
  });
});
