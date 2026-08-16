#!/usr/bin/env node
// Verify docs/plans/validation-launch-surface.dag.toml against the actual code.
//
// A map with wrong coordinates is worse than no map: it is a control that
// cannot fail, in documentation form. The checker therefore rejects incomplete
// declarations and reduced coverage as well as ordinary coordinate drift.
//
// Exit 0 clean, 1 on drift. Run: node scripts/check-launch-surface-dag.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import ts from "typescript";

export const DAG_PATH = "docs/plans/validation-launch-surface.dag.toml";

const REQUIRED_COVERAGE = {
  node_count: { label: "node", expected: 17 },
  invariant_count: { label: "invariant", expected: 6 },
  flow_count: { label: "flow hop", expected: 9 },
};

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonemptyStrings(value) {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(item => typeof item === "string" && item.length > 0)
  );
}

function enclosingFunctionName(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isFunctionDeclaration(current)) return current.name?.text ?? "<anonymous>";
    if (ts.isMethodDeclaration(current)) return current.name?.getText() ?? "<anonymous>";
    if (ts.isFunctionExpression(current) || ts.isArrowFunction(current)) {
      if (ts.isVariableDeclaration(current.parent) && ts.isIdentifier(current.parent.name)) {
        return current.parent.name.text;
      }
      if (ts.isPropertyAssignment(current.parent)) return current.parent.name.getText();
      return "<anonymous>";
    }
  }
  return "<top-level>";
}

function directCallers(sourceText, fileName, symbol) {
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const callers = [];
  const visit = node => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === symbol
    ) {
      callers.push(enclosingFunctionName(node));
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return callers;
}

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

