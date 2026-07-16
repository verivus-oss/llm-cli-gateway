// Offline unit tests for the supply-chain guard scanner. Pure classification
// over injected fixtures; no network, no npm install, no filesystem baseline.
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  deriveName,
  toInstances,
  isExactVersion,
  validateLedger,
  computeDropped,
  reusedInvariantFindings,
  fetchInDistFindings,
  licenseFindings,
  socketPolicyFindings,
  parseSocketIssueRules,
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
const trusted = acceptedVersions => ({
  acceptedVersions,
  source: "registry.npmjs.org",
  state: "trusted",
});

describe("deriveName", () => {
  it("derives from path when meta.name is absent", () => {
    expect(deriveName("node_modules/tar-stream", {})).toBe("tar-stream");
  });
  it("derives scoped names correctly", () => {
    expect(deriveName("node_modules/@modelcontextprotocol/sdk", {})).toBe(
      "@modelcontextprotocol/sdk"
    );
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
      "node_modules/zod": {
        version: "4.4.3",
        resolved: `${REG}/zod/-/zod-4.4.3.tgz`,
        integrity: "sha512-AAA",
      },
    };
    const out = toInstances(map);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("zod");
    expect(out.some(i => i.path === "")).toBe(false);
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
    const r = classifyClosure(
      [inst()],
      ledgerOf({ zod: trusted(["4.4.3"]) }),
      baselineOf([inst()])
    );
    expect(r.exit).toBe(0);
    expect(r.rows[0].class).toBe("clean");
  });

  it("row 7: accepted new version of a baselined name -> roll-forward (2)", () => {
    // baseline has zod@4.4.3; ledger accepts 4.4.3 AND 4.4.4; fresh is 4.4.4.
    const fresh = inst({
      version: "4.4.4",
      resolved: `${REG}/zod/-/zod-4.4.4.tgz`,
      integrity: "sha512-BBB",
    });
    const r = classifyClosure(
      [fresh],
      ledgerOf({ zod: trusted(["4.4.3", "4.4.4"]) }),
      baselineOf([inst()])
    );
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
    const r = classifyClosure([p1], ledgerOf({ dep: trusted(["4.4.3"]) }), baselineOf([p1, p2]));
    expect(r.exit).toBe(2);
    expect(r.rows[0].class).toBe("clean"); // surviving path is clean
    expect(r.dropped.map(d => d.path)).toEqual(["node_modules/a/node_modules/dep"]);
  });

  it("a same-path change is NOT double-counted as drop + mismatch", () => {
    const changed = inst({ integrity: "sha512-CHANGED" });
    const r = classifyClosure(
      [changed],
      ledgerOf({ zod: trusted(["4.4.3"]) }),
      baselineOf([inst()])
    );
    expect(r.dropped).toHaveLength(0); // same path present -> not dropped
    expect(r.rows[0].class).toBe("integrity-mismatch");
    expect(r.exit).toBe(3);
  });
});

describe("reused invariants", () => {
  it("forbidden native/tar chain -> 3", () => {
    const f = reusedInvariantFindings([
      inst({ path: "node_modules/tar-stream", name: "tar-stream", version: "3.1.7" }),
    ]);
    expect(f.some(x => x.class === "forbidden-chain")).toBe(true);
  });
  it("blocklisted version -> 3", () => {
    const f = reusedInvariantFindings([
      inst({ path: "node_modules/type-is", name: "type-is", version: "2.1.0" }),
    ]);
    expect(f.some(x => x.class === "blocked-version")).toBe(true);
  });
});

