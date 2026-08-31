/**
 * The deployment-shape gate for transcript bodies
 * (docs/plans/postgres-security-hardening.md 6.1).
 *
 * A TABLE, because the rule is a conjunction and each half fails differently:
 * the DSN must name a loopback or unix-socket target AND the thing listening on
 * it must run as this OS user. Every cell states which half it exercises.
 *
 * /proc is injected rather than mocked: these are real files in a temp
 * directory, in the exact format the kernel writes, taken from a measured line
 * on this host. A stubbed reader would prove the parser agrees with itself.
 */
import { afterEach, describe, expect, it } from "vitest";
import { lookup } from "node:dns/promises";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  evaluateTranscriptAdmission,
  isLoopbackLiteral,
  loopbackListenerUids,
  parseDsnTarget,
  resetTranscriptAdmission,
  setTranscriptAdmissionForTests,
  transcriptAdmission,
} from "../storage/transcript-admission.js";

const HEADER =
  "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n";

/** One /proc/net/tcp row. `address` is the kernel's per-word little-endian hex. */
function row(address: string, port: number, uid: number, state = "0A"): string {
  const portHex = port.toString(16).toUpperCase().padStart(4, "0");
  return `   0: ${address}:${portHex} ${address.replace(/./g, "0")}:0000 ${state} 00000000:00000000 00:00000000 00000000  ${uid}        0 52242917 1 0000000000000000 100 0 0 10 0\n`;
}

const V4_LOOPBACK = "0100007F";
const V4_WILDCARD = "00000000";
const V6_LOOPBACK = "00000000000000000000000001000000";
const V6_WILDCARD = "00000000000000000000000000000000";

const temporaries: string[] = [];

function procWith(tcp: string, tcp6: string): string {
  const dir = mkdtempSync(join(tmpdir(), "proc-net-"));
  temporaries.push(dir);
  writeFileSync(join(dir, "tcp"), HEADER + tcp);
  writeFileSync(join(dir, "tcp6"), HEADER + tcp6);
  return dir;
}

/** A unix socket directory holding libpq's `.s.PGSQL.<port>` entry. */
function socketDir(port: number): string {
  const dir = mkdtempSync(join(tmpdir(), "pgsock-"));
  temporaries.push(dir);
  writeFileSync(join(dir, `.s.PGSQL.${port}`), "");
  return dir;
}

afterEach(() => {
  resetTranscriptAdmission();
  while (temporaries.length > 0)
    rmSync(temporaries.pop() as string, { recursive: true, force: true });
});

