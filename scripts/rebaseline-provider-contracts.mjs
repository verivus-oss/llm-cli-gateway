#!/usr/bin/env node
// Auto-rebaseline provider contracts against the installed CLIs.
//
// Governing principle: the gateway passes through what the upstream binary
// supports, and NOTHING else. It wires up capability as it appears and unwires
// it as it disappears. A provider's deprecation cycle is not ours to manage, so
// every class of drift is applied mechanically rather than queued for review:
//
//   VERSION drift        the target is a factual record of what was validated.
//   ADDITIVE flag drift  an upstream flag the gateway does not emit, recorded
//                        as an acknowledgement so the probe stays quiet.
//   NEW commands         declared reachable per the provider's `autoDeclare`.
//   REMOVALS             a flag the installed binary stopped advertising. The
//                        contract describes what the binary supports, so the
//                        truthful contract is the one without it.
//
// An earlier version of this file refused removals, on the grounds that `flags`
// is the argv emit allowlist and a removal has to be made in lock-step across
// the contract, `provider-codegen.ts` and `index.ts`. The lock-step observation
// holds and is why the first two land in one run here. The conclusion did not:
// it made a vendor's deprecation a standing review item on our side.
//
// `hiddenFromHelp` on a flag contract is the declared way to say "real but
// deliberately undocumented"; `computeFlagDrift` skips those, so a contrary
// belief is recorded in the contract rather than defended by a human gate.
//
// What is NOT rewritten is the hand-written emission in `src/index.ts`, because
// it is not derivable from a flag string (the devin `--agent-config` removal
// touched 22 references, none of which spell the flag). Those are reported with
// file:line, and the handler tests asserting `validateUpstreamCliArgs(...).ok`
// fail by name once the contract stops declaring the flag.
// See docs/plans/provider-contract-removal-autoapply.dag.toml.
//
// Usage:
//   node scripts/rebaseline-provider-contracts.mjs            # report only
//   node scripts/rebaseline-provider-contracts.mjs --apply    # write changes
//   node scripts/rebaseline-provider-contracts.mjs --json     # machine readable
//   node scripts/rebaseline-provider-contracts.mjs --apply --no-declare-new
//                                                            # skip declaring
//                                                            # NEW commands
import { readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve, sep } from "node:path";
import ts from "typescript";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const DEFINITIONS = join(REPO, "src", "provider-definitions.ts");
const CONTRACTS = join(REPO, "src", "upstream-contracts.ts");
const CODEGEN = join(REPO, "src", "provider-codegen.ts");

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const AS_JSON = args.includes("--json");
// Declaring newly discovered commands is ON by default: the gateway wires up
// access to provider capability as it appears. Scope is governed per provider
// by "autoDeclare" in provider-definitions.ts (reachable | catalogue | off),
// because a probe reads capability and cannot read intent. "--no-declare-new"
// suppresses it for a single run without editing that declared intent.
// See docs/plans/provider-contract-drift-rc3.dag.toml#scope-reachability.
const DECLARE_NEW = !args.includes("--no-declare-new");

/**
 * Read the PROVIDER_TARGET_VERSIONS literal from provider-definitions.ts.
 *
 * @param source File contents.
 * @returns Map of provider to declared version string, plus the block bounds.
 */
export function parseTargetVersions(source) {
  const start = source.indexOf("export const PROVIDER_TARGET_VERSIONS");
  if (start === -1) throw new Error("PROVIDER_TARGET_VERSIONS not found");
  const open = source.indexOf("{", start);
  const close = source.indexOf("};", open);
  if (open === -1 || close === -1) throw new Error("PROVIDER_TARGET_VERSIONS block malformed");
  const body = source.slice(open + 1, close);

  const versions = {};
  for (const line of body.split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*"([^"]*)"\s*,?\s*$/);
    if (m) versions[m[1]] = m[2];
  }
  return { versions, open, close, body };
}

/** Escape a string for literal use inside a RegExp. */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Characters that cannot appear in a version written into a double-quoted
 * TypeScript string literal without escaping.
 *
 * This value comes from a vendor CLI's own `--version` banner, which is not
 * under our control, and it is written into SOURCE. Rather than escape and
 * hope, refuse: a version containing a quote, backslash or newline is far more
 * likely to be a parse failure than a real version, and corrupting
 * provider-definitions.ts is a much worse outcome than declining to rebaseline.
 */
const UNSAFE_IN_LITERAL = /["\\\r\n]/;

/**
 * Rewrite one provider's version string in the PROVIDER_TARGET_VERSIONS block.
 *
 * Replaces only within the located block so an identical string elsewhere in
 * the file cannot be clobbered.
 *
 * Three ways this went wrong before, all found by probing it rather than
 * reading it, and all of them silently corrupted the file:
 *   - a version containing `"` closed the string literal early and produced
 *     invalid TypeScript;
 *   - a version containing `$1` or `$&` was interpreted by String.replace as a
 *     replacement pattern, so the written value was not the value passed in;
 *   - `cli` was interpolated into the RegExp unescaped, so a key containing a
 *     metacharacter could match a different provider's line.
 *
 * @param source File contents.
 * @param cli Provider key.
 * @param nextVersion Replacement version string.
 * @returns Updated file contents.
 * @throws When the entry is absent, or the version cannot be safely embedded.
 */
/**
 * Recombine an installed banner into the CURATED shape of the current target.
 *
 * The seven targets do not share one format, and that is deliberate: several
 * contract spellings differ from what the binary reports (`claude 2.1.220` vs
 * `2.1.220 (Claude Code)`), and `provider-version-guard.test.ts` asserts that
 * at least one such pair exists, to prove the normalizer is load-bearing.
 * Writing the raw banner collapses that difference and makes the assertion
 * vacuous, so preserve the existing prefix and take only the version and build
 * id from the banner.
 *
 * @param currentTarget The contracted spelling being replaced.
 * @param installedRaw The banner as the binary reported it.
 * @param normalize The shipped `normalizeProviderVersion`, passed in rather than
 *   reimplemented so the two can never disagree.
 */
export function preserveTargetSpelling(currentTarget, installedRaw, normalize) {
  const parsed = normalize(installedRaw);
  if (!parsed.version) return installedRaw;

  const prefixMatch = /^([A-Za-z][A-Za-z0-9._-]*)\s+(?=v?\d)/.exec(currentTarget.trim());
  const prefix = prefixMatch ? `${prefixMatch[1]} ` : "";
  const build = parsed.build ? ` (${parsed.build})` : "";
  return `${prefix}${parsed.version}${build}`;
}

export function rewriteTargetVersion(source, cli, nextVersion) {
  if (typeof nextVersion !== "string" || nextVersion.length === 0) {
    throw new Error(`Refusing to write an empty version for ${cli}`);
  }
  if (UNSAFE_IN_LITERAL.test(nextVersion)) {
    throw new Error(
      `Refusing to write version for ${cli}: contains a quote, backslash or newline ` +
        `(${JSON.stringify(nextVersion)}). This would corrupt provider-definitions.ts.`
    );
  }

  const { open, close, body } = parseTargetVersions(source);
  const pattern = new RegExp(`(^\\s*${escapeRegExp(cli)}\\s*:\\s*")([^"]*)("\\s*,?\\s*$)`, "m");
  if (!pattern.test(body)) throw new Error(`No target-version entry for ${cli}`);
  // Replacement FUNCTION, not a string: a string replacement would treat `$1`
  // and `$&` inside nextVersion as capture-group references.
  const nextBody = body.replace(
    pattern,
    (_match, prefix, _old, suffix) => prefix + nextVersion + suffix
  );
  const next = source.slice(0, open + 1) + nextBody + source.slice(close);

  // Round-trip guard. The character denylist above only covers failure modes
  // somebody thought of; this covers the rest by construction. Re-parse the
  // result and require that every provider reads back as intended: the one we
  // changed holds exactly nextVersion, and no other entry moved. A value
  // containing `};`, for instance, would truncate the block on the next parse
  // and was not on any denylist, but it cannot survive this.
  let verified;
  try {
    verified = parseTargetVersions(next).versions;
  } catch (err) {
    throw new Error(
      `Refusing to write ${cli}=${JSON.stringify(nextVersion)}: result no longer parses ` +
        `(${err instanceof Error ? err.message : String(err)})`,
      { cause: err }
    );
  }
  if (verified[cli] !== nextVersion) {
    throw new Error(
      `Refusing to write ${cli}=${JSON.stringify(nextVersion)}: it reads back as ` +
        `${JSON.stringify(verified[cli])}`
    );
  }
  const before = parseTargetVersions(source).versions;
  for (const key of Object.keys(before)) {
    if (key !== cli && before[key] !== verified[key]) {
      throw new Error(
        `Refusing to write ${cli}: the rewrite also changed ${key} ` +
          `(${JSON.stringify(before[key])} -> ${JSON.stringify(verified[key])})`
      );
    }
  }

  return next;
}

// ---------------------------------------------------------------------------
// Acknowledged-flag rebaselining (additive drift).
//
// `acknowledgedUpstreamFlags` records "upstream advertises this flag and the
// gateway deliberately does not emit it". It is probe-quieting ONLY and is
// never consulted as an argv allowlist, which is exactly why it is safe to
// write mechanically while a removal is not.
//
// The edit uses the TypeScript AST for LOCATION ONLY and then splices text at
// the returned offsets. It never reprints a node. That matters: the arrays in
// upstream-contracts.ts carry per-entry trailing comments explaining why each
// flag is not emitted ("alias of --allowed-tools", "short form of
// --background"), and a printer-based rewrite silently discards every one of
// them. Insert-only editing preserves them by construction.
// ---------------------------------------------------------------------------

/** Parse a TS source string for location queries. */
function parseContracts(source) {
  return ts.createSourceFile(
    "upstream-contracts.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
}

/** The UPSTREAM_CLI_CONTRACTS object literal, unwrapping as/satisfies. */
function findContractsObject(sourceFile) {
  for (const stmt of sourceFile.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || decl.name.text !== "UPSTREAM_CLI_CONTRACTS") continue;
      let init = decl.initializer;
      while (
        init &&
        (ts.isAsExpression(init) ||
          ts.isSatisfiesExpression(init) ||
          ts.isParenthesizedExpression(init))
      ) {
        init = init.expression;
      }
      if (init && ts.isObjectLiteralExpression(init)) return init;
    }
  }
  return null;
}

