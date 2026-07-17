import { describe, expect, it } from "vitest";
import {
  buildSnapshotPayload,
  codexChangelogRssSemanticSnapshot,
  compareHelpFlagShapes,
  compareSourceSnapshot,
  compareTargetVersion,
  extractRootCommands,
  githubReleaseSemanticSnapshot,
  normalizeSnapshot,
  parseTrustedInstalledVersion,
  renderReport,
  requireInstalledHelpProbeErrorIsCritical,
  requireInstalledVersionIndeterminateIsCritical,
  rootCatalogDrift,
  subcommandHelpProbeIsUntrusted,
  verifyDeclaredCommandPath,
} from "../../scripts/upstream-scan.mjs";

describe("upstream scanner hardening", () => {
  it("compares stable GitHub release semantics instead of mutable API payload fields", () => {
    const url = "https://api.github.com/repos/example/tool/releases/latest";
    const before = githubReleaseSemanticSnapshot(
      url,
      JSON.stringify({
        tag_name: "v2.19.1",
        name: "v2.19.1",
        draft: false,
        prerelease: false,
        published_at: "2026-07-01T00:00:00Z",
        target_commitish: "main",
        body: "Release notes",
        updated_at: "2026-07-01T00:00:00Z",
        assets: [{ download_count: 1 }],
      })
    );
    const transportOnlyChange = githubReleaseSemanticSnapshot(
      url,
      JSON.stringify({
        tag_name: "v2.19.1",
        name: "v2.19.1",
        draft: false,
        prerelease: false,
        published_at: "2026-07-01T00:00:00Z",
        target_commitish: "main",
        body: "Release notes",
        updated_at: "2026-07-13T00:00:00Z",
        assets: [{ download_count: 99 }],
      })
    );
    const releaseChange = githubReleaseSemanticSnapshot(
      url,
      JSON.stringify({
        tag_name: "v2.20.0",
        name: "v2.20.0",
        draft: false,
        prerelease: false,
        published_at: "2026-07-13T00:00:00Z",
        target_commitish: "main",
        body: "New release notes",
      })
    );

    expect(
      compareSourceSnapshot({ semantic: before }, { semantic: transportOnlyChange })
    ).toMatchObject({
      changed: false,
      comparison: "semantic",
    });
    expect(compareSourceSnapshot({ semantic: before }, { semantic: releaseChange })).toMatchObject({
      changed: true,
      comparison: "semantic",
    });
    expect(compareSourceSnapshot({ sha256: "legacy" }, { semantic: before })).toEqual({
      changed: false,
      comparison: "semantic-baseline-initialized",
    });
  });

  it("normalizes Codex RSS to CLI and watched contract entries", () => {
    const url = "https://learn.chatgpt.com/docs/changelog/rss.xml";
    const item = ({
      guid,
      link = guid,
      title,
      content,
      pubDate = "Mon, 13 Jul 2026 00:00:00 GMT",
    }) =>
      `<item><title>${title}</title><link>${link}</link><guid>${guid}</guid><pubDate>${pubDate}</pubDate><content:encoded><![CDATA[${content}]]></content:encoded></item>`;
    const rss = (items, lastBuildDate = "Mon, 13 Jul 2026 00:00:00 GMT") =>
      `<rss><channel><lastBuildDate>${lastBuildDate}</lastBuildDate>${items.join("")}</channel></rss>`;

    const appEntry = item({
      guid: "https://developers.openai.com/codex/changelog/#codex-2026-07-09-app",
      title: "Codex app",
      content: "Review tasks and improve session recovery.",
    });
    const mobileEntry = item({
      guid: "https://developers.openai.com/codex/changelog/#codex-2026-07-06-mobile",
      title: "Codex mobile",
      content: "Review sessions more quickly on iOS.",
    });
    const unsuffixedAppEntry = item({
      guid: "https://developers.openai.com/codex/changelog/#codex-2026-07-08",
      title: "Introducing the Codex app",
      content: "Review session history more quickly.",
    });
    const linkClassifiedMobileEntry = item({
      guid: "https://developers.openai.com/codex/changelog/#codex-2026-07-07",
      link: "https://developers.openai.com/codex/mobile",
      title: "Release notes",
      content: "Review session history more quickly.",
    });
    const cliEntry = item({
      guid: "https://developers.openai.com/codex/changelog/#codex-2026-07-01-cli",
      title: "Codex CLI",
      content: "Use `codex exec resume --sandbox workspace-write` for a follow-up.",
    });
    const appCliEntry = item({
      guid: "https://developers.openai.com/codex/changelog/#codex-2026-07-10-app",
      title: "Codex app",
      content: "The shared CLI workflow now supports `codex exec --app-cli-flag`.",
    });

    const before = codexChangelogRssSemanticSnapshot(
      url,
      rss([appEntry, mobileEntry, unsuffixedAppEntry, linkClassifiedMobileEntry, cliEntry])
    );
    const routineChurn = codexChangelogRssSemanticSnapshot(
      url,
      rss(
        [
          mobileEntry,
          appEntry,
          unsuffixedAppEntry,
          linkClassifiedMobileEntry,
          item({
            guid: "https://developers.openai.com/codex/changelog/#codex-2026-07-01-cli",
            title: "Codex CLI",
            content: "\nUse  `codex exec resume --sandbox workspace-write`\nfor a follow-up.\n",
          }),
        ],
        "Tue, 14 Jul 2026 00:00:00 GMT"
      )
    );
    const changedSandboxMode = codexChangelogRssSemanticSnapshot(
      url,
      rss([
        appEntry,
        mobileEntry,
        item({
          guid: "https://developers.openai.com/codex/changelog/#codex-2026-07-01-cli",
          title: "Codex CLI",
          content: "Use `codex exec resume --sandbox danger-full-access` for a follow-up.",
        }),
      ])
    );
    const newCliFlag = codexChangelogRssSemanticSnapshot(
      url,
      rss([
        appEntry,
        mobileEntry,
        cliEntry,
        item({
          guid: "https://developers.openai.com/codex/changelog/#codex-2026-07-14-cli",
          title: "CLI update",
          content: "Run `codex exec --future-flag` to enable the new workflow.",
        }),
      ])
    );
    const appCliChange = codexChangelogRssSemanticSnapshot(
      url,
      rss([appEntry, mobileEntry, cliEntry, appCliEntry])
    );

    expect(before?.fields.entries).toEqual([
      {
        guid: "https://developers.openai.com/codex/changelog/#codex-2026-07-01-cli",
        title: "Codex CLI",
        contentSha256: expect.any(String),
      },
    ]);
    expect(compareSourceSnapshot({ semantic: before }, { semantic: routineChurn })).toMatchObject({
      changed: false,
      comparison: "semantic",
    });
    expect(
      compareSourceSnapshot({ semantic: before }, { semantic: changedSandboxMode })
    ).toMatchObject({ changed: true, comparison: "semantic" });
    expect(compareSourceSnapshot({ semantic: before }, { semantic: newCliFlag })).toMatchObject({
      changed: true,
      comparison: "semantic",
    });
    expect(compareSourceSnapshot({ semantic: before }, { semantic: appCliChange })).toMatchObject({
      changed: true,
      comparison: "semantic",
    });
    expect(appCliChange?.fields.entries).toContainEqual({
      guid: "https://developers.openai.com/codex/changelog/#codex-2026-07-10-app",
      title: "Codex app",
      contentSha256: expect.any(String),
    });
    expect(
      codexChangelogRssSemanticSnapshot("https://example.test/feed", rss([cliEntry]))
    ).toBeNull();
  });

  it("compares explicit version probes including build suffixes", () => {
    expect(compareTargetVersion("claude 2.1.210", "2.1.210 (Claude Code)").matches).toBe(true);
    expect(
      compareTargetVersion("cursor-agent 2026.07.09-c59fd9a", "cursor-agent 2026.07.09-a3815c0")
        .matches
    ).toBe(false);
  });

  it("treats an unconfirmed installed version as critical only under --require-installed", () => {
    const parsed = { targetVersion: "claude 2.1.211", installedVersion: "2.1.211", matches: true };
    const mismatch = { targetVersion: "claude 2.1.211", installedVersion: "2.1.9", matches: false };
    const unparseable = { targetVersion: "claude 2.1.211", installedVersion: null, matches: null };
    const noTarget = { targetVersion: null, installedVersion: null, matches: null };

    // A clean match or mismatch is decided elsewhere, never here.
    expect(requireInstalledVersionIndeterminateIsCritical(true, parsed)).toBe(false);
    expect(requireInstalledVersionIndeterminateIsCritical(true, mismatch)).toBe(false);

    // The fail-open the fix closes: require-installed + a declared target we
    // could not confirm must be critical instead of a silent log.
    expect(requireInstalledVersionIndeterminateIsCritical(true, unparseable)).toBe(true);
    expect(requireInstalledVersionIndeterminateIsCritical(true, undefined)).toBe(false);

    // Without require-installed, or without a declared target, it stays a log.
    expect(requireInstalledVersionIndeterminateIsCritical(false, unparseable)).toBe(false);
    expect(requireInstalledVersionIndeterminateIsCritical(true, noTarget)).toBe(false);
  });

  it("escalates a nonzero-exit help probe to critical only under --require-installed", () => {
    const okHelp = { available: true, helpExitedNonzero: false };
    const failedHelp = { available: true, helpExitedNonzero: true };
    const absentHelp = { available: false, helpExitedNonzero: false };

    // The fail-open the fix closes: a help probe that spawned but exited nonzero
    // produced untrustworthy help text, so under --require-installed its contract
    // is unverified and this must be critical.
    expect(requireInstalledHelpProbeErrorIsCritical(true, failedHelp)).toBe(true);

    // A clean help exit, an absent binary (decided elsewhere), and runs without
    // --require-installed are not this critical.
    expect(requireInstalledHelpProbeErrorIsCritical(true, okHelp)).toBe(false);
    expect(requireInstalledHelpProbeErrorIsCritical(true, absentHelp)).toBe(false);
    expect(requireInstalledHelpProbeErrorIsCritical(false, failedHelp)).toBe(false);
    expect(requireInstalledHelpProbeErrorIsCritical(true, undefined)).toBe(false);
  });

  it("treats a subcommand help probe that could not run as untrusted, not drift-free", () => {
    const strict = { helpProbeExitTolerant: false };
    const tolerant = { helpProbeExitTolerant: true };

    // The fail-open the fix closes: the root binary spawned, but the SUBCOMMAND
    // help probe never completed (timeout / EACCES => available:false). That is
    // an unverified contract, not an absent path, so a non-tolerant subcommand
    // must flag it (and, downstream, --require-installed escalates it).
    expect(subcommandHelpProbeIsUntrusted(strict, { available: false, status: null })).toBe(true);
    // A subcommand that ran but exited nonzero is likewise untrusted.
    expect(subcommandHelpProbeIsUntrusted(strict, { available: true, status: 1 })).toBe(true);
    // A clean exit is trusted.
    expect(subcommandHelpProbeIsUntrusted(strict, { available: true, status: 0 })).toBe(false);

    // A help-exit-tolerant subcommand (one whose help is expected to exit nonzero)
    // is trusted in every case, including a probe that never ran.
    expect(subcommandHelpProbeIsUntrusted(tolerant, { available: false, status: null })).toBe(
      false
    );
    expect(subcommandHelpProbeIsUntrusted(tolerant, { available: true, status: 1 })).toBe(false);
    expect(subcommandHelpProbeIsUntrusted(tolerant, { available: true, status: 0 })).toBe(false);
  });

  it("does not trust a --version that exits nonzero, closing the parse fail-open", () => {
    // A clean exit-0 probe yields the parsed version line.
    expect(parseTrustedInstalledVersion({ available: true, status: 0, output: "2.1.211" })).toBe(
      "2.1.211"
    );

    // The fail-open: --version exits nonzero but prints a string that parses to
    // the target. Trusting it would pass the gate with the CLI unverified. The
    // fix returns null, which compareTargetVersion turns into an indeterminate
    // match that --require-installed escalates to a critical.
    for (const status of [1, 3, 127, null]) {
      const untrusted = parseTrustedInstalledVersion({
        available: true,
        status,
        output: "2.1.211",
      });
      expect(untrusted).toBeNull();
      const probe = {
        targetVersion: "cli 2.1.211",
        ...compareTargetVersion("cli 2.1.211", untrusted),
      };
      expect(probe.matches).toBeNull();
      expect(requireInstalledVersionIndeterminateIsCritical(true, probe)).toBe(true);
    }

    // A spawn that never ran (available:false) is also untrusted.
    expect(parseTrustedInstalledVersion({ available: false, status: null, output: "" })).toBeNull();
  });

  it("discovers root commands, handles aliases, and guards missing paths before help", () => {
    const commands = extractRootCommands(`
Commands:
  agent|agents  List configured agents
  list          List sessions [aliases: ls]
  help          Print help

Options:
  --version     Print version
`);
    expect(commands).toEqual(["agent", "agents", "help", "list"]);

    const drift = rootCatalogDrift(
      [
        { commandPath: ["agent"], aliases: ["agents"] },
        { commandPath: ["list"], aliases: ["ls"] },
      ],
      commands
    );
    expect(drift).toEqual({ added: [], removed: [] });

    expect(
      rootCatalogDrift(
        [
          { commandPath: ["plugin"], aliases: ["plugins"] },
          { commandPath: ["plugins"], aliases: ["plugin"] },
        ],
        ["plugin"]
      )
    ).toEqual({ added: [], removed: [] });

    const checkedParents: string[] = [];
    const missing = verifyDeclaredCommandPath(["ssh"], commandPath => {
      checkedParents.push(commandPath.join(" "));
      return { available: true, commands };
    });
    expect(missing.state).toBe("missing");
    expect(checkedParents).toEqual([""]);

    const alias = verifyDeclaredCommandPath(
      ["plugins"],
      () => ({ available: true, commands: ["plugin"] }),
      new Map([["plugins", ["plugin"]]])
    );
    expect(alias.state).toBe("present");
  });

  it("compares only explicit root flag shapes and values", () => {
    const contract = {
      flags: {
        "--permission-mode": { arity: "one", values: ["auto"] },
        "--resume": { arity: "optional" },
        // An upstream variadic flag still accepts the gateway's one-value use.
        "--add-dir": { arity: "one" },
      },
    };
    const help = `
Options:
  --permission-mode <MODE>  Permission mode (choices: "auto", "manual")
  --resume <ID>             Resume by ID
  --add-dir <DIR...>        Additional directories
`;
    const drift = compareHelpFlagShapes(contract, help);

    expect(drift.enumMismatches).toEqual([
      {
        flag: "--permission-mode",
        missingValues: [],
        extraValues: ["manual"],
        installedValues: ["auto", "manual"],
      },
    ]);
    expect(drift.arityMismatches).toEqual([
      { flag: "--resume", contractArity: "optional", installedArity: "one" },
    ]);
  });

  it("normalizes v1 snapshot flags into canonical discoveredFlags", () => {
    const snapshot = normalizeSnapshot({
      helpSurface: { flags: ["--root"] },
      subcommands: { inspect: { flags: ["--json"] } },
    });

    expect(snapshot.helpSurface.discoveredFlags).toEqual(["--root"]);
    expect(snapshot.helpSurface.flags).toBeUndefined();
    expect(snapshot.subcommands.inspect.discoveredFlags).toEqual(["--json"]);
    expect(snapshot.subcommands.inspect.flags).toBeUndefined();
  });

  it("preserves source and help baselines when only one scan surface refreshes", () => {
    const prior = {
      sources: [
        {
          url: "https://api.github.com/repos/example/tool/releases/latest",
          sha256: "prior-source-hash",
          semantic: { kind: "github-release.v1", sha256: "prior-semantic-hash" },
        },
      ],
      helpSurface: { flags: ["--prior"] },
      rootCommands: ["prior-command"],
      subcommands: { inspect: { flags: ["--json"] } },
    };

    const helpOnly = buildSnapshotPayload("mistral", null, prior, {
      available: true,
      probedAt: "2026-07-13T00:00:00.000Z",
      versionProbe: { installedVersion: "2.19.1", targetVersion: "2.19.1", matches: true },
      discoveredFlags: ["--current"],
      subcommands: {},
    });
    expect(helpOnly.sources).toEqual(prior.sources);
    expect(helpOnly.helpSurface.discoveredFlags).toEqual(["--current"]);

    const sourceOnly = buildSnapshotPayload(
      "mistral",
      [{ url: "https://example.test/release", sha256: "current-source-hash" }],
      prior,
      null
    );
    expect(sourceOnly.sources).toEqual([
      { url: "https://example.test/release", sha256: "current-source-hash" },
    ]);
    expect(sourceOnly.helpSurface.discoveredFlags).toEqual(["--prior"]);
    expect(sourceOnly.helpSurface.flags).toBeUndefined();
    expect(sourceOnly.rootCommands).toEqual(["prior-command"]);
    expect(sourceOnly.subcommands.inspect.discoveredFlags).toEqual(["--json"]);

    const mixedRefresh = buildSnapshotPayload(
      "mistral",
      [
        { url: prior.sources[0].url, ok: false, status: 0, sha256: null, error: "offline" },
        { url: "https://example.test/current", ok: true, status: 200, sha256: "current" },
      ],
      prior,
      null
    );
    expect(mixedRefresh.sources).toEqual([
      prior.sources[0],
      { url: "https://example.test/current", ok: true, status: 200, sha256: "current" },
    ]);
  });

  it("includes installed version and root-command evidence in markdown reports", () => {
    const report = renderReport(
      "mistral",
      {
        upstream: "Mistral Vibe CLI",
        executable: "vibe",
        flags: {},
        subcommands: {},
        conformanceFixtures: [],
      },
      {
        watchCategories: [],
        sourceUrls: [],
      },
      null,
      [],
      {
        available: true,
        versionProbe: {
          targetVersion: "vibe 2.19.1",
          installedVersion: "vibe 2.19.1",
          matches: true,
        },
        rootCommands: ["models"],
        rootCatalogDrift: { added: [], removed: [] },
        arityMismatches: [],
        enumMismatches: [],
        subcommands: {},
      }
    );

    expect(report).toContain("Contract target version: `vibe 2.19.1`");
    expect(report).toContain("Installed version: `vibe 2.19.1`");
    expect(report).toContain("Version comparison: **matches**");
    expect(report).toContain("Root commands discovered: **1**");
  });
});
