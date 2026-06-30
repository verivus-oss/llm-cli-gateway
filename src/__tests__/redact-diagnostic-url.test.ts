import { describe, expect, it } from "vitest";
import { redactDiagnosticUrl } from "../endpoint-exposure.js";

// redactDiagnosticUrl strips credentials/sensitive params from a URL on the
// diagnostic surfaces, while leaving a clean URL byte-identical (it must not
// silently canonicalize a non-secret base_url via URL parsing).
describe("redactDiagnosticUrl", () => {
  it("returns null for null input", () => {
    expect(redactDiagnosticUrl(null)).toBeNull();
  });

  it("redacts userinfo while preserving scheme/host/path", () => {
    expect(redactDiagnosticUrl("https://user:pass@host.example/v1")).toBe(
      "https://<redacted>:<redacted>@host.example/v1"
    );
  });

  it("redacts sensitive query params", () => {
    expect(redactDiagnosticUrl("https://host.example/v1?token=abc&safe=ok")).toBe(
      "https://host.example/v1?token=<redacted>&safe=ok"
    );
  });

  it("leaves a clean URL byte-identical (no canonicalization)", () => {
    // Uppercase host and an explicit default port would be normalized away by
    // `new URL().toString()`; with nothing to redact, the original bytes survive.
    for (const url of [
      "https://api.example.com/v1",
      "https://API.Example.com/v1",
      "https://host.example:443/v1",
      "http://127.0.0.1:11434/v1",
      "https://host.example/v1?safe=ok",
    ]) {
      expect(redactDiagnosticUrl(url)).toBe(url);
    }
  });
});
