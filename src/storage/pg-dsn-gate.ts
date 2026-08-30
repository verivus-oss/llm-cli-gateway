/**
 * The single admission decision for a PostgreSQL DSN.
 *
 * Consulted before the string is REPORTED and before it is CONNECTED with, so
 * one refusal closes the log line, the resolver lookup and the startup packet
 * together. Rounds 14 to 23 hardened only the log line, and pg went on dialling
 * whatever the string said.
 *
 * It returns a verdict and never a rewritten string. Rounds 3 to 10 were all
 * defects in code that edited the DSN before handing it on.
 *
 * Every rule here is stated over a CLASS. The five escapes of this series were
 * one class narrowed to one spelling each, so a rule that names a literal the
 * attacker chooses is not a rule.
 */

import { POSTGRES_DSN_PREFIXES } from "./roles.js";

export type DsnAdmission = { admitted: true } | { admitted: false; reason: string };

const ADMITTED: DsnAdmission = { admitted: true };
function refuse(reason: string): DsnAdmission {
  return { admitted: false, reason };
}

/** Both spellings of `@` that survive pg's single decode. `%2540` is not one. */
const AT_TOKEN = /@|%40/i;
/** A colon spelled as an escape hides a password inside the USER field. */
const ENCODED_COLON = /%3A/i;
const URI_CHARACTERS = /^[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]*$/;
/** Query keys pg resolves into the target. `dbname` is inert in pg 8.22 and is
 *  listed anyway so a pg that starts honouring it cannot open a hole quietly. */
const TARGET_KEYS = new Set(["host", "port", "user", "dbname"]);
/**
 * `parse()` reads these off disk. That is a hazard for the REPORTER, which runs
 * synchronously in a constructor and would block on a fifo, and it is ordinary
 * for the CONNECTOR, which is about to read the same file anyway. So this is
 * NOT a core rule: refusing it on the connect path would break every TLS
 * deployment that names a client certificate.
 */
const SSL_FILE_KEYS = new Set(["sslcert", "sslkey", "sslrootcert"]);
/** How keyword and JDBC grammars smuggle a password into what looks like a name. */
const KEYWORD_SEPARATORS = [";", "=", "&"] as const;

/**
 * Does this DSN name a file the parser would OPEN? Asked by the reporter only.
 *
 * Matched exactly as pg matches it, and no wider. pg reads under
 * `if (config.sslcert)`, so a key with no value never opens anything, and its
 * config keys are case-sensitive, so `SSLCERT` sets a different property and is
 * inert. Refusing either would be a refusal pg's behaviour does not earn.
 */
export function namesSslFileParameter(dsn: string): boolean {
  const lower = dsn.toLowerCase();
  const prefix = POSTGRES_DSN_PREFIXES.find(candidate => lower.startsWith(candidate));
  if (prefix === undefined) return false;
  return queryPairs(dsn.slice(prefix.length)).some(
    ([key, value]) => SSL_FILE_KEYS.has(key) && value.length > 0
  );
}

/** First `/`, `?` or `#`. All three end the authority, and computing that in
 *  one place is the point: round 22's fragment bypass existed because two
 *  places computed it and only one counted `#`. */
function endOfAuthority(rest: string): number {
  const ends = ["/", "?", "#"].map(delimiter => rest.indexOf(delimiter)).filter(at => at >= 0);
  return ends.length === 0 ? rest.length : Math.min(...ends);
}

