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

  it("does not close a fenced block on a mixed-delimiter line", () => {
    // A ```~ line is not a valid close for a backtick fence, so the block stays
    // open until the real close: "# After" is kept, the phantoms are dropped.
    const f3 = "`".repeat(3);
    const mixed = "`".repeat(3) + "~";
    const content = ["# Real", f3, "# Phantom A", mixed, "# Phantom B", f3, "# After", ""].join(
      "\n"
    );

    const site = copiedSite();
    writeFileSync(join(site, "mix.md"), content);
    const m1 = join(site, "maintainers.md");
    writeFileSync(
      m1,
      `${readFileSync(m1, "utf8")}\n[after](https://llm-cli-gateway.dev/mix.md#after)\n`
    );
    expect(validate(site).status).toBe(0);

    const site2 = copiedSite();
    writeFileSync(join(site2, "mix.md"), content);
    const m2 = join(site2, "maintainers.md");
    writeFileSync(
      m2,
      `${readFileSync(m2, "utf8")}\n[phantom](https://llm-cli-gateway.dev/mix.md#phantom-b)\n`
    );
    expect(validate(site2).status).toBe(1);
  });

  it("does not treat a backtick fence with a backtick info string as a fence", () => {
    // ```lang`x is not a GFM fence open, so it must not swallow the heading that
    // follows it to the end of the document.
    const badOpen = "`".repeat(3) + "lang`bad";
    const content = ["# Real", badOpen, "# Should Still Exist", "end", ""].join("\n");

    const site = copiedSite();
    writeFileSync(join(site, "info.md"), content);
    const maintainers = join(site, "maintainers.md");
    writeFileSync(
      maintainers,
      `${readFileSync(maintainers, "utf8")}\n[still here](https://llm-cli-gateway.dev/info.md#should-still-exist)\n`
    );

    expect(validate(site).status).toBe(0);
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

  it("keeps underscores in heading slugs like GitHub", () => {
    // The repo's docs use identifier headings (codex_request, llm_job_status).
    // The slug must retain underscores, so #codex_request resolves and the
    // underscore-stripped #codexrequest does not.
    const site = copiedSite();
    writeFileSync(join(site, "id.md"), "# Title\n\n## codex_request\n\nbody\n");
    const maintainers = join(site, "maintainers.md");
    writeFileSync(
      maintainers,
      `${readFileSync(maintainers, "utf8")}\n[ok](https://llm-cli-gateway.dev/id.md#codex_request)\n`
    );
    expect(validate(site).status).toBe(0);

    const site2 = copiedSite();
    writeFileSync(join(site2, "id.md"), "# Title\n\n## codex_request\n\nbody\n");
    const maintainers2 = join(site2, "maintainers.md");
    writeFileSync(
      maintainers2,
      `${readFileSync(maintainers2, "utf8")}\n[stripped](https://llm-cli-gateway.dev/id.md#codexrequest)\n`
    );
    expect(validate(site2).status).toBe(1);
  });

  it("does not mint an anchor from an explicit id inside a fenced block", () => {
    // An <a id> or {#custom-id} written as an EXAMPLE inside a code fence is
    // documentation, not a live anchor. A fragment pointing at it must 404.
    const fence = "`".repeat(3);
    const content = [
      "# Real",
      "",
      fence,
      '<a id="fenced-html-id"></a>',
      "## Fenced Heading {#fenced-custom-id}",
      fence,
      "",
      "body",
      "",
    ].join("\n");

    for (const anchor of ["fenced-html-id", "fenced-custom-id"]) {
      const site = copiedSite();
      writeFileSync(join(site, "anc.md"), content);
      const maintainers = join(site, "maintainers.md");
      writeFileSync(
        maintainers,
        `${readFileSync(maintainers, "utf8")}\n[x](https://llm-cli-gateway.dev/anc.md#${anchor})\n`
      );
      const result = validate(site);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("absent from the headings");
    }
  });

  it("resolves a heading after a CRLF-authored fenced block", () => {
    // A Windows (CRLF) file's fence close is ```\r\n. If the scanner splits on
    // "\n" only, the trailing \r defeats the close anchor and the fence runs to
    // EOF, hiding every heading after it. The heading fragment must resolve.
    const fence = "`".repeat(3);
    const content = [
      "# Real",
      "",
      fence,
      "code line",
      fence,
      "",
      "## After Fence",
      "",
      "body",
      "",
    ].join("\r\n");

    const site = copiedSite();
    writeFileSync(join(site, "crlf.md"), content);
    const maintainers = join(site, "maintainers.md");
    writeFileSync(
      maintainers,
      `${readFileSync(maintainers, "utf8")}\n[after](https://llm-cli-gateway.dev/crlf.md#after-fence)\n`
    );
    expect(validate(site).status).toBe(0);
  });

  it("mints an anchor for a Setext (underlined) heading", () => {
    const site = copiedSite();
    writeFileSync(
      join(site, "setext.md"),
      "Top Title\n=========\n\nSubsection Two\n--------------\n\nbody\n"
    );
    const maintainers = join(site, "maintainers.md");
    writeFileSync(
      maintainers,
      `${readFileSync(maintainers, "utf8")}\n[h1](https://llm-cli-gateway.dev/setext.md#top-title)\n[h2](https://llm-cli-gateway.dev/setext.md#subsection-two)\n`
    );
    expect(validate(site).status).toBe(0);

    const site2 = copiedSite();
    writeFileSync(join(site2, "setext.md"), "Top Title\n=========\n\nbody\n");
    const maintainers2 = join(site2, "maintainers.md");
    writeFileSync(
      maintainers2,
      `${readFileSync(maintainers2, "utf8")}\n[hr](https://llm-cli-gateway.dev/setext.md#no-such-heading)\n`
    );
    expect(validate(site2).status).toBe(1);
  });

  it("keeps a code-span identifier's trailing underscore in the slug", () => {
    // A heading like `## \`output_\`` is a code span: GitHub renders the
    // underscore literally, so the slug is "output_", not "output". Pinned so the
    // slugger never drops a trailing identifier underscore (a regression an
    // emphasis-stripping attempt introduced).
    const site = copiedSite();
    writeFileSync(join(site, "ident.md"), "# Title\n\n## `output_`\n\nbody\n");
    const maintainers = join(site, "maintainers.md");
    writeFileSync(
      maintainers,
      `${readFileSync(maintainers, "utf8")}\n[id](https://llm-cli-gateway.dev/ident.md#output_)\n`
    );
    expect(validate(site).status).toBe(0);

    const site2 = copiedSite();
    writeFileSync(join(site2, "ident.md"), "# Title\n\n## `output_`\n\nbody\n");
    const maintainers2 = join(site2, "maintainers.md");
    writeFileSync(
      maintainers2,
      `${readFileSync(maintainers2, "utf8")}\n[stripped](https://llm-cli-gateway.dev/ident.md#output)\n`
    );
    expect(validate(site2).status).toBe(1);
  });

  it("slugs a multiline Setext heading from all its paragraph lines", () => {
    // GFM: a Setext underline turns the WHOLE preceding paragraph into the
    // heading, so "First Line\nSecond Line\n---" slugs to first-line-second-line,
    // not just second-line.
    const site = copiedSite();
    writeFileSync(join(site, "ml.md"), "# Title\n\nFirst Line\nSecond Line\n-----------\n\nbody\n");
    const maintainers = join(site, "maintainers.md");
    writeFileSync(
      maintainers,
      `${readFileSync(maintainers, "utf8")}\n[ml](https://llm-cli-gateway.dev/ml.md#first-line-second-line)\n`
    );
    expect(validate(site).status).toBe(0);

    const site2 = copiedSite();
    writeFileSync(
      join(site2, "ml.md"),
      "# Title\n\nFirst Line\nSecond Line\n-----------\n\nbody\n"
    );
    const maintainers2 = join(site2, "maintainers.md");
    writeFileSync(
      maintainers2,
      `${readFileSync(maintainers2, "utf8")}\n[partial](https://llm-cli-gateway.dev/ml.md#second-line)\n`
    );
    expect(validate(site2).status).toBe(1);
  });

  it("keeps a real heading at column zero after four-space-indented backticks", () => {
    // A four-space-indented run of backticks is not a top-level fence (fence
    // indent is <=3 spaces), so it is not stripped and does not swallow the real
    // "# Heading" at column zero right after it, which must resolve.
    const site = copiedSite();
    writeFileSync(join(site, "ic.md"), "    ```\n# Live Heading\n    ```\n\nbody\n");
    const maintainers = join(site, "maintainers.md");
    writeFileSync(
      maintainers,
      `${readFileSync(maintainers, "utf8")}\n[live](https://llm-cli-gateway.dev/ic.md#live-heading)\n`
    );
    expect(validate(site).status).toBe(0);
  });

  it("keeps an indented explicit anchor as a live anchor", () => {
    // Indented (non-fenced) content is not stripped, so an <a id> on an indented
    // line stays a live anchor and resolves. This is the fail-open direction of
    // the documented best-effort scope (never a false CI failure).
    const site = copiedSite();
    writeFileSync(join(site, "pc.md"), '# T\n\nParagraph text\n    <a id="active"></a>\n\nbody\n');
    const maintainers = join(site, "maintainers.md");
    writeFileSync(
      maintainers,
      `${readFileSync(maintainers, "utf8")}\n[a](https://llm-cli-gateway.dev/pc.md#active)\n`
    );
    expect(validate(site).status).toBe(0);
  });

  it("stays linear on a hash-heavy heading line and an unclosed-bracket file", () => {
    // The ATX capture is greedy-to-EOL with a code-side close-hash strip, and the
    // markdown-link text run is bounded, so neither goes quadratic.
    const site = copiedSite();
    writeFileSync(join(site, "hash.md"), `# ${"#".repeat(30000)}x\n`);
    writeFileSync(join(site, "install.md"), "[".repeat(60000));
    const maintainers = join(site, "maintainers.md");
    writeFileSync(
      maintainers,
      `${readFileSync(maintainers, "utf8")}\n[h](https://llm-cli-gateway.dev/hash.md#missing)\n`
    );
    const start = Date.now();
    const result = validate(site);
    expect(result.status).toBe(1);
    expect(Date.now() - start).toBeLessThan(3000);
  });

  it("stays linear on a wildcard-heavy header rule and many fragments to one target", () => {
    // The header wildcard collapses consecutive `*` (so "***" does not become a
    // catastrophic ".*.*.*"), and a target's anchors are parsed once per file
    // rather than once per link, so neither of these repo-controlled inputs is
    // quadratic.
    const site = copiedSite();
    const headersPath = join(site, "_headers");
    writeFileSync(
      headersPath,
      `${readFileSync(headersPath, "utf8")}\n/${"*".repeat(16)}X\n  Content-Type: text/plain\n`
    );
    const n = 3000;
    const headings = Array.from({ length: n }, (_, i) => `## h${i}`).join("\n\n");
    const links = Array.from(
      { length: n },
      (_, i) => `[l${i}](https://llm-cli-gateway.dev/big.md#h${i})`
    ).join("\n");
    writeFileSync(join(site, "big.md"), `# T\n\n${headings}\n`);
    const maintainers = join(site, "maintainers.md");
    writeFileSync(maintainers, `${readFileSync(maintainers, "utf8")}\n${links}\n`);
    const start = Date.now();
    const result = validate(site);
    expect(result.status).toBe(0);
    expect(Date.now() - start).toBeLessThan(3000);
  });

  it("stays linear on a malformed run of <a prefixes (no quadratic anchor scan)", () => {
    // A file of many "<a " with no closing ">" must not make the explicit-anchor
    // regex scan to EOF from every position. Bound the run and assert it is fast.
    const site = copiedSite();
    writeFileSync(join(site, "q.md"), "<a ".repeat(40000));
    const maintainers = join(site, "maintainers.md");
    writeFileSync(
      maintainers,
      `${readFileSync(maintainers, "utf8")}\n[q](https://llm-cli-gateway.dev/q.md#missing)\n`
    );
    const start = Date.now();
    const result = validate(site);
    const elapsed = Date.now() - start;
    expect(result.status).toBe(1);
    expect(elapsed).toBeLessThan(3000);
  });

  it("does not mint an anchor from a heading inside a longer-closed fence", () => {
    // GFM lets a fence close with more delimiters than it opened. A 4-backtick
    // block closed by 5 backticks still hides its `# Phantom` line, so a
    // #phantom fragment must fail rather than resolve to a phantom anchor.
    const site = copiedSite();
    const open = "`".repeat(4);
    const close = "`".repeat(5);
    writeFileSync(join(site, "fence.md"), `# Real\n\n${open}\n# Phantom\n${close}\n\nbody\n`);
    const maintainers = join(site, "maintainers.md");
    writeFileSync(
      maintainers,
      `${readFileSync(maintainers, "utf8")}\n[phantom](https://llm-cli-gateway.dev/fence.md#phantom)\n`
    );

    const result = validate(site);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("absent from the headings");
  });

  it("resolves a real heading fragment in a file that also has a fenced block", () => {
    const site = copiedSite();
    const open = "`".repeat(4);
    const close = "`".repeat(5);
    writeFileSync(join(site, "fence.md"), `# Real Heading\n\n${open}\n# Phantom\n${close}\n`);
    const maintainers = join(site, "maintainers.md");
    writeFileSync(
      maintainers,
      `${readFileSync(maintainers, "utf8")}\n[real](https://llm-cli-gateway.dev/fence.md#real-heading)\n`
    );

    expect(validate(site).status).toBe(0);
  });

  it("reserves emitted slugs when a base and its disambiguator collide", () => {
    // Headings Foo, Foo, Foo-1 must slug to foo, foo-1, foo-1-1 (github-slugger
    // occurrence loop), not silently drop the third to a taken slug.
    const site = copiedSite();
    writeFileSync(join(site, "col.md"), "# Foo\n\na\n\n# Foo\n\nb\n\n# Foo-1\n\nc\n");
    const maintainers = join(site, "maintainers.md");
    writeFileSync(
      maintainers,
      `${readFileSync(maintainers, "utf8")}\n[third](https://llm-cli-gateway.dev/col.md#foo-1-1)\n`
    );

    expect(validate(site).status).toBe(0);
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
