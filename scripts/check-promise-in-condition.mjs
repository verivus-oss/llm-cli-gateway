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
 * Boolean positions checked: if/while/do conditions, the ternary condition,
 * `!x`, and every operand of `&&` / `||` that is not the value-producing tail.
 */
import ts from "typescript";
import { relative } from "node:path";

const ROOT = process.cwd();
const cfgPath = ts.findConfigFile(ROOT, ts.sys.fileExists, "tsconfig.json");
const cfg = ts.readConfigFile(cfgPath, ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, ROOT);
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
  const rel = relative(ROOT, sf.fileName);
  if (!rel.startsWith("src/")) continue;

  const flag = (node, why) => {
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
    if (ts.isIfStatement(node)) flag(node.expression, "if condition");
    else if (ts.isWhileStatement(node) || ts.isDoStatement(node))
      flag(node.expression, "loop condition");
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
