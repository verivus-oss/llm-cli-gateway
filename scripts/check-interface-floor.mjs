#!/usr/bin/env node
// The TOOL SURFACE never gets poorer than it has been.
//
// The capability floor guards what argv the gateway will ACCEPT. Nothing guarded
// what the tool schema TELLS A CALLER, and on 2026-08-19 that surface silently
// got worse: grok `effort` carried a five-value enum, the enum was wrong (it
// refused input the binary parses), and the fix deleted it outright. Correctness
// improved and the interface degraded, and every gate stayed green because none
// of them reads the schema.
//
// A typed parameter that tells the caller what is valid is the product. Losing
// one is a regression even when the reason for losing it is good, so it has to
// be a decision somebody makes rather than a side effect nobody sees.
//
// FAILS ON: a parameter disappearing, an enum disappearing, an enum value
// disappearing, or a described parameter losing its description.
// FREE: adding parameters, adding enum values, adding enums, rewording.
//
//   node scripts/check-interface-floor.mjs           # verify
//   node scripts/check-interface-floor.mjs --update  # record ADDITIONS only
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const FLOOR = join(REPO, "seed", "interface-floor.json");
const FIXTURE = join(REPO, "site", "tools.fixture.json");
const UPDATE = process.argv.includes("--update");

/** Enum members of a property, however the schema spells them. */
export function enumOf(property) {
  if (Array.isArray(property?.enum)) return property.enum.map(String);
  const fromAnyOf = (property?.anyOf ?? []).flatMap(branch => branch?.enum ?? []);
  return fromAnyOf.length > 0 ? fromAnyOf.map(String) : [];
}

/**
 * One token per promise the schema makes to a caller.
 *
 * `tool.param` is the parameter existing. `tool.param:enum` is the promise that
 * the set is closed and enumerated, which is the promise `effort` lost.
 * `tool.param=value` is one member of it. `tool.param:described` is the promise
 * that the field explains itself.
 */
export function promises(fixture) {
  const tools = Array.isArray(fixture) ? fixture : (fixture.tools ?? []);
  const out = {};
  for (const tool of tools) {
    const properties = tool.inputSchema?.properties ?? {};
    const tokens = [];
    for (const [name, property] of Object.entries(properties)) {
      tokens.push(name);
      const members = enumOf(property);
      if (members.length > 0) {
        tokens.push(`${name}:enum`);
        for (const member of members) tokens.push(`${name}=${member}`);
      }
      if (typeof property?.description === "string" && property.description.length > 0) {
        tokens.push(`${name}:described`);
      }
    }
    out[tool.name] = [...new Set(tokens)].sort();
  }
  return out;
}

/** Promises the floor records that the surface no longer makes. */
export function broken(floor, current) {
  const lost = [];
  for (const [tool, tokens] of Object.entries(floor)) {
    if (tool === "__schema") continue;
    const present = new Set(current[tool] ?? []);
    const missing = tokens.filter(token => !present.has(token));
    if (missing.length > 0) lost.push({ tool, missing });
  }
  return lost;
}

/** Union, so the floor only ever grows. */
export function mergeFloor(floor, current) {
  const merged = {};
  for (const tool of new Set([...Object.keys(floor), ...Object.keys(current)])) {
    if (tool === "__schema") continue;
    merged[tool] = [...new Set([...(floor[tool] ?? []), ...(current[tool] ?? [])])].sort();
  }
  return merged;
}

function main() {
  if (!existsSync(FIXTURE)) {
    console.error(`missing ${FIXTURE}; run npm run site:generate first`);
    process.exit(1);
  }
  const current = promises(JSON.parse(readFileSync(FIXTURE, "utf8")));
  const floor = existsSync(FLOOR) ? JSON.parse(readFileSync(FLOOR, "utf8")) : {};
  const lost = broken(floor, current);

  if (lost.length > 0) {
    console.error("interface floor breached: the tool surface tells callers LESS than it has.");
    for (const { tool, missing } of lost) console.error(`  ${tool}: ${missing.join(" ")}`);
    console.error(
      "\nA `:enum` token means the schema promised a closed, enumerated set and no\n" +
        "longer does. If the set was wrong, the policy answer is that `values` becomes\n" +
        "DESCRIPTION and never rejects: keep telling the caller, stop refusing them.\n" +
        "If the loss is intended, edit seed/interface-floor.json by hand so it is\n" +
        "visible in review."
    );
    process.exit(1);
  }

  if (UPDATE) {
    writeFileSync(
      FLOOR,
      `${JSON.stringify({ __schema: ["param", "param:enum", "param=value", "param:described"], ...mergeFloor(floor, current) }, null, 2)}\n`
    );
    console.log(`interface floor updated: ${Object.keys(current).length} tools`);
    return;
  }

  const tools = Object.keys(floor).filter(key => key !== "__schema");
  const total = tools.reduce((sum, tool) => sum + floor[tool].length, 0);
  console.log(`interface floor: ${total} promises across ${tools.length} tools, none broken`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
