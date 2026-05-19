/**
 * U27: Gemini auth detection across multiple methods.
 *
 * `geminiAuthStatus` is "ok" (status === "present") when ANY of:
 *   - OAuth credential file present
 *   - GEMINI_API_KEY env var set and non-empty
 *   - GOOGLE_API_KEY env var set and non-empty
 *   - GOOGLE_CLOUD_PROJECT set AND GOOGLE_GENAI_USE_VERTEXAI=true
 *
 * The returned `methods` breakdown reports which method(s) matched.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { geminiAuthStatus } from "../provider-status.js";

let fakeHome: string;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), "u27-prov-home-"));
});

afterEach(() => {
  rmSync(fakeHome, { recursive: true, force: true });
});

function emptyEnv(): NodeJS.ProcessEnv {
  // Strip out any pre-existing GEMINI_*/GOOGLE_* env so the test is hermetic.
  return {} as NodeJS.ProcessEnv;
}

function writeOauthCred(home: string): void {
  mkdirSync(join(home, ".gemini"), { recursive: true });
  writeFileSync(join(home, ".gemini", "oauth_creds.json"), "{}", { mode: 0o600 });
}

describe("U27 geminiAuthStatus", () => {
  it("reports status='not_found' and all methods false when nothing is configured", () => {
    const res = geminiAuthStatus(emptyEnv(), fakeHome);
    expect(res.status).toBe("not_found");
    expect(res.methods).toEqual({
      oauth: false,
      geminiApiKey: false,
      googleApiKey: false,
      vertexAi: false,
    });
  });

  it("matches OAuth credential store alone", () => {
    writeOauthCred(fakeHome);
    const res = geminiAuthStatus(emptyEnv(), fakeHome);
    expect(res.status).toBe("present");
    expect(res.methods.oauth).toBe(true);
    expect(res.methods.geminiApiKey).toBe(false);
    expect(res.methods.googleApiKey).toBe(false);
    expect(res.methods.vertexAi).toBe(false);
  });

  it("matches GEMINI_API_KEY alone", () => {
    const env = { GEMINI_API_KEY: "sk-test-abc" } as NodeJS.ProcessEnv;
    const res = geminiAuthStatus(env, fakeHome);
    expect(res.status).toBe("present");
    expect(res.methods.geminiApiKey).toBe(true);
    expect(res.methods.oauth).toBe(false);
  });

  it("matches GOOGLE_API_KEY alone", () => {
    const env = { GOOGLE_API_KEY: "AIza..." } as NodeJS.ProcessEnv;
    const res = geminiAuthStatus(env, fakeHome);
    expect(res.status).toBe("present");
    expect(res.methods.googleApiKey).toBe(true);
  });

  it("matches Vertex AI when GOOGLE_CLOUD_PROJECT + GOOGLE_GENAI_USE_VERTEXAI=true are both set", () => {
    const env = {
      GOOGLE_CLOUD_PROJECT: "my-proj",
      GOOGLE_GENAI_USE_VERTEXAI: "true",
    } as NodeJS.ProcessEnv;
    const res = geminiAuthStatus(env, fakeHome);
    expect(res.status).toBe("present");
    expect(res.methods.vertexAi).toBe(true);
  });

  it("does NOT match Vertex when only GOOGLE_CLOUD_PROJECT is set", () => {
    const env = { GOOGLE_CLOUD_PROJECT: "my-proj" } as NodeJS.ProcessEnv;
    const res = geminiAuthStatus(env, fakeHome);
    expect(res.methods.vertexAi).toBe(false);
    expect(res.status).toBe("not_found");
  });

  it("does NOT match Vertex when GOOGLE_GENAI_USE_VERTEXAI is not exactly 'true'", () => {
    const env = {
      GOOGLE_CLOUD_PROJECT: "my-proj",
      GOOGLE_GENAI_USE_VERTEXAI: "1",
    } as NodeJS.ProcessEnv;
    const res = geminiAuthStatus(env, fakeHome);
    expect(res.methods.vertexAi).toBe(false);
  });

  it("treats empty env-var strings as not set", () => {
    const env = {
      GEMINI_API_KEY: "",
      GOOGLE_API_KEY: "",
    } as NodeJS.ProcessEnv;
    const res = geminiAuthStatus(env, fakeHome);
    expect(res.methods.geminiApiKey).toBe(false);
    expect(res.methods.googleApiKey).toBe(false);
    expect(res.status).toBe("not_found");
  });

  it("reports multiple matched methods when several are present", () => {
    writeOauthCred(fakeHome);
    const env = {
      GEMINI_API_KEY: "sk-test",
      GOOGLE_CLOUD_PROJECT: "p",
      GOOGLE_GENAI_USE_VERTEXAI: "true",
    } as NodeJS.ProcessEnv;
    const res = geminiAuthStatus(env, fakeHome);
    expect(res.status).toBe("present");
    expect(res.methods).toEqual({
      oauth: true,
      geminiApiKey: true,
      googleApiKey: false,
      vertexAi: true,
    });
  });
});
