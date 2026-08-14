import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function readRepositoryFile(relativePath) {
  return readFileSync(join(repoRoot, relativePath), "utf8");
}

function position(text, fragment) {
  const index = text.indexOf(fragment);
  expect(index, `Missing ${JSON.stringify(fragment)}`).toBeGreaterThanOrEqual(0);
  return index;
}

function commandPosition(text, command) {
  return position(text, `\n${command}\n`);
}

/**
 * Blank out YAML comment bodies, preserving byte offsets so positions computed
 * on the result stay comparable to each other. Assertions about what a workflow
 * *does* must not be satisfied, or defeated, by prose describing what it does.
 */
function withoutComments(text) {
  return text.replace(/#[^\n]*/g, match => " ".repeat(match.length));
}

describe("release to public Pages contract", () => {
  const releaseWorkflow = readRepositoryFile(".github/workflows/release-tag-publish.yml");
  const pagesWorkflow = readRepositoryFile(".github/workflows/pages-deploy.yml");
  const npmPublishWorkflow = readRepositoryFile(".github/workflows/npm-publish.yml");
  const maintainersPage = readRepositoryFile("site/maintainers.md");
  const packageJson = JSON.parse(readRepositoryFile("package.json"));
  const preRelease = readRepositoryFile("scripts/pre-release.sh");
  const asyncSkill = readRepositoryFile(".agents/skills/async-job-orchestration/SKILL.md");
  const leastCostSkill = readRepositoryFile(".agents/skills/least-cost-routing/SKILL.md");
  const multiReviewSkill = readRepositoryFile(".agents/skills/multi-llm-review/SKILL.md");
  const guardedWorktreeProviderSkills = ["devin", "grok", "mistral"].map(provider =>
    readRepositoryFile(`.agents/skills/provider-${provider}/SKILL.md`)
  );
  const bestPractices = readRepositoryFile("docs/guides/BEST_PRACTICES.md");

  it("marks GitHub prereleases from the checked-out package version", () => {
    expect(releaseWorkflow).toContain(
      'RELEASE_KIND="$(node scripts/release-version.mjs "${VER}")"'
    );
    expect(releaseWorkflow).toContain("RELEASE_ARGS+=(--prerelease)");
    expect(releaseWorkflow).toContain('"${RELEASE_ARGS[@]}"');
  });

  it("releases only an existing strict tag at the commit that passed the release gate", () => {
    expect(releaseWorkflow).toContain("resolve-release-tag:");
    expect(releaseWorkflow).toContain(
      'if [[ ! "${TAG}" =~ ^v[0-9]+\\.[0-9]+\\.[0-9]+(-[0-9A-Za-z-]+(\\.[0-9A-Za-z-]+)*)?$ ]]'
    );
    expect(releaseWorkflow).toContain("ref: refs/tags/${{ steps.tag.outputs.tag }}");
    expect(releaseWorkflow).toContain(
      "ref: refs/tags/${{ needs.resolve-release-tag.outputs.tag }}"
    );
    expect(releaseWorkflow).toContain('git show-ref --verify --quiet "${TAG_REF}"');
    expect(releaseWorkflow).toContain('git rev-parse "${TAG_REF}^{commit}"');
    expect(releaseWorkflow).toContain(
      'printf \'commit=%s\\n\' "${CHECKED_OUT}" >> "$GITHUB_OUTPUT"'
    );
    expect(releaseWorkflow).toContain("--verify-tag");
    expect(releaseWorkflow).toContain('--target "${TESTED_SHA}"');
    expect(releaseWorkflow).toContain('CURRENT_SHA="$(git rev-parse HEAD)"');
  });

  it("rechecks the public tag ref immediately before release creation", () => {
    const remoteLookup = position(
      releaseWorkflow,
      'GIT_TERMINAL_PROMPT=0 GH_TOKEN="" GITHUB_TOKEN=""'
    );
    const releaseCreate = position(releaseWorkflow, 'gh release create "${TAG}"');

    expect(releaseWorkflow).toContain("git -c credential.helper= -c core.askPass=/bin/false");
    expect(releaseWorkflow).toContain("ls-remote --exit-code --tags origin");
    expect(releaseWorkflow).toContain('"refs/tags/${TAG}"');
    expect(releaseWorkflow).toContain('"refs/tags/${TAG}^{}"');
    expect(releaseWorkflow).toContain('$2 == tag_ref "^{}"');
    expect(releaseWorkflow).toContain('if [[ "${REMOTE_TAG_TARGET}" != "${TESTED_SHA}" ]]; then');
    expect(remoteLookup).toBeLessThan(releaseCreate);
    expect(releaseWorkflow.slice(remoteLookup, releaseCreate)).toMatch(
      /if \[\[ "\$\{REMOTE_TAG_TARGET\}" != "\$\{TESTED_SHA\}" \]\]; then\n\s+echo "ERROR: refusing to release \$\{TAG\}; remote target \$\{REMOTE_TAG_TARGET\} does not match tested commit \$\{TESTED_SHA\}" >&2\n\s+exit 1\n\s+fi\n\s*$/
    );
  });

  it("skips declared prereleases and fails closed before Pages credentials are read", () => {
    expect(pagesWorkflow).toContain("github.event.release.prerelease == false");
    expect(pagesWorkflow).toContain("Verify released tag is the current highest stable release");
    expect(pagesWorkflow).toContain("/releases?per_page=100&page=${page}");
    expect(pagesWorkflow).toContain("highest published stable release");
    const stableCheck = position(
      pagesWorkflow,
      "node scripts/sync-site-version.mjs --check --require-stable"
    );
    const latestReleaseCheck = position(
      pagesWorkflow,
      "Verify released tag is the current highest stable release"
    );
    const install = position(pagesWorkflow, "npm ci --ignore-scripts --no-audit --no-fund");
    const tokenFetch = position(
      pagesWorkflow,
      "node .github/scripts/fetch-azure-keyvault-secrets.mjs"
    );
    expect(stableCheck).toBeLessThan(install);
    expect(stableCheck).toBeLessThan(tokenFetch);
    expect(latestReleaseCheck).toBeLessThan(install);
    expect(latestReleaseCheck).toBeLessThan(tokenFetch);
  });

  it("requires an explicit release tag for manual npm publish runs", () => {
    expect(npmPublishWorkflow).toContain("workflow_dispatch:");
    expect(npmPublishWorkflow).toContain(
      'description: "Release tag to publish (for example, v2.14.0)"'
    );
    expect(npmPublishWorkflow).toContain("required: true");
    expect(npmPublishWorkflow).toContain("resolve-release-tag:");
    expect(npmPublishWorkflow).toContain(
      'if [[ ! "${RELEASE_TAG}" =~ ^v[0-9]+\\.[0-9]+\\.[0-9]+(-[0-9A-Za-z-]+(\\.[0-9A-Za-z-]+)*)?$ ]]'
    );
    expect(npmPublishWorkflow).toContain(
      "ref: refs/tags/${{ needs.resolve-release-tag.outputs.tag }}"
    );
    expect(npmPublishWorkflow).toContain("Verify package version matches selected release tag");
  });

  it("runs tests explicitly before lifecycle-bypassing npm publication", () => {
    const rebuild = position(npmPublishWorkflow, "- run: npm rebuild better-sqlite3");
    const build = position(npmPublishWorkflow, "- run: npm run build");
    const tests = position(npmPublishWorkflow, "- run: npm test");
    const strip = position(npmPublishWorkflow, "- name: Strip internal MCP names from dist");
    const publish = position(npmPublishWorkflow, "npm publish --ignore-scripts");

    expect(rebuild).toBeLessThan(build);
    expect(build).toBeLessThan(tests);
    expect(tests).toBeLessThan(strip);
    expect(strip).toBeLessThan(publish);
  });

  it("publishes from a digest-pinned artefact, never from a repository checkout", () => {
    // The publishing identity must not execute repository code. Compromised
    // source that reaches the build job can at worst produce a tarball, which
    // the publish job then refuses on digest mismatch.
    const buildStart = position(npmPublishWorkflow, "\n  build:\n");
    const publishStart = position(npmPublishWorkflow, "\n  publish:\n");
    expect(buildStart).toBeLessThan(publishStart);

    // Comments are stripped first: prose about `npm ci` or "npm runs no ..."
    // would otherwise satisfy or defeat these assertions by accident.
    const buildJob = withoutComments(npmPublishWorkflow.slice(buildStart, publishStart));
    const publishJob = withoutComments(npmPublishWorkflow.slice(publishStart));

    // Only the publish job may hold a publishing identity.
    expect(buildJob).not.toContain("id-token: write");
    expect(publishJob).toContain("id-token: write");

    // The publish job checks out nothing and runs no repository script.
    expect(publishJob).not.toContain("actions/checkout");
    expect(publishJob).not.toMatch(/npm[@\d.]* ci\b/);
    expect(publishJob).not.toMatch(/\bnpm run\b/);

    // Its only input is the build job's artefact, bound by digest.
    expect(publishJob).toContain("actions/download-artifact");
    expect(publishJob).toContain("Verify tarball digest");
    expect(publishJob).toContain('if [ "$ACTUAL" != "$EXPECTED_SHA" ]');
    // The "./" is load-bearing and is asserted deliberately. npm-package-arg
    // classifies a bare "release/<file>.tgz" as a hosted-git shorthand, because
    // its file-spec test requires a leading "./", "../", "/", "~/" or drive
    // letter and "owner/repo" matches first. The 3.1.0-rc.5 publish failed
    // exactly there: npm ran `git ls-remote ssh://git@github.com/release/
    // llm-cli-gateway-3.1.0-rc.5.tgz.git` and exited 128 on a publickey denial,
    // with the tarball present and its digest already verified. Verified
    // against npm 11.12.1: npa("release/x.tgz").type === "git" while
    // npa("./release/x.tgz").type === "file".
    expect(publishJob).toContain(
      'npm publish --ignore-scripts --tag "$DIST_TAG" "./release/$TARBALL"'
    );
  });

  it("gates the committed lockfile before any dependency code runs", () => {
    // The supply-chain scan used to run only inside security:audit, after a
    // script-enabled install had already executed whatever the tree contained.
    const ciWorkflow = readRepositoryFile(".github/workflows/ci.yml");
    for (const workflow of [ciWorkflow, npmPublishWorkflow]) {
      const body = withoutComments(workflow);
      const scan = position(body, "dep-drift-scan.mjs --frozen");
      // Matches both `npm ci` and the pinned `npm@12.0.1 ci` form.
      const install = body.search(/npm[@\d.]* ci\b/);
      expect(install, "no clean install found in workflow").toBeGreaterThanOrEqual(0);
      expect(scan).toBeLessThan(install);
    }
    // Ordinary CI installs under npm 12's script policy, not npm 11 defaults.
    expect(ciWorkflow).toContain("ci --strict-allow-scripts");
  });

  it("keeps public maintainer guidance free of internal service-account identities", () => {
    expect(maintainersPage).not.toMatch(/\.gserviceaccount\.com/);
  });

  it("checks shipped skills for internal MCP aliases during the normal gate", () => {
    expect(packageJson.scripts["verify:no-internal-mcp:check"]).toBe(
      "node scripts/verify-no-internal-mcp.mjs --allow-unstripped-dist"
    );
    expect(packageJson.scripts.check).toContain("npm run verify:no-internal-mcp:check");
    expect(readRepositoryFile("scripts/verify-no-internal-mcp.mjs")).toContain(
      "PACKED_INTERNAL_MCP_ALIASES"
    );
    expect(readRepositoryFile("scripts/verify-no-internal-mcp.mjs")).toContain(
      "findInternalMcpAliases(line, PACKED_INTERNAL_MCP_ALIASES)"
    );
  });

  it("keeps shipped async and routing skills aligned with registered tool contracts", () => {
    expect(asyncSkill).toContain('"collectWith": "llm_job_result"');
    expect(asyncSkill).toContain("collect with llm_job_result");
    expect(asyncSkill).not.toContain('"fetchWith":');
    expect(leastCostSkill).toContain("accepts a registered `workspace`");
    expect(leastCostSkill).toContain("It is not sent to HTTP/API providers");
  });

  it("keeps shipped review skills aligned with guarded provider worktree admission", () => {
    const normalizeWhitespace = text => text.replace(/\s+/g, " ");
    const explicitSessionRule =
      "explicit provider-native `sessionId` that is not overridden by `createNewSession`";
    const rejectedSessionModes =
      "fresh, `createNewSession`, and `resumeLatest`-only worktree requests fail closed";
    const normalizedMultiReviewSkill = normalizeWhitespace(multiReviewSkill);

    expect(multiReviewSkill).toContain("Do not request a fresh gateway worktree");
    expect(normalizedMultiReviewSkill).toContain(explicitSessionRule);
    expect(normalizedMultiReviewSkill).toContain(rejectedSessionModes);
    expect(multiReviewSkill).not.toContain("use gateway `worktree` when isolation is needed");
    for (const providerSkill of guardedWorktreeProviderSkills) {
      const normalizedProviderSkill = normalizeWhitespace(providerSkill);
      expect(normalizedProviderSkill).toContain(explicitSessionRule);
      expect(normalizedProviderSkill).toContain(rejectedSessionModes);
    }
  });

  it("documents the API adapter enum and every reserved CLI provider name", () => {
    expect(bestPractices).toContain('`"openai-compatible"`, `"anthropic"`, or `"xai-responses"`');
    expect(bestPractices).toContain(
      "`grok`, `mistral`, `devin`, `cursor`): such a config block is rejected"
    );
    expect(bestPractices).not.toContain('kind = "api"');
  });

  it("regenerates discovery from a fresh build before its release gate", () => {
    const build = commandPosition(preRelease, "npm run build");
    const generate = commandPosition(preRelease, "npm run site:generate");
    const check = commandPosition(preRelease, "npm run check");
    expect(build).toBeLessThan(generate);
    expect(generate).toBeLessThan(check);
  });
});