describe("the admission matrix", () => {
  const uid = 4242;

  it("ADMITS loopback IPv4 whose listener runs as this uid", () => {
    const procDir = procWith(row(V4_LOOPBACK, 5432, uid), "");
    const verdict = evaluateTranscriptAdmission("postgresql://u:p@127.0.0.1:5432/gw", {
      procDir,
      uid,
    });
    expect(verdict.admitted).toBe(true);
    expect(verdict.shape).toBe("loopback-tcp");
    expect(verdict.reason).toBeNull();
    expect(verdict.evidence).toContain("5432");
  });

  it("ADMITS IPv6 loopback in bracket form", () => {
    const procDir = procWith("", row(V6_LOOPBACK, 5432, uid));
    const verdict = evaluateTranscriptAdmission("postgresql://u@[::1]:5432/gw", { procDir, uid });
    expect(verdict.admitted).toBe(true);
    expect(verdict.shape).toBe("loopback-tcp");
  });

  it("ADMITS the literal name localhost", () => {
    const procDir = procWith(row(V4_LOOPBACK, 5432, uid), "");
    expect(
      evaluateTranscriptAdmission("postgresql://u@localhost:5432/gw", { procDir, uid }).admitted
    ).toBe(true);
  });

  it("ADMITS a WILDCARD bind, which is the shape rootless podman actually publishes", () => {
    // Measured on this host for the compose file's 5433 publish:
    // `00000000000000000000000000000000:1539 ... 0A ... 1000`. A checker that
    // required a literal 127.0.0.1 bind would refuse the reference deployment.
    const procDir = procWith(row(V4_WILDCARD, 5433, uid), row(V6_WILDCARD, 5433, uid));
    expect(
      evaluateTranscriptAdmission("postgresql://u@127.0.0.1:5433/gw", { procDir, uid }).admitted
    ).toBe(true);
  });

  it("ADMITS a unix socket owned by this uid", () => {
    const dir = socketDir(5432);
    const verdict = evaluateTranscriptAdmission(`postgresql:///gw?host=${dir}`, {
      uid: process.getuid?.() ?? 0,
    });
    expect(verdict.admitted).toBe(true);
    expect(verdict.shape).toBe("unix-socket");
  });

  it("REFUSES the keyword/value DSN form, because node-postgres is not libpq", () => {
    // This test used to assert the opposite, on the premise that the driver
    // accepts what libpq accepts. Measured against the installed pg, it does
    // not:
    //
    //   new Client({ connectionString: "host=/var/run/postgresql dbname=gw" })
    //     -> host "base", port 5432, database "host=/var/run/postgresql dbname=gw"
    //
    // So the gate was proving a unix-socket shape for a connection the driver
    // would open to a bare NAME. `base` is pg-connection-string's own base URL
    // host, and a DNS search domain can make a bare name resolve, which is the
    // one thing this gate exists to refuse. Proving the wrong shape is worse
    // than proving none.
    const dir = socketDir(5432);
    const verdict = evaluateTranscriptAdmission(`host=${dir} dbname=gw user=llmgw`, {
      uid: process.getuid?.() ?? 0,
    });
    expect(verdict.admitted).toBe(false);
    expect(verdict.shape).toBeNull();
  });

  it("resolves the host pg resolves when the query names it twice", () => {
    // THE BYPASS THIS BRANCH EXISTS TO CLOSE, measured.
    //
    // The gate read the host with `URLSearchParams.get("host")`, the FIRST
    // value. `pg-connection-string` iterates the query and assigns each one, so
    // the LAST wins. A DSN naming loopback first and a remote host second was
    // admitted as loopback while the driver opened the remote host, which sends
    // prompt and response bodies somewhere this gate proved nothing about.
    const procDir = procWith(row(V4_LOOPBACK, 5432, uid), "");

    // TWO controls now cover this string, and the EARLIER one fires. Folding
    // `admitPgDsn` in front of this gate means a duplicate target parameter is
    // refused for being ambiguous, before anything is resolved, so the remote
    // host is never named at all. That is a stricter answer than the one this
    // test was written for, and the property it was written for is asserted
    // separately below, on a string the ambiguity rule does not reach.
    const duplicated = evaluateTranscriptAdmission(
      "postgresql://u@127.0.0.1:5432/gw?host=127.0.0.1&host=db.remote.invalid",
      { procDir, uid }
    );
    expect(duplicated.admitted).toBe(false);
    expect(duplicated.reason).toContain("a target parameter is given more than once");
    expect(duplicated.reason).not.toContain("db.remote.invalid");

    // The property itself, UNSHADOWED: one `host` parameter, an authority that
    // says loopback, and pg resolving somewhere else. No ambiguity rule reaches
    // this (one target key, and no colon in the authority to make the parameter
    // look like an apparent password), so only reading the host FROM PG refuses
    // it. Reverting `parseDsnTarget` to the hand-written parser admits it.
    const overridden = evaluateTranscriptAdmission(
      "postgresql://127.0.0.1/gw?host=db.remote.invalid",
      { procDir, uid }
    );
    expect(overridden.admitted).toBe(false);
    expect(overridden.reason).toContain("db.remote.invalid");
  });

  it("follows PGHOST, which the driver follows and the old parser ignored", () => {
    // Same class: the gate answered from the DSN text while pg applies
    // `config.host || process.env.PGHOST || default`. An empty authority plus
    // an ambient PGHOST resolved to a remote host in the driver and to nothing
    // resolvable in the gate.
    const procDir = procWith(row(V4_LOOPBACK, 5432, uid), "");
    const previous = process.env.PGHOST;
    process.env.PGHOST = "db.remote.invalid";
    try {
      const verdict = evaluateTranscriptAdmission("postgresql:///gw", { procDir, uid });
      expect(verdict.admitted).toBe(false);
      expect(verdict.reason).toContain("db.remote.invalid");
    } finally {
      if (previous === undefined) delete process.env.PGHOST;
      else process.env.PGHOST = previous;
    }
  });

  it("REFUSES a remote host", () => {
    const procDir = procWith(row(V4_LOOPBACK, 5432, uid), "");
    const verdict = evaluateTranscriptAdmission("postgresql://u@db.internal:5432/gw", {
      procDir,
      uid,
    });
    expect(verdict.admitted).toBe(false);
    expect(verdict.reason).toContain("db.internal");
    expect(verdict.shape).toBeNull();
  });

  it("REFUSES a hostname that really does resolve to loopback, deliberately", async () => {
    // The refusal has to be shown to be a RULE and not an accident, so the
    // name is proven to resolve to 127.0.0.1 first. Resolution is asynchronous
    // and this decision is read by surfaces that cannot await, so an
    // unresolvable-in-time name is treated as remote. Write 127.0.0.1 instead.
    const resolved = await lookup("ip6-loopback").catch(() => null);
    if (resolved) expect(isLoopbackLiteral(resolved.address)).toBe(true);
    const procDir = procWith(row(V4_LOOPBACK, 5432, uid), "");
    const verdict = evaluateTranscriptAdmission("postgresql://u@ip6-loopback:5432/gw", {
      procDir,
      uid,
    });
    expect(verdict.admitted).toBe(false);
    expect(verdict.reason).toContain("not resolved here");
  });

  it("REFUSES a malformed DSN", () => {
    for (const dsn of [
      "not a dsn at all",
      "postgresql://u@[::1",
      "postgresql://u@h:99999/gw",
      "",
    ]) {
      const verdict = evaluateTranscriptAdmission(dsn, { uid });
      expect(verdict.admitted, dsn).toBe(false);
      expect(verdict.reason, dsn).not.toBeNull();
    }
  });

  it("REFUSES a missing DSN", () => {
    expect(evaluateTranscriptAdmission(null, { uid }).admitted).toBe(false);
    expect(evaluateTranscriptAdmission(undefined, { uid }).reason).toContain(
      "no [persistence].dsn"
    );
  });

  it("REFUSES a loopback listener owned by ANOTHER uid", () => {
    const procDir = procWith(row(V4_LOOPBACK, 5432, uid + 1), "");
    const verdict = evaluateTranscriptAdmission("postgresql://u@127.0.0.1:5432/gw", {
      procDir,
      uid,
    });
    expect(verdict.admitted).toBe(false);
    expect(verdict.reason).toContain(String(uid + 1));
  });

  it("REFUSES when ANY listener on the port is foreign, not just when all are", () => {
    // Two address families, two processes, and no way to know which one a
    // connection reaches. One foreign listener refuses the whole port.
    const procDir = procWith(row(V4_LOOPBACK, 5432, uid), row(V6_LOOPBACK, 5432, uid + 9));
    expect(
      evaluateTranscriptAdmission("postgresql://u@127.0.0.1:5432/gw", { procDir, uid }).admitted
    ).toBe(false);
  });

  it("REFUSES when nothing is listening on the port", () => {
    const procDir = procWith(row(V4_LOOPBACK, 5999, uid), "");
    expect(
      evaluateTranscriptAdmission("postgresql://u@127.0.0.1:5432/gw", { procDir, uid }).reason
    ).toContain("nothing is listening");
  });

  it("REFUSES a socket that is CONNECTED rather than LISTENING on that port", () => {
    // State 01 is ESTABLISHED. An outbound connection of ours to a remote
    // database on 5432 must not be read as proof that 5432 is served locally.
    const procDir = procWith(row(V4_LOOPBACK, 5432, uid, "01"), "");
    expect(
      evaluateTranscriptAdmission("postgresql://u@127.0.0.1:5432/gw", { procDir, uid }).admitted
    ).toBe(false);
  });

  it("REFUSES when /proc cannot be read at all", () => {
    const verdict = evaluateTranscriptAdmission("postgresql://u@127.0.0.1:5432/gw", {
      procDir: join(tmpdir(), "definitely-not-a-proc-dir-9f3a"),
      uid,
    });
    expect(verdict.admitted).toBe(false);
    expect(verdict.reason).toContain("/proc/net/tcp");
    expect(loopbackListenerUids(5432, join(tmpdir(), "definitely-not-a-proc-dir-9f3a"))).toBeNull();
  });

  it("counts only loopback and wildcard binds, never a public one", () => {
    // `isLoopbackOrWildcardHex` is the difference between "something local is
    // listening" and "something is listening". Deleting the filter left the
    // suite green, and a PUBLIC bind owned by this uid then satisfied the gate,
    // which is precisely the deployment shape section 6.1 refuses.
    const publicV4 = "08080808"; // 8.8.8.8, per-word little-endian as /proc writes it
    const procDir = procWith(row(publicV4, 5432, uid), "");
    expect(loopbackListenerUids(5432, procDir)).toEqual(new Set());

    const verdict = evaluateTranscriptAdmission("postgresql://127.0.0.1:5432/gw", {
      procDir,
      uid,
    });
    expect(verdict.admitted).toBe(false);
    expect(verdict.reason).toContain("nothing is listening on loopback port 5432");
  });

  it("REFUSES a unix socket owned by another uid", () => {
    const dir = socketDir(5432);
    const verdict = evaluateTranscriptAdmission(`postgresql:///gw?host=${dir}`, { uid: 999_999 });
    expect(verdict.admitted).toBe(false);
    expect(verdict.reason).toContain("owned by uid");
  });

  it("REFUSES a unix socket path with no socket entry for that port", () => {
    const dir = socketDir(5432);
    const verdict = evaluateTranscriptAdmission(`postgresql:///gw?host=${dir}&port=5433`, {
      uid: process.getuid?.() ?? 0,
    });
    expect(verdict.admitted).toBe(false);
    expect(verdict.reason).toContain("could not be inspected");
  });

  it("REFUSES when the platform reports no uid at all", () => {
    const procDir = procWith(row(V4_LOOPBACK, 5432, uid), "");
    const verdict = evaluateTranscriptAdmission("postgresql://u@127.0.0.1:5432/gw", {
      procDir,
      uid: null,
    });
    expect(verdict.admitted).toBe(false);
    expect(verdict.reason).toContain("no effective uid");
  });

  it("names section 6.1 in every refusal, so an operator can find the rule", () => {
    for (const dsn of [null, "garbage", "postgresql://u@db.internal/gw"]) {
      const verdict = evaluateTranscriptAdmission(dsn, { uid });
      expect(verdict.reason).toContain("postgres-security-hardening.md section 6.1");
    }
  });
});