describe("fetch-in-dist detector (mirrors release-security-audit.sh scope)", () => {
  it("is case-insensitive (Fetch/FETCH), includes declarations, and excludes __tests__", () => {
    const root = mkdtempSync(join(tmpdir(), "sc-dist-"));
    try {
      mkdirSync(join(root, "dist", "__tests__"), { recursive: true });
      writeFileSync(join(root, "dist", "shipped.js"), "const x = Fetch(url);\n");
      writeFileSync(join(root, "dist", "shipped.d.ts"), "declare const fetch: unknown;\n");
      writeFileSync(join(root, "dist", "__tests__", "t.js"), "await fetch(url);\n");
      writeFileSync(join(root, "dist", "__tests__", "t.d.ts"), "declare const fetch: unknown;\n");
      const findings = fetchInDistFindings(root);
      // Case-insensitive: "Fetch" in the shipped file is caught.
      expect(findings.some(f => f.path.endsWith("dist/shipped.js"))).toBe(true);
      expect(findings.some(f => f.path.endsWith("dist/shipped.d.ts"))).toBe(true);
      // __tests__ (not shipped) is excluded, matching the audit.
      expect(findings.some(f => f.path.includes("__tests__"))).toBe(false);
      expect(findings.every(f => f.exit === 3)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("allows only the reviewed Kit Git operation lines", () => {
    const root = mkdtempSync(join(tmpdir(), "sc-dist-approved-git-"));
    try {
      mkdirSync(join(root, "dist"), { recursive: true });
      writeFileSync(
        join(root, "dist", "personal-config.js"),
        [
          'case "fetch":',
          'git(layout.baselineDir, ["fetch", "origin"], false, options);',
          'const upstreamSynchronization = git(layout.baselineDir, ["fetch", "origin"], true, options);',
        ].join("\n") + "\n"
      );
      expect(fetchInDistFindings(root)).toEqual([]);

      writeFileSync(
        join(root, "dist", "personal-config.js"),
        'const unexpected = fetch("https://example.invalid");\n'
      );
      expect(fetchInDistFindings(root)).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("fails closed when dist/ is absent", () => {
    const root = mkdtempSync(join(tmpdir(), "sc-nodist-"));
    try {
      expect(fetchInDistFindings(root)).toEqual([
        {
          path: "dist",
          name: "dist",
          version: "-",
          class: "missing-dist",
          exit: 3,
        },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("P2 license allowlist", () => {
  const allowed = new Set(["MIT", "ISC", "BSD-2-Clause", "BSD-3-Clause"]);
  it("an allowlisted license passes", () => {
    expect(licenseFindings([inst({ license: "MIT" })], allowed)).toEqual([]);
  });
  it("a copyleft / non-allowlisted license is flagged (exit 3)", () => {
    const f = licenseFindings([inst({ license: "GPL-3.0" })], allowed);
    expect(f).toHaveLength(1);
    expect(f[0].class).toBe("license-violation");
    expect(f[0].exit).toBe(3);
  });
  it("a missing license is flagged", () => {
    expect(licenseFindings([inst({ license: null })], allowed)).toHaveLength(1);
  });
  it("an SPDX expression not verbatim in the allowlist is flagged (conservative)", () => {
    expect(licenseFindings([inst({ license: "(MIT OR GPL-3.0)" })], allowed)).toHaveLength(1);
  });
  it("classifyClosure folds a license violation into exit 3", () => {
    const r = classifyClosure(
      [inst({ license: "GPL-3.0" })],
      ledgerOf({ zod: trusted(["4.4.3"]) }),
      baselineOf([inst()]),
      { licenseAllowlist: allowed }
    );
    expect(r.exit).toBe(3);
    expect(r.invariants.some(i => i.class === "license-violation")).toBe(true);
  });
  it("without licenseAllowlist opt, no license check runs (backward compatible)", () => {
    const r = classifyClosure(
      [inst({ license: "GPL-3.0" })],
      ledgerOf({ zod: trusted(["4.4.3"]) }),
      baselineOf([inst()])
    );
    expect(r.exit).toBe(0);
  });
});

describe("P2 socket.yml policy-drift", () => {
  const expected = { malware: true, shrinkwrap: false, shellAccess: false };
  it("matching posture -> no findings", () => {
    expect(
      socketPolicyFindings({ malware: true, shrinkwrap: false, shellAccess: false }, expected)
    ).toEqual([]);
  });
  it("a flipped critical rule -> finding (exit 3)", () => {
    const f = socketPolicyFindings(
      { malware: false, shrinkwrap: false, shellAccess: false },
      expected
    );
    expect(f).toHaveLength(1);
    expect(f[0].class).toBe("socket-policy-drift");
    expect(f[0].name).toBe("issueRules.malware");
    expect(f[0].exit).toBe(3);
  });
  it("a missing required rule -> finding", () => {
    expect(socketPolicyFindings({ shrinkwrap: false, shellAccess: false }, expected)).toHaveLength(
      1
    );
  });
  it("weakening shellAccess false -> true is drift", () => {
    const f = socketPolicyFindings(
      { malware: true, shrinkwrap: false, shellAccess: true },
      expected
    );
    expect(f.some(x => x.name === "issueRules.shellAccess")).toBe(true);
  });
  it("an ADDED rule not in the reviewed posture is drift (bidirectional)", () => {
    const f = socketPolicyFindings(
      { malware: true, shrinkwrap: false, shellAccess: false, newRisk: false },
      expected
    );
    expect(f).toHaveLength(1);
    expect(f[0].name).toBe("issueRules.newRisk");
    expect(f[0].exit).toBe(3);
  });
});

describe("parseSocketIssueRules", () => {
  it("parses the flat issueRules block, strips comments, stops at dedent", () => {
    const text = [
      "version: 2",
      "issueRules:",
      "  malware: true # required",
      "  shrinkwrap: false",
      "  shellAccess: false",
      "githubApp:",
      "  enabled: true",
    ].join("\n");
    expect(parseSocketIssueRules(text)).toEqual({
      malware: true,
      shrinkwrap: false,
      shellAccess: false,
    });
  });
  it("returns {} when there is no issueRules block", () => {
    expect(parseSocketIssueRules("version: 2\ngithubApp:\n  enabled: true")).toEqual({});
  });
});

describe("classifyClosure whole-closure behaviour", () => {
  it("malformed ledger (caret) -> exit 1", () => {
    const r = classifyClosure(
      [inst()],
      ledgerOf({ zod: trusted(["^4.4.3"]) }),
      baselineOf([inst()])
    );
    expect(r.exit).toBe(1);
    expect(r.ledgerErrors.length).toBeGreaterThan(0);
  });

  it("clean whole closure -> exit 0, valid JSON report shape", () => {
    const r = classifyClosure(
      [inst()],
      ledgerOf({ zod: trusted(["4.4.3"]) }),
      baselineOf([inst()])
    );
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
    const bad = inst({
      path: "node_modules/evil",
      name: "evil",
      version: "1.0.0",
      resolved: `${REG}/evil/-/evil-1.0.0.tgz`,
    });
    const r = classifyClosure(
      [clean, bad],
      ledgerOf({ zod: trusted(["4.4.3"]) }), // evil not ledgered
      baselineOf([clean])
    );
    expect(r.exit).toBe(3); // tag-along dominates the clean instance
  });
});
