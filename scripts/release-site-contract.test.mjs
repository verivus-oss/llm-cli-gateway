import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { STEPS as GATE_STEPS } from "./check-steps.mjs";

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
  const changelog = readRepositoryFile("CHANGELOG.md");
  const bestPractices = readRepositoryFile("docs/guides/BEST_PRACTICES.md");
  const readme = readRepositoryFile("README.md");
  const agentGuide = readRepositoryFile("site/agents.md");
  const technicalGuide = readRepositoryFile("site/guides/coding-agent-gateway-technical-guide.md");
  const toolCatalog = readRepositoryFile("site/tools.md");
  const releaseArticle = readRepositoryFile("docs/articles/3.1.0-release.md");

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

  it("keeps every CI job's temporary files off the shared /tmp", () => {
    // The self-hosted host has ONE 8 GB tmpfs at /tmp shared by twelve runner
    // units, and Node's tmpdir() writes there unless TMPDIR says otherwise.
    //
    // Three rounds of reviewers have walked past a version of this test:
    //   r7 codex  moved repository code INSIDE the fence step. $GITHUB_ENV
    //             reaches SUBSEQUENT steps only, so that code ran unfenced.
    //   r7 grok   moved the fence behind `uses: actions/checkout`.
    //   r8 both   made the first step key `if:` / `id:` / `shell:` instead of
    //             name/uses/run, which the step REGEX could not see at all;
    //             and appended `; node ...` to the export's continuation line,
    //             which a line-PREFIX check accepts.
    //
    // So steps are no longer recognised by which key comes first. A step is
    // its DASH. And the fence step's body must equal the export exactly,
    // rather than merely starting with it.
    // EVERY workflow, not just ci.yml. Round 8: sast.yml and security.yml run
    // on the same self-hosted labels with no fence at all, so this test's own
    // name was false while it passed. The sweep is by the RUNNER LABEL, so a
    // new self-hosted workflow is covered the day it is added.
    const workflowDir = ".github/workflows";
    const jobs = [];
    for (const file of readdirSync(join(repoRoot, workflowDir)).sort()) {
      if (!file.endsWith(".yml") && !file.endsWith(".yaml")) continue;
      const text = readRepositoryFile(`${workflowDir}/${file}`);
      const jobsAt = text.indexOf("\njobs:\n");
      if (jobsAt < 0) continue;
      for (const job of text
        .slice(jobsAt)
        .split(/\n {2}(?=[A-Za-z0-9_-]+:\n)/)
        .slice(1)) {
        // Only jobs that land on the shared host have the problem.
        if (!job.includes("workhorse3")) continue;
        jobs.push({ file, job });
      }
    }
    expect(jobs.length, "no self-hosted jobs found in any workflow").toBeGreaterThanOrEqual(6);

    const FENCE_NAME = "Keep temporary files off the shared /tmp";
    const EXPECTED_EXPORT = [
      "- name: Keep temporary files off the shared /tmp",
      "run: |",
      "printf 'TMPDIR=%s\\nTMP=%s\\nTEMP=%s\\n' \\",
      '"$RUNNER_TEMP" "$RUNNER_TEMP" "$RUNNER_TEMP" >> "$GITHUB_ENV"',
    ];

    for (const { file, job } of jobs) {
      const name = `${file}:${job.slice(0, job.indexOf(":"))}`;
      const body = withoutComments(job);
      const stepsAt = body.indexOf("\n    steps:\n");
      expect(stepsAt, `${name} has no steps block`).toBeGreaterThanOrEqual(0);
      // A step begins at its list dash, whatever key follows it.
      const steps = body
        .slice(stepsAt)
        .split(/\n(?= {6}- )/)
        .slice(1);
      expect(steps.length, `${name} has no steps`).toBeGreaterThan(0);

      // FIRST, ahead of `uses:` actions too: checkout and setup-node write to
      // the temporary directory themselves.
      expect(steps[0], `${name} runs a step before the TMPDIR fence`).toContain(FENCE_NAME);

      // EXACTLY the export, not merely beginning with it. An appended
      // `; node ...` on the continuation line runs before $GITHUB_ENV applies.
      const fenceLines = steps[0]
        .split("\n")
        .map(line => line.trim())
        .filter(line => line.length > 0);
      expect(fenceLines, `${name}'s fence step does more than export TMPDIR`).toEqual(
        EXPECTED_EXPORT
      );

      // Nothing later may take it away again. $GITHUB_ENV loses to a step
      // `env:`, and `unset` inside a run block beats both.
      for (const step of steps.slice(1)) {
        expect(step, `${name} unsets the fence in a later step`).not.toMatch(
          /\bunset\b[^\n]*\bTMPDIR\b/
        );
        expect(step, `${name} overrides TMPDIR in a later step env:`).not.toMatch(
          /^\s+TMPDIR:(?! \$\{\{ runner\.temp \}\})/m
        );
      }
    }
  });

  it("keeps public maintainer guidance free of internal service-account identities", () => {
    expect(maintainersPage).not.toMatch(/\.gserviceaccount\.com/);
  });

  it("checks shipped skills for internal MCP aliases during the normal gate", () => {
    expect(packageJson.scripts["verify:no-internal-mcp:check"]).toBe(
      "node scripts/verify-no-internal-mcp.mjs --allow-unstripped-dist"
    );
    // The gate is a declared step list now, not an && chain, so the assertion
    // moved from the string to the list. Same claim: this check is IN the gate.
    expect(GATE_STEPS.map(step => step.script)).toContain("verify:no-internal-mcp:check");
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

  it("keeps current public guidance aligned with PostgreSQL worktree support", () => {
    for (const [name, document] of [
      ["README", readme],
      ["best practices", bestPractices],
      ["agent guide", agentGuide],
      ["technical guide", technicalGuide],
      ["tool catalog", toolCatalog],
    ]) {
      expect(document, `${name} must name both supported session managers`).toMatch(
        /file-backed\s+(?:or|and)\s+PostgreSQL session manager/i
      );
      expect(document, `${name} must explain host-local ownership`).toMatch(
        /owning host|host that owns the filesystem artifact/i
      );
      expect(document, `${name} must couple bulk deletion to PostgreSQL cleanup limits`).toMatch(
        /(?:(?:Explicit\s+)?PostgreSQL\s+deletion,\s+including\s+`?session_clear_all`?,\s+deletes\s+(?:the|a)\s+session\s+row\s+before\s+(?:its|the)\s+cleanup\s+observer\s+runs|`?session_clear_all`?[^\n]{0,800}PostgreSQL\s+deletes\s+each\s+session\s+row\s+before\s+(?:its|the)\s+cleanup\s+observer\s+runs)/i
      );
      expect(document, `${name} must disclose the missing retry`).toMatch(
        /failed\s+(?:worktree\s+)?removal\s+is\s+not\s+retained\s+for\s+automatic\s+retry/i
      );
      expect(document, `${name} must cover database-side expiry`).toMatch(
        /cleanup_expired_sessions[^.]*no\s+gateway\s+observer[^.]*no\s+worktree\s+cleanup/i
      );
      expect(document, `${name} must not restore the obsolete engine gate`).not.toMatch(
        /PostgreSQL-backed sessions reject|fail closed with PostgreSQL session storage/i
      );
    }

    for (const [name, document] of [
      ["changelog", changelog],
      ["README", readme],
      ["best practices", bestPractices],
      ["agent guide", agentGuide],
      ["technical guide", technicalGuide],
    ]) {
      expect(document, `${name} must scope TTL eviction to the file store`).toMatch(
        /file-backed manager[^.]*TTL eviction|file-backed TTL eviction|TTL eviction in the file-backed manager/i
      );
      expect(document, `${name} must scope file-backed retry to deletion or TTL eviction`).toMatch(
        /session deletion[^.]*file-backed TTL eviction[^.]*failed (?:Git )?(?:worktree )?(?:removal|cleanup)[^.]*retr(?:y|ies)|file-backed manager[^.]*session deletion[^.]*TTL eviction[^.]*failed (?:Git )?(?:worktree )?(?:removal|cleanup)[^.]*retr(?:y|ies)/i
      );
    }

    expect(releaseArticle).not.toContain("implements the cleanup-tombstone surface for real");
    expect(changelog).not.toContain("implements the cleanup-tombstone surface for real");
    expect(changelog).not.toContain("Recovery stays lazy");
    expect(releaseArticle.replace(/\s+/g, " ")).toContain(
      "That compatibility surface does not make ordinary PostgreSQL deletion durable. " +
        "Explicit deletion removes the session row before its cleanup observer runs, so " +
        "a failed worktree removal leaves no tombstone for automatic retry."
    );
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