describe("loopback literals", () => {
  it("accepts the whole of 127.0.0.0/8 and both IPv6 spellings", () => {
    for (const host of [
      "127.0.0.1",
      "127.1.2.3",
      "127.255.255.255",
      "::1",
      "[::1]",
      "::ffff:127.0.0.1",
    ]) {
      expect(isLoopbackLiteral(host), host).toBe(true);
    }
  });

  it("rejects near misses that a substring check would accept", () => {
    for (const host of ["128.0.0.1", "10.127.0.1", "127.0.0.1.evil.com", "1270.0.0.1", "::2", ""]) {
      expect(isLoopbackLiteral(host), host).toBe(false);
    }
  });

  it("strips brackets only when BOTH are there", () => {
    // The bracket test is a conjunction and neither half was pinned: a sweep
    // deleted each arm with the suite green. Dropping either one makes the
    // stripper run on a string that is not bracketed, and the remainder then
    // reads as a loopback literal it is not.
    for (const host of ["[127.0.0.1x", "x127.0.0.1]", "[::1x", "x::1]"]) {
      expect(isLoopbackLiteral(host), host).toBe(false);
    }
    expect(isLoopbackLiteral("[127.0.0.1]")).toBe(true);
  });

  it("rejects an octet outside 0-255 even when the first one says 127", () => {
    // `\d{1,3}` matches `999`, so the range check is the only thing between
    // `127.999.0.1` and being called loopback. The near-miss list above never
    // reached it: every entry there fails the pattern or the `=== 127` test,
    // so deleting the range check killed nothing.
    for (const host of ["127.999.0.1", "127.0.256.1", "127.0.0.300"]) {
      expect(isLoopbackLiteral(host), host).toBe(false);
    }
  });
});