function sameStrings(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * Check the launch-surface map and return every problem instead of exiting.
 * Tests inject a temporary root so fail-open mutations exercise this exact code.
 */
export function checkLaunchSurfaceDag({ rootDir = process.cwd(), dagPath = DAG_PATH } = {}) {
  const problems = [];
  const fileCache = new Map();
  const absolute = relative => path.resolve(rootDir, relative);
  const readSource = relative => {
    if (!fileCache.has(relative)) {
      try {
        fileCache.set(relative, fs.readFileSync(absolute(relative), "utf8"));
      } catch (error) {
        problems.push(`${relative}: cannot read source (${error.message})`);
        fileCache.set(relative, "");
      }
    }
    return fileCache.get(relative);
  };
  const linesOf = relative => readSource(relative).split("\n");

  let document;
  try {
    document = parseToml(fs.readFileSync(absolute(dagPath), "utf8"));
  } catch (error) {
    return {
      problems: [`${dagPath}: invalid or unreadable TOML (${error.message})`],
      nodesChecked: 0,
      invariantsChecked: 0,
      flowsChecked: 0,
    };
  }

  if (!isRecord(document.meta)) problems.push("meta: missing table");
  const nodes = Array.isArray(document.node) ? document.node : [];
  const invariants = Array.isArray(document.invariant) ? document.invariant : [];
  const flowCount = nodes.reduce(
    (count, node) => count + (isRecord(node) && Array.isArray(node.flow) ? node.flow.length : 0),
    0
  );
  const actualCounts = {
    node_count: nodes.length,
    invariant_count: invariants.length,
    flow_count: flowCount,
  };
  for (const [key, coverage] of Object.entries(REQUIRED_COVERAGE)) {
    const declared = document.meta?.[key];
    if (!Number.isInteger(declared)) {
      problems.push(`meta.${key}: missing integer coverage declaration`);
    } else if (declared !== coverage.expected) {
      problems.push(`meta.${key}: must remain ${coverage.expected}, declared ${declared}`);
    }
    if (actualCounts[key] !== coverage.expected) {
      problems.push(
        `coverage ${key}: requires ${coverage.expected} ${coverage.label}(s), parsed ${actualCounts[key]}`
      );
    }
  }

  const nodeIds = new Set();
  let nodesChecked = 0;
  let flowsChecked = 0;
  for (const [index, node] of nodes.entries()) {
    const label = `node[${index}]`;
    if (!isRecord(node)) {
      problems.push(`${label}: must be a table`);
      continue;
    }
    for (const field of ["id", "kind", "file", "role"]) {
      if (typeof node[field] !== "string" || node[field].length === 0) {
        problems.push(`${label}.${field}: missing non-empty string`);
      }
    }
    if (!Number.isInteger(node.line) || node.line < 1) {
      problems.push(`${label}.line: missing positive integer`);
    }
    if (!nonemptyStrings(node.affects))
      problems.push(`${label}.affects: missing non-empty string list`);
    if (typeof node.id === "string") {
      if (nodeIds.has(node.id)) problems.push(`${label}.id: duplicate ${node.id}`);
      nodeIds.add(node.id);
    }
    if (
      typeof node.id !== "string" ||
      typeof node.file !== "string" ||
      !Number.isInteger(node.line)
    ) {
      continue;
    }
    nodesChecked++;
    const symbol = node.id.split(".").slice(1).join(".");
    const lines = linesOf(node.file);
    if (node.line > lines.length) {
      problems.push(
        `${node.id}: ${node.file}:${node.line} is past end of file (${lines.length} lines)`
      );
    } else {
      const window = lines.slice(Math.max(0, node.line - 3), node.line + 2).join("\n");
      if (!window.includes(symbol)) {
        problems.push(`${node.id}: ${node.file}:${node.line} no longer declares "${symbol}"`);
      }
    }

    if (node.kind === "durable_field") {
      if (!Array.isArray(node.flow) || node.flow.length === 0) {
        problems.push(`${node.id}.flow: missing non-empty structured flow`);
        continue;
      }
      for (const [flowIndex, hop] of node.flow.entries()) {
        const hopLabel = `${node.id}.flow[${flowIndex}]`;
        if (!isRecord(hop)) {
          problems.push(`${hopLabel}: must be a table with file, line, token, and role`);
          continue;
        }
        for (const field of ["file", "token", "role"]) {
          if (typeof hop[field] !== "string" || hop[field].length === 0) {
            problems.push(`${hopLabel}.${field}: missing non-empty string`);
          }
        }
        if (!Number.isInteger(hop.line) || hop.line < 1) {
          problems.push(`${hopLabel}.line: missing positive integer`);
        }
        if (
          typeof hop.file !== "string" ||
          typeof hop.token !== "string" ||
          !Number.isInteger(hop.line)
        ) {
          continue;
        }
        flowsChecked++;
        const flowLines = linesOf(hop.file);
        const flowWindow = flowLines.slice(Math.max(0, hop.line - 2), hop.line + 1).join("\n");
        if (!flowWindow.includes(hop.token)) {
          problems.push(`${hopLabel}: ${hop.file}:${hop.line} no longer carries "${hop.token}"`);
        }
      }
    } else if (Object.hasOwn(node, "flow")) {
      problems.push(`${node.id}.flow: only durable_field nodes may declare a flow`);
    }
  }

  const invariantSymbols = new Set();
  let invariantsChecked = 0;
  const orchestratorFile = "src/validation-orchestrator.ts";
  const orchestratorSource = readSource(orchestratorFile);
  for (const [index, invariant] of invariants.entries()) {
    const label = `invariant[${index}]`;
    if (!isRecord(invariant)) {
      problems.push(`${label}: must be a table`);
      continue;
    }
    for (const field of ["symbol", "why"]) {
      if (typeof invariant[field] !== "string" || invariant[field].length === 0) {
        problems.push(`${label}.${field}: missing non-empty string`);
      }
    }
    if (!Number.isInteger(invariant.callers) || invariant.callers < 0) {
      problems.push(`${label}.callers: missing non-negative integer`);
    }
    if (!nonemptyStrings(invariant.expect)) {
      problems.push(`${label}.expect: missing non-empty string list`);
    }
    if (typeof invariant.symbol === "string") {
      if (invariantSymbols.has(invariant.symbol)) {
        problems.push(`${label}.symbol: duplicate ${invariant.symbol}`);
      }
      invariantSymbols.add(invariant.symbol);
    }
    if (
      typeof invariant.symbol !== "string" ||
      !Number.isInteger(invariant.callers) ||
      !nonemptyStrings(invariant.expect)
    ) {
      continue;
    }
    invariantsChecked++;
    const actualCallers = directCallers(orchestratorSource, orchestratorFile, invariant.symbol);
    const actualIdentities = sortedUnique(actualCallers);
    const expectedIdentities = sortedUnique(invariant.expect);
    if (actualCallers.length !== invariant.callers) {
      problems.push(
        `invariant ${invariant.symbol}: DAG says ${invariant.callers} call(s), source has ${actualCallers.length}`
      );
    }
    if (!sameStrings(actualIdentities, expectedIdentities)) {
      problems.push(
        `invariant ${invariant.symbol}: expected callers [${expectedIdentities.join(", ")}], found [${actualIdentities.join(", ")}]`
      );
    }
  }

  return { problems, nodesChecked, invariantsChecked, flowsChecked };
}

export function isDirectInvocation(metaUrl, argv1) {
  if (!argv1) return false;
  try {
    return fs.realpathSync(fileURLToPath(metaUrl)) === fs.realpathSync(argv1);
  } catch {
    return false;
  }
}

if (isDirectInvocation(import.meta.url, process.argv[1])) {
  const result = checkLaunchSurfaceDag();
  console.log(
    `checked ${result.nodesChecked} nodes, ${result.invariantsChecked} invariants, ${result.flowsChecked} flow hops`
  );
  if (result.problems.length === 0) {
    console.log("launch-surface DAG matches the code");
    process.exit(0);
  }
  console.error("\nlaunch-surface DAG has drifted from the code:\n");
  for (const problem of result.problems) console.error(`  - ${problem}`);
  console.error(
    "\nThe DAG is the map used to decide what a change affects. Fix the code or the map, but do not leave them disagreeing."
  );
  process.exit(1);
}