/** A named property assignment in an object literal, or null. */
function propByName(objectLiteral, name) {
  for (const prop of objectLiteral.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    const key = ts.isIdentifier(prop.name)
      ? prop.name.text
      : ts.isStringLiteral(prop.name)
        ? prop.name.text
        : null;
    if (key === name) return prop;
  }
  return null;
}

/**
 * The `subcommand([...], ...)` call declaring exactly `commandPath`.
 *
 * Searched recursively so nested `children` declarations are reachable without
 * modelling the nesting shape.
 */
function findSubcommandCall(node, commandPath) {
  let hit = null;
  const visit = current => {
    if (hit) return;
    if (
      ts.isCallExpression(current) &&
      ts.isIdentifier(current.expression) &&
      current.expression.text === "subcommand"
    ) {
      const first = current.arguments[0];
      if (first && ts.isArrayLiteralExpression(first)) {
        const parts = first.elements.map(el => (ts.isStringLiteral(el) ? el.text : null));
        if (
          parts.length === commandPath.length &&
          parts.every((part, i) => part === commandPath[i])
        ) {
          hit = current;
          return;
        }
      }
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return hit;
}

/** Indentation of the line containing `pos`. */
function indentAt(source, pos) {
  const lineStart = source.lastIndexOf("\n", pos - 1) + 1;
  const match = /^[ \t]*/.exec(source.slice(lineStart, pos));
  return match ? match[0] : "";
}

/** Start of the line containing `pos`. */
function lineStartAt(source, pos) {
  return source.lastIndexOf("\n", pos - 1) + 1;
}

/**
 * Insert flags into an existing array literal, keeping it sorted.
 *
 * Insertions are computed against the ORIGINAL offsets and applied in
 * descending position order, so earlier splices cannot invalidate later ones.
 */
function insertIntoArray(source, arrayLiteral, flags) {
  const existing = arrayLiteral.elements
    .filter(el => ts.isStringLiteral(el))
    .map(el => ({ text: el.text, start: el.getStart() }));
  const have = new Set(existing.map(e => e.text));
  const toAdd = [...new Set(flags)].filter(f => !have.has(f)).sort();
  if (toAdd.length === 0) return source;

  const closeBracket = arrayLiteral.getEnd() - 1;
  const indent = existing.length > 0 ? indentAt(source, existing[0].start) : "  ";

  const byPosition = new Map();
  for (const flag of toAdd) {
    const next = existing.find(e => e.text > flag);
    const pos = next ? lineStartAt(source, next.start) : lineStartAt(source, closeBracket);
    const list = byPosition.get(pos) ?? [];
    list.push(flag);
    byPosition.set(pos, list);
  }

  let next = source;
  for (const pos of [...byPosition.keys()].sort((a, b) => b - a)) {
    const text = byPosition
      .get(pos)
      .sort()
      .map(flag => `${indent}${JSON.stringify(flag)},\n`)
      .join("");
    next = next.slice(0, pos) + text + next.slice(pos);
  }
  return next;
}

/** Insert a new `acknowledgedUpstreamFlags` property into an object literal. */
function insertProperty(source, objectLiteral, flags) {
  const sorted = [...new Set(flags)].sort();
  const openBrace = objectLiteral.getStart();
  const inner = objectLiteral.properties.length > 0 ? objectLiteral.properties[0].getStart() : null;
  const indent = inner ? indentAt(source, inner) : `${indentAt(source, openBrace)}  `;
  const body = sorted.map(flag => `\n${indent}  ${JSON.stringify(flag)},`).join("");
  const text = `\n${indent}acknowledgedUpstreamFlags: [${body}\n${indent}],`;
  return source.slice(0, openBrace + 1) + text + source.slice(openBrace + 1);
}

/**
 * Append an options argument to a `subcommand(...)` call that has none.
 *
 * `flags` (the 4th parameter) defaults to `[]`, so a 3-argument call needs an
 * explicit `[]` inserted before the options object to keep the positions right.
 */
function appendOptionsArg(source, call, flags) {
  const sorted = [...new Set(flags)].sort();
  const lastArg = call.arguments[call.arguments.length - 1];
  const insertAt = lastArg.getEnd();
  const indent = indentAt(source, call.getStart());
  const body = sorted.map(flag => `\n${indent}    ${JSON.stringify(flag)},`).join("");
  const needsFlagsArg = call.arguments.length < 4;
  const prefix = needsFlagsArg ? ",\n" + indent + "  []" : "";
  const text = `${prefix},\n${indent}  {\n${indent}    acknowledgedUpstreamFlags: [${body}\n${indent}    ],\n${indent}  }`;
  return source.slice(0, insertAt) + text + source.slice(insertAt);
}

/**
 * Merge `flags` into the acknowledged list for a provider's root contract
 * (`commandPath === null`) or one of its subcommands.
 *
 * @returns `{ source, skipped }`. `skipped` is a reason string when the target
 *   could not be located, so one unmappable entry never aborts the others.
 */
export function rewriteAcknowledgedFlags(source, cli, commandPath, flags) {
  for (const flag of flags) {
    if (typeof flag !== "string" || flag.length === 0 || UNSAFE_IN_LITERAL.test(flag)) {
      throw new Error(`Refusing to write acknowledged flag ${JSON.stringify(flag)} for ${cli}`);
    }
  }

  const sourceFile = parseContracts(source);
  const contracts = findContractsObject(sourceFile);
  if (!contracts) throw new Error("UPSTREAM_CLI_CONTRACTS object literal not found");
  const entry = propByName(contracts, cli);
  if (!entry || !ts.isObjectLiteralExpression(entry.initializer)) {
    throw new Error(`No contract entry for ${cli}`);
  }

  let target = null;
  let call = null;
  if (commandPath === null) {
    target = entry.initializer;
  } else {
    call = findSubcommandCall(entry.initializer, commandPath);
    if (!call) {
      return { source, skipped: `${cli} ${commandPath.join(" ")} (no subcommand() declaration)` };
    }
    const options = call.arguments[4];
    if (options && ts.isObjectLiteralExpression(options)) target = options;
  }

  let next;
  if (target) {
    const prop = propByName(target, "acknowledgedUpstreamFlags");
    next =
      prop && ts.isArrayLiteralExpression(prop.initializer)
        ? insertIntoArray(source, prop.initializer, flags)
        : insertProperty(source, target, flags);
  } else {
    next = appendOptionsArg(source, call, flags);
  }

  if (next === source) return { source, skipped: null };

  // Round-trip guard: the result must still parse, and it must parse with no
  // new syntax diagnostics. A splice that produced invalid TypeScript would
  // otherwise only surface at build time, after the file was written.
  const reparsed = parseContracts(next);
  const before = parseContracts(source).parseDiagnostics?.length ?? 0;
  const after = reparsed.parseDiagnostics?.length ?? 0;
  if (after > before) {
    throw new Error(
      `Refusing to write acknowledged flags for ${cli}` +
        `${commandPath ? ` ${commandPath.join(" ")}` : ""}: the edit introduced ${after - before} ` +
        `parse error(s).`
    );
  }
  return { source: next, skipped: null };
}

// ---------------------------------------------------------------------------
// Removal rebaselining (a flag the installed binary stopped advertising).
//
// Deleting is harder than inserting for one reason: an entry owns explanatory
// text around it. A flag record in `flags` is routinely preceded by a comment
// block saying why its arity or value set is what it is, and deleting the
// record alone strands that comment describing something that no longer exists.
// So a deletion spans the whole entry, its own leading comments, its trailing
// comma and any same-line trailing comment.
//
// The one genuinely ambiguous case is a comment sitting between two entries:
// it may belong to either. It is attributed to the PREVIOUS entry when it
// begins on the same line that entry ends on, and to the following entry
// otherwise, which is how the file is actually written.
// ---------------------------------------------------------------------------

/** Zero-based line index of `pos`. */
function lineOf(source, pos) {
  let line = 0;
  for (let i = 0; i < pos && i < source.length; i++) if (source[i] === "\n") line++;
  return line;
}

/**
 * The text span to delete for `node`, including the comments it owns.
 *
 * @param previousEnd End offset of the preceding sibling, or null when first.
 */
function deletionSpan(source, node, previousEnd) {
  const prevLine = previousEnd === null ? -1 : lineOf(source, previousEnd);
  let start = node.getStart();
  for (const comment of ts.getLeadingCommentRanges(source, node.getFullStart()) ?? []) {
    // Same line as the previous entry's end: that comment annotates the entry
    // being kept, so deleting it would remove an explanation of live code.
    if (lineOf(source, comment.pos) <= prevLine) continue;
    start = comment.pos;
    break;
  }
  // Take the whole line when only indentation precedes the entry, so a deletion
  // never leaves a whitespace-only line behind.
  const lineStart = lineStartAt(source, start);
  if (/^[ \t]*$/.test(source.slice(lineStart, start))) start = lineStart;

  let end = node.getEnd();
  const hadTrailingComma = source[end] === ",";
  if (hadTrailingComma) end += 1;
  const trailing = ts.getTrailingCommentRanges(source, end) ?? [];
  if (trailing.length > 0) {
    end = trailing[trailing.length - 1].end;
  } else {
    // Separator spacing on a single-line array: `["--a", "--b"]` must collapse
    // to `["--b"]`, not `[ "--b"]`.
    while (source[end] === " " || source[end] === "\t") end += 1;
  }
  if (source[end] === "\r") end += 1;
  if (source[end] === "\n") end += 1;

  // The LAST element carries no trailing comma, so the separator that has to go
  // is the one BEFORE it. Without this, deleting the tail of an array leaves a
  // dangling `["--a", ]`, which parses but is not something anyone wrote.
  if (!hadTrailingComma && previousEnd !== null) {
    let i = start - 1;
    while (i >= 0 && /\s/.test(source[i])) i--;
    if (source[i] === ",") start = i;
  }
  return { start, end };
}

/**
 * Apply deletions computed against the ORIGINAL offsets.
 *
 * Descending order, so an earlier splice cannot shift a later one's offsets.
 */
function spliceOut(source, spans) {
  let next = source;
  for (const span of [...spans].sort((a, b) => b.start - a.start)) {
    next = next.slice(0, span.start) + next.slice(span.end);
  }
  return next;
}

/**
 * Root-level flag key sets per provider, for the disturbance guard.
 *
 * Cheaper and more direct than diffing text: it asserts the property that
 * matters (nothing but the named provider's flag set moved) rather than a
 * proxy for it.
 */
function rootFlagKeysByCli(source) {
  const contracts = findContractsObject(parseContracts(source));
  const out = {};
  if (!contracts) return out;
  for (const prop of contracts.properties) {
    if (!ts.isPropertyAssignment(prop) || !ts.isObjectLiteralExpression(prop.initializer)) continue;
    const cli = ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : null;
    if (!cli) continue;
    const flags = propByName(prop.initializer, "flags");
    out[cli] =
      flags && ts.isObjectLiteralExpression(flags.initializer)
        ? flags.initializer.properties
            .map(p =>
              ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))
                ? p.name.text
                : null
            )
            .filter(Boolean)
            .sort()
        : [];
  }
  return out;
}

