#!/usr/bin/env node
/**
 * Which controls in this diff have a test behind them, and which only look like
 * they do?
 *
 * Rounds 24 to 27 each answered that by READING, and each was wrong in the same
 * shape: a rule pinned by one case was read as pinned by all of them. The claim
 * "every multi-arm control has a case per arm and every enumerated set a case
 * per member" was asserted and falsified four rounds running.
 *
 * So the set is DERIVED. `enumerate` walks the TypeScript AST and emits one
 * mutation per control; `run` applies each, runs the suite, and reverts. A
 * mutation the suite still passes is a control with no test.
 *
 *   node scripts/mutation-sweep.mjs enumerate <out.json> <file...> [--diff <ref>]
 *   node scripts/mutation-sweep.mjs run <in.json> <out.jsonl> --total <n> [options]
 *
 * A SURVIVOR IS NOT AUTOMATICALLY A DEFECT. Some mutations are equivalent, and
 * some guards are unreachable from any spelling the code can be handed. The
 * output says which mutations survived; classifying each one, with the
 * measurement that decided it, is the reviewer's job and belongs in
 * docs/evidence.
 */
import ts from "typescript";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const [mode, ...rest] = process.argv.slice(2);

/** Mutation shapes. Each is something a reviewer would call "a control". */
function enumerateFile(file, add) {
  const text = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
  const src = node => text.slice(node.getStart(sf), node.getEnd());
  const line = node => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const span = (a, b) => [
    sf.getLineAndCharacterOfPosition(a).line + 1,
    sf.getLineAndCharacterOfPosition(b).line + 1,
  ];
  const emit = (kind, label, start, end, replacement) =>
    add({ file, kind, label, start, end, replacement, ...spanOf(span(start, end)) });
  const spanOf = ([l1, l2]) => ({ l1, l2 });

  const walk = node => {
    // One deletion per member of an enumerated set of string literals.
    if (ts.isArrayLiteralExpression(node)) {
      const els = node.elements;
      if (
        els.length >= 2 &&
        els.every(e => ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e))
      ) {
        els.forEach((el, i) => {
          const rest_ = els
            .filter((_, j) => j !== i)
            .map(src)
            .join(", ");
          emit(
            "set-member",
            `drop ${src(el)} from [${els.map(src).join(",")}] (L${line(node)})`,
            node.getStart(sf),
            node.getEnd(),
            `[${rest_}]`
          );
        });
      }
    }

    // Each arm of a `||` / `&&` chain, kept alone. Outermost node only, so the
    // operands are whole arms rather than fragments of a longer chain.
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      const isLogical =
        op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.AmpersandAmpersandToken;
      const parentSameOp =
        ts.isBinaryExpression(node.parent) && node.parent.operatorToken.kind === op;
      if (isLogical && !parentSameOp) {
        const arms = [];
        const flatten = x => {
          if (ts.isBinaryExpression(x) && x.operatorToken.kind === op) {
            flatten(x.left);
            flatten(x.right);
          } else arms.push(x);
        };
        flatten(node);
        const sym = op === ts.SyntaxKind.BarBarToken ? "||" : "&&";
        if (arms.length >= 2) {
          arms.forEach((_, i) => {
            const kept = arms
              .filter((__, j) => j !== i)
              .map(src)
              .join(` ${sym} `);
            emit(
              "logical-arm",
              `drop arm ${i + 1}/${arms.length} of \`${src(node).replace(/\s+/g, " ").slice(0, 90)}\` (L${line(node)})`,
              node.getStart(sf),
              node.getEnd(),
              kept
            );
          });
        }
      }
    }

    // One `case` label at a time; its value then falls through to `default`.
    if (ts.isCaseBlock(node)) {
      const clauses = node.clauses.filter(ts.isCaseClause);
      if (clauses.length >= 2) {
        for (const c of clauses) {
          const labelEnd =
            c.expression.getEnd() + text.slice(c.expression.getEnd()).indexOf(":") + 1;
          const [start, end] =
            c.statements.length === 0 ? [c.getStart(sf), labelEnd] : [c.getStart(sf), c.getEnd()];
          emit("switch-case", `drop case ${src(c.expression)} (L${line(c)})`, start, end, "");
        }
      }
    }

    // Each top-level regex alternative, and each flag. `/g` is skipped: dropping
    // it changes iteration rather than the set the pattern admits.
    if (ts.isRegularExpressionLiteral(node)) {
      const raw = src(node);
      const close = raw.lastIndexOf("/");
      const body = raw.slice(1, close);
      const flags = raw.slice(close + 1);
      const parts = [];
      let depth = 0;
      let inClass = false;
      let cur = "";
      for (let i = 0; i < body.length; i++) {
        const ch = body[i];
        if (ch === "\\") {
          cur += ch + (body[i + 1] ?? "");
          i++;
          continue;
        }
        if (inClass) {
          cur += ch;
          if (ch === "]") inClass = false;
          continue;
        }
        if (ch === "[") {
          inClass = true;
          cur += ch;
          continue;
        }
        if (ch === "(") depth++;
        if (ch === ")") depth--;
        if (ch === "|" && depth === 0) {
          parts.push(cur);
          cur = "";
          continue;
        }
        cur += ch;
      }
      parts.push(cur);
      if (parts.length > 1) {
        parts.forEach((_, i) => {
          const kept = parts.filter((__, j) => j !== i).join("|");
          emit(
            "regex-part",
            `drop alternative ${i + 1}/${parts.length} of ${raw} (L${line(node)})`,
            node.getStart(sf),
            node.getEnd(),
            `/${kept}/${flags}`
          );
        });
      }
      for (const f of flags) {
        if (f === "g") continue;
        emit(
          "regex-part",
          `drop flag /${f} of ${raw} (L${line(node)})`,
          node.getStart(sf),
          node.getEnd(),
          `/${body}/${flags.replace(f, "")}`
        );
      }
    }

    // A whole guard. Stated as the SHAPE "something that can refuse", not as a
    // list of the spellings already in the tree: an earlier version required the
    // `if` branch to be a single `return`, and so missed a gate whose branch was
    // `console.error` plus `process.exit`, and a Zod `.refine()` link, which is a
    // control expressed as a call argument rather than a statement. A check that
    // enumerates the set it governs has that enumeration in its own blast radius.
    if (ts.isIfStatement(node) && !node.elseStatement) {
      emit(
        "guard-stmt",
        `delete guard \`${src(node).replace(/\s+/g, " ").slice(0, 110)}\` (L${line(node)})`,
        node.getStart(sf),
        node.getEnd(),
        ""
      );
    }
    if (ts.isForOfStatement(node) || ts.isForStatement(node)) {
      emit(
        "guard-stmt",
        `delete loop \`${src(node).replace(/\s+/g, " ").slice(0, 110)}\` (L${line(node)})`,
        node.getStart(sf),
        node.getEnd(),
        ""
      );
    }
    if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)) {
      if (
        /^(assert|require|ensure|check|validate|refuse|guard)/i.test(
          src(node.expression.expression)
        )
      ) {
        emit(
          "guard-stmt",
          `delete call \`${src(node).replace(/\s+/g, " ").slice(0, 110)}\` (L${line(node)})`,
          node.getStart(sf),
          node.getEnd(),
          ""
        );
      }
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const name = node.expression.name.text;
      if (["refine", "superRefine", "regex", "startsWith", "endsWith", "nonempty"].includes(name)) {
        emit(
          "guard-stmt",
          `drop .${name}() from \`${src(node).replace(/\s+/g, " ").slice(0, 110)}\` (L${line(node)})`,
          node.getStart(sf),
          node.getEnd(),
          src(node.expression.expression)
        );
      }
    }

    ts.forEachChild(node, walk);
  };
  walk(sf);
}

