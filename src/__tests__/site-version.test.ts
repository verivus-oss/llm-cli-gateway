import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Guard: every public static-site product-version surface must agree. Nothing
// reads package.json at Pages build time, so this makes drift a red build.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("static site product versions", () => {
  const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
    version: string;
    publicSiteVersion: string;
  };
  const pkgVersion = packageJson.version;
  const html = readFileSync(join(repoRoot, "site", "index.html"), "utf8");
  const serverCard = readFileSync(
    join(repoRoot, "site", ".well-known", "mcp", "server-card.json"),
    "utf8"
  );
  const mcpAlias = readFileSync(join(repoRoot, "site", ".well-known", "mcp.json"), "utf8");
  const toolsFixture = JSON.parse(
    readFileSync(join(repoRoot, "site", "tools.fixture.json"), "utf8")
  ) as { siteVersion?: unknown };
  const tools = readFileSync(join(repoRoot, "site", "tools.md"), "utf8");
  const openapi = JSON.parse(readFileSync(join(repoRoot, "site", "openapi.json"), "utf8")) as {
    info?: { version?: unknown };
  };

  // The site tracks the latest STABLE release (the npm `latest` tag). During a
  // prerelease cut (x.y.z-<id>) the site legitimately does NOT match package.json
  // and instead holds the last stable version, so for a prerelease we assert the
  // site still shows a valid stable version rather than matching the RC string.
  // Strict semver prerelease: dot-separated non-empty alphanumeric/hyphen
  // identifiers (matches sync-site-version.mjs; rejects `2.14.0-.`, `-rc..1`).
  const isPrerelease = /^\d+\.\d+\.\d+-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*$/.test(pkgVersion);
  const expectedSiteVersion = isPrerelease ? packageJson.publicSiteVersion : pkgVersion;

  it("package.json version is x.y.z or x.y.z-<prerelease>", () => {
    expect(pkgVersion).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/);
    expect(packageJson.publicSiteVersion).toMatch(/^\d+\.\d+\.\d+$/);
    if (!isPrerelease) expect(packageJson.publicSiteVersion).toBe(pkgVersion);
  });

  it("JSON-LD softwareVersion matches the independent package site-version target", () => {
    const m = html.match(/"softwareVersion":\s*"(\d+\.\d+\.\d+)"/);
    expect(m, "softwareVersion anchor not found in site/index.html").not.toBeNull();
    expect(m?.[1]).toBe(expectedSiteVersion);
  });

  it("footer version matches package.json (stable) or holds a stable version (prerelease)", () => {
    const m = html.match(/llm-cli-gateway v(\d+\.\d+\.\d+)<\/span>/);
    const homepage = html.match(/"softwareVersion":\s*"(\d+\.\d+\.\d+)"/)?.[1];
    expect(m, "footer version anchor not found in site/index.html").not.toBeNull();
    expect(homepage, "softwareVersion anchor not found in site/index.html").toBeDefined();
    expect(m?.[1]).toBe(homepage);
    expect(m?.[1]).toBe(expectedSiteVersion);
  });

  it("keeps machine-discovery and OpenAPI product versions aligned with the homepage target", () => {
    const homepage = html.match(/"softwareVersion":\s*"(\d+\.\d+\.\d+)"/)?.[1];
    const serverCardVersion = JSON.parse(serverCard).version;
    expect(homepage).toBeDefined();
    expect(serverCardVersion).toBe(homepage);
    expect(openapi.info?.version).toBe(homepage);
    expect(mcpAlias).toBe(serverCard);
    expect(toolsFixture.siteVersion).toBe(homepage);
    expect(tools).toContain(`- Public site version: \`${homepage}\``);
  });
});
