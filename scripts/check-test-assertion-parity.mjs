#!/usr/bin/env node
/**
 * s5 of docs/plans/storage-unification.dag.toml: the amended constraint.
 *
 * "npm run test:pg passes unchanged" could not survive making JobStore async,
 * because an async surface delivers failure as a rejection and
 * drivers/sqlite.ts:24 forbids the alternative. The replacement is this: same
 * tests, same matchers, same errors, no assertion weakened, across EVERY
 * reached test file rather than the five *-pg ones.
 *
 * It is an ALLOWLIST and it DEFAULTS TO FAIL. Only three rewrites are legal:
 *
 *   1. `expect(() => X).toThrow(E)` -> `await expect(X).rejects.toThrow(E)`,
 *      with the matcher and E byte-identical.
 *   2. inserting `await` before a call.
 *   3. the same matcher and the same expected value, on an awaited result.
 *
 * Everything else is a violation, including: narrowing `toThrow(E)` to a bare
 * `toThrow()`, removing an assertion, weakening a matcher, adding .skip/.only/
 * .todo, decreasing the test count, and renaming a test.
 */
import ts from "typescript";
import { execFileSync } from "node:child_process";

const MATCHER_MODIFIERS = new Set(["resolves", "rejects", "not"]);
const TEST_CALLEES = new Set(["it", "test", "describe"]);

/** Strip a zero-arg arrow wrapper and a leading await, then collapse spaces. */
export function normaliseSubject(text) {
  let t = String(text).trim();
  let thunk = false;
  const arrow = t.match(/^(?:async\s*)?\(\s*\)\s*=>\s*([\s\S]+)$/);
  if (arrow) {
    thunk = true;
    t = arrow[1].trim();
    if (t.startsWith("{") && t.endsWith("}")) t = t.slice(1, -1).trim();
  }
  // Strip EVERY await, not just a leading one, and count them.
  //
  // An inserted await often lands INSIDE the subject:
  //   expect(store.getById(x)?.stdout)  ->  expect((await store.getById(x))?.stdout)
  // Comparing raw text then finds no match and reports a violation at exactly
  // the sites the allowlist exists to permit. Stripping all awaits makes the
  // subject comparable; the COUNT is what distinguishes an insertion (allowed)
  // from a removal (not).
  const awaitCount = (t.match(/\bawait\s+/g) ?? []).length;
  t = t.replace(/\bawait\s+/g, "");
  const subject = t.replace(/\s+/g, " ").trim();
  // Separate key for COMPARISON only. Inserting an await usually adds a paren
  // pair (`x?.y` becomes `(await x)?.y`), so parens are ignored when matching.
  // They are kept in `subject`, because a violation message has to be readable
  // and `store.recordStart{ id: 1 }` is not.
  const matchKey = subject.replace(/[()]/g, "");
  return { subject, matchKey, thunk, awaitCount };
}

function collapse(text) {
  return String(text).replace(/\s+/g, " ").trim();
}