describe("an unconfigured dsn is reported as unconfigured", () => {
  // Three spellings of ABSENT, and the third had no case: a whitespace-only
  // value fell through to the gate and came back as a scheme refusal, which
  // sends an operator looking for a malformed string they never wrote. Each
  // arm gets its own assertion on the REASON, not merely on the refusal.
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["whitespace only", "   "],
  ])("says so for a dsn that is %s", (_name, dsn) => {
    const verdict = evaluateTranscriptAdmission(dsn, { procDir: "/nonexistent", uid: 4242 });
    expect(verdict.admitted).toBe(false);
    expect(verdict.reason).toContain("no [persistence].dsn is configured");
  });
});

describe("the port bounds pg's own resolution does not enforce", () => {
  // Through the QUERY spelling, which is where the bound is actually reachable.
  // `:70000` in the authority never gets there, because WHATWG rejects it and
  // the parse throws; `?port=70000` and `?port=-1` are resolved by pg without
  // complaint and arrive here as the value a syscall would be handed. Measured
  // with the line removed: both then come back as a target.
  it.each([
    ["above 65535", "postgresql://127.0.0.1/gw?port=70000"],
    ["negative", "postgresql://127.0.0.1/gw?port=-1"],
  ])("refuses a port that is %s", (_name, dsn) => {
    expect(parseDsnTarget(dsn)).toBeNull();
  });

  it("leaves the ports pg does resolve alone", () => {
    expect(parseDsnTarget("postgresql://127.0.0.1:1/gw")?.port).toBe(1);
    expect(parseDsnTarget("postgresql://127.0.0.1:65535/gw")?.port).toBe(65535);
    expect(parseDsnTarget("postgresql://127.0.0.1/gw?port=65535")?.port).toBe(65535);
  });

  it("records the spellings that never reach the bound at all", () => {
    // Not a gap: pg substitutes its default for both, so the value handed on is
    // already in range. Written down so the next sweep reads the surviving
    // `Number.isInteger` arm as a measurement rather than as a missing case.
    expect(parseDsnTarget("postgresql://127.0.0.1/gw?port=abc")?.port).toBe(5432);
    expect(parseDsnTarget("postgresql://127.0.0.1:0/gw")?.port).toBe(5432);
    expect(parseDsnTarget("postgresql://127.0.0.1:70000/gw")).toBeNull();
  });
});

