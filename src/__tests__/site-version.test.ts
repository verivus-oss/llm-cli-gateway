import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Guard: the static marketing site (site/index.html) carries the version in two
// hard-coded places, and nothing reads package.json at build time. Without this
// guard the site drifts silently (it sat at 2.6.0 through the 2.7/2.8/2.9
// releases). A mismatch here is a red build; `node scripts/sync-site-version.mjs`
// is the fix.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("site/index.html version is in sync with package.json", () => {
  const pkgVersion: string = JSON.parse(
    readFileSync(join(repoRoot, "package.json"), "utf8")
  ).version;
  const html = readFileSync(join(repoRoot, "site", "index.html"), "utf8");

  it("package.json version is a plain x.y.z string", () => {
    expect(pkgVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("JSON-LD softwareVersion matches package.json", () => {
    const m = html.match(/"softwareVersion":\s*"(\d+\.\d+\.\d+)"/);
    expect(m, "softwareVersion anchor not found in site/index.html").not.toBeNull();
    expect(m?.[1]).toBe(pkgVersion);
  });

  it("footer version matches package.json", () => {
    const m = html.match(/llm-cli-gateway v(\d+\.\d+\.\d+)<\/span>/);
    expect(m, "footer version anchor not found in site/index.html").not.toBeNull();
    expect(m?.[1]).toBe(pkgVersion);
  });
});
