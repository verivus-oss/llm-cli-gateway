#!/usr/bin/env node
// Release-only strip step. Overwrites the compiled internal MCP registry
// (`dist/mcp-registry.js` + `.d.ts`) with an empty stub so the published tarball
// carries zero internal MCP server names or host commands. Every other module
// imports only the two public symbols below (and `ClaudeMcpServerName` is a
// plain `string` alias), so stubbing this one file removes every internal name
// from the shipped bytes.
//
// CRITICAL: this MUST run as an EXPLICIT release step, never as a package.json
// lifecycle script — the publish job runs `npm publish --ignore-scripts`, which
// would skip a `prepack`/`prepare` hook entirely (see the v5 plan, §4f). It is
// wired:
//   - .github/workflows/npm-publish.yml — after `npm run security:audit` (whose
//     internal `npm run build` is the last rebuild) and before `npm pack`/publish.
//   - scripts/pre-release.sh — as the FINAL step, after verify-registry-install.sh
//     (which does an unflagged Verdaccio publish that rebuilds dist).
//
// Idempotent: re-running on an already-stripped dist is a no-op rewrite. Run
// `npm run build` to restore the full registry for local development.

import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const JS_PATH = join(ROOT, "dist", "mcp-registry.js");
const DTS_PATH = join(ROOT, "dist", "mcp-registry.d.ts");

// ESM stub — matches `"type":"module"` + NodeNext emit. The empty registry and
// name list are the documented stripped-build runtime: open `z.string()` schema,
// no per-server approval weight, unknown names fall back to Codex MCP config.
const JS_STUB = `// Stripped at release time by scripts/strip-internal-mcp.mjs.
// The internal MCP registry is intentionally empty in published builds; the
// gateway resolves MCP server names from the host's Codex MCP config instead.
export const INTERNAL_MCP_REGISTRY = {};
export const CLAUDE_MCP_SERVER_NAMES = [];
`;

// The stub .d.ts must present the SAME public type surface as the source module
// so a published build's types match a dev build's: the two runtime const
// exports PLUS the `ClaudeServerDef`/`RegistryEntry` interfaces the source
// exports (ClaudeServerDef is type-imported by claude-mcp-config.ts). Only the
// internal NAME/command literals are stripped — none of these declarations
// contain any, so the surface stays identical while the data goes empty. This
// mirrors the tsc-emitted dist/mcp-registry.d.ts exactly (sans implementation).
const DTS_STUB = `export interface ClaudeServerDef {
    command: string;
    args: string[];
    env?: Record<string, string>;
}
export interface RegistryEntry {
    defaultDef: () => ClaudeServerDef;
    forwardEnv?: readonly string[];
    requireEnv?: readonly string[];
    approval?: {
        score: number;
        reason: string;
    };
}
export declare const INTERNAL_MCP_REGISTRY: Record<string, RegistryEntry>;
export declare const CLAUDE_MCP_SERVER_NAMES: readonly string[];
`;

let failed = false;
for (const path of [JS_PATH, DTS_PATH]) {
  if (!existsSync(path)) {
    console.error(
      `strip-internal-mcp: ${path} not found — run \`npm run build\` before stripping.`
    );
    failed = true;
  }
}
if (failed) {
  process.exit(1);
}

writeFileSync(JS_PATH, JS_STUB, "utf8");
writeFileSync(DTS_PATH, DTS_STUB, "utf8");

console.log(
  "strip-internal-mcp: stubbed dist/mcp-registry.js + dist/mcp-registry.d.ts " +
    "(internal MCP names removed from the build)."
);