/** Shared post-edit guard: the result must parse no worse than the input. */
function assertNoNewParseErrors(source, next, what, fileName = "upstream-contracts.ts") {
  const parse = text =>
    ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
      .parseDiagnostics?.length ?? 0;
  const before = parse(source);
  const after = parse(next);
  if (after > before) {
    throw new Error(
      `Refusing to write ${what}: the edit introduced ${after - before} parse error(s).`
    );
  }
}

/**
 * Delete flags the installed binary no longer advertises from a provider's
 * contract: the `flags` record at root level, or the flag-name array of a
 * `subcommand(...)` declaration.
 *
 * @returns `{ source, skipped, removed }`. `skipped` is a reason string when
 *   the target could not be located, so one unmappable entry never aborts the
 *   rest of the run.
 */
export function rewriteRemovedFlags(source, cli, commandPath, flags) {
  const sourceFile = parseContracts(source);
  const contracts = findContractsObject(sourceFile);
  if (!contracts) throw new Error("UPSTREAM_CLI_CONTRACTS object literal not found");
  const entry = propByName(contracts, cli);
  if (!entry || !ts.isObjectLiteralExpression(entry.initializer)) {
    throw new Error(`No contract entry for ${cli}`);
  }

  const wanted = new Set(flags);
  const spans = [];
  const removed = [];

  if (commandPath === null) {
    const flagsProp = propByName(entry.initializer, "flags");
    if (!flagsProp || !ts.isObjectLiteralExpression(flagsProp.initializer)) {
      return { source, skipped: `${cli} (no literal flags record)`, removed: [] };
    }
    const properties = flagsProp.initializer.properties;
    for (let i = 0; i < properties.length; i++) {
      const prop = properties[i];
      if (!ts.isPropertyAssignment(prop)) continue;
      const key =
        ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : null;
      if (!key || !wanted.has(key)) continue;
      // Unreachable via the classifier, because `computeFlagDrift` skips
      // hiddenFromHelp flags entirely. Reaching it means the classifier and this
      // writer disagree about what the contract says, and guessing which one is
      // right is exactly how a real, working flag gets deleted.
      if (
        ts.isObjectLiteralExpression(prop.initializer) &&
        propByName(prop.initializer, "hiddenFromHelp")
      ) {
        throw new Error(
          `Refusing to remove ${key} from ${cli}: it is marked hiddenFromHelp, so its ` +
            `absence from help output is expected and is not evidence of removal.`
        );
      }
      spans.push(deletionSpan(source, prop, i > 0 ? properties[i - 1].getEnd() : null));
      removed.push(key);
    }
  } else {
    const call = findSubcommandCall(entry.initializer, commandPath);
    if (!call) {
      return {
        source,
        skipped: `${cli} ${commandPath.join(" ")} (no subcommand() declaration)`,
        removed: [],
      };
    }
    const flagsArg = call.arguments[3];
    if (!flagsArg || !ts.isArrayLiteralExpression(flagsArg)) {
      return {
        source,
        skipped: `${cli} ${commandPath.join(" ")} (no literal flag array)`,
        removed: [],
      };
    }
    const elements = flagsArg.elements;
    for (let i = 0; i < elements.length; i++) {
      const el = elements[i];
      if (!ts.isStringLiteral(el) || !wanted.has(el.text)) continue;
      spans.push(deletionSpan(source, el, i > 0 ? elements[i - 1].getEnd() : null));
      removed.push(el.text);
    }
  }

  if (spans.length === 0) return { source, skipped: null, removed: [] };

  const next = spliceOut(source, spans);
  const where = commandPath ? ` ${commandPath.join(" ")}` : "";
  assertNoNewParseErrors(source, next, `flag removal for ${cli}${where}`);

  const before = rootFlagKeysByCli(source);
  const after = rootFlagKeysByCli(next);
  for (const key of Object.keys(before)) {
    const expected =
      key === cli && commandPath === null ? before[key].filter(f => !wanted.has(f)) : before[key];
    if (JSON.stringify(after[key]) !== JSON.stringify(expected)) {
      throw new Error(
        `Refusing to remove flags for ${cli}${where}: the edit also changed ${key}'s flag set.`
      );
    }
  }

  return { source: next, skipped: null, removed: removed.sort() };
}

