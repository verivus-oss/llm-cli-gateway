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

  // The site tracks the latest STABLE release (the npm `latest` tag). During a
  // prerelease cut (x.y.z-<id>) the site legitimately does NOT match package.json
  // and instead holds the last stable version, so for a prerelease we assert the
  // site still shows a valid stable version rather than matching the RC string.
  // Strict semver prerelease: dot-separated non-empty alphanumeric/hyphen
  // identifiers (matches sync-site-version.mjs; rejects `2.14.0-.`, `-rc..1`).
  const isPrerelease = /^\d+\.\d+\.\d+-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*$/.test(pkgVersion);

  it("package.json version is x.y.z or x.y.z-<prerelease>", () => {
    expect(pkgVersion).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/);
  });

  it("JSON-LD softwareVersion matches package.json (stable) or holds a stable version (prerelease)", () => {
    const m = html.match(/"softwareVersion":\s*"(\d+\.\d+\.\d+)"/);
    expect(m, "softwareVersion anchor not found in site/index.html").not.toBeNull();
    if (isPrerelease) {
      expect(m?.[1]).toMatch(/^\d+\.\d+\.\d+$/);
    } else {
      expect(m?.[1]).toBe(pkgVersion);
    }
  });

  it("footer version matches package.json (stable) or holds a stable version (prerelease)", () => {
    const m = html.match(/llm-cli-gateway v(\d+\.\d+\.\d+)<\/span>/);
    expect(m, "footer version anchor not found in site/index.html").not.toBeNull();
    if (isPrerelease) {
      expect(m?.[1]).toMatch(/^\d+\.\d+\.\d+$/);
    } else {
      expect(m?.[1]).toBe(pkgVersion);
    }
  });
});