describe("DSN parsing", () => {
  it("reads the port from the authority and from the query, defaulting to 5432", () => {
    expect(parseDsnTarget("postgresql://u@127.0.0.1/gw")?.port).toBe(5432);
    expect(parseDsnTarget("postgresql://u@127.0.0.1:6000/gw")?.port).toBe(6000);
    expect(parseDsnTarget("postgresql://u@127.0.0.1/gw?port=6001")?.port).toBe(6001);
  });

  it("reads a percent-encoded socket directory out of the authority", () => {
    expect(parseDsnTarget("postgresql://%2Fvar%2Frun%2Fpostgresql/gw")?.socketDirectory).toBe(
      "/var/run/postgresql"
    );
  });

  it("lets `host=` in the query win over the authority, as libpq does", () => {
    const target = parseDsnTarget("postgresql://u@127.0.0.1:5432/gw?host=/tmp/sock");
    expect(target?.socketDirectory).toBe("/tmp/sock");
    expect(target?.host).toBeNull();
  });
});

describe("the memo", () => {
  it("answers once per DSN, because the kernel state underneath it can change", () => {
    const dir = socketDir(5432);
    const dsn = `postgresql:///gw?host=${dir}`;
    const first = transcriptAdmission(dsn);
    // Break the shape underneath it. A re-evaluation would now refuse.
    rmSync(join(dir, ".s.PGSQL.5432"));
    expect(transcriptAdmission(dsn)).toBe(first);
    resetTranscriptAdmission();
    expect(transcriptAdmission(dsn).admitted).toBe(false);
  });

  it("re-evaluates for a DIFFERENT dsn rather than reusing the answer", () => {
    const dir = socketDir(5432);
    expect(transcriptAdmission(`postgresql:///gw?host=${dir}`).admitted).toBe(true);
    expect(transcriptAdmission("postgresql://u@db.internal/gw").admitted).toBe(false);
  });

  it("honours the test override, so a suite does not depend on the host it runs on", () => {
    setTranscriptAdmissionForTests({
      admitted: true,
      shape: "loopback-tcp",
      evidence: "injected",
      reason: null,
    });
    expect(transcriptAdmission("postgresql://u@db.internal/gw").admitted).toBe(true);
  });
});

