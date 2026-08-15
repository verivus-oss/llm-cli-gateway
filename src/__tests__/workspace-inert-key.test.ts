import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWorkspaceRegistry } from "../workspace-registry.js";
import type { Logger } from "../logger.js";

// Issue #272: `allow_unregistered_working_dir` is parsed and never read.
//
// It is deliberately still ACCEPTED, so existing configs keep loading, but its
// presence now warns. The danger was never the key: it was the SILENCE. An
// operator setting it to `false` believed they had restricted where providers
// could be pointed, and nothing said otherwise.
//
// These tests drive loadWorkspaceRegistry for real. An earlier version of this
// file asserted against source TEXT, which Mistral correctly blocked: a
// regression that stopped the warning firing at runtime would have passed.

let dir: string;
let warnings: { message: string; meta?: unknown }[];

function capturingLogger(): Logger {
  return {
    info: () => {},
    debug: () => {},
    error: () => {},
    warn: (message: string, meta?: unknown) => warnings.push({ message, meta }),
  } as unknown as Logger;
}

function configWith(body: string): string {
  const path = join(dir, "config.toml");
  writeFileSync(path, body);
  return path;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gtwy-272-"));
  warnings = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const warned = () =>
  warnings.some(w => w.message.includes("allow_unregistered_working_dir"));

describe("issue #272: the inert workspace key warns instead of misleading", () => {
  it("warns when the operator sets it to false", () => {
    // The real-world case. false is the setting that produces false confidence.
    loadWorkspaceRegistry(
      capturingLogger(),
      configWith('[workspaces]\nallow_unregistered_working_dir = false\n')
    );
    expect(warned()).toBe(true);
  });

  it("warns when the operator sets it to true", () => {
    loadWorkspaceRegistry(
      capturingLogger(),
      configWith('[workspaces]\nallow_unregistered_working_dir = true\n')
    );
    expect(warned()).toBe(true);
  });

  it("does NOT warn when the key is absent", () => {
    // Negative control. The schema defaults it to false, so a value-based check
    // would warn for every config on earth and be filtered as noise within a
    // day. This is why the implementation tests PRESENCE in the raw config.
    loadWorkspaceRegistry(capturingLogger(), configWith('[workspaces]\ndefault = ""\n'));
    expect(warned()).toBe(false);
  });

  it("the warning names what DOES constrain workingDir", () => {
    loadWorkspaceRegistry(
      capturingLogger(),
      configWith('[workspaces]\nallow_unregistered_working_dir = false\n')
    );
    const msg = warnings.map(w => w.message).join(" ");
    // A warning that only says "this does nothing" leaves the operator with no
    // idea what to rely on instead, which is how the false belief formed.
    expect(msg).toMatch(/workspace registration/i);
    expect(msg).toMatch(/executor|neutral-workspace/i);
  });

  it("the config still LOADS with the key present", () => {
    // It must remain accepted: warning is not the same as rejecting, and
    // breaking existing configs would be a worse outcome than the false name.
    const registry = loadWorkspaceRegistry(
      capturingLogger(),
      configWith('[workspaces]\nallow_unregistered_working_dir = true\n')
    );
    expect(registry).toBeDefined();
    expect(registry.sources.configFile).not.toBeNull();
  });

  it("STILL reads nowhere in production logic", () => {
    // Guards the opposite regression: if someone wires the field into a real
    // decision, the warning above becomes a lie in the other direction.
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const { fileURLToPath } = require("node:url") as typeof import("node:url");
    const { dirname } = require("node:path") as typeof import("node:path");
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "workspace-registry.ts"),
      "utf8"
    );
    const reads = src
      .split("\n")
      .filter(l => l.includes("allowUnregisteredWorkingDir"))
      .filter(l => !l.trim().startsWith("//"));
    expect(reads.length).toBe(3);
    expect(reads.some(l => /if\s*\(.*allowUnregisteredWorkingDir/.test(l))).toBe(false);
  });
});
