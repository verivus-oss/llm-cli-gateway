import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { syncSiteVersion } from "./sync-site-version.mjs";

const temporaryRoots = [];

function siteIndex(homepageVersion, footerVersion = homepageVersion) {
  return `<!doctype html>
<script type="application/ld+json">{"softwareVersion": "${homepageVersion}"}</script>
<span>llm-cli-gateway v${footerVersion}</span>
`;
}

function createFixture({
  packageVersion,
  homepageVersion,
  publicSiteVersion = homepageVersion,
  footerVersion = homepageVersion,
  serverCardVersion,
  mcpAliasVersion = serverCardVersion,
  openapiVersion,
}) {
  const root = mkdtempSync(join(tmpdir(), "llm-gateway-site-version-"));
  temporaryRoots.push(root);
  mkdirSync(join(root, "site", ".well-known", "mcp"), { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ version: packageVersion, publicSiteVersion }, null, 2)}\n`,
    "utf8"
  );
  writeFileSync(
    join(root, "site", "index.html"),
    siteIndex(homepageVersion, footerVersion),
    "utf8"
  );
  writeFileSync(
    join(root, "site", ".well-known", "mcp", "server-card.json"),
    `${JSON.stringify({ name: "gateway", version: serverCardVersion }, null, 2)}\n`,
    "utf8"
  );
  writeFileSync(
    join(root, "site", ".well-known", "mcp.json"),
    `${JSON.stringify({ name: "gateway", version: mcpAliasVersion }, null, 2)}\n`,
    "utf8"
  );
  writeFileSync(
    join(root, "site", "openapi.json"),
    `${JSON.stringify({ openapi: "3.1.0", info: { version: openapiVersion } }, null, 2)}\n`,
    "utf8"
  );
  return root;
}

function versions(root) {
  const index = readFileSync(join(root, "site", "index.html"), "utf8");
  const serverCard = JSON.parse(
    readFileSync(join(root, "site", ".well-known", "mcp", "server-card.json"), "utf8")
  );
  const mcpAlias = readFileSync(join(root, "site", ".well-known", "mcp.json"), "utf8");
  const openapi = JSON.parse(readFileSync(join(root, "site", "openapi.json"), "utf8"));
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  return {
    publicSiteVersion: packageJson.publicSiteVersion,
    homepage: index.match(/"softwareVersion":\s*"(\d+\.\d+\.\d+)"/)?.[1],
    footer: index.match(/llm-cli-gateway v(\d+\.\d+\.\d+)<\/span>/)?.[1],
    serverCard: serverCard.version,
    openapi: openapi.info.version,
    mcpAlias,
    serverCardContent: readFileSync(
      join(root, "site", ".well-known", "mcp", "server-card.json"),
      "utf8"
    ),
  };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("sync-site-version", () => {
  it("synchronizes every public version surface for a stable release", () => {
    const root = createFixture({
      packageVersion: "2.18.0",
      homepageVersion: "2.17.1",
      serverCardVersion: "2.17.1",
      openapiVersion: "2.17.1",
    });

    expect(syncSiteVersion({ rootDirectory: root })).toMatchObject({
      packageVersion: "2.18.0",
      targetVersion: "2.18.0",
      prerelease: false,
    });
    expect(versions(root)).toMatchObject({
      publicSiteVersion: "2.18.0",
      homepage: "2.18.0",
      footer: "2.18.0",
      serverCard: "2.18.0",
      openapi: "2.18.0",
    });
    expect(versions(root).mcpAlias).toBe(versions(root).serverCardContent);
    expect(() => syncSiteVersion({ rootDirectory: root, checkOnly: true })).not.toThrow();
  });

  it("rejects stale discovery metadata during an RC check and repairs it to the stable target", () => {
    const root = createFixture({
      packageVersion: "2.18.0-rc.1",
      homepageVersion: "2.17.1",
      serverCardVersion: "2.13.2",
      openapiVersion: "2.13.2",
    });

    expect(() => syncSiteVersion({ rootDirectory: root, checkOnly: true })).toThrow(
      /server-card\.json version/
    );
    expect(syncSiteVersion({ rootDirectory: root })).toMatchObject({
      targetVersion: "2.17.1",
      prerelease: true,
    });
    expect(versions(root)).toMatchObject({
      homepage: "2.17.1",
      footer: "2.17.1",
      serverCard: "2.17.1",
      openapi: "2.17.1",
    });
    expect(versions(root).mcpAlias).toBe(versions(root).serverCardContent);
    expect(() => syncSiteVersion({ rootDirectory: root, checkOnly: true })).not.toThrow();
  });

  it("rejects an internally consistent RC site that differs from package truth", () => {
    const root = createFixture({
      packageVersion: "2.18.0-rc.1",
      publicSiteVersion: "2.17.1",
      homepageVersion: "2.16.0",
      serverCardVersion: "2.16.0",
      openapiVersion: "2.16.0",
    });

    expect(() => syncSiteVersion({ rootDirectory: root, checkOnly: true })).toThrow(
      /JSON-LD softwareVersion: site has 2\.16\.0, expected 2\.17\.1/
    );
  });

  it("rejects an inconsistent RC homepage and production deployment of an RC", () => {
    const root = createFixture({
      packageVersion: "2.18.0-rc.1",
      homepageVersion: "2.17.1",
      footerVersion: "2.16.0",
      serverCardVersion: "2.17.1",
      openapiVersion: "2.17.1",
    });

    expect(() => syncSiteVersion({ rootDirectory: root, checkOnly: true })).toThrow(
      /footer version/
    );
    expect(() =>
      syncSiteVersion({ rootDirectory: root, checkOnly: true, requireStable: true })
    ).toThrow(/Refusing a production Pages deployment/);
  });
});