/** New-side line numbers the diff touches, per file. */
function changedLines(ref) {
  const diff = execFileSync("git", ["diff", `${ref}...HEAD`, "-U0", "--", "src/"], {
    encoding: "utf8",
  });
  const out = {};
  let current = null;
  for (const l of diff.split("\n")) {
    if (l.startsWith("+++ b/")) {
      current = l.slice(6).trim();
      out[current] ??= new Set();
    } else if (l.startsWith("@@") && current) {
      const m = /\+(\d+)(?:,(\d+))?/.exec(l);
      if (!m) continue;
      const start = Number(m[1]);
      for (let i = 0; i < Number(m[2] ?? 1); i++) out[current].add(start + i);
    }
  }
  return out;
}

if (mode === "enumerate") {
  const diffAt = rest.indexOf("--diff");
  const ref = diffAt >= 0 ? rest[diffAt + 1] : null;
  const wholeAt = rest.indexOf("--whole");
  const whole = new Set(wholeAt >= 0 ? rest[wholeAt + 1].split(",") : []);
  const consumed = new Set([diffAt + 1, wholeAt + 1].filter(i => i > 0));
  const argv = rest.filter((a, i) => !a.startsWith("--") && !consumed.has(i));
  const [outFile, ...files] = argv;
  const all = [];
  for (const f of files) enumerateFile(f, m => all.push(m));

  // Scope: with `--diff`, a control counts if it lies inside the diff under
  // review. A file the diff does not touch at all is taken WHOLE, and so is one
  // named in `--whole`, which is how a module whose behaviour this branch owns
  // end to end is covered rather than only its latest edit.
  //
  // The widening is EXPLICIT because the alternative is silent narrowing: line
  // filtering a file whose every control is under review drops most of them,
  // and a smaller number reads as a cleaner result rather than a smaller
  // question. Whatever is dropped is printed below.
  let kept = all;
  if (ref) {
    const changed = changedLines(ref);
    kept = all.filter(m => {
      if (whole.has(m.file)) return true;
      const lines = changed[m.file];
      if (!lines) return true;
      for (let l = m.l1; l <= m.l2; l++) if (lines.has(l)) return true;
      return false;
    });
  }
  kept.forEach((m, i) => (m.id = `m${String(i + 1).padStart(3, "0")}`));
  writeFileSync(outFile, JSON.stringify(kept, null, 2));
  const byKind = {};
  for (const m of kept) byKind[m.kind] = (byKind[m.kind] ?? 0) + 1;
  console.error(`${kept.length} mutations across ${files.length} files`);
  for (const [k, n] of Object.entries(byKind)) console.error(`  ${k.padEnd(12)} ${n}`);
  // NO SILENT CAPS. A sweep that bounded its own coverage and did not say so
  // reads afterwards as though it had covered everything.
  if (kept.length !== all.length) {
    console.error(
      `  scoped out ${all.length - kept.length} control(s) outside ${ref}...HEAD` +
        `${whole.size > 0 ? `, with ${[...whole].join(", ")} taken whole` : ""}`
    );
  }
  process.exit(0);
}

