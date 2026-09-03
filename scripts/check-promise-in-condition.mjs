#!/usr/bin/env node
/**
 * Structural gate for the half no linter covers: a PROMISE used as a BOOLEAN.
 *
 * `no-floating-promises` finds a promise nobody consumes. `no-misused-promises`
 * finds an async function handed to a void slot. Neither finds
 * `if (maybePromise)`, because the promise IS consumed and the code type
 * checks: a promise is a legitimate thing to put in a condition. It is just
 * always truthy, so the condition stops being evaluated and whatever it guarded
 * silently stops guarding.
 *
 * s5 produced eight of these while making JobStore async. Two were security or
 * durability controls, and one broke every job creation. That last one was
 * caught by a runtime test, not by either rule, which is why this exists.
 *
 * Boolean positions checked: if/while/do/for conditions, the ternary condition,
 * `!x`, every operand of `&&` / `||` that is not the value-producing tail, and
 * `Boolean(x)` anywhere.
 *
 * THE COERCION FAMILY, enumerated and decided one by one. A live defect sat in
 * `Boolean(asyncJobManager.getJobKitExecution(jobId))` while this gate reported
 * zero, because a coercion CALL is not a syntactic boolean position. Adding
 * `Boolean` alone would have left the rest of the family as the next blind spot,
 * so each shape below is a decision, not an omission.
 *
 *   Boolean(p)        FLAGGED anywhere. The call exists to produce truthiness,
 *                     so it is a boolean position by definition, and there is no
 *                     reading under which coercing a promise to a boolean is
 *                     what the author meant.
 *   !!p               ALREADY FLAGGED, and no code was needed: the outer `!`
 *                     yields a boolean the checker rejects, then the visitor
 *                     descends to the inner `!` whose operand is the promise.
 *                     Verified by fixture, not assumed.
 *   Number(p)         SEEN THROUGH in a boolean position, not flagged outside
 *   String(p)         one. `Number(p)` is NaN and `String(p)` is the constant
 *                     "[object Promise]", so in a condition the guard is dead
 *                     exactly as with Boolean. Outside a condition they are a
 *                     diagnostic shape rather than a failed guard, and this gate
 *                     is named for guards; widening it there would change its
 *                     subject and its noise floor.
 *   `${p}`            NOT FLAGGED, same reasoning as String() outside a
 *                     condition, and template literals are overwhelmingly log
 *                     text.
 *   xs.filter(Boolean) FLAGGED when the ELEMENT type is a promise. The existing
 *                     predicate rule asks what the callback RETURNS, which says
 *                     nothing here: `Boolean` is synchronous and correct, and it
 *                     is the array that is wrong. Every element survives.
 *   p ?? fallback     NOT FLAGGED. `??` tests nullishness, not truthiness, so a
 *                     bare-promise left side makes the FALLBACK dead rather than
 *                     the guard. That is a different defect, and this gate
 *                     deliberately permits `Promise<T> | undefined` (see below),
 *                     so it has no way to tell the two apart without contradicting
 *                     that exemption.
 *   switch/case p     NOT FLAGGED. `case` compares with `===`; a promise simply
 *                     never matches, which is a dead branch and not a dead guard.
 */
import ts from "typescript";
import { relative, resolve, sep } from "node:path";

const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== "--root" || !args[1])) {
  console.error("usage: check-promise-in-condition.mjs [--root <dir>]");
  process.exit(2);
}

const ROOT = args.length === 2 ? resolve(args[1]) : process.cwd();
const cfgPath = resolve(ROOT, "tsconfig.json");
const cfg = ts.readConfigFile(cfgPath, ts.sys.readFile);
if (cfg.error) {
  console.error(ts.flattenDiagnosticMessageText(cfg.error.messageText, "\n"));
  process.exit(2);
}
const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, ROOT);
if (parsed.errors.length > 0) {
  for (const error of parsed.errors) {
    console.error(ts.flattenDiagnosticMessageText(error.messageText, "\n"));
  }
  process.exit(2);
}
const program = ts.createProgram(parsed.fileNames, parsed.options);
const checker = program.getTypeChecker();

