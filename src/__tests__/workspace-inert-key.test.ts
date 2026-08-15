import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Issue #272: `allow_unregistered_working_dir` is parsed and never read.
//
// It is deliberately still ACCEPTED, so existing configs keep loading, but its
// presence now warns. The danger it created was not the key itself: it was the
// silence. An operator setting it to `false` believed they had restricted where
// providers could be pointed, and nothing said otherwise.

function registrySource(): string {
  return readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "workspace-registry.ts"),
    "utf8"
  );
}

describe("issue #272: the inert workspace key warns instead of misleading", () => {
  it("is still parsed, so existing configs do not break", () => {
    expect(registrySource()).toContain("allow_unregistered_working_dir: z.boolean()");
  });

  it("warns at load when the operator actually set it", () => {
    const src = registrySource();
    expect(src).toContain('hasOwnProperty.call(raw, "allow_unregistered_working_dir")');
    expect(src).toContain("has NO EFFECT");
  });

  it("the warning names what DOES constrain workingDir, not just what does not", () => {
    // A warning that only says "this does nothing" leaves the operator with no
    // idea what to rely on instead, which is how the false belief formed.
    const src = registrySource();
    const at = src.indexOf("has NO EFFECT");
    const msg = src.slice(at, at + 600);
    expect(msg).toMatch(/workspace registration/i);
    expect(msg).toMatch(/executor|neutral-workspace/i);
  });

  it("STILL reads nowhere in production logic", () => {
    // The regression this guards: someone wires the field into a real decision
    // and the warning above becomes a lie in the other direction.
    const src = registrySource();
    const reads = src
      .split("\n")
      .filter(l => l.includes("allowUnregisteredWorkingDir"))
      .filter(l => !l.trim().startsWith("//"));
    // definition in the interface, assignment in the parsed result, and the
    // disabled-registry default. Three, and no conditional use.
    expect(reads.length).toBe(3);
    expect(reads.some(l => /if\s*\(.*allowUnregisteredWorkingDir/.test(l))).toBe(false);
  });
});