/**
 * Delete entries from `acknowledgedUpstreamFlags` that the installed binary no
 * longer advertises.
 *
 * Always safe to write: the list is probe-quieting only and is never consulted
 * as an emit allowlist, which is the same property that let the additive writer
 * add to it mechanically.
 */
export function rewriteRemovedAcknowledgedFlags(source, cli, commandPath, flags) {
  const contracts = findContractsObject(parseContracts(source));
  if (!contracts) throw new Error("UPSTREAM_CLI_CONTRACTS object literal not found");
  const entry = propByName(contracts, cli);
  if (!entry || !ts.isObjectLiteralExpression(entry.initializer)) {
    throw new Error(`No contract entry for ${cli}`);
  }

  let target = null;
  if (commandPath === null) {
    target = entry.initializer;
  } else {
    const call = findSubcommandCall(entry.initializer, commandPath);
    const options = call?.arguments[4];
    if (options && ts.isObjectLiteralExpression(options)) target = options;
  }
  if (!target) {
    const where = commandPath ? ` ${commandPath.join(" ")}` : "";
    return { source, skipped: `${cli}${where} (no acknowledged list)`, removed: [] };
  }

  const prop = propByName(target, "acknowledgedUpstreamFlags");
  if (!prop || !ts.isArrayLiteralExpression(prop.initializer)) {
    return { source, skipped: null, removed: [] };
  }

  const wanted = new Set(flags);
  const elements = prop.initializer.elements;
  const spans = [];
  const removed = [];
  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    if (!ts.isStringLiteral(el) || !wanted.has(el.text)) continue;
    spans.push(deletionSpan(source, el, i > 0 ? elements[i - 1].getEnd() : null));
    removed.push(el.text);
  }
  if (spans.length === 0) return { source, skipped: null, removed: [] };

  const next = spliceOut(source, spans);
  assertNoNewParseErrors(source, next, `acknowledged-flag removal for ${cli}`);
  return { source: next, skipped: null, removed: removed.sort() };
}

/**
 * Delete a removed flag from the contract-DERIVED generation tables in
 * `src/provider-codegen.ts`.
 *
 * This is the edit that makes the contract half safe to apply on its own run.
 * `deriveGrokArgs` and the schema derivation throw at call time when a
 * generation entry names a flag absent from the contract
 * (src/provider-codegen.ts:92, :170), so a contract-only removal leaves the
 * tree in exactly the half-applied state the old three-file manual recipe was
 * warning about. Both halves land in the same run instead.
 *
 * Table names are derived from the provider (`GROK_FLAG_GENERATION`,
 * `UNGENERATED_GROK_FLAGS`); a provider with no such tables is a no-op, which
 * is every provider but grok today.
 */