/** Every expect(...) chain in a source file, as comparable fingerprints. */
export function extractAssertions(source, filename = "f.ts") {
  const sf = ts.createSourceFile(filename, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const out = [];
  const visit = node => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "expect" &&
      node.arguments.length > 0
    ) {
      const { subject, matchKey, thunk, awaitCount } = normaliseSubject(
        node.arguments[0].getText(sf)
      );
      const chain = [];
      let cursor = node;
      let matcher = null;
      let args = null;
      while (cursor.parent && ts.isPropertyAccessExpression(cursor.parent)) {
        const access = cursor.parent;
        const name = access.name.text;
        if (ts.isCallExpression(access.parent) && access.parent.expression === access) {
          matcher = name;
          args = access.parent.arguments.map(a => collapse(a.getText(sf)));
          break;
        }
        if (!MATCHER_MODIFIERS.has(name)) break;
        chain.push(name);
        cursor = access;
      }
      if (matcher) {
        out.push({
          subject,
          matchKey,
          thunk,
          awaitCount,
          modifiers: chain,
          matcher,
          args,
          line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** Test titles in source order, with any skip/only/todo modifier. */
export function extractTests(source, filename = "f.ts") {
  const sf = ts.createSourceFile(filename, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const out = [];
  const visit = node => {
    if (ts.isCallExpression(node) && node.arguments.length > 0) {
      let base = node.expression;
      let modifier = null;
      if (ts.isPropertyAccessExpression(base)) {
        modifier = base.name.text;
        base = base.expression;
      }
      if (ts.isIdentifier(base) && TEST_CALLEES.has(base.text)) {
        const title = node.arguments[0];
        if (ts.isStringLiteralLike(title)) {
          out.push({ kind: base.text, modifier, title: title.text });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function sameArgs(a, b) {
  if (a === null || b === null) return a === b;
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Can `head` stand for `base` under the allowlist?
 *
 * Rule 1 is the ONLY shape change permitted: a synchronous-thunk subject whose
 * matcher moves behind `rejects`, keeping the matcher and its arguments
 * byte-identical. Rules 2 and 3 fall out of normalisation, since `await` and a
 * thunk wrapper are stripped before comparison.
 */
export function permittedRewrite(base, head) {
  if (base.matchKey !== head.matchKey) return false;
  // Removing an await is NOT on the allowlist. It looked harmless until it was
  // measured: hoisting an await off an assertion subject and onto its
  // declaration turned two concurrently-submitted transactions into sequential
  // ones, so a test named "serialises transactions" stopped exercising the
  // queue while still passing. The matcher and the expected value were
  // identical either side, which is exactly why the checker has to look here.
  if (head.awaitCount < base.awaitCount) return false;
  if (base.matcher !== head.matcher) return false;
  if (!sameArgs(base.args, head.args)) return false;
  const sameModifiers =
    base.modifiers.length === head.modifiers.length &&
    base.modifiers.every((m, i) => m === head.modifiers[i]);
  if (sameModifiers) return true;
  // sync throw -> rejection: base had a thunk, head gains exactly `rejects`.
  return (
    base.thunk &&
    head.modifiers.length === base.modifiers.length + 1 &&
    head.modifiers[0] === "rejects" &&
    head.modifiers.slice(1).every((m, i) => m === base.modifiers[i])
  );
}

function key(a) {
  // `awaited` is part of identity. Without it an await REMOVED from a subject
  // produces a byte-identical fingerprint and takes the exact-match fast path,
  // which is how 106 removals once passed this checker unclassified.
  return `${a.matchKey}|${a.awaitCount}|${a.modifiers.join(".")}|${a.matcher}|${(a.args ?? []).join(",")}`;
}

/**
 * Assertions that ALREADY had a bare matcher at the base ref.
 *
 * `toThrow()` with no argument reads like a weakened `toThrow(E)` to anyone
 * comparing against the parity rule, and this checker cannot tell the two apart
 * from the head alone. It does not need to, because it compares against the
 * base, but a reader will. So the tool REPORTS them: the exception is carried by
 * the checker's own output against a named ref, not by a comment asking for
 * restraint. Anyone tempted to "narrow" one of these can see it was always bare.
 */
export function preExistingBareMatchers(baseSource, filename) {
  return extractAssertions(baseSource, filename)
    .filter(a => Array.isArray(a.args) && a.args.length === 0)
    .map(a => ({
      filename,
      line: a.line,
      subject: a.subject,
      matcher: [...a.modifiers, a.matcher].join("."),
    }));
}

export function compareTestFile(baseSource, headSource, filename) {
  const violations = [];

  const baseTests = extractTests(baseSource, filename);
  const headTests = extractTests(headSource, filename);

  for (const t of headTests) {
    if (t.modifier && ["skip", "only", "todo", "fails"].includes(t.modifier)) {
      const wasAlready = baseTests.some(b => b.title === t.title && b.modifier === t.modifier);
      if (!wasAlready) {
        violations.push(`${filename}: "${t.title}" gained .${t.modifier}`);
      }
    }
  }

  const baseTitles = baseTests.map(t => `${t.kind}:${t.title}`);
  const headTitles = headTests.map(t => `${t.kind}:${t.title}`);
  for (const title of baseTitles) {
    if (!headTitles.includes(title)) {
      violations.push(`${filename}: test removed or renamed: ${title}`);
    }
  }
  if (headTests.length < baseTests.length) {
    violations.push(
      `${filename}: test count decreased, ${baseTests.length} -> ${headTests.length}`
    );
  }

  const baseAssertions = extractAssertions(baseSource, filename);
  const headAssertions = extractAssertions(headSource, filename);
  const pool = [...headAssertions];

  for (const b of baseAssertions) {
    const exact = pool.findIndex(h => key(h) === key(b));
    if (exact !== -1) {
      pool.splice(exact, 1);
      continue;
    }
    const rewritten = pool.findIndex(h => permittedRewrite(b, h));
    if (rewritten !== -1) {
      pool.splice(rewritten, 1);
      continue;
    }
    const nearby = headAssertions.find(h => h.matchKey === b.matchKey);
    violations.push(
      `${filename}:${b.line}: assertion changed outside the allowlist. ` +
        `was expect(${b.subject}).${[...b.modifiers, b.matcher].join(".")}(${(b.args ?? []).join(", ")})` +
        (nearby
          ? `, now .${[...nearby.modifiers, nearby.matcher].join(".")}(${(nearby.args ?? []).join(", ")})`
          : ", and no assertion on that subject survives")
    );
  }

  return violations;
}

function gitShow(ref, path) {
  try {
    return execFileSync("git", ["show", `${ref}:${path}`], {
      encoding: "utf8",
      // A file that is NEW in head legitimately has no base; git says so on
      // stderr and that is not a problem to report.
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

function main() {
  const baseRef = process.argv[2];
  if (!baseRef) {
    console.error("usage: check-test-assertion-parity.mjs <base-ref>");
    console.error("Refusing to run with no base: a checker with nothing to compare passes");
    console.error("vacuously, which is the failure mode it exists to prevent.");
    process.exit(2);
  }

  const changed = execFileSync("git", ["diff", "--name-only", baseRef, "--", "src/__tests__"], {
    encoding: "utf8",
  })
    .split("\n")
    .map(s => s.trim())
    .filter(s => s.endsWith(".test.ts"));

  const violations = [];
  const bare = [];
  for (const path of changed) {
    const baseSource = gitShow(baseRef, path);
    // A NEW test file has no base to weaken, so it is out of scope.
    if (baseSource === null) continue;
    const headSource = gitShow("HEAD", path) ?? "";
    violations.push(...compareTestFile(baseSource, headSource, path));
    bare.push(...preExistingBareMatchers(baseSource, path));
  }

  if (bare.length > 0) {
    console.log(`pre-existing bare matchers at ${baseRef}, NOT weakened by this change:`);
    for (const b of bare) console.log(`  ${b.filename}:${b.line}  ${b.matcher}() on ${b.subject}`);
    console.log("");
  }

  if (violations.length > 0) {
    console.error(`assertion parity FAILED against ${baseRef}:\n`);
    for (const v of violations) console.error(`  ${v}`);
    console.error(
      `\n${violations.length} violation(s). Permitted: sync-throw to rejects with the ` +
        `matcher and error byte-identical, and inserted awaits. Nothing else.`
    );
    process.exit(1);
  }

  console.log(
    `assertion parity: ${changed.length} changed test file(s) vs ${baseRef}; ` +
      `every base assertion still present, same matchers, same errors.`
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();