describe("permissions do not decide this", () => {
  it("an unreadable /proc table is NOT the same as an empty one", () => {
    // Both refuse, but for different reasons, and only one of them means "the
    // database is definitely not local". Collapsing them would let a hardened
    // /proc (hidepid) read as "nothing is listening".
    const dir = procWith("", "");
    chmodSync(join(dir, "tcp"), 0o000);
    chmodSync(join(dir, "tcp6"), 0o000);
    const uids = loopbackListenerUids(5432, dir);
    // Running as root would still read them; that host gets the empty answer.
    expect(uids === null || uids.size === 0).toBe(true);
  });
});

/**
 * What a verdict may name, and what it may never name.
 *
 * The property is NOT "the secret never appears", which was the first thing
 * written here and is false: an operator who puts a string in the HOST or in a
 * socket directory has named the thing pg will dial, and a gate that refuses to
 * say where it is looking is not diagnosable. The property is about POSITION.
 *
 *   credential position   userinfo password, `password=`, and every position
 *                         inside a DSN the gate REFUSES, since a refused DSN is
 *                         never named at all. Must not appear, ever.
 *   target position       host, socket directory. May appear, but only as the
 *                         one display control renders it.
 *
 * A corpus rather than the three shapes measured leaking, because three shapes
 * is what each previous round fixed before the next found a fourth spelling.
 * The marker is planted BY POSITION and the whole verdict is checked, `evidence`
 * included: that field is written on the admit path and read by the same health
 * surface, so a leak moving between fields would otherwise pass.
 */