/**
 * A BARE promise in a condition is always truthy and the condition is dead.
 *
 * `Promise<T> | undefined` is different and is NOT flagged: testing whether a
 * cached or in-flight promise EXISTS is a legitimate idiom, and this codebase
 * uses it deliberately for memoised schema readiness, for the terminal-hook
 * deferred, and for joining an in-flight reconciliation run. Flagging those
 * would train the reader to ignore the gate, which is how a real finding gets
 * missed.
 *
 * Promise-ness is decided by asking the checker for a CALLABLE `then` member,
 * never by matching the rendered type NAME. This gate previously tested
 * /^Promise</, which is exactly the mistake that stripped seven awaits earlier
 * in this node: PromiseWithChild IS a promise and does not match that name.
 * Both reviewers found it independently, and a gate that is wrong on the one
 * type that matters is the reliable-looking tool the design warns about.
 */
function thenable(type) {
  const then = checker.getPropertyOfType(type, "then");
  const decl = then?.valueDeclaration ?? then?.declarations?.[0];
  if (!decl) return false;
  return checker.getTypeOfSymbolAtLocation(then, decl).getCallSignatures().length > 0;
}

function isPromiseLike(type) {
  if (!type) return false;
  if (type.isUnion()) {
    const nullish = type.types.some(
      t => (t.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)) !== 0
    );
    if (nullish) return false;
    return type.types.some(thenable);
  }
  return thenable(type);
}

/**
 * Array methods that test their callback's return value for TRUTHINESS.
 *
 * An async callback returns a promise and every promise is truthy, so:
 *   every  -> always true      some   -> always true
 *   filter -> keeps everything find   -> first element, predicate ignored
 *
 * The gate above cannot see this: the truthiness test happens inside
 * Array.prototype, so there is no boolean-position node in the source. Five of
 * these were found by hand in s5, two of them sitting in assertions that read
 * as though they still tested something.
 *
 * Worse than `.map(async ...)`, which at least leaves visible promises in the
 * result for something downstream to complain about. A predicate silently
 * answers YES.
 *
 * No legitimate idiom to exempt: an async predicate is unconditionally wrong.
 */
/**
 * Coercion callees this gate sees through. `Boolean` is additionally a boolean
 * position in its own right (see the header); `Number` and `String` are only
 * transparent, so they are reported when a condition wraps them and ignored
 * when a log line does.
 */
const COERCERS = new Set(["Boolean", "Number", "String"]);

const TRUTHINESS_PREDICATES = new Set([
  "every",
  "some",
  "filter",
  "find",
  "findIndex",
  "findLast",
  "findLastIndex",
]);