function decodeKey(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** pg merges `searchParams` into its config, and searchParams DECODES keys, so
 *  `?%68ost=` is `host` to pg. Comparing raw keys would miss it. */
function queryPairs(rest: string): Array<[string, string]> {
  const at = rest.indexOf("?");
  if (at < 0) return [];
  const hash = rest.indexOf("#", at);
  const query = hash < 0 ? rest.slice(at + 1) : rest.slice(at + 1, hash);
  if (query.length === 0) return [];
  return query.split("&").map(pair => {
    const eq = pair.indexOf("=");
    return eq < 0
      ? ([decodeKey(pair), ""] as [string, string])
      : ([decodeKey(pair.slice(0, eq)), pair.slice(eq + 1)] as [string, string]);
  });
}

function queryKeys(rest: string): string[] {
  return queryPairs(rest).map(([key]) => key);
}

/**
 * The gate as a precondition, for the CONNECT side.
 *
 * A DSN the reporter refuses to name must not be dialled either. Refusing in
 * only one of the two places is what let `?host=` redirect a connection while
 * the log line stayed clean, and what put an apparent password into the
 * startup packet where no amount of redaction reached it.
 */
export function assertAdmissiblePgDsn(dsn: string, label: string): void {
  const admission = admitPgDsn(dsn);
  if (admission.admitted) return;
  // The DSN itself is never echoed: the reason names the SHAPE that was
  // refused, and the label names which configured DSN carried it.
  throw new Error(`refusing to connect with the ${label} DSN: ${admission.reason}`);
}

export function admitPgDsn(dsn: string): DsnAdmission {
  const lower = dsn.toLowerCase();
  const prefix = POSTGRES_DSN_PREFIXES.find(candidate => lower.startsWith(candidate));
  if (prefix === undefined) return refuse("not a postgresql:// or postgres:// URI");

  const afterPrefix = dsn.slice(prefix.length);
  const authority = afterPrefix.slice(0, endOfAuthority(afterPrefix));

  const hash = dsn.indexOf("#", prefix.length);
  const rest = hash < 0 ? afterPrefix : dsn.slice(prefix.length, hash);
  if (!URI_CHARACTERS.test(rest)) {
    return refuse("holds a character RFC 3986 requires to be percent-encoded");
  }

  const targets = queryKeys(afterPrefix).filter(key => TARGET_KEYS.has(key));
  if (new Set(targets).size !== targets.length) {
    return refuse("a target parameter is given more than once");
  }

  const ats = authority.split("@").length - 1;
  if (ats > 1) return refuse("more than one unencoded @ in the authority");

  const userinfoEnd = authority.lastIndexOf("@");
  if (AT_TOKEN.test(afterPrefix.slice(userinfoEnd + 1))) {
    return refuse("an @ after the authority is ambiguous; it may be relocated userinfo");
  }

  if (ats === 1 && ENCODED_COLON.test(authority.slice(0, userinfoEnd))) {
    return refuse("an encoded colon in the userinfo hides a password inside the user");
  }

  // THE CLASS round 23 escaped through. When the authority carries no `@`, its
  // colon span is a port to the parser and a password to a reader. That is
  // harmless while the target comes from the authority, and a disclosure the
  // moment a query parameter supplies the target instead: the printed host is
  // then chosen from bytes sitting in the apparent password position.
  //
  // Round 23's fix named the empty port, so `u:?host=X` was refused and
  // `u:1?host=X` was not. One digit. The rule is about the SHAPE, not the span.
  if (ats === 0 && authority.includes(":") && targets.length > 0) {
    return refuse("a colon in the authority with a target parameter is an apparent password");
  }

  if (authority.includes("=") || authority.includes(",")) {
    return refuse("a keyword-shaped authority is not a URI authority");
  }

  const path = rest.slice(endOfAuthority(rest)).split("?")[0] ?? "";
  if (path.includes(":")) {
    return refuse("a colon outside the authority opens an apparent password");
  }
  // libpq keyword and JDBC property syntax. pg's URI parser treats none of
  // these as a boundary, so `postgres:///db;password=SECRET` lands in the
  // DATABASE intact and gets printed. Raw spellings only: pg decodes the path
  // with decodeURI, which leaves every one of these encoded.
  if (KEYWORD_SEPARATORS.some(separator => path.includes(separator))) {
    return refuse("the database name holds URI or keyword structure");
  }

  return ADMITTED;
}