if (mode !== "run") {
  console.error("usage: mutation-sweep.mjs enumerate|run ...");
  process.exit(2);
}

const [mutFile, outFile] = rest;
const opt = name => {
  const at = rest.indexOf(`--${name}`);
  return at >= 0 ? rest[at + 1] : null;
};
const TOTAL = Number(opt("total"));
const CWD = opt("cwd") ?? process.cwd();
const SHARD = Number(opt("shard") ?? 0);
const SHARDS = Number(opt("shards") ?? 1);
const TESTS = (opt("tests") ?? "").split(",").filter(Boolean);
const BAIL = TESTS.length === 0; // a whole-suite run can stop at the first failure

if (!Number.isInteger(TOTAL) || TOTAL <= 0) {
  console.error("--total <n> is required: the number of tests the UNMUTATED tree reports.");
  process.exit(2);
}

const clean = () =>
  execFileSync("git", ["status", "--porcelain"], { cwd: CWD, encoding: "utf8" }).trim();

/**
 * Run the suite and decide what happened.
 *
 * NOT from the exit code alone. The first version of this read only the status,
 * passed a flag vitest does not accept, and recorded 48 of 48 mutants as killed
 * because the CLI died before loading a test. A run with no summary line is
 * `invalid`, which is not a verdict.
 */
function runSuite() {
  const argv = ["vitest", "run", ...TESTS, ...(BAIL ? ["--bail=1"] : [])];
  const r = spawnSync("npx", argv, { cwd: CWD, encoding: "utf8", timeout: 2_400_000 });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const line = /^\s*Tests\s+(.*)$/m.exec(out)?.[1]?.trim() ?? null;
  const total = line ? Number(/\((\d+)\)\s*$/.exec(line)?.[1] ?? NaN) : NaN;
  const green = r.status === 0 && total === TOTAL;
  const failed = line !== null && /\d+ failed/.test(line);
  return { ran: green || failed, passed: green, line };
}

function trial(file, start, end, replacement) {
  const original = readFileSync(`${CWD}/${file}`, "utf8");
  writeFileSync(`${CWD}/${file}`, original.slice(0, start) + replacement + original.slice(end));
  const result = runSuite();
  execFileSync("git", ["checkout", "--", file], { cwd: CWD });
  if (clean() !== "") throw new Error(`tree dirty after mutating ${file}`);
  return result;
}

if (clean() !== "") {
  console.error(`shard ${SHARD}: ${CWD} is not clean; a sweep measures a COMMIT.`);
  process.exit(2);
}

// CONTROLS, before any mutation. A harness that cannot show it detects a kill,
// and cannot show the unmutated tree is green, has not measured anything.
const controlFile = JSON.parse(readFileSync(mutFile, "utf8"))[0]?.file;
if (!controlFile) {
  console.error("no mutations to run");
  process.exit(2);
}
const controlText = readFileSync(`${CWD}/${controlFile}`, "utf8");
const noop = trial(controlFile, 0, 0, "\n");
if (!noop.ran) {
  console.error(`shard ${SHARD}: control did not RUN (${noop.line}); the harness is broken.`);
  process.exit(2);
}
if (!noop.passed) {
  console.error(`shard ${SHARD}: control was KILLED (${noop.line}); the tree is not green.`);
  process.exit(2);
}
const kill = trial(controlFile, 0, controlText.length, "export const broken = 1;\n");
if (kill.passed) {
  console.error(
    `shard ${SHARD}: emptying ${controlFile} killed nothing; the harness cannot detect a kill.`
  );
  process.exit(2);
}
console.error(`shard ${SHARD}: controls ok (no-op survives, gutted file killed)`);

const muts = JSON.parse(readFileSync(mutFile, "utf8")).filter((_, i) => i % SHARDS === SHARD);
for (const m of muts) {
  const result = trial(m.file, m.start, m.end, m.replacement);
  const verdict = !result.ran ? "invalid" : result.passed ? "SURVIVES" : "killed";
  appendFileSync(outFile, `${JSON.stringify({ ...m, verdict, tests: result.line })}\n`);
  console.error(
    `${m.id} ${verdict.padEnd(9)} ${(result.line ?? "NO SUMMARY").padEnd(34)} ${m.label.slice(0, 60)}`
  );
}
