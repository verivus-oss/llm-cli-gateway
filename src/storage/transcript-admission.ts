/**
 * May transcript BODIES enter this PostgreSQL deployment?
 *
 * docs/plans/postgres-security-hardening.md section 6.1 (amendment
 * 2026-08-22) rules that the gate is DEPLOYMENT SHAPE, not the completion of
 * that document's steps 3 to 8. Loopback or unix socket, gateway and database
 * under the same OS user: admitted, because that is threat-equivalent to the
 * 0600 `logs.db` it replaces. Anything else: refused until those steps are
 * done.
 *
 * The verdict is DATA, resolved once per DSN and carried. Nothing else may
 * spell an `isLocal` test: a second call site is a second answer, and this one
 * reads live kernel state that can change under a running process.
 *
 * SYNCHRONOUS, deliberately, and that constrains what can be proven. The
 * decision is read by `flightRecorderEngineDecision`, which `llm_process_health`
 * and the startup block both call and neither can await (hazard: a fail-closed
 * gate reading a snapshot it cannot wait on). So there is no DNS here: a host
 * name other than `localhost` cannot be resolved without yielding, and a shape
 * that cannot be proven is refused rather than assumed.
 */
import { readFileSync, statSync } from "node:fs";
import { resolvePgDsnTarget } from "./pg-dsn-target.js";
import { join } from "node:path";

export type TranscriptDeploymentShape = "unix-socket" | "loopback-tcp";

export interface TranscriptAdmission {
  admitted: boolean;
  /** Proven shape, or null when nothing was proven. */
  shape: TranscriptDeploymentShape | null;
  /** What was proven, for an operator reading a health surface. */
  evidence: string | null;
  /** Why not. Always set when `admitted` is false, never set when it is true. */
  reason: string | null;
}

const REFUSAL_SUFFIX =
  "postgres-security-hardening.md section 6.1 admits transcript bodies only into a " +
  "loopback or unix-socket PostgreSQL running as this same OS user; anything else waits " +
  "for steps 3 to 8 of section 6.";

function refuse(reason: string): TranscriptAdmission {
  return { admitted: false, shape: null, evidence: null, reason: `${reason}. ${REFUSAL_SUFFIX}` };
}

function admit(shape: TranscriptDeploymentShape, evidence: string): TranscriptAdmission {
  return { admitted: true, shape, evidence, reason: null };
}

/** 127.0.0.0/8, ::1, and the IPv4-mapped form of either. Never a name. */
export function isLoopbackLiteral(host: string): boolean {
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const address = bare.toLowerCase().replace(/^::ffff:/, "");
  if (address === "::1") return true;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
  if (!ipv4) return false;
  const octets = ipv4.slice(1).map(Number);
  if (octets.some(part => part > 255)) return false;
  return octets[0] === 127;
}

interface DsnTarget {
  socketDirectory: string | null;
  host: string | null;
  port: number;
}

/**
 * The target pg will use, resolved BY pg.
 *
 * This used to be a hand-written parser: trim, `new URL`, `searchParams.get`,
 * a manual authority slice, plus a separate keyword/value reader. Every one of
 * those was a second answer to a question `pg` had already decided, and they
 * disagreed with it in three measured ways (duplicate query keys, ambient
 * `PGHOST`/`PGPORT`, and keyword/value strings pg does not accept at all).
 *
 * A gate that admits transcript BODIES cannot afford to be reporting on a
 * different host from the one the driver opens. See `pg-dsn-target.ts`.
 */
export function parseDsnTarget(dsn: string): DsnTarget | null {
  return resolvePgDsnTarget(dsn);
}

/** The effective uid, or null where the platform has none (Windows). */
function currentUid(): number | null {
  const geteuid = process.geteuid?.bind(process) ?? process.getuid?.bind(process);
  if (!geteuid) return null;
  try {
    return geteuid();
  } catch {
    return null;
  }
}

/**
 * Every uid listening on `port` over loopback, from /proc/net/tcp{,6}.
 *
 * A WILDCARD bind counts. The reference deployment (rootless podman) publishes
 * `*:5433` through a userspace forwarder, so requiring a literal 127.0.0.1 bind
 * would refuse the exact shape section 6.1 admits. Measured on this host:
 * `00000000000000000000000000000000:1539 ... 0A ... 1000`.
 *
 * Returns null when the tables cannot be read at all, which is NOT the same as
 * an empty set: unreadable means nothing was proven, empty means nothing is
 * listening and the DSN cannot be reaching a local process.
 */
export function loopbackListenerUids(port: number, procDir = "/proc/net"): Set<number> | null {
  let sawTable = false;
  const uids = new Set<number>();
  for (const table of ["tcp", "tcp6"]) {
    let body: string;
    try {
      body = readFileSync(join(procDir, table), "utf8");
    } catch {
      continue;
    }
    sawTable = true;
    for (const line of body.split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields.length < 8) continue;
      // 0A is TCP_LISTEN. Anything else is an established or closing socket and
      // says nothing about who will answer the next connection.
      if (fields[3] !== "0A") continue;
      const [address, portHex] = fields[1].split(":");
      if (Number.parseInt(portHex, 16) !== port) continue;
      if (!isLoopbackOrWildcardHex(address)) continue;
      const uid = Number(fields[7]);
      if (Number.isInteger(uid)) uids.add(uid);
    }
  }
  return sawTable ? uids : null;
}