export function rewriteRemovedCodegenFlags(source, cli, flags) {
  const upper = cli.toUpperCase();
  const wanted = new Set(flags);
  const sourceFile = ts.createSourceFile(
    "provider-codegen.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );

  /** The array literal initialising a top-level `const <name>`. */
  const arrayNamed = name => {
    for (const stmt of sourceFile.statements) {
      if (!ts.isVariableStatement(stmt)) continue;
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || decl.name.text !== name) continue;
        let init = decl.initializer;
        while (
          init &&
          (ts.isAsExpression(init) ||
            ts.isSatisfiesExpression(init) ||
            ts.isParenthesizedExpression(init))
        ) {
          init = init.expression;
        }
        if (init && ts.isArrayLiteralExpression(init)) return init;
      }
    }
    return null;
  };

  /**
   * The named array plus every array it spreads in, flattened.
   *
   * `GROK_FLAG_GENERATION` is `[...GROK_GEN_OUTPUT_FORMAT, ...GROK_GEN_MAIN,
   * ...]`, so its own elements are SpreadElements and none of them is a flag
   * record. Scanning only the named array found the declaration, matched
   * nothing, and reported success: a silent no-op that would have left every
   * real removal half-applied.
   */
  const arraysUnder = (name, seen = new Set()) => {
    if (seen.has(name)) return [];
    seen.add(name);
    const arr = arrayNamed(name);
    if (!arr) return [];
    const found = [{ name, arr }];
    for (const el of arr.elements) {
      if (ts.isSpreadElement(el) && ts.isIdentifier(el.expression)) {
        found.push(...arraysUnder(el.expression.text, seen));
      }
    }
    return found;
  };

  const spans = [];
  const removed = [];

  for (const { name, arr } of arraysUnder(`${upper}_FLAG_GENERATION`)) {
    for (let i = 0; i < arr.elements.length; i++) {
      const el = arr.elements[i];
      if (!ts.isObjectLiteralExpression(el)) continue;
      const flagProp = propByName(el, "flag");
      const value =
        flagProp && ts.isStringLiteral(flagProp.initializer) ? flagProp.initializer.text : null;
      if (!value || !wanted.has(value)) continue;
      spans.push(deletionSpan(source, el, i > 0 ? arr.elements[i - 1].getEnd() : null));
      removed.push(`${name} ${value}`);
    }
  }

  for (const { name, arr } of arraysUnder(`UNGENERATED_${upper}_FLAGS`)) {
    for (let i = 0; i < arr.elements.length; i++) {
      const el = arr.elements[i];
      if (!ts.isStringLiteral(el) || !wanted.has(el.text)) continue;
      spans.push(deletionSpan(source, el, i > 0 ? arr.elements[i - 1].getEnd() : null));
      removed.push(`${name} ${el.text}`);
    }
  }

  if (spans.length === 0) return { source, removed: [] };
  const next = spliceOut(source, spans);
  assertNoNewParseErrors(source, next, `codegen removal for ${cli}`, "provider-codegen.ts");
  return { source: next, removed: removed.sort() };
}

// ---------------------------------------------------------------------------
// Residual-emission reporting.
//
// Removing a flag from the contract does not stop `src/index.ts` emitting it,
// and that plumbing is not derivable from the flag string: the devin
// `--agent-config` removal touched 22 references, none of which spell the flag.
// So this REPORTS rather than rewrites. A text match cannot tell a grok
// `--model` reference from a claude one, which makes it a located pointer for
// the follow-up edit, not an authority to delete.
//
// The suite is the other half of this: handler tests assert
// `validateUpstreamCliArgs(cli, preparedArgs).ok`, so a handler still emitting
// a dropped flag fails by name once the contract no longer declares it.
// ---------------------------------------------------------------------------

/** Source files that may still emit a removed flag. */
function emittingSourceFiles() {
  const src = join(REPO, "src");
  return readdirSync(src, { recursive: true, withFileTypes: true })
    .filter(e => e.isFile() && e.name.endsWith(".ts"))
    .map(e => join(e.parentPath ?? e.path, e.name))
    .filter(p => !p.includes(`${sep}__tests__${sep}`))
    .filter(p => p !== CONTRACTS && p !== join(src, "provider-codegen.ts"));
}

/**
 * Match a flag as a whole token, so removing `--model` does not report every
 * `--model-name` and `--dry-run` does not match `--dry-run-only`.
 */
export function flagTokenPattern(flag) {
  return new RegExp(`${flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`);
}

/**
 * Occurrences of each removed flag still present in the tree, as file:line.
 *
 * @param files Paths to read, or `{ file, text }` pairs for offline callers.
 */
export function findResidualReferences(flags, files = emittingSourceFiles()) {
  const hits = [];
  for (const flag of flags) {
    const pattern = flagTokenPattern(flag);
    for (const entry of files) {
      let file = entry;
      let text = entry?.text;
      if (typeof entry === "string") {
        file = entry;
        try {
          text = readFileSync(entry, "utf8");
        } catch {
          continue;
        }
      } else {
        file = entry.file;
      }
      if (!text?.includes(flag)) continue;
      text.split("\n").forEach((line, i) => {
        if (pattern.test(line)) {
          hits.push({ flag, file: relative(REPO, file), line: i + 1, text: line.trim() });
        }
      });
    }
  }
  return hits;
}

/** A property key that needs quoting in an object literal. */
function objectKey(name) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}

/**
 * Declare root commands the installed binary advertises but the contract does
 * not know about.
 *
 * This is cataloguing, not adoption. The gateway is wiring up access to a
 * capability the provider binary owns; it does not manage or interpret what the
 * command does. `cursor bedrock` configuring AWS credentials, for example, is
 * entirely the cursor binary's business, and the contract only needs to record
 * that the command exists so drift detection stays honest.
 *
 * Two deliberate defaults keep auto-declaration conservative:
 *   - `exposure` is left unset, so `subcommand()` applies its own
 *     `tracked_only` default: catalogued, NOT projected into the provider admin
 *     tools and NOT reachable by callers.
 *   - `risk` is descriptive metadata only for a `tracked_only` entry (it feeds
 *     admin prompts and report filters, and `exposure` is what actually gates
 *     reachability), so it takes a conservative "assume it writes" default and
 *     is marked unverified in a comment for a maintainer to refine.
 */
export function rewriteNewRootCommands(source, cli, commands) {
  const wanted = [...new Set(commands)].filter(c => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(c)).sort();
  if (wanted.length === 0) return { source, skipped: null };

  const sourceFile = parseContracts(source);
  const contracts = findContractsObject(sourceFile);
  if (!contracts) throw new Error("UPSTREAM_CLI_CONTRACTS object literal not found");
  const entry = propByName(contracts, cli);
  if (!entry || !ts.isObjectLiteralExpression(entry.initializer)) {
    throw new Error(`No contract entry for ${cli}`);
  }
  const subsProp = propByName(entry.initializer, "subcommands");
  if (!subsProp) return { source, skipped: `${cli} (no subcommands property)` };

  // `subcommands` is usually a bare object literal, but grok wraps its tree in
  // `acknowledgeSubcommandFlags({ ... }, GROK_DEBUG_HELP_FLAGS)` to apply a
  // shared acknowledgement across every entry. Unwrap that call and edit its
  // first argument, so a provider using the helper is not silently skipped.
  let objectLiteral = null;
  if (ts.isObjectLiteralExpression(subsProp.initializer)) {
    objectLiteral = subsProp.initializer;
  } else if (ts.isCallExpression(subsProp.initializer)) {
    const first = subsProp.initializer.arguments[0];
    if (first && ts.isObjectLiteralExpression(first)) objectLiteral = first;
  }
  if (!objectLiteral) {
    return { source, skipped: `${cli} (subcommands is not an editable object literal)` };
  }
  const already = new Set(
    objectLiteral.properties
      .filter(p => ts.isPropertyAssignment(p))
      .map(p =>
        ts.isIdentifier(p.name) ? p.name.text : ts.isStringLiteral(p.name) ? p.name.text : ""
      )
  );
  const toAdd = wanted.filter(c => !already.has(c));
  if (toAdd.length === 0) return { source, skipped: null };

  const first = objectLiteral.properties[0];
  const indent = first
    ? indentAt(source, first.getStart())
    : `${indentAt(source, objectLiteral.getStart())}  `;
  const block = toAdd
    .map(
      name =>
        `\n${indent}// Auto-declared by \`npm run providers:rebaseline\`: upstream advertises\n` +
        `${indent}// this command. Catalogued only (exposure defaults to tracked_only, so it\n` +
        `${indent}// is not reachable by callers); risk is a conservative default pending\n` +
        `${indent}// maintainer verification.\n` +
        `${indent}${objectKey(name)}: subcommand(\n` +
        `${indent}  [${JSON.stringify(name)}],\n` +
        `${indent}  "Upstream-declared ${cli} command (auto-catalogued, unverified).",\n` +
        `${indent}  "writes_local_config"\n` +
        `${indent}),`
    )
    .join("");

  const openBrace = objectLiteral.getStart();
  const next = source.slice(0, openBrace + 1) + block + source.slice(openBrace + 1);

  const before = parseContracts(source).parseDiagnostics?.length ?? 0;
  const after = parseContracts(next).parseDiagnostics?.length ?? 0;
  if (after > before) {
    throw new Error(
      `Refusing to declare root command(s) ${toAdd.join(", ")} for ${cli}: the edit ` +
        `introduced ${after - before} parse error(s).`
    );
  }
  return { source: next, skipped: null, declared: toAdd };
}