const violations = [];
for (const sf of program.getSourceFiles()) {
  if (sf.isDeclarationFile) continue;
  // Separator-safe: the predicate is written against POSIX form so a Windows
  // checkout (src\\probe.ts) is gated exactly like a POSIX one (src/probe.ts).
  const rel = relative(ROOT, sf.fileName).split(sep).join("/");
  if (!rel.startsWith("src/")) continue;

  /**
   * See through a coercion call so the boolean positions below examine the
   * VALUE, not the boolean/number/string the coercion manufactures from it.
   * Without this every rule here stops at `Boolean(...)` and reports nothing,
   * which is precisely how the llm_job_result telemetry defect survived.
   */
  const unwrapCoercion = node => {
    let cur = node;
    for (;;) {
      if (
        ts.isCallExpression(cur) &&
        ts.isIdentifier(cur.expression) &&
        COERCERS.has(cur.expression.text) &&
        cur.arguments.length === 1
      ) {
        cur = cur.arguments[0];
        continue;
      }
      if (ts.isParenthesizedExpression(cur)) {
        cur = cur.expression;
        continue;
      }
      return cur;
    }
  };

  const flag = (rawNode, why) => {
    const node = unwrapCoercion(rawNode);
    let t;
    try {
      t = checker.getTypeAtLocation(node);
    } catch {
      return;
    }
    if (!isPromiseLike(t)) return;
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    violations.push({
      site: `${rel}:${line + 1}`,
      why,
      code: node.getText(sf).replace(/\s+/g, " ").slice(0, 74),
    });
  };

  const visit = node => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      TRUTHINESS_PREDICATES.has(node.expression.name.text) &&
      node.arguments.length >= 1
    ) {
      const cb = node.arguments[0];
      // Syntactically `async`, OR anything whose call signature RETURNS a
      // promise. Matching only inline async arrows missed two shapes a reviewer
      // named: `const p = async x => ...; items.find(p)`, and a plain callback
      // that returns a promise without the async keyword. Both make the
      // predicate unconditionally truthy in exactly the same way.
      let isAsync =
        (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) &&
        (cb.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false);
      if (!isAsync) {
        try {
          const signatures = checker.getTypeAtLocation(cb).getCallSignatures();
          isAsync =
            signatures.length > 0 &&
            signatures.every(sig => isPromiseLike(checker.getReturnTypeOfSignature(sig)));
        } catch {
          isAsync = false;
        }
      }
      if (isAsync) {
        const { line } = sf.getLineAndCharacterOfPosition(cb.getStart(sf));
        violations.push({
          site: `${rel}:${line + 1}`,
          why: `async predicate to .${node.expression.name.text}()`,
          code: node.getText(sf).replace(/\s+/g, " ").slice(0, 74),
        });
      }
    }
    // `Boolean(p)` is a boolean position wherever it appears: the call has no
    // purpose other than truthiness. Number/String are NOT handled here, only
    // seen through by `flag`, because outside a condition they are diagnostics.
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "Boolean" &&
      node.arguments.length === 1
    ) {
      flag(node.arguments[0], "Boolean() coercion");
    }
    // `xs.filter(Boolean)` and friends: the callback is fine, the ELEMENTS are
    // promises, and every promise survives the filter.
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      TRUTHINESS_PREDICATES.has(node.expression.name.text) &&
      node.arguments.length === 1 &&
      ts.isIdentifier(node.arguments[0]) &&
      node.arguments[0].text === "Boolean"
    ) {
      try {
        const receiver = checker.getTypeAtLocation(node.expression.expression);
        const element = checker.getIndexTypeOfType(receiver, ts.IndexKind.Number);
        if (element && isPromiseLike(element)) {
          const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
          violations.push({
            site: `${rel}:${line + 1}`,
            why: `.${node.expression.name.text}(Boolean) over promise elements`,
            code: node.getText(sf).replace(/\s+/g, " ").slice(0, 74),
          });
        }
      } catch {
        /* type resolution failure is not a finding */
      }
    }
    if (ts.isIfStatement(node)) flag(node.expression, "if condition");
    else if (ts.isWhileStatement(node) || ts.isDoStatement(node))
      flag(node.expression, "loop condition");
    else if (ts.isForStatement(node) && node.condition) flag(node.condition, "for condition");
    else if (ts.isConditionalExpression(node)) flag(node.condition, "ternary condition");
    else if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken)
      flag(node.operand, "negation");
    else if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        node.operatorToken.kind === ts.SyntaxKind.BarBarToken)
    ) {
      // The LEFT operand is always tested. The right one is tested too when the
      // whole expression is itself in a boolean position, which the parent
      // visit already covers.
      // `x && typeof (x as Promise<T>).then === "function"` is the deliberate
      // duck-type: the left operand is an existence check and the right operand
      // is what decides promise-ness. Flagging the left would report every
      // correct use of the idiom, which is how a gate teaches people to skip it.
      const rightDuckTypesAPromise =
        /typeof\s*\(?[\s\S]*?\)?\s*\.\s*(then|catch|finally)\s*===\s*"function"/.test(
          node.right.getText(sf)
        );
      if (!rightDuckTypesAPromise) flag(node.left, `${node.operatorToken.getText(sf)} operand`);
      const p = node.parent;
      const parentIsCondition =
        p &&
        ((ts.isIfStatement(p) && p.expression === node) ||
          (ts.isConditionalExpression(p) && p.condition === node) ||
          (ts.isPrefixUnaryExpression(p) && p.operator === ts.SyntaxKind.ExclamationToken));
      if (parentIsCondition) flag(node.right, `${node.operatorToken.getText(sf)} operand`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

const prod = violations.filter(v => !v.site.includes("__tests__"));
const tests = violations.filter(v => v.site.includes("__tests__"));

if (prod.length > 0) {
  console.error("promise used as a boolean (always truthy) FAILED:\n");
  for (const v of prod) console.error(`  ${v.site}  [${v.why}]  ${v.code}`);
  console.error(`\n${prod.length} violation(s) in production. Await it, or compare it explicitly.`);
  if (tests.length) console.error(`(${tests.length} more in tests, not gated)`);
  process.exit(1);
}

console.log(
  `promise-in-condition: 0 in production` + (tests.length ? `, ${tests.length} in tests` : "")
);
