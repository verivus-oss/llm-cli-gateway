// Offline unit tests for the supply-chain guard scanner. Pure classification
// over injected fixtures; no network, no npm install, no filesystem baseline.
import { describe, it, expect } from "vitest";
import {
  deriveName,
  toInstances,
  isExactVersion,
  validateLedger,
  classifyInstance,
  computeDropped,
  reusedInvariantFindings,
  classifyClosure,
} from "./dep-drift-scan.mjs";

const REG = "https://registry.npmjs.org";

/** Build an instance with registry defaults; override any field. */
function inst(over = {}) {
  return {
    path: "node_modules/zod",
    name: "zod",
    version: "4.4.3",
    resolved: `${REG}/zod/-/zod-4.4.3.tgz`,
    integrity: "sha512-AAA",
    ...over,
  };
}

function ledgerOf(entries) {
  return { schemaVersion: "prod-closure-ledger.v1", packages: entries };
}
function baselineOf(instances) {
  return { schemaVersion: "prod-closure-baseline.v1", instances };
}
const trusted = (acceptedVersions) => ({ acceptedVersions, source: "registry.npmjs.org", state: "trusted" });

describe("deriveName", () => {
  it("derives from path when meta.name is absent", () => {
    expect(deriveName("node_modules/tar-stream", {})).toBe("tar-stream");
  });
  it("derives scoped names correctly", () => {
    expect(deriveName("node_modules/@modelcontextprotocol/sdk", {})).toBe("@modelcontextprotocol/sdk");
    expect(deriveName("node_modules/@hono/node-server", {})).toBe("@hono/node-server");
  });
  it("handles nested (top-of-tree) node_modules paths, last segment wins", () => {
    expect(deriveName("node_modules/a/node_modules/tar-stream", {})).toBe("tar-stream");
  });
  it("the forbidden string split would leave the prefix (regression guard)", () => {
    // Demonstrates why split(/node_modules\//) is mandated: the plain string
    // split leaves "node_modules/" on the top-level entry, so a blocklist misses.
    expect("node_modules/tar-stream".split("/node_modules/").pop()).toBe("node_modules/tar-stream");
    expect(deriveName("node_modules/tar-stream", {})).toBe("tar-stream");
  });
  it("prefers explicit meta.name when present", () => {
    expect(deriveName("node_modules/x", { name: "real-name" })).toBe("real-name");
  });
});

describe("toInstances", () => {
  it("excludes the root '' entry and derives names", () => {
    const map = {
      "": { name: "llm-cli-gateway", version: "2.16.0" },
      "node_modules/zod": { version: "4.4.3", resolved: `${REG}/zod/-/zod-4.4.3.tgz`, integrity: "sha512-AAA" },
    };
    const out = toInstances(map);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("zod");
    expect(out.some((i) => i.path === "")).toBe(false);
  });
});

describe("isExactVersion / validateLedger", () => {
  it("accepts exact semver incl prerelease, build, and combined", () => {
    expect(isExactVersion("1.2.3")).toBe(true);
    expect(isExactVersion("1.2.3-rc.1")).toBe(true);
    expect(isExactVersion("1.2.3+build.5")).toBe(true);
    expect(isExactVersion("1.2.3-rc.1+build.5")).toBe(true);
  });
  it("rejects ranges", () => {
    for (const v of ["^1.2.3", "~1.2.3", "1.x", "*", "1.2.3 || 1.2.4", ">=1.0.0"]) {
      expect(isExactVersion(v)).toBe(false);
    }
  });
  it("flags a non-exact acceptedVersions entry", () => {
    const errs = validateLedger(ledgerOf({ zod: trusted(["^4.4.3"]) }));
    expect(errs.length).toBeGreaterThan(0);
  });
  it("passes a clean exact ledger", () => {
    expect(validateLedger(ledgerOf({ zod: trusted(["4.4.3"]) }))).toEqual([]);
  });
});