/** The PROVIDER_DEFINITIONS object literal in provider-definitions.ts. */
function findDefinitionsObject(sourceFile) {
  for (const stmt of sourceFile.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || decl.name.text !== "PROVIDER_DEFINITIONS") continue;
      let init = decl.initializer;
      while (
        init &&
        (ts.isAsExpression(init) ||
          ts.isSatisfiesExpression(init) ||
          ts.isParenthesizedExpression(init))
      ) {
        init = init.expression;
      }
      if (init && ts.isObjectLiteralExpression(init)) return init;
    }
  }
  return null;
}

/**
 * Declare admin families so a newly discovered provider command becomes
 * REACHABLE, not merely catalogued.
 *
 * The two registries are distinct and both are needed:
 *   - `upstream-contracts.ts` `subcommands` records that the command exists, so
 *     drift detection stays honest. That alone exposes nothing.
 *   - `provider-definitions.ts` `adminSubcommands` is what the admin projection
 *     actually reads (`projectProviderAdminOperations` walks `def.adminSubcommands`),
 *     so it is what makes the command invokable.
 *
 * They compose: `familyBaseRisk` prefers the CONTRACT's risk when the command is
 * declared there and falls back to the family's coarse `safety` otherwise. The
 * single provider-agnostic policy then maps that risk to an exposure, so a
 * mutating command lands on `mcp_requires_approval` (reachable, approval-gated,
 * argv passed straight through to the provider binary) without anyone
 * hand-picking an exposure.
 *
 * `safety` defaults to `mutating-gated` because an unclassified new command
 * should be gated rather than silently read-only; the contract risk refines it.
 * `kind` is omitted so it takes the `cli-subcommand` default, which is correct
 * for a real invokable subcommand and is exactly what the probe discovered.
 */
