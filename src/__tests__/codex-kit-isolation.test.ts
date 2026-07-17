import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertCodexKitIsolationPlan,
  assertCodexKitIsolationProjection,
  CodexKitIsolationError,
  buildCodexKitEnvironment,
  buildCodexKitSkillsOverride,
  createCodexKitIsolationPlan,
  createCodexKitIsolationProjection,
  inspectCodexKitPromptInput,
  runCodexKitPromptProbeForTest,
} from "../codex-kit-isolation.js";
import { prepareCodexRequest } from "../index.js";
import { validateUpstreamCliArgs } from "../upstream-contracts.js";
import {
  isProcessGroupRegisteredForTest,
  PROCESS_GROUP_KILL_GRACE_MS,
  spawnCliProcess,
} from "../executor.js";

function promptInput(text: string): string {
  return JSON.stringify([
    {
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text }],
    },
  ]);
}

function userPromptInput(text: string): string {
  return JSON.stringify([
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text }],
    },
  ]);
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function waitForProcessGroupCleanup(parentPid: number, descendantPid: number): Promise<void> {
  const deadline = Date.now() + PROCESS_GROUP_KILL_GRACE_MS + 3000;
  while (Date.now() < deadline) {
    if (!pidIsAlive(descendantPid) && !isProcessGroupRegisteredForTest(parentPid)) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(
    `Codex Kit probe group did not clean parent ${parentPid} / descendant ${descendantPid}`
  );
}

describe("Codex Personal Agent Config isolation", () => {
  let testDir: string | null = null;

  afterEach(() => {
    if (testDir) rmSync(testDir, { recursive: true, force: true });
    testDir = null;
  });

  it("parses only absolute discovered SKILL.md paths and detects app blocks", () => {
    const inspection = inspectCodexKitPromptInput(
      promptInput(
        [
          "<skills_instructions>",
          "- Repo skill (file: /tmp/kit skill/SKILL.md)",
          "- User skill (file: /tmp/other/SKILL.md)",
          "</skills_instructions>",
          "<apps_instructions>apps</apps_instructions>",
        ].join("\n")
      )
    );

    expect(inspection).toEqual({
      developerMessageCount: 1,
      skillPaths: ["/tmp/kit skill/SKILL.md", "/tmp/other/SKILL.md"],
      skillsBlockCount: 1,
      appsBlockCount: 1,
    });
  });

  it("fails closed for a discovered-skills block without safe paths", () => {
    expect(() =>
      inspectCodexKitPromptInput(
        promptInput("<skills_instructions>unparseable</skills_instructions>")
      )
    ).toThrow(CodexKitIsolationError);
  });

  it("does not treat a user-message echo as a discovered capability block", () => {
    expect(
      inspectCodexKitPromptInput(userPromptInput("<skills_instructions>fake</skills_instructions>"))
    ).toEqual({
      developerMessageCount: 0,
      skillPaths: [],
      skillsBlockCount: 0,
      appsBlockCount: 0,
    });
  });

  it("emits TOML-safe disabled-skill configuration", () => {
    expect(buildCodexKitSkillsOverride(['/tmp/space/"quoted"/SKILL.md'])).toBe(
      'skills.config=[{path="/tmp/space/\\"quoted\\"/SKILL.md",enabled=false}]'
    );
  });

  it("removes inherited Codex session variables while retaining CODEX_HOME", () => {
    expect(
      buildCodexKitEnvironment({
        CODEX_HOME: "/home/me/.codex",
        CODEX_THREAD_ID: "thread",
        CODEX_UNSAFE_CONTEXT: "context",
        PATH: "/usr/bin",
      })
    ).toEqual({ CODEX_THREAD_ID: undefined, CODEX_UNSAFE_CONTEXT: undefined });
  });

  it("keeps a pure pre-admission projection outside the executable plan capability set", () => {
    const contextPrefix =
      '<gateway-personal-config stamp="stamp" digest="digest">context</gateway-personal-config>';
    const projection = createCodexKitIsolationProjection("/tmp/codex-kit-projection", {
      contextPrefix,
      sandboxMode: "workspace-write",
      outputFormat: "text",
    });

    expect(() => assertCodexKitIsolationProjection(projection, contextPrefix)).not.toThrow();
    expect(() => assertCodexKitIsolationPlan(projection, contextPrefix)).toThrow(
      "Codex Kit isolation plan was not issued by the gateway"
    );
    expect(projection.args).toContain("skills.config=[]");
    expect(projection.env).toEqual({});
    expect(projection.skillPaths).toEqual([]);
  });

  it("uses a two-pass nonblocking probe and appends every gateway control", async () => {
    testDir = mkdtempSync(join(tmpdir(), "codex-kit-isolation-"));
    const calls: Array<{ args: string[]; cwd: string; env: NodeJS.ProcessEnv }> = [];
    const kitPrefix = "<gateway-personal-config>Kit context</gateway-personal-config>";
    const plan = await createCodexKitIsolationPlan(testDir, {
      contextPrefix: kitPrefix,
      sandboxMode: "workspace-write",
      outputFormat: "text",
      baseEnv: {
        PATH: process.env.PATH,
        CODEX_THREAD_ID: "thread",
        HTTPS_PROXY: "http://untrusted-proxy.invalid",
      },
      probe: ({ cwd, args, env }) => {
        calls.push({ cwd, args, env });
        if (calls.length === 1) {
          return promptInput(
            [
              "<skills_instructions>",
              "- Repo skill (file: /tmp/repo/.agents/skills/example/SKILL.md)",
              "</skills_instructions>",
              "<apps_instructions>apps</apps_instructions>",
            ].join("\n")
          );
        }
        expect(args).toContain(
          'skills.config=[{path="/tmp/repo/.agents/skills/example/SKILL.md",enabled=false}]'
        );
        return promptInput("provider-owned developer policy only");
      },
    });

    expect(calls).toHaveLength(2);
    expect(plan.cwd).toBe(testDir);
    expect(plan.projectRoot).toBe(testDir);
    expect(plan.sandboxMode).toBe("workspace-write");
    expect(plan.outputFormat).toBe("text");
    expect(plan.env.CODEX_THREAD_ID).toBeUndefined();
    expect(plan.env.HTTPS_PROXY).toBeUndefined();
    expect(plan.args).toEqual([
      "--ignore-user-config",
      "--ignore-rules",
      "--disable",
      "apps",
      "--disable",
      "plugins",
      "--disable",
      "hooks",
      "--disable",
      "multi_agent",
      "--disable",
      "memories",
      "-c",
      "project_doc_max_bytes=0",
      "-c",
      "project_doc_fallback_filenames=[]",
      "-c",
      "project_root_markers=[]",
      "-c",
      'projects."' + testDir + '".trust_level="untrusted"',
      "-c",
      'web_search="disabled"',
      "-c",
      "memories.use_memories=false",
      "-c",
      "memories.generate_memories=false",
      "-c",
      'skills.config=[{path="/tmp/repo/.agents/skills/example/SKILL.md",enabled=false}]',
    ]);
    for (const call of calls) {
      expect(call.env.CODEX_THREAD_ID).toBeUndefined();
      expect(call.env.HTTPS_PROXY).toBeUndefined();
      expect(call.args).toEqual(
        expect.arrayContaining([
          "--disable",
          "apps",
          "plugins",
          "hooks",
          "multi_agent",
          "memories",
          "project_root_markers=[]",
          'web_search="disabled"',
          "memories.use_memories=false",
          "memories.generate_memories=false",
        ])
      );
    }
    expect(Object.isFrozen(plan.args)).toBe(true);
    expect(Object.isFrozen(plan.skillPaths)).toBe(true);
    expect(Object.isFrozen(plan.env)).toBe(true);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(() =>
      assertCodexKitIsolationPlan({
        ...plan,
        args: [...plan.args, "--enable", "hooks"],
      })
    ).toThrow(CodexKitIsolationError);
    expect(() =>
      assertCodexKitIsolationPlan({
        cwd: plan.cwd,
        projectRoot: plan.projectRoot,
        args: [...plan.args],
        env: {},
        skillPaths: [],
        contextPrefixDigest: plan.contextPrefixDigest,
        sandboxMode: plan.sandboxMode,
        outputFormat: plan.outputFormat,
      })
    ).toThrow(CodexKitIsolationError);

    const commonParams = {
      prompt: "complete the task",
      fullAuto: false,
      sandboxMode: "workspace-write" as const,
      dangerouslyBypassApprovalsAndSandbox: false,
      approvalStrategy: "legacy" as const,
      mcpServers: [],
      optimizePrompt: false,
      operation: "codex_request",
      outputFormat: plan.outputFormat,
      ignoreUserConfig: true,
      ignoreRules: true,
      kitContextPrefix: kitPrefix,
      kitIsolation: plan,
    };
    const fresh = prepareCodexRequest({
      ...commonParams,
      workingDir: "/a/noncanonical/caller-spelling",
    });
    expect("args" in fresh).toBe(true);
    if (!("args" in fresh)) return;
    expect(fresh.args).toContain("--sandbox");
    expect(fresh.args).toContain("workspace-write");
    expect(fresh.args).toContain("project_doc_max_bytes=0");
    expect(fresh.args.filter(arg => arg === "--ignore-user-config")).toHaveLength(1);
    expect(fresh.args.filter(arg => arg === "--ignore-rules")).toHaveLength(1);
    expect(fresh.args).not.toContain("-C");
    expect(fresh.args.at(-1)).toBe("-");
    expect(fresh.args).not.toContain(commonParams.prompt);
    expect(fresh.args).not.toContain(kitPrefix);
    expect(fresh.stdinPayload).toBe(`${kitPrefix}\n\n${commonParams.prompt}`);
    expect(validateUpstreamCliArgs("codex", fresh.args).ok).toBe(true);

    const highImpactOverrides: Array<Partial<Parameters<typeof prepareCodexRequest>[0]>> = [
      { addDir: ["/tmp/extra"] },
      { askForApproval: "never" },
      { approvalPolicy: "balanced" },
      { configOverrides: { project_doc_max_bytes: "999" } },
      { dangerouslyBypassApprovalsAndSandbox: true },
      { dangerouslyBypassHookTrust: true },
      { disable: ["apps"] },
      { enable: ["hooks"] },
      { ephemeral: true },
      { fullAuto: true },
      { ignoreRules: false },
      { ignoreUserConfig: false },
      { images: ["/tmp/image.png"] },
      { localProvider: "ollama" },
      { mcpServers: ["untrusted"] },
      { oss: true },
      { outputFormat: "json" },
      { outputLastMessage: "/tmp/result.txt" },
      { outputSchema: { type: "object" } },
      { profile: "untrusted" },
      { resumeLatest: true },
      { sandboxMode: "read-only" },
      { search: true },
      { strictConfig: true },
      { useLegacyFullAutoFlag: true },
      { color: "always" },
    ];
    for (const overrides of highImpactOverrides) {
      const rejected = prepareCodexRequest({ ...commonParams, ...overrides });
      expect("args" in rejected).toBe(false);
    }
    const alteredPrefix = prepareCodexRequest({
      ...commonParams,
      kitContextPrefix: `${kitPrefix}\n<altered>instruction</altered>`,
    });
    expect("args" in alteredPrefix).toBe(false);
    for (const promptParts of [
      { task: "complete the task", system: "injected system instructions" },
      { task: "complete the task", tools: "injected tool instructions" },
      { task: "complete the task", context: "injected context instructions" },
      { task: "complete the task", cacheControl: { system: true } },
    ]) {
      const rejected = prepareCodexRequest({
        ...commonParams,
        prompt: undefined,
        promptParts,
      });
      expect("args" in rejected).toBe(false);
    }

    const resumed = prepareCodexRequest({
      ...commonParams,
      sessionId: "01940000-0000-7000-8000-000000000abc",
    });
    expect("args" in resumed).toBe(true);
    if (!("args" in resumed)) return;
    expect(resumed.args).toContain("resume");
    expect(resumed.args).not.toContain("--sandbox");
    expect(resumed.args.filter(arg => arg === "--ignore-user-config")).toHaveLength(1);
    expect(resumed.args.filter(arg => arg === "--ignore-rules")).toHaveLength(1);
    expect(resumed.args.at(-1)).toBe("-");
    expect(resumed.args).not.toContain(commonParams.prompt);
    expect(resumed.args).not.toContain(kitPrefix);
    expect(resumed.stdinPayload).toBe(`${kitPrefix}\n\n${commonParams.prompt}`);
    expect(validateUpstreamCliArgs("codex", resumed.args).ok).toBe(true);

    const literalDash = prepareCodexRequest({
      prompt: "-",
      fullAuto: false,
      dangerouslyBypassApprovalsAndSandbox: false,
      approvalStrategy: "legacy",
      optimizePrompt: false,
      operation: "codex_request",
    });
    expect("args" in literalDash).toBe(true);
    if (!("args" in literalDash)) return;
    expect(literalDash.args.at(-1)).toBe("-");
    expect(literalDash.stdinPayload).toBe("-");
    expect(validateUpstreamCliArgs("codex", literalDash.args).ok).toBe(true);
  });

  it("fails closed when either preflight pass lacks developer prompt evidence", async () => {
    testDir = mkdtempSync(join(tmpdir(), "codex-kit-isolation-"));
    const options = {
      contextPrefix: "<gateway-personal-config>Kit context</gateway-personal-config>",
      sandboxMode: "workspace-write" as const,
      outputFormat: "text" as const,
    };

    await expect(
      createCodexKitIsolationPlan(testDir, {
        ...options,
        probe: () => userPromptInput("user echo only"),
      })
    ).rejects.toThrow("could not inspect a developer prompt surface");

    let calls = 0;
    await expect(
      createCodexKitIsolationPlan(testDir, {
        ...options,
        probe: () => {
          calls += 1;
          return calls === 1
            ? promptInput("provider-owned developer policy only")
            : userPromptInput("user echo only");
        },
      })
    ).rejects.toThrow("could not verify a developer prompt surface");
    expect(calls).toBe(2);
  });

  it.skipIf(process.platform === "win32")(
    "force-kills a SIGTERM-ignoring probe descendant after its leader exits",
    async () => {
      testDir = mkdtempSync(join(tmpdir(), "codex-kit-isolation-"));
      const pidFile = join(testDir, "probe-pids.txt");
      const codexStub = join(testDir, "codex");
      const descendantSource = [
        'process.on("SIGTERM", () => {});',
        'process.stdout.write("ready\\n");',
        "setInterval(() => {}, 1000);",
      ].join("");
      const stubSource = [
        "#!/usr/bin/env node",
        'const { spawn } = require("node:child_process");',
        'const { writeFileSync } = require("node:fs");',
        `const descendant = spawn(process.execPath, ["-e", ${JSON.stringify(
          descendantSource
        )}], { stdio: ["ignore", "pipe", "ignore"] });`,
        'descendant.stdout.once("data", () => {',
        "  writeFileSync(process.env.KIT_PROBE_PID_FILE, `${process.pid}:${descendant.pid}`);",
        "  process.stdout.write(Buffer.alloc(2 * 1024 * 1024 + 1, 120));",
        "});",
        'process.on("SIGTERM", () => process.exit(0));',
        "setInterval(() => {}, 1000);",
      ].join("\n");
      writeFileSync(codexStub, stubSource, { mode: 0o700 });
      chmodSync(codexStub, 0o700);

      let parentPid: number | undefined;
      let descendantPid: number | undefined;
      try {
        await expect(
          runCodexKitPromptProbeForTest(() =>
            spawnCliProcess(process.execPath, [codexStub], {
              cwd: testDir ?? undefined,
              env: { ...process.env, KIT_PROBE_PID_FILE: pidFile },
              stdio: ["ignore", "pipe", "pipe"],
            })
          )
        ).rejects.toThrow("Codex Kit isolation preflight failed");

        [parentPid, descendantPid] = readFileSync(pidFile, "utf8").split(":").map(Number);
        expect(Number.isInteger(parentPid)).toBe(true);
        expect(Number.isInteger(descendantPid)).toBe(true);
        expect(pidIsAlive(descendantPid)).toBe(true);
        expect(isProcessGroupRegisteredForTest(parentPid)).toBe(true);

        await waitForProcessGroupCleanup(parentPid, descendantPid);
        expect(pidIsAlive(descendantPid)).toBe(false);
        expect(isProcessGroupRegisteredForTest(parentPid)).toBe(false);
      } finally {
        if (parentPid) {
          try {
            process.kill(-parentPid, "SIGKILL");
          } catch {
            /* best-effort test cleanup */
          }
        }
      }
    },
    15_000
  );
});