describe("classifyInstance decision table (rows 1-7)", () => {
  const baseIdx = () => {
    const b = baselineOf([inst()]);
    // build the index the same way classifyClosure does, via a full classify
    return b;
  };

  it("row 1: non-registry source -> source-anomaly (3)", () => {
    const r = classifyClosure(
      [inst({ resolved: "git+https://github.com/x/y.git#abc" })],
      ledgerOf({ zod: trusted(["4.4.3"]) }),
      baselineOf([inst()])
    );
    expect(r.exit).toBe(3);
    expect(r.rows[0].class).toBe("source-anomaly");
  });

  it("row 2: same name@version, different integrity -> integrity-mismatch (3)", () => {
    const r = classifyClosure(
      [inst({ integrity: "sha512-TAMPERED" })],
      ledgerOf({ zod: trusted(["4.4.3"]) }),
      baselineOf([inst()])
    );
    expect(r.exit).toBe(3);
    expect(r.rows[0].class).toBe("integrity-mismatch");
  });

  it("row 3: name not in ledger -> tag-along (3)", () => {
    const r = classifyClosure([inst()], ledgerOf({}), baselineOf([inst()]));
    expect(r.exit).toBe(3);
    expect(r.rows[0].class).toBe("tag-along");
  });

  it("row 3: revoked ledger state -> tag-along (3)", () => {
    const r = classifyClosure(
      [inst()],
      ledgerOf({ zod: { ...trusted(["4.4.3"]), state: "revoked" } }),
      baselineOf([inst()])
    );
    expect(r.exit).toBe(3);
    expect(r.rows[0].class).toBe("tag-along");
  });

  it("row 4: name absent from baseline -> new_to_tree tag-along (3)", () => {
    const r = classifyClosure([inst()], ledgerOf({ zod: trusted(["4.4.3"]) }), baselineOf([]));
    expect(r.exit).toBe(3);
    expect(r.rows[0].class).toBe("tag-along-new-to-tree");
  });

  it("row 5: unaccepted version of a ledgered, baselined name -> tag-along (3)", () => {
    const fresh = inst({ version: "4.9.9", resolved: `${REG}/zod/-/zod-4.9.9.tgz` });
    const r = classifyClosure([fresh], ledgerOf({ zod: trusted(["4.4.3"]) }), baselineOf([inst()]));
    expect(r.exit).toBe(3);
    expect(r.rows[0].class).toBe("tag-along-unaccepted-version");
  });

  it("row 6: exact baseline match -> clean (0)", () => {
    const r = classifyClosure([inst()], ledgerOf({ zod: trusted(["4.4.3"]) }), baselineOf([inst()]));
    expect(r.exit).toBe(0);
    expect(r.rows[0].class).toBe("clean");
  });

  it("row 7: accepted new version of a baselined name -> roll-forward (2)", () => {
    // baseline has zod@4.4.3; ledger accepts 4.4.3 AND 4.4.4; fresh is 4.4.4.
    const fresh = inst({ version: "4.4.4", resolved: `${REG}/zod/-/zod-4.4.4.tgz`, integrity: "sha512-BBB" });
    const r = classifyClosure([fresh], ledgerOf({ zod: trusted(["4.4.3", "4.4.4"]) }), baselineOf([inst()]));
    expect(r.exit).toBe(2);
    expect(r.rows[0].class).toBe("roll-forward");
  });
});

describe("dropped (instance-level reverse diff)", () => {
  it("a missing baseline path is a dropped instance (2)", () => {
    const dropped = computeDropped([], [inst()]);
    expect(dropped).toHaveLength(1);
    expect(dropped[0].exit).toBe(2);
    expect(dropped[0].class).toBe("dropped");
  });

  it("multi-path name losing ONE path still fires (exit 2, not 0)", () => {
    const p1 = inst({ path: "node_modules/dep", name: "dep" });
    const p2 = inst({ path: "node_modules/a/node_modules/dep", name: "dep" });
    // baseline has dep at two paths; fresh keeps only p1 (exact) and drops p2.
    const r = classifyClosure(
      [p1],
      ledgerOf({ dep: trusted(["4.4.3"]) }),
      baselineOf([p1, p2])
    );
    expect(r.exit).toBe(2);
    expect(r.rows[0].class).toBe("clean"); // surviving path is clean
    expect(r.dropped.map((d) => d.path)).toEqual(["node_modules/a/node_modules/dep"]);
  });

  it("a same-path change is NOT double-counted as drop + mismatch", () => {
    const changed = inst({ integrity: "sha512-CHANGED" });
    const r = classifyClosure([changed], ledgerOf({ zod: trusted(["4.4.3"]) }), baselineOf([inst()]));
    expect(r.dropped).toHaveLength(0); // same path present -> not dropped
    expect(r.rows[0].class).toBe("integrity-mismatch");
    expect(r.exit).toBe(3);
  });
});

describe("reused invariants", () => {
  it("forbidden native/tar chain -> 3", () => {
    const f = reusedInvariantFindings([inst({ path: "node_modules/tar-stream", name: "tar-stream", version: "3.1.7" })]);
    expect(f.some((x) => x.class === "forbidden-chain")).toBe(true);
  });
  it("blocklisted version -> 3", () => {
    const f = reusedInvariantFindings([inst({ path: "node_modules/type-is", name: "type-is", version: "2.1.0" })]);
    expect(f.some((x) => x.class === "blocked-version")).toBe(true);
  });
});

describe("classifyClosure whole-closure behaviour", () => {
  it("malformed ledger (caret) -> exit 1", () => {
    const r = classifyClosure([inst()], ledgerOf({ zod: trusted(["^4.4.3"]) }), baselineOf([inst()]));
    expect(r.exit).toBe(1);
    expect(r.ledgerErrors.length).toBeGreaterThan(0);
  });

  it("clean whole closure -> exit 0, valid JSON report shape", () => {
    const r = classifyClosure([inst()], ledgerOf({ zod: trusted(["4.4.3"]) }), baselineOf([inst()]));
    expect(r.exit).toBe(0);
    expect(() => JSON.stringify(r)).not.toThrow();
    expect(r.counts).toEqual({ clean: 1 });
  });

  it("empty closure -> exit 0, valid JSON", () => {
    const r = classifyClosure([], ledgerOf({}), baselineOf([]));
    expect(r.exit).toBe(0);
    expect(JSON.parse(JSON.stringify(r)).exit).toBe(0);
  });

  it("exit code is the max severity across mixed classes", () => {
    const clean = inst();
    const bad = inst({ path: "node_modules/evil", name: "evil", version: "1.0.0", resolved: `${REG}/evil/-/evil-1.0.0.tgz` });
    const r = classifyClosure(
      [clean, bad],
      ledgerOf({ zod: trusted(["4.4.3"]) }), // evil not ledgered
      baselineOf([clean])
    );
    expect(r.exit).toBe(3); // tag-along dominates the clean instance
  });
});
