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
