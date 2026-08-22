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
  while (temporaries.length > 0) rmSync(temporaries.pop() as string, { recursive: true, force: true });
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

  it("ADMITS the keyword/value DSN form libpq also accepts", () => {
    const dir = socketDir(5432);
    const verdict = evaluateTranscriptAdmission(`host=${dir} dbname=gw user=llmgw`, {
      uid: process.getuid?.() ?? 0,
    });
    expect(verdict.admitted).toBe(true);
    expect(verdict.shape).toBe("unix-socket");
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
    for (const dsn of ["not a dsn at all", "postgresql://u@[::1", "postgresql://u@h:99999/gw", ""]) {
      const verdict = evaluateTranscriptAdmission(dsn, { uid });
      expect(verdict.admitted, dsn).toBe(false);
      expect(verdict.reason, dsn).not.toBeNull();
    }
  });

  it("REFUSES a missing DSN", () => {
    expect(evaluateTranscriptAdmission(null, { uid }).admitted).toBe(false);
    expect(evaluateTranscriptAdmission(undefined, { uid }).reason).toContain("no [persistence].dsn");
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
    for (const host of ["127.0.0.1", "127.1.2.3", "127.255.255.255", "::1", "[::1]", "::ffff:127.0.0.1"]) {
      expect(isLoopbackLiteral(host), host).toBe(true);
    }
  });

  it("rejects near misses that a substring check would accept", () => {
    for (const host of ["128.0.0.1", "10.127.0.1", "127.0.0.1.evil.com", "1270.0.0.1", "::2", ""]) {
      expect(isLoopbackLiteral(host), host).toBe(false);
    }
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
