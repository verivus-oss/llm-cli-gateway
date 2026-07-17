import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const validator = join(repoRoot, "scripts", "validate-site-discovery.mjs");
const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function copiedSite() {
  const directory = mkdtempSync(join(tmpdir(), "llm-gateway-site-validate-"));
  temporaryDirectories.push(directory);
  const site = join(directory, "site");
  cpSync(join(repoRoot, "site"), site, { recursive: true });
  return site;
}

function validate(site) {
  return spawnSync(process.execPath, [validator, `--site-dir=${site}`], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

describe("local site discovery validation", () => {
  it("passes with the shipped Cloudflare header mapping", () => {
    const result = validate(copiedSite());
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("site discovery validation passed (local)");
  });

  it("fails when site/_headers declares the wrong content type", () => {
    const site = copiedSite();
    const headersPath = join(site, "_headers");
    writeFileSync(
      headersPath,
      `${readFileSync(headersPath, "utf8")}\n/llms.txt\n  Content-Type: application/octet-stream\n`
    );

    const result = validate(site);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      '/llms.txt content-type "application/octet-stream" does not start with "text/plain"'
    );
  });

  it("fails on a broken self-link in a non-route site file", () => {
    // site/maintainers.md is not in the enumerated route list, so the old
    // route-only validator never saw its links while lychee's whole-domain
    // exclusion skipped them too. The repo-wide sweep must catch this.
    const site = copiedSite();
    const maintainers = join(site, "maintainers.md");
    writeFileSync(
      maintainers,
      `${readFileSync(maintainers, "utf8")}\n[dead](https://llm-cli-gateway.dev/does-not-exist.md)\n`
    );

    const result = validate(site);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("does-not-exist.md");
    expect(result.stderr).toContain("returned 404");
  });

  it("fails on a broken Markdown heading fragment in a self-link", () => {
    const site = copiedSite();
    const maintainers = join(site, "maintainers.md");
    writeFileSync(
      maintainers,
      `${readFileSync(maintainers, "utf8")}\n[bad anchor](https://llm-cli-gateway.dev/install.md#definitely-not-a-real-anchor-xyz)\n`
    );

    const result = validate(site);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("absent from the headings");
  });

  it("treats a directory-resolving self-link as a clean 404, not an EISDIR crash", () => {
    // site/guides/ is a directory; a trailing-slash self-link must fail cleanly
    // rather than throw an uncaught EISDIR from readFileSync.
    const site = copiedSite();
    const maintainers = join(site, "maintainers.md");
    writeFileSync(
      maintainers,
      `${readFileSync(maintainers, "utf8")}\n[dir](https://llm-cli-gateway.dev/guides/)\n`
    );

    const result = validate(site);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("returned 404");
    expect(result.stderr).not.toContain("EISDIR");
  });

  it("resolves a duplicate-heading fragment via the -1 disambiguator", () => {
    const site = copiedSite();
    writeFileSync(join(site, "dup.md"), "# Title\n\n## Setup\n\nfirst\n\n## Setup\n\nsecond\n");
    const maintainers = join(site, "maintainers.md");
    writeFileSync(
      maintainers,
      `${readFileSync(maintainers, "utf8")}\n[second setup](https://llm-cli-gateway.dev/dup.md#setup-1)\n`
    );

    const result = validate(site);
    expect(result.status).toBe(0);
  });

  it("fails on a duplicate-heading fragment past the last disambiguator", () => {
    const site = copiedSite();
    writeFileSync(join(site, "dup.md"), "# Title\n\n## Setup\n\nfirst\n\n## Setup\n\nsecond\n");
    const maintainers = join(site, "maintainers.md");
    writeFileSync(
      maintainers,
      `${readFileSync(maintainers, "utf8")}\n[missing](https://llm-cli-gateway.dev/dup.md#setup-9)\n`
    );

    const result = validate(site);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("absent from the headings");
  });

  it("fails when public guidance overgeneralizes Codex stdin prompt support", () => {
    const site = copiedSite();
    const llmsPath = join(site, "llms.txt");
    writeFileSync(
      llmsPath,
      readFileSync(llmsPath, "utf8").replace(
        "Codex new and resume prompts use stdin.",
        "Codex prompts use stdin."
      )
    );

    const result = validate(site);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/overgeneralizes Codex stdin support|missing the Codex prompt/);
  });
});
