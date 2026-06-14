import { describe, expect, it } from "vitest";
import { redactSecrets, isRedactionEnabled } from "../secret-redaction.js";

describe("secret redaction (F4)", () => {
  it("redacts provider, cloud, and VCS keys", () => {
    const cases: Array<[string, string]> = [
      ["sk-ant-abcdefghijklmnopqrstuvwx", "anthropic"],
      ["sk-proj-ABCDEFGHIJKLMNOP1234567890", "openai"],
      ["xai-ABCDEFGHIJKLMNOP1234", "xai"],
      ["AIzaSyA1234567890abcdefghijklmnopqrstuv", "google"],
      ["AKIAIOSFODNN7EXAMPLE", "aws"],
      ["ghp_0123456789abcdefghijklmnopqrstuvwxyz", "github"],
      ["xoxb-1234567890-abcdefghij", "slack"],
    ];
    for (const [secret] of cases) {
      const out = redactSecrets(`prefix ${secret} suffix`);
      expect(out).toBe("prefix [REDACTED] suffix");
    }
  });

  it("redacts bearer tokens but keeps the scheme", () => {
    expect(redactSecrets("Authorization: Bearer abcdef0123456789ghijkl")).toBe(
      "Authorization: Bearer [REDACTED]"
    );
  });

  it("redacts JWTs", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36";
    expect(redactSecrets(jwt)).toBe("[REDACTED]");
  });

  it("redacts PEM private key blocks", () => {
    const pem =
      "-----BEGIN RSA PRIVATE KEY-----\nMIIBOwIBAAJBAKj...\nabc123\n-----END RSA PRIVATE KEY-----";
    expect(redactSecrets(`key:\n${pem}\ndone`)).toBe("key:\n[REDACTED]\ndone");
  });

  it("redacts the value of explicit secret assignments, keeping the key", () => {
    expect(redactSecrets('password: "hunter2horse"')).toBe("password: [REDACTED]");
    expect(redactSecrets("api_key=AbCdEf123456")).toBe("api_key=[REDACTED]");
    expect(redactSecrets("client_secret = 's3cr3t-value'")).toBe("client_secret = [REDACTED]");
  });

  it("redacts URL userinfo passwords only", () => {
    expect(redactSecrets("postgres://user:p4ssw0rd@db.internal:5432/x")).toBe(
      "postgres://user:[REDACTED]@db.internal:5432/x"
    );
  });

  it("does not over-redact ordinary prose or code", () => {
    const benign = [
      "Refactor the parser and add tests.",
      "the secret is that there is no secret",
      "rotate the access key next quarter",
      "const token = parseToken(input); // returns a Token node",
      "She said the password was easy to guess.",
    ];
    for (const text of benign) {
      expect(redactSecrets(text)).toBe(text);
    }
  });

  it("is idempotent", () => {
    const once = redactSecrets("key sk-ant-abcdefghijklmnopqrstuvwx end");
    expect(redactSecrets(once)).toBe(once);
  });

  it("returns falsy/empty inputs unchanged", () => {
    expect(redactSecrets("")).toBe("");
  });

  it("isRedactionEnabled defaults on and respects disable values", () => {
    expect(isRedactionEnabled({} as NodeJS.ProcessEnv)).toBe(true);
    for (const v of ["0", "false", "off", "no", "FALSE"]) {
      expect(
        isRedactionEnabled({ LLM_GATEWAY_REDACT_LOGGED_SECRETS: v } as NodeJS.ProcessEnv)
      ).toBe(false);
    }
    expect(
      isRedactionEnabled({ LLM_GATEWAY_REDACT_LOGGED_SECRETS: "1" } as NodeJS.ProcessEnv)
    ).toBe(true);
  });
});