/**
 * /proc's per-word little-endian hex address, for the forms that mean "reachable
 * on this host": the wildcard bind, IPv4 loopback, IPv6 loopback, and the
 * IPv4-mapped loopback an IPv6 listener reports.
 */
function isLoopbackOrWildcardHex(address: string): boolean {
  const upper = address.toUpperCase();
  if (/^0+$/.test(upper)) return true;
  if (upper.length === 8) return upper === "0100007F";
  if (upper.length !== 32) return false;
  // ::1 is the low word only, byte-swapped within that word.
  if (upper === "00000000000000000000000001000000") return true;
  // ::ffff:127.0.0.1
  return upper === "0000000000000000FFFF00000100007F";
}

/**
 * The verdict for one DSN. Pure apart from the two kernel reads, which is what
 * makes the matrix in the suite a table rather than a mock.
 */
export function evaluateTranscriptAdmission(
  dsn: string | null | undefined,
  options: { procDir?: string; uid?: number | null } = {}
): TranscriptAdmission {
  if (dsn === null || dsn === undefined || dsn.trim().length === 0) {
    return refuse("no [persistence].dsn is configured, so the deployment shape is unknown");
  }
  const target = parseDsnTarget(dsn);
  if (!target) {
    return refuse("the [persistence].dsn could not be parsed, so its host cannot be proven local");
  }
  const uid = options.uid === undefined ? currentUid() : options.uid;
  if (uid === null) {
    return refuse(
      "this platform reports no effective uid, so the database cannot be proven to run as this OS user"
    );
  }

  if (target.socketDirectory !== null) {
    const socket = join(target.socketDirectory, `.s.PGSQL.${target.port}`);
    let ownerUid: number;
    try {
      ownerUid = statSync(socket).uid;
    } catch {
      return refuse(`the unix socket ${socket} could not be inspected, so its owner is unknown`);
    }
    if (ownerUid !== uid) {
      return refuse(
        `the unix socket ${socket} is owned by uid ${ownerUid}, not this process's uid ${uid}`
      );
    }
    return admit("unix-socket", `${socket} is owned by uid ${uid}, this process's own`);
  }

  const host = target.host ?? "";
  const localhostName = host.toLowerCase() === "localhost";
  if (!localhostName && !isLoopbackLiteral(host)) {
    return refuse(
      `the [persistence].dsn host "${host}" is not a loopback literal. A name is not resolved here, ` +
        "because this decision is read by surfaces that cannot await one; write 127.0.0.1 or ::1 if it is loopback"
    );
  }
  const uids = loopbackListenerUids(target.port, options.procDir);
  if (uids === null) {
    return refuse(
      `neither /proc/net/tcp nor /proc/net/tcp6 could be read, so the owner of the listener on port ${target.port} is unknown`
    );
  }
  if (uids.size === 0) {
    return refuse(`nothing is listening on loopback port ${target.port}`);
  }
  // EVERY listener must be ours. Two processes can hold the same port across
  // address families, and there is no way to tell which one a connection will
  // reach, so one foreign listener refuses the whole port.
  const foreign = [...uids].filter(candidate => candidate !== uid);
  if (foreign.length > 0) {
    return refuse(
      `a process owned by uid ${foreign.join(", ")} is listening on loopback port ${target.port}, not this process's uid ${uid}`
    );
  }
  return admit(
    "loopback-tcp",
    `the listener on loopback port ${target.port} runs as uid ${uid}, this process's own`
  );
}

/**
 * The resolved fact, once per DSN.
 *
 * Memoised because it reads live kernel state: calling it again after a
 * container restart could answer differently, and a health surface reporting
 * `admitted` while the recorder is on SQLite because admission failed at
 * startup is the split this whole programme exists to remove. The DSN is the
 * key, so a differently configured deployment is a different question.
 */
let memo: { dsn: string | null; verdict: TranscriptAdmission } | null = null;

export function transcriptAdmission(dsn: string | null | undefined): TranscriptAdmission {
  if (override) return override;
  const key = dsn ?? null;
  if (memo && memo.dsn === key) return memo.verdict;
  const verdict = evaluateTranscriptAdmission(key);
  memo = { dsn: key, verdict };
  return verdict;
}

/**
 * Tests only. The memo is process-wide, so a suite must not inherit one, and a
 * suite asserting the ADMITTED wiring must not depend on what happens to be
 * listening on the machine running it. Overriding here rather than stubbing
 * `flightRecorderEngineDecision` keeps the one decision point real.
 */
let override: TranscriptAdmission | null = null;

export function setTranscriptAdmissionForTests(verdict: TranscriptAdmission | null): void {
  override = verdict;
  memo = null;
}

export function resetTranscriptAdmission(): void {
  memo = null;
  override = null;
}
