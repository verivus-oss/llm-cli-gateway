/**
 * U26 — Codex high-impact feature flags.
 *
 * Verifies `prepareCodexRequest` (the real emission path) surfaces the new
 * --output-schema / --profile / -c / --ephemeral / -i /
 * --ignore-user-config / --ignore-rules flags into the argv segment, that
 * configOverrides is sanitized at the Zod level, that missing image paths
 * fail fast via createErrorResponse, and that the outputSchema temp-file
 * cleanup hook actually deletes the file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { prepareCodexRequest, resolveGatewayServerRuntime } from "../index.js";
import {
  CODEX_CONFIG_OVERRIDES_SCHEMA,
  filterCodexResumeFlags,
  prepareCodexHighImpactFlags,
  prepareCodexOutputSchema,
} from "../request-helpers.js";
import { validateUpstreamCliArgs } from "../upstream-contracts.js";

const BASE_PARAMS = {
  prompt: "hello codex",
  fullAuto: false,
  dangerouslyBypassApprovalsAndSandbox: false,
  approvalStrategy: "legacy" as const,
  mcpServers: [] as never[],
  optimizePrompt: false,
  operation: "codex_request",
};

function callPrepare(extra: Record<string, unknown>): { args: string[]; cleanup?: () => void } {
  const result = prepareCodexRequest({ ...BASE_PARAMS, ...extra } as never);
  if (!("args" in result)) {
    throw new Error(
      "prepareCodexRequest returned an ExtendedToolResponse instead of CliRequestPrep — " +
        JSON.stringify(result).slice(0, 200)
    );
  }
  return { args: result.args, cleanup: result.cleanup };
}

describe("U26 — Codex high-impact feature flags", () => {
  let testHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    testHome = mkdtempSync(join(tmpdir(), "u26-codex-handler-"));
    originalHome = process.env.HOME;
    process.env.HOME = testHome;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(testHome, { recursive: true, force: true });
  });

  describe("flag emission via prepareCodexRequest", () => {
    it("treats search as a deprecated no-op because current Codex exec rejects --search", () => {
      const { args } = callPrepare({ search: true });
      expect(args).not.toContain("--search");
    });

    it("emits --profile <name>", () => {
      const { args } = callPrepare({ profile: "research" });
      const idx = args.indexOf("--profile");
      expect(idx).toBeGreaterThan(-1);
      expect(args[idx + 1]).toBe("research");
    });

    it("emits --ephemeral when ephemeral=true", () => {
      const { args } = callPrepare({ ephemeral: true });
      expect(args).toContain("--ephemeral");
    });

    it("emits --ignore-user-config when ignoreUserConfig=true", () => {
      const { args } = callPrepare({ ignoreUserConfig: true });
      expect(args).toContain("--ignore-user-config");
    });

    it("emits --ignore-rules when ignoreRules=true", () => {
      const { args } = callPrepare({ ignoreRules: true });
      expect(args).toContain("--ignore-rules");
    });

    it("emits -c key=value for configOverrides", () => {
      const { args } = callPrepare({ configOverrides: { "model.foo": "bar" } });
      // Find consecutive ["-c", "model.foo=bar"]
      let found = false;
      for (let i = 0; i < args.length - 1; i++) {
        if (args[i] === "-c" && args[i + 1] === "model.foo=bar") {
          found = true;
          break;
        }
      }
      expect(found).toBe(true);
    });

    it("emits -i <path> for each image", () => {
      // Create real files so the existsSync check passes.
      const img1 = join(testHome, "a.png");
      const img2 = join(testHome, "b.png");
      writeFileSync(img1, "x");
      writeFileSync(img2, "y");
      const { args } = callPrepare({ images: [img1, img2] });
      let count = 0;
      for (let i = 0; i < args.length - 1; i++) {
        if (args[i] === "-i" && (args[i + 1] === img1 || args[i + 1] === img2)) count++;
      }
      expect(count).toBe(2);
    });

    it("fails fast (createErrorResponse) when an image path does not exist", () => {
      const missing = join(testHome, "definitely-missing.png");
      const result = prepareCodexRequest({
        ...BASE_PARAMS,
        images: [missing],
      } as never);
      expect("args" in result).toBe(false);
      // ExtendedToolResponse surfaces the missing path via the error text.
      const text = JSON.stringify(result);
      expect(text).toContain(missing);
    });

    it("does NOT emit any U26 flag when no new params are supplied", () => {
      const { args } = callPrepare({});
      expect(args).not.toContain("--search");
      expect(args).not.toContain("--ephemeral");
      expect(args).not.toContain("--profile");
      expect(args).not.toContain("--output-schema");
      expect(args).not.toContain("-c");
      expect(args).not.toContain("-i");
      expect(args).not.toContain("--ignore-user-config");
      expect(args).not.toContain("--ignore-rules");
    });

    it("fullAuto emits current Codex-compatible argv", () => {
      const { args } = callPrepare({ fullAuto: true });
      expect(args).toContain("--sandbox");
      expect(args).toContain("workspace-write");
      expect(args).not.toContain("--ask-for-approval");
      expect(args).not.toContain("--full-auto");
      expect(validateUpstreamCliArgs("codex", args).ok).toBe(true);
    });

    it("logs deprecated Codex approval inputs on resume without emitting them", () => {
      const warn = vi.fn();
      const runtime = resolveGatewayServerRuntime({
        logger: {
          info: vi.fn(),
          warn,
          error: vi.fn(),
          debug: vi.fn(),
        },
      });

      const result = prepareCodexRequest(
        {
          ...BASE_PARAMS,
          resumeLatest: true,
          askForApproval: "on-request",
          useLegacyFullAutoFlag: true,
        } as never,
        runtime
      );

      expect("args" in result).toBe(true);
      if (!("args" in result)) return;
      expect(result.args).not.toContain("--ask-for-approval");
      expect(result.args).not.toContain("--full-auto");
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("--ask-for-approval"));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("--full-auto"));
    });
  });

  describe("#44 — codex always emits --json so telemetry is captured on every request", () => {
    it("emits --json on a new session in the default (text) output mode", () => {
      const { args } = callPrepare({ createNewSession: true });
      expect(args).toContain("--json");
    });

    it("emits --json on a new session when outputFormat='json' (opt-in path unchanged)", () => {
      const { args } = callPrepare({ createNewSession: true, outputFormat: "json" });
      expect(args).toContain("--json");
    });

    it("emits --json on resume too (telemetry must not depend on session mode)", () => {
      const RESUME_ID = "01940000-0000-7000-8000-000000000abc"; // real codex UUID, not gw-
      const { args } = callPrepare({ sessionId: RESUME_ID });
      expect(args).toContain("resume");
      expect(args).toContain("--json");
      // --json is accepted by `codex exec` (and `codex exec resume`); the
      // mechanical upstream contract must agree.
      expect(validateUpstreamCliArgs("codex", args).ok).toBe(true);
    });
  });

  describe("outputSchema temp-file lifecycle", () => {
    it("string outputSchema passes the path verbatim with no temp file", () => {
      const schemaPath = "/some/preexisting/schema.json";
      const { args, cleanup } = callPrepare({ outputSchema: schemaPath });
      const idx = args.indexOf("--output-schema");
      expect(idx).toBeGreaterThan(-1);
      expect(args[idx + 1]).toBe(schemaPath);
      // Cleanup should be a no-op for string input.
      cleanup?.();
      // The user-provided path is untouched.
      // (no assertion needed: we never wrote there).
    });

    it("object outputSchema materializes a 0o600 temp file under os.tmpdir()", () => {
      const schemaObj = { type: "object", properties: { x: { type: "string" } } };
      const { args, cleanup } = callPrepare({ outputSchema: schemaObj });
      const idx = args.indexOf("--output-schema");
      expect(idx).toBeGreaterThan(-1);
      const path = args[idx + 1];
      expect(path.startsWith(tmpdir())).toBe(true);
      expect(existsSync(path)).toBe(true);

      // File content matches.
      const content = JSON.parse(readFileSync(path, "utf-8"));
      expect(content).toEqual(schemaObj);

      // Mode bits: 0o600 (owner read/write only).
      const stat = statSync(path);
      // mask off file-type bits, keep permission bits.
      expect(stat.mode & 0o777).toBe(0o600);

      // Cleanup deletes the file.
      cleanup?.();
      expect(existsSync(path)).toBe(false);
    });

    it("cleanup is idempotent (second call does not throw)", () => {
      const { cleanup } = callPrepare({ outputSchema: { x: 1 } });
      expect(() => {
        cleanup?.();
        cleanup?.();
      }).not.toThrow();
    });

    it("prepareCodexOutputSchema returns null for undefined input", () => {
      expect(prepareCodexOutputSchema(undefined)).toBeNull();
    });
  });

  describe("CODEX_CONFIG_OVERRIDES_SCHEMA Zod-level validation", () => {
    it("accepts a well-formed override map", () => {
      const parsed = CODEX_CONFIG_OVERRIDES_SCHEMA.safeParse({
        "model.foo": "bar",
        "tools.web_search": "true",
      });
      expect(parsed.success).toBe(true);
    });

    it("rejects a key with whitespace", () => {
      const parsed = CODEX_CONFIG_OVERRIDES_SCHEMA.safeParse({ "bad key": "x" });
      expect(parsed.success).toBe(false);
    });

    it("rejects a key with equals sign", () => {
      const parsed = CODEX_CONFIG_OVERRIDES_SCHEMA.safeParse({ "bad=key": "x" });
      expect(parsed.success).toBe(false);
    });

    it("rejects a key with a flag-like prefix (-)", () => {
      const parsed = CODEX_CONFIG_OVERRIDES_SCHEMA.safeParse({ "--evil": "x" });
      expect(parsed.success).toBe(false);
    });

    it("rejects a value containing a newline", () => {
      const parsed = CODEX_CONFIG_OVERRIDES_SCHEMA.safeParse({ k: "value\nwith newline" });
      expect(parsed.success).toBe(false);
    });

    it("rejects a value containing a carriage return", () => {
      const parsed = CODEX_CONFIG_OVERRIDES_SCHEMA.safeParse({ k: "value\rwith cr" });
      expect(parsed.success).toBe(false);
    });
  });

  describe("Codex resume-mode flag filtering", () => {
    it("filters --search, --add-dir, -C, --cd, --profile, --sandbox, --ask-for-approval, --full-auto", () => {
      const input = [
        "--model",
        "gpt-5.5",
        "--sandbox",
        "workspace-write",
        "--ask-for-approval",
        "never",
        "--full-auto",
        "--add-dir",
        "/tmp/extra",
        "-C",
        "/tmp/cwd",
        "--cd",
        "/tmp/cwd-long",
        "--profile",
        "research",
        "--search",
        "PROMPT",
      ];
      const out = filterCodexResumeFlags(input);
      expect(out).toEqual(["--model", "gpt-5.5", "PROMPT"]);
    });

    it("preserves --output-schema on resume (Phase 4 slice α — accepted by codex exec resume)", () => {
      const input = ["--model", "gpt-5.5", "--output-schema", "/tmp/schema.json", "PROMPT"];
      expect(filterCodexResumeFlags(input)).toEqual(input);
    });

    it("preserves -c key=value on resume (Phase 4 slice α — config overrides accepted)", () => {
      const input = ["--model", "gpt-5.5", "-c", "model.foo=bar", "PROMPT"];
      expect(filterCodexResumeFlags(input)).toEqual(input);
    });

    it("preserves benign flags when filtering", () => {
      const input = ["exec", "resume", "--last", "--model", "gpt-5.5", "hello"];
      expect(filterCodexResumeFlags(input)).toEqual(input);
    });
  });

  describe("Phase 4 slice α — resume branch passes --output-schema + -c", () => {
    const RESUME_ID = "01940000-0000-7000-8000-000000000abc"; // not gw- prefix

    it("resume + outputSchema (string) emits --output-schema <path>", () => {
      const schemaPath = "/some/preexisting/schema.json";
      const { args } = callPrepare({ sessionId: RESUME_ID, outputSchema: schemaPath });
      expect(args).toContain("resume");
      const idx = args.indexOf("--output-schema");
      expect(idx).toBeGreaterThan(-1);
      expect(args[idx + 1]).toBe(schemaPath);
    });

    it("resume + outputSchema (object) materialises a temp file and cleanup deletes it", () => {
      const schemaObj = { type: "object", properties: { y: { type: "number" } } };
      const { args, cleanup } = callPrepare({ sessionId: RESUME_ID, outputSchema: schemaObj });
      expect(args).toContain("resume");
      const idx = args.indexOf("--output-schema");
      expect(idx).toBeGreaterThan(-1);
      const path = args[idx + 1];
      expect(path.startsWith(tmpdir())).toBe(true);
      expect(existsSync(path)).toBe(true);
      cleanup?.();
      expect(existsSync(path)).toBe(false);
    });

    it("resume + configOverrides emits -c key=value for each entry", () => {
      const { args } = callPrepare({
        sessionId: RESUME_ID,
        configOverrides: { "model.foo": "bar", "tools.web_search": "true" },
      });
      expect(args).toContain("resume");
      const pairs: string[] = [];
      for (let i = 0; i < args.length - 1; i++) {
        if (args[i] === "-c") pairs.push(args[i + 1]);
      }
      expect(pairs).toContain("model.foo=bar");
      expect(pairs).toContain("tools.web_search=true");
    });

    it("resume still drops --search and logs a deprecation warning", () => {
      const warn = vi.fn();
      const runtime = resolveGatewayServerRuntime({
        logger: {
          info: vi.fn(),
          warn,
          error: vi.fn(),
          debug: vi.fn(),
        },
      });

      const result = prepareCodexRequest(
        {
          ...BASE_PARAMS,
          sessionId: RESUME_ID,
          search: true,
        } as never,
        runtime
      );

      expect("args" in result).toBe(true);
      if (!("args" in result)) return;
      expect(result.args).toContain("resume");
      expect(result.args).not.toContain("--search");
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("--search"));
    });

    it("resume drops --profile and logs a compatibility warning", () => {
      const warn = vi.fn();
      const runtime = resolveGatewayServerRuntime({
        logger: {
          info: vi.fn(),
          warn,
          error: vi.fn(),
          debug: vi.fn(),
        },
      });

      const result = prepareCodexRequest(
        {
          ...BASE_PARAMS,
          sessionId: RESUME_ID,
          profile: "research",
        } as never,
        runtime
      );

      expect("args" in result).toBe(true);
      if (!("args" in result)) return;
      expect(result.args).toContain("resume");
      expect(result.args).not.toContain("--profile");
      expect(result.args).not.toContain("research");
      expect(validateUpstreamCliArgs("codex", result.args).ok).toBe(true);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("--profile"));
    });

    it("regression: new-session path still emits --output-schema + -c when supplied", () => {
      const { args } = callPrepare({
        createNewSession: true,
        outputSchema: "/tmp/x.json",
        configOverrides: { "model.foo": "bar" },
      });
      expect(args).not.toContain("resume");
      expect(args).toContain("--output-schema");
      // ["-c", "model.foo=bar"] adjacency check
      let found = false;
      for (let i = 0; i < args.length - 1; i++) {
        if (args[i] === "-c" && args[i + 1] === "model.foo=bar") {
          found = true;
          break;
        }
      }
      expect(found).toBe(true);
    });
  });

  describe("prepareCodexHighImpactFlags pure helper", () => {
    it("returns missingImagePath without writing a temp file", () => {
      const r = prepareCodexHighImpactFlags({
        images: ["/totally/missing/path.png"],
        outputSchema: { x: 1 }, // even with a schema, image check fires first
      });
      expect(r.missingImagePath).toBe("/totally/missing/path.png");
      // No args, no cleanup needed.
      expect(r.args).toEqual([]);
    });
  });
});
