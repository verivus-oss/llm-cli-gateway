// Offline unit tests for the consumer dependency-tree tripwire. Pure
// classification over injected `npm ls --all --json` fixtures; no network, no
// npm install, no verdaccio.
import { describe, it, expect } from "vitest";
import { pathToFileURL } from "node:url";
import {
  EXPECTED_TREE_PROBLEMS,
  classifyConsumerTree,
  collectInvalidNodes,
  formatConsumerTreeReport,
  isDirectInvocation,
} from "./check-consumer-tree.mjs";

const HONO_INVALID = '"^1.19.9" from node_modules/@modelcontextprotocol/sdk';

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
    const result = classifyConsumerTree(pinnedTree());
    expect(result.ok).toBe(true);
    expect(result.unexpected).toEqual([]);
    expect(result.missing).toEqual([]);
    expect(result.otherProblems).toEqual([]);
  });

  it("fails when the security pin stopped reaching consumers", () => {
    // The override was dropped, so npm resolved the SDK's own ^1.19.9 range.
    // The tree is now internally consistent, which a plain `npm ls` exit-0
    // check would happily pass while the advisory pin silently stopped shipping.
    const result = classifyConsumerTree(treeOf({ honoServer: { version: "1.19.15" } }));
    expect(result.ok).toBe(false);
    expect(result.missing).toHaveLength(1);
    expect(result.missing[0].name).toBe("@hono/node-server");
    expect(result.unexpected).toEqual([]);

    const { errors } = formatConsumerTreeReport(result);
    expect(errors.join("\n")).toContain("NO LONGER reaching consumers");
  });

  it("fails when the pinned version drifts to an unreviewed one", () => {
    const result = classifyConsumerTree(
      treeOf({ honoServer: { version: "2.0.12", invalid: HONO_INVALID } })
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
      })
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
      })
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
      })
    );
    expect(result.ok).toBe(true);
    expect(result.otherProblems).toEqual([]);
  });
});

describe("isDirectInvocation", () => {
  // Regression: the CLI guard used `import.meta.url === \`file://${argv[1]}\``,
  // which silently reported "imported" whenever the script path contained a
  // character a URL escapes. The gate then exited 0 having checked nothing,
  // i.e. it failed OPEN, which is the exact failure this module exists to stop.
  it("recognises a direct run from a plain path", () => {
    const p = "/srv/repos/gw/scripts/check-consumer-tree.mjs";
    expect(isDirectInvocation(pathToFileURL(p).href, p)).toBe(true);
  });

  it("recognises a direct run from a path containing spaces", () => {
    const p = "/srv/dir with space/check-consumer-tree.mjs";
    expect(isDirectInvocation(pathToFileURL(p).href, p)).toBe(true);
    // The naive form this replaced would compare against an unencoded string
    // and miss, so assert the encoding really is the thing that differs.
    expect(pathToFileURL(p).href).not.toBe(`file://${p}`);
  });

  it("recognises a direct run from other URL-escaped characters", () => {
    for (const p of [
      "/srv/re#po/check-consumer-tree.mjs",
      "/srv/re?po/check-consumer-tree.mjs",
      "/srv/ünïcode/check-consumer-tree.mjs",
    ]) {
      expect(isDirectInvocation(pathToFileURL(p).href, p)).toBe(true);
    }
  });

  it("reports false when the module is merely imported", () => {
    expect(
      isDirectInvocation(
        pathToFileURL("/srv/gw/scripts/check-consumer-tree.mjs").href,
        "/srv/gw/scripts/some-other-entry.mjs"
      )
    ).toBe(false);
  });

  it("reports false when there is no argv[1] at all", () => {
    expect(isDirectInvocation("file:///srv/gw/x.mjs", undefined)).toBe(false);
    expect(isDirectInvocation("file:///srv/gw/x.mjs", "")).toBe(false);
  });
});

describe("EXPECTED_TREE_PROBLEMS", () => {
  it("documents a justification for every tolerated entry", () => {
    // An entry without a reason is an undocumented exception; the whole point
    // of the list is that each one carries its advisory rationale.
    expect(EXPECTED_TREE_PROBLEMS.length).toBeGreaterThan(0);
    for (const entry of EXPECTED_TREE_PROBLEMS) {
      expect(entry.name).toBeTruthy();
      expect(entry.version).toMatch(/^\d+\.\d+\.\d+/);
      expect(entry.invalid).toBeTruthy();
      expect(entry.reason && entry.reason.length).toBeGreaterThan(10);
    }
  });

  it("pins @hono/node-server at or above the GHSA-frvp-7c67-39w9 patched floor", () => {
    // Ratchet: the advisory's GitHub-mirror range is `< 2.0.5`. If someone
    // lowers this entry to satisfy the SDK's declared range, the pin would stop
    // clearing `npm audit` and this fails rather than shipping a flagged version.
    const hono = EXPECTED_TREE_PROBLEMS.find(e => e.name === "@hono/node-server");
    expect(hono).toBeDefined();
    const [major, minor, patch] = hono.version.split(".").map(Number);
    expect(major).toBeGreaterThanOrEqual(2);
    expect(major > 2 || minor > 0 || patch >= 5).toBe(true);
  });
});