export function rewriteAdminSubcommands(source, cli, families) {
  if (families.length === 0) return { source, skipped: null };

  const sourceFile = ts.createSourceFile(
    "provider-definitions.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const definitions = findDefinitionsObject(sourceFile);
  if (!definitions) throw new Error("PROVIDER_DEFINITIONS object literal not found");
  const entry = propByName(definitions, cli);
  if (!entry || !ts.isObjectLiteralExpression(entry.initializer)) {
    throw new Error(`No provider definition for ${cli}`);
  }
  const adminProp = propByName(entry.initializer, "adminSubcommands");
  if (!adminProp || !ts.isArrayLiteralExpression(adminProp.initializer)) {
    return { source, skipped: `${cli} (no adminSubcommands array)` };
  }

  const arrayLiteral = adminProp.initializer;
  const already = new Set();
  for (const el of arrayLiteral.elements) {
    if (!ts.isObjectLiteralExpression(el)) continue;
    const fam = propByName(el, "family");
    if (fam && ts.isStringLiteral(fam.initializer)) already.add(fam.initializer.text);
  }
  const toAdd = families.filter(f => !already.has(f.family));
  if (toAdd.length === 0) return { source, skipped: null };

  const firstEl = arrayLiteral.elements[0];
  const indent = firstEl
    ? indentAt(source, firstEl.getStart())
    : `${indentAt(source, arrayLiteral.getStart())}  `;
  const block = toAdd
    .map(
      f =>
        `\n${indent}{\n` +
        `${indent}  family: ${JSON.stringify(f.family)},\n` +
        `${indent}  safety: ${JSON.stringify(f.safety)},\n` +
        `${indent}  evidence: ${JSON.stringify(f.evidence)},\n` +
        `${indent}},`
    )
    .join("");

  const openBracket = arrayLiteral.getStart();
  const next = source.slice(0, openBracket + 1) + block + source.slice(openBracket + 1);

  const before = sourceFile.parseDiagnostics?.length ?? 0;
  const after =
    ts.createSourceFile(
      "provider-definitions.ts",
      next,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    ).parseDiagnostics?.length ?? 0;
  if (after > before) {
    throw new Error(
      `Refusing to declare admin families ${toAdd.map(f => f.family).join(", ")} for ${cli}: ` +
        `the edit introduced ${after - before} parse error(s).`
    );
  }
  return { source: next, skipped: null, declared: toAdd.map(f => f.family) };
}

/**
 * Classify probe results into what can be auto-applied and what cannot.
 *
 * @param probes Per-provider installed probe results.
 * @param versionVerdicts Per-provider version comparison verdicts.
 * @param contracts Optional `UPSTREAM_CLI_CONTRACTS`, needed only to classify
 *   stale acknowledgements. Omitted, `acknowledgedRemovals` is empty.
 * @returns Classified actions.
 */
export function classifyRebaseline(probes, versionVerdicts, contracts = null) {
  const versionUpdates = [];
  const additive = [];
  const removals = [];
  // A vanished `acknowledgedUpstreamFlags` entry is reported by
  // `computeFlagDrift` as a warning STRING rather than as drift, so it never
  // reached this classifier and the stale acknowledgement lingered. Recompute
  // it from the probe's own `discoveredFlags` instead of parsing that warning
  // text: the fact is already in the data, and a message format is not an API.
  const acknowledgedRemovals = [];

  for (const verdict of versionVerdicts) {
    if (verdict.state === "drift" && verdict.installed) {
      versionUpdates.push({
        cli: verdict.cli,
        from: verdict.target,
        to: verdict.installed,
      });
    }
  }

  for (const probe of probes) {
    if (!probe || !probe.available) continue;
    const extra = (probe.extraFlags ?? []).filter(f => f.startsWith("--"));
    if (extra.length > 0) {
      additive.push({ cli: probe.cli, commandPath: null, flags: [...extra].sort() });
    }
    const missing = probe.missingFlags ?? [];
    if (missing.length > 0) removals.push({ cli: probe.cli, flags: [...missing].sort() });

    const entry = contracts?.[probe.cli] ?? null;
    const staleRoot = staleAcknowledged(entry?.acknowledgedUpstreamFlags, probe.discoveredFlags);
    if (staleRoot.length > 0) {
      acknowledgedRemovals.push({ cli: probe.cli, commandPath: null, flags: staleRoot });
    }

    // Subcommand-level drift is the same class of fact as root level, so it is
    // equally safe to acknowledge. It was previously neither classified nor
    // written, which left findings the tool was capable of clearing.
    for (const sub of Object.values(probe.subcommands ?? {})) {
      if (!sub || sub.available === false) continue;
      const subExtra = (sub.extraFlags ?? []).filter(f => f.startsWith("--"));
      if (subExtra.length > 0) {
        additive.push({
          cli: probe.cli,
          commandPath: [...(sub.commandPath ?? [])],
          flags: [...subExtra].sort(),
        });
      }
      const subMissing = sub.missingFlags ?? [];
      if (subMissing.length > 0) {
        removals.push({
          cli: probe.cli,
          commandPath: [...(sub.commandPath ?? [])],
          flags: [...subMissing].sort(),
        });
      }

      const declared = entry?.subcommands?.[(sub.commandPath ?? []).join(" ")] ?? null;
      const staleSub = staleAcknowledged(declared?.acknowledgedUpstreamFlags, sub.discoveredFlags);
      if (staleSub.length > 0) {
        acknowledgedRemovals.push({
          cli: probe.cli,
          commandPath: [...(sub.commandPath ?? [])],
          flags: staleSub,
        });
      }
    }
  }

  return { versionUpdates, additive, removals, acknowledgedRemovals };
}

/** Acknowledged flags the installed binary's help no longer advertises. */
function staleAcknowledged(acknowledged, discoveredFlags) {
  if (!acknowledged?.length || !discoveredFlags) return [];
  const discovered = new Set(discoveredFlags);
  return [...acknowledged].filter(flag => !discovered.has(flag)).sort();
}

async function main() {
  const { buildUpstreamContractReport, UPSTREAM_CLI_CONTRACTS, flattenCliSubcommands } =
    await import(join(REPO, "dist", "upstream-contracts.js"));
  // The shipped normalizer, reused rather than reimplemented, so the rebaseliner
  // and the version guard can never disagree about what a version string means.
  const contractsModule = await import(join(REPO, "dist", "provider-version-guard.js"));
  const { compareInstalledToTargets } = contractsModule;
  const { getCliVersions } = await import(join(REPO, "dist", "cli-updater.js"));

  const versions = await getCliVersions();
  const installed = {};
  for (const info of versions) installed[info.cli] = info.installed ? (info.version ?? null) : null;

  const verdicts = compareInstalledToTargets(installed);
  const report = buildUpstreamContractReport({ probeInstalled: true });
  const probes = Object.values(report.installedProbe ?? {}).filter(p => p && p.cli);

  // Only the acknowledged lists are needed, flattened to the same
  // space-joined command path the probe reports, so the classifier stays a pure
  // function over plain data and remains testable offline.
  const contractView = Object.fromEntries(
    Object.entries(UPSTREAM_CLI_CONTRACTS).map(([cli, contract]) => [
      cli,
      {
        acknowledgedUpstreamFlags: contract.acknowledgedUpstreamFlags ?? [],
        subcommands: Object.fromEntries(
          flattenCliSubcommands(contract.subcommands).map(sub => [
            sub.commandPath.join(" "),
            { acknowledgedUpstreamFlags: sub.acknowledgedUpstreamFlags ?? [] },
          ])
        ),
      },
    ])
  );

  const plan = classifyRebaseline(probes, verdicts, contractView);

  const applied = [];
  if (APPLY && plan.versionUpdates.length > 0) {
    let source = readFileSync(DEFINITIONS, "utf8");
    const currentTargets = parseTargetVersions(source).versions;
    for (const update of plan.versionUpdates) {
      const spelled = preserveTargetSpelling(
        currentTargets[update.cli] ?? update.from,
        update.to,
        contractsModule.normalizeProviderVersion
      );
      source = rewriteTargetVersion(source, update.cli, spelled);
      applied.push(`PROVIDER_TARGET_VERSIONS.${update.cli}: ${update.from} -> ${spelled}`);
    }
    writeFileSync(DEFINITIONS, source);
    console.error(
      "\nNOTE: version targets moved. src/__tests__/provider-version-guard.test.ts " +
        "pins REAL_INSTALLED to the exact strings this host reported, and is " +
        "deliberately NOT derived from PROVIDER_TARGET_VERSIONS (that would make its " +
        "match assertions tautological). Refresh that fixture in the same change, or " +
        "its suite fails with every provider reported as drifted."
    );
  }

  // Root-command discovery lives in the scanner's own probe (the dist report
  // does not carry it), so reuse that exported function rather than
  // reimplementing the help parsing and letting the two drift apart.
  const newRootCommands = [];
  const unreachableCommands = [];
  try {
    const [contractsMod, executorMod, defsMod] = await Promise.all([
      import(join(REPO, "dist", "upstream-contracts.js")),
      import(join(REPO, "dist", "executor.js")),
      import(join(REPO, "dist", "provider-definitions.js")),
    ]);
    const machinery = { ...contractsMod, ...executorMod, ...defsMod };
    const { probeInstalledCliSurface } = await import("./upstream-scan.mjs");
    for (const probe of probes) {
      const surface = probeInstalledCliSurface(machinery, probe.cli);

      // Cataloguing gap: commands the contract does not declare at all.
      const added = surface?.rootCatalogDrift?.added ?? [];
      if (added.length > 0) newRootCommands.push({ cli: probe.cli, commands: [...added].sort() });

      // Intent gate. A probe reads capability, not intent, so a provider whose
      // command surface is a deliberate decision declares that in its
      // definition rather than leaving the tool to infer it.
      const mode = defsMod.PROVIDER_DEFINITIONS_BY_ID?.[probe.cli]?.autoDeclare ?? "reachable";
      if (mode === "off") continue;

      // Reachability follows the NEWLY DISCOVERED set, deliberately NOT every
      // command that lacks an admin family. Comparing all discovered commands
      // against adminSubcommands retroactively wires surfaces a maintainer
      // chose to leave unwired: it declared 46 families across seven providers
      // when only four commands were actually new.
      //
      // The cross-run order dependence this trades against is real but minor:
      // once catalogued, a command leaves the discovery set, so a run that
      // catalogues and then fails before wiring leaves it catalogued-but-
      // unreachable. That state is visible in the drift report and fixable by
      // hand, which is a far better failure than mass over-declaration.
      if (mode === "reachable" && added.length > 0) {
        unreachableCommands.push({ cli: probe.cli, commands: [...added].sort() });
      }
    }
  } catch (err) {
    console.error(
      `root-command discovery unavailable (${err instanceof Error ? err.message : String(err)})`
    );
  }

  const skippedAdminFamilies = [];
  const declaredRootCommands = [];
  if (APPLY && DECLARE_NEW && newRootCommands.length > 0) {
    // 1. Catalogue in the contract, so drift detection knows the command.
    let contractSource = readFileSync(CONTRACTS, "utf8");
    for (const item of newRootCommands) {
      const outcome = rewriteNewRootCommands(contractSource, item.cli, item.commands);
      contractSource = outcome.source;
      if (outcome.declared?.length) {
        declaredRootCommands.push(`${item.cli}: catalogued ${outcome.declared.join(" ")}`);
        applied.push(`${item.cli}: catalogued root command(s) ${outcome.declared.join(" ")}`);
      }
    }
    writeFileSync(CONTRACTS, contractSource);
  }

  // 2. Declare admin families, so discovered commands become REACHABLE rather
  //    than only catalogued. Cataloguing alone silences drift and exposes
  //    nothing. Driven by the reachability gap, so it is idempotent and does
  //    not depend on step 1 having run in the same invocation.
  if (APPLY && DECLARE_NEW && unreachableCommands.length > 0) {
    let defsSource = readFileSync(DEFINITIONS, "utf8");
    for (const item of unreachableCommands) {
      const version = installed[item.cli] ?? "installed binary";
      const families = item.commands.map(command => ({
        family: command,
        safety: "mutating-gated",
        evidence:
          `${version} root help advertises \`${command}\`. Auto-declared by ` +
          `\`npm run providers:rebaseline\`. safety is the conservative default: a ` +
          `read-only misclassification would remove a control, a gated one only ` +
          `adds an approval, so generated families are never \`read-only\`. ` +
          `UNVERIFIED pending maintainer review.`,
      }));
      const outcome = rewriteAdminSubcommands(defsSource, item.cli, families);
      defsSource = outcome.source;
      if (outcome.skipped) {
        skippedAdminFamilies.push(outcome.skipped);
        continue;
      }
      if (outcome.declared?.length) {
        applied.push(`${item.cli}: admin family reachable ${outcome.declared.join(" ")}`);
      }
    }
    writeFileSync(DEFINITIONS, defsSource);
  }

  const skippedAcknowledgements = [];
  if (APPLY && plan.additive.length > 0) {
    let source = readFileSync(CONTRACTS, "utf8");
    for (const add of plan.additive) {
      const before = source;
      const outcome = rewriteAcknowledgedFlags(source, add.cli, add.commandPath ?? null, add.flags);
      source = outcome.source;
      if (outcome.skipped) {
        skippedAcknowledgements.push(`${outcome.skipped}: ${add.flags.join(" ")}`);
        continue;
      }
      if (source !== before) {
        const where = add.commandPath?.length ? ` ${add.commandPath.join(" ")}` : "";
        applied.push(`${add.cli}${where}: acknowledged ${add.flags.join(" ")}`);
      }
    }
    writeFileSync(CONTRACTS, source);
  }

  // Removals: the contract and its derived generation tables are edited in the
  // SAME run, because the codegen tables throw at call time on a flag the
  // contract no longer declares. Applying one without the other is the only
  // genuinely broken intermediate state, so it is never written.
  const skippedRemovals = [];
  if (APPLY && (plan.removals.length > 0 || plan.acknowledgedRemovals.length > 0)) {
    let source = readFileSync(CONTRACTS, "utf8");
    for (const removal of plan.removals) {
      const outcome = rewriteRemovedFlags(
        source,
        removal.cli,
        removal.commandPath ?? null,
        removal.flags
      );
      source = outcome.source;
      if (outcome.skipped) {
        skippedRemovals.push(`${outcome.skipped}: ${removal.flags.join(" ")}`);
        continue;
      }
      if (outcome.removed.length > 0) {
        const where = removal.commandPath?.length ? ` ${removal.commandPath.join(" ")}` : "";
        applied.push(`${removal.cli}${where}: dropped ${outcome.removed.join(" ")}`);
      }
    }
    for (const removal of plan.acknowledgedRemovals) {
      const outcome = rewriteRemovedAcknowledgedFlags(
        source,
        removal.cli,
        removal.commandPath ?? null,
        removal.flags
      );
      source = outcome.source;
      if (outcome.removed.length > 0) {
        const where = removal.commandPath?.length ? ` ${removal.commandPath.join(" ")}` : "";
        applied.push(
          `${removal.cli}${where}: dropped stale acknowledgement ${outcome.removed.join(" ")}`
        );
      }
    }
    writeFileSync(CONTRACTS, source);

    let codegen = readFileSync(CODEGEN, "utf8");
    for (const removal of plan.removals) {
      const outcome = rewriteRemovedCodegenFlags(codegen, removal.cli, removal.flags);
      codegen = outcome.source;
      for (const entry of outcome.removed) applied.push(`${removal.cli}: dropped ${entry}`);
    }
    writeFileSync(CODEGEN, codegen);
  }

  // Reported after the writes, so it describes what actually survives rather
  // than what was there before the contract was corrected.
  const residualReferences =
    plan.removals.length > 0
      ? findResidualReferences([...new Set(plan.removals.flatMap(r => r.flags))])
      : [];

  const result = {
    generatedAt: new Date().toISOString(),
    applied: APPLY,
    versionUpdates: plan.versionUpdates,
    additiveFlagDrift: plan.additive,
    removedFlagDrift: plan.removals,
    staleAcknowledgements: plan.acknowledgedRemovals,
    changesWritten: applied,
    skippedRemovals,
    residualReferences,
  };

  if (AS_JSON) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    if (
      plan.versionUpdates.length === 0 &&
      plan.additive.length === 0 &&
      plan.removals.length === 0 &&
      plan.acknowledgedRemovals.length === 0
    ) {
      console.log("No provider contract drift: installed CLIs match their contracts.");
    }
    for (const u of plan.versionUpdates) {
      console.log(`${APPLY ? "rebaselined" : "would rebaseline"} ${u.cli}: ${u.from} -> ${u.to}`);
    }
    for (const a of plan.additive) {
      console.log(
        `${a.cli}: installed binary advertises ${a.flags.length} flag(s) the contract does not know: ${a.flags.join(" ")}`
      );
    }
    for (const r of plan.removals) {
      const where = r.commandPath?.length ? ` ${r.commandPath.join(" ")}` : "";
      console.log(
        `${r.cli}${where}: installed binary NO LONGER advertises ${r.flags.join(" ")}; ` +
          `${APPLY ? "dropped from" : "would drop from"} the contract`
      );
    }
    for (const r of plan.acknowledgedRemovals) {
      const where = r.commandPath?.length ? ` ${r.commandPath.join(" ")}` : "";
      console.log(
        `${r.cli}${where}: stale acknowledgement ${r.flags.join(" ")}; ` +
          `${APPLY ? "dropped" : "would drop"}`
      );
    }
    for (const s of skippedRemovals) {
      console.error(`skipped removal, target not located: ${s}`);
    }
    if (residualReferences.length > 0) {
      console.error(
        "\nThe gateway still references flag(s) the installed binary dropped. The contract is" +
          "\ncorrect now; these emission sites are not, and each one produces a request the" +
          "\nprovider rejects at argument parsing:"
      );
      for (const hit of residualReferences) {
        console.error(`  ${hit.file}:${hit.line}  ${hit.flag}  ${hit.text}`);
      }
      console.error(
        "\nNot auto-edited: a flag string does not determine which parameter names, Zod fields" +
          "\nand pass-throughs feed it, and a text match cannot tell one provider's --model from" +
          "\nanother's. Handler tests asserting validateUpstreamCliArgs(...).ok will now name the" +
          "\nsame sites."
      );
    }
  }

  // Exit codes are the scheduled job's whole signal, so they distinguish the
  // three outcomes that need different responses:
  //   0  clean
  //   2  drift found that this tool rebaselined (or can, in report mode)
  //   3  the gateway still references a flag the installed binary dropped
  // Treating version drift as clean, which an earlier version did, makes a
  // timer silently report success while the contract is stale.
  //
  // 3 no longer means "a human must judge an upstream change". Upstream's
  // deprecation cycle is not ours to manage, so it is applied, not deliberated.
  // It now means our own tree is internally inconsistent, which is a defect
  // report about code we own.
  if (residualReferences.length > 0) process.exit(3);
  const rebaselinable =
    plan.versionUpdates.length > 0 ||
    plan.additive.length > 0 ||
    plan.removals.length > 0 ||
    plan.acknowledgedRemovals.length > 0;
  process.exit(rebaselinable ? 2 : 0);
}

/**
 * True when this module is the process entry point.
 *
 * Canonicalizes both sides with realpathSync rather than comparing a
 * `file://` string against import.meta.url. That naive form has already
 * produced two fail-open bugs in this repo (see scripts/check-consumer-tree.mjs):
 * it misses on any URL-escaped character such as a space, and again whenever
 * the path is reached through a symlink, because node canonicalizes
 * import.meta.url while a hand-built URL does not.
 */
function isDirectInvocation(metaUrl, argv1) {
  if (!argv1) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(argv1);
  } catch {
    return false;
  }
}

if (isDirectInvocation(import.meta.url, process.argv[1])) {
  main().catch(err => {
    console.error(`rebaseline failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