describe("what a transcript-admission verdict may name", () => {
  // No `@`, `%`, `;`, `=` or `&`: those make the gate refuse for a DIFFERENT
  // reason, and the case would then prove nothing about the position it names.
  // The keyword-shaped entries below plant those separators deliberately.
  const SECRET = "Xyzzy-Correct-Horse-Battery-Staple-42";
  const ENV = { procDir: "/nonexistent", uid: 4242 } as const;

  /** Positions holding a credential, or sitting inside a DSN the gate refuses. */
  const NEVER_NAMED: Array<[string, string]> = [
    ["userinfo password", `postgres://alice:${SECRET}@db.example.com:5432/app`],
    ["userinfo password, loopback host", `postgres://alice:${SECRET}@127.0.0.1:5432/app`],
    [
      "userinfo password, percent-encoded",
      `postgres://alice:${encodeURIComponent(SECRET)}@db.example.com/app`,
    ],
    ["password query parameter", `postgres://u@127.0.0.1/db?password=${SECRET}`],
    ["keyword authority", `postgresql://host=evil;password=${SECRET}/app`],
    ["keyword authority, percent-encoded", `postgres://host=evil%3Bpassword%3D${SECRET}/app`],
    ["keyword value of a target parameter", `postgres://u@h/db?host=evil;password=${SECRET}`],
    ["keyword value of the user parameter", `postgres://u@h/db?user=alice;password=${SECRET}`],
    ["keyword-shaped database name", `postgres:///db;password=${SECRET}`],
    ["user", `postgres://${SECRET}@127.0.0.1/db`],
    ["application_name", `postgres://127.0.0.1/db?application_name=${SECRET}`],
    ["fragment", `postgres://127.0.0.1/db#${SECRET}`],
  ];

  /** Positions that ARE the target. Naming them is the job; HOW is the control. */
  const NAMED_THROUGH_THE_CONTROL: Array<[string, string]> = [
    ["host", `postgres://${SECRET}/db`],
    ["socket directory", `postgres://u@h/db?host=/tmp/${SECRET}`],
  ];

  const evaluate = (dsn: string): string => JSON.stringify(evaluateTranscriptAdmission(dsn, ENV));

  it.each(NEVER_NAMED)("a %s is never named", (_position, dsn) => {
    expect(evaluate(dsn)).not.toContain(SECRET);
  });

  it.each(NAMED_THROUGH_THE_CONTROL)(
    "a %s is named only as the control renders it",
    (_position, dsn) => {
      const verdict = evaluateTranscriptAdmission(dsn, ENV);
      const text = `${verdict.reason ?? ""}${verdict.evidence ?? ""}`;
      if (!text.includes(SECRET)) return;
      // Present, so it came through `showLogField`: bounded, and carrying no
      // character that would break or reorder the line it sits in.
      expect(text).not.toMatch(/[\u0080-\u009F\u007F\u2028\u2029]|\p{Cf}/u);
      expect([...text].length).toBeLessThan(600);
    }
  );

  /**
   * LIVENESS. Every assertion above passes against a function returning a
   * constant, and passes just as well if the corpus stopped reaching the code
   * that formats a target. Both are pinned here: the reasons must be real and
   * distinct, and at least one must still name a host, which is the path that
   * leaked.
   */
  it("the corpus reaches the code that names a target, and says something", () => {
    const reasons = [...NEVER_NAMED, ...NAMED_THROUGH_THE_CONTROL]
      .map(([, dsn]) => evaluateTranscriptAdmission(dsn, ENV).reason)
      .filter((reason): reason is string => reason !== null);
    expect(reasons).toHaveLength(NEVER_NAMED.length + NAMED_THROUGH_THE_CONTROL.length);
    expect(new Set(reasons).size).toBeGreaterThan(1);
    expect(reasons.filter(reason => reason.includes("host")).length).toBeGreaterThan(0);
  });

  it("an ordinary DSN is still named in full", () => {
    // The control for over-refusal: the repair must not have been "print less".
    const verdict = evaluateTranscriptAdmission("postgres://alice@db.example.com:5432/app", ENV);
    expect(verdict.admitted).toBe(false);
    expect(verdict.reason).toContain("db.example.com");
  });
});
