import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import {
  AcpDisabledError,
  AcpError,
  AcpPermissionDeniedError,
  AcpProcessExitError,
  AcpProtocolError,
  AcpTimeoutError,
  ProviderAcpDisabledError,
  ProviderAcpUnsupportedError,
  ProviderRuntimeDisabledError,
  ProviderUnavailableError,
  isAcpError,
  redactAcpDebug,
  redactAcpMessage,
} from "../acp/errors.js";

// Step: define-acp-provider-registry-and-errors.
// Validation clause: error tests assert raw JSON-RPC payloads and credential
// paths do not appear in user-facing messages.

const RAW_JSON_RPC =
  '{"jsonrpc":"2.0","id":7,"method":"session/prompt","params":{"prompt":"leak this secret prompt text"}}';
const CREDENTIAL_PATH = "/home/werner/.config/grok/credentials.json";
const HOME_REL_PATH = "~/.codex/sessions/abc.json";
const BEARER = "Authorization: Bearer sk-abcdef0123456789deadbeef";
const EMAIL = "werner@verivus.com";

describe("redactAcpMessage", () => {
  it("strips raw JSON-RPC bodies", () => {
    const out = redactAcpMessage(`agent said ${RAW_JSON_RPC}`);
    expect(out).not.toContain("leak this secret prompt text");
    expect(out).not.toContain("session/prompt");
    expect(out).toContain("<redacted-json>");
  });

  it("strips nested JSON bodies without leaking trailing prompt fields", () => {
    const out = redactAcpMessage(
      'agent said {"outer":{"message":"ok"},"params":{"prompt":"leak this prompt text"}}'
    );
    expect(out).not.toContain("leak this prompt text");
    expect(out).not.toContain("prompt");
    expect(out).toBe("agent said <redacted-json>");
  });

  it("ignores JSON delimiters inside quoted strings while redacting the whole body", () => {
    const out = redactAcpMessage('agent said {"message":"}","prompt":"leak this prompt text"}');
    expect(out).not.toContain("leak this prompt text");
    expect(out).not.toContain("prompt");
    expect(out).toBe("agent said <redacted-json>");
  });

  it("handles unmatched JSON delimiters without over-redacting", () => {
    const input = `${"{".repeat(1000)} keep this status`;
    expect(redactAcpMessage(input)).toBe(input);
  });

  it("redacts truncated JSON-RPC-like payloads instead of leaking prompt text", () => {
    const out = redactAcpMessage(
      'agent said {"jsonrpc":"2.0","params":{"prompt":"leak this prompt text"}'
    );
    expect(out).not.toContain("leak this prompt text");
    expect(out).not.toContain("jsonrpc");
    expect(out).toBe("agent said <redacted-json>");
  });

  it("handles large unmatched delimiter runs in linear time", () => {
    const input = `${"{".repeat(200_000)} keep this status`;
    const started = performance.now();
    expect(redactAcpMessage(input)).toBe(input);
    expect(performance.now() - started).toBeLessThan(250);
  });

  it("strips absolute credential paths", () => {
    const out = redactAcpMessage(`failed reading ${CREDENTIAL_PATH}`);
    expect(out).not.toContain(CREDENTIAL_PATH);
    expect(out).not.toContain("credentials.json");
    expect(out).toContain("<redacted-path>");
  });

  it("strips home-relative paths", () => {
    const out = redactAcpMessage(`session at ${HOME_REL_PATH}`);
    expect(out).not.toContain(".codex/sessions");
    expect(out).toContain("<redacted-path>");
  });

  it("strips paths regardless of the preceding delimiter (quoted, parenthesised, key:/path)", () => {
    // Regression for round-2 finding: paths only preceded by start-of-string or
    // whitespace were redacted; quoted/parenthesised/key:/path forms leaked.
    const leaky = [
      `cannot read (${CREDENTIAL_PATH})`,
      `path="${CREDENTIAL_PATH}"`,
      `path='${CREDENTIAL_PATH}'`,
      `cwd:/home/werner/project`,
      `home=${HOME_REL_PATH}`,
      `at(${HOME_REL_PATH})`,
    ];
    for (const message of leaky) {
      const out = redactAcpMessage(message);
      expect(out).not.toContain(CREDENTIAL_PATH);
      expect(out).not.toContain("credentials.json");
      expect(out).not.toContain(".codex/sessions");
      expect(out).not.toContain("/home/werner/project");
      expect(out).toContain("<redacted-path>");
    }
  });

  it("preserves the delimiter character that precedes a redacted path", () => {
    expect(redactAcpMessage(`path="${CREDENTIAL_PATH}"`)).toContain('path="<redacted-path>"');
    expect(redactAcpMessage(`(${CREDENTIAL_PATH})`)).toContain("(<redacted-path>)");
  });

  it("strips Windows drive-letter and UNC credential paths", () => {
    // Regression for round-3 finding: only ~/... and POSIX /... paths were
    // redacted; Windows drive-letter and UNC paths leaked credentials.json.
    const driveLetter = "C:\\Users\\werner\\.config\\grok\\credentials.json";
    const unc = "\\\\fileserver\\share\\grok\\credentials.json";

    const driveOut = redactAcpMessage(`cannot read ${driveLetter}`);
    expect(driveOut).not.toContain("credentials.json");
    expect(driveOut).not.toContain("C:\\Users");
    expect(driveOut).toContain("<redacted-path>");

    const uncOut = redactAcpMessage(`cannot read ${unc}`);
    expect(uncOut).not.toContain("credentials.json");
    expect(uncOut).not.toContain("fileserver");
    expect(uncOut).toContain("<redacted-path>");

    // Quoted/parenthesised Windows forms too.
    expect(redactAcpMessage(`path="${driveLetter}"`)).not.toContain("credentials.json");
    expect(redactAcpMessage(`(${driveLetter})`)).not.toContain("credentials.json");
  });

  it("does not redact non-path slashes like version timeouts", () => {
    // Guard against over-redaction regressions on legitimate numeric content.
    const out = redactAcpMessage("ACP request initialize timed out after 10000ms.");
    expect(out).toBe("ACP request initialize timed out after 10000ms.");
  });

  it("strips bearer tokens and api keys", () => {
    const out = redactAcpMessage(BEARER);
    expect(out).not.toContain("sk-abcdef0123456789deadbeef");
  });

  it("strips email addresses", () => {
    const out = redactAcpMessage(`auth for ${EMAIL}`);
    expect(out).not.toContain(EMAIL);
    expect(out).toContain("<redacted-email>");
  });
});

describe("redactAcpDebug", () => {
  it("drops sensitive keys and redacts string values recursively", () => {
    const redacted = redactAcpDebug({
      method: "session/prompt",
      payload: RAW_JSON_RPC,
      cwd: "/home/werner/project",
      nested: { token: "sk-deadbeefcafebabe1234", note: `path ${CREDENTIAL_PATH}` },
      durationMs: 42,
    }) as Record<string, unknown>;

    expect(redacted.method).toBe("session/prompt");
    expect(redacted.payload).toBe("<redacted>");
    expect(redacted.cwd).toBe("<redacted>");
    expect(redacted.durationMs).toBe(42);

    const nested = redacted.nested as Record<string, unknown>;
    expect(nested.token).toBe("<redacted>");
    expect(String(nested.note)).not.toContain(CREDENTIAL_PATH);

    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain("leak this secret prompt text");
    expect(serialized).not.toContain("credentials.json");
    expect(serialized).not.toContain("sk-deadbeefcafebabe1234");
  });
});

describe("AcpError construction redacts the user-facing message", () => {
  it("redacts a JSON-RPC payload embedded in the message", () => {
    const err = new AcpError("protocol", `provider returned ${RAW_JSON_RPC}`, {
      provider: "grok",
      debug: { payload: RAW_JSON_RPC },
    });
    expect(err.userMessage).not.toContain("leak this secret prompt text");
    expect(err.userMessage).not.toContain("session/prompt");
    expect(err.message).toBe(err.userMessage);
    // debug is also redacted of the secret key.
    expect(JSON.stringify(err.debug)).not.toContain("leak this secret prompt text");
  });

  it("redacts credential paths embedded in the message", () => {
    const err = new AcpError("provider_unavailable", `cannot read ${CREDENTIAL_PATH}`, {
      provider: "grok",
    });
    expect(err.userMessage).not.toContain(CREDENTIAL_PATH);
    expect(err.userMessage).not.toContain("credentials.json");
  });

  it("redacts the attached cause so secrets cannot leak via logged error.cause", () => {
    // Regression for round-3 blocker: the gateway logger (src/index.ts) writes
    // error args to stderr via console.error, which inspects error.cause
    // (message + stack). A raw cause carrying a token/credential path therefore
    // reaches the logs. The cause is now redacted at construction.
    const cause = new Error(`oauth token sk-leakyleakyleaky987 from ${CREDENTIAL_PATH}`);
    const err = new AcpError("protocol", "protocol failure", { cause });
    const attached = (err as { cause?: unknown }).cause as Error;

    // userMessage never contained the cause, and still does not.
    expect(err.userMessage).not.toContain("sk-leakyleakyleaky987");
    expect(err.userMessage).not.toContain("credentials.json");

    // The cause is redacted but structurally faithful: still an Error with the
    // original name, just no raw token/credential-path material.
    expect(attached).toBeInstanceOf(Error);
    expect(attached.name).toBe("Error");
    expect(attached.message).not.toContain("sk-leakyleakyleaky987");
    expect(attached.message).not.toContain("credentials.json");
    expect(attached.message).toContain("<redacted");
    // Anything console.error would render (message + stack) is clean.
    expect(String(attached.stack ?? "")).not.toContain("sk-leakyleakyleaky987");
    expect(String(attached.stack ?? "")).not.toContain("credentials.json");
  });

  it("redacts a secret embedded in the cause error name so it cannot leak via util.inspect", () => {
    // Regression for round-4 blocker: redactAcpCause redacted message+stack but
    // copied error.name verbatim. util.inspect/console.error(err) renders the
    // name (e.g. "Error [sk-...]" or a name carrying a credential path), so a
    // token-bearing name reached stderr through the gateway logger. The name is
    // now run through redactAcpMessage too.
    const cause = new Error("benign message");
    cause.name = `TokenError sk-leakyleakyleaky987 at ${CREDENTIAL_PATH}`;
    const err = new AcpError("protocol", "protocol failure", { cause });
    const attached = (err as { cause?: unknown }).cause as Error;

    expect(attached.name).not.toContain("sk-leakyleakyleaky987");
    expect(attached.name).not.toContain("credentials.json");
    expect(attached.name).toContain("<redacted");
    // util.inspect is exactly what console.error(err) uses to render a cause.
    const rendered = inspect(attached);
    expect(rendered).not.toContain("sk-leakyleakyleaky987");
    expect(rendered).not.toContain("credentials.json");
  });

  it("preserves a class-default cause error name unchanged through redaction", () => {
    const cause = new Error("benign message");
    const err = new AcpError("protocol", "protocol failure", { cause });
    const attached = (err as { cause?: unknown }).cause as Error;
    // The common case (name === "Error") must survive redaction so log readers
    // still see the error type.
    expect(attached.name).toBe("Error");
  });

  it("redacts a non-Error cause through the debug sanitiser", () => {
    const err = new AcpError("protocol", "protocol failure", {
      cause: { token: "sk-deadbeefcafebabe1234", note: `read ${CREDENTIAL_PATH}` },
    });
    const serialized = JSON.stringify((err as { cause?: unknown }).cause);
    expect(serialized).not.toContain("sk-deadbeefcafebabe1234");
    expect(serialized).not.toContain("credentials.json");
  });
});

describe("typed ACP error subclasses", () => {
  it("AcpDisabledError carries the acp_disabled kind and is an AcpError", () => {
    const err = new AcpDisabledError();
    expect(err.kind).toBe("acp_disabled");
    expect(isAcpError(err)).toBe(true);
    expect(err).toBeInstanceOf(AcpError);
  });

  it("ProviderAcpDisabledError names the provider", () => {
    const err = new ProviderAcpDisabledError("mistral");
    expect(err.kind).toBe("provider_acp_disabled");
    expect(err.provider).toBe("mistral");
    expect(err.userMessage).toContain("mistral");
  });

  it("ProviderAcpUnsupportedError fails closed for unsupported providers", () => {
    const err = new ProviderAcpUnsupportedError("gemini");
    expect(err.kind).toBe("provider_acp_unsupported");
    expect(err.provider).toBe("gemini");
  });

  it("ProviderRuntimeDisabledError points at the provider runtime gate", () => {
    const err = new ProviderRuntimeDisabledError("grok");
    expect(err.kind).toBe("provider_runtime_disabled");
    expect(err.userMessage).toContain("runtime_enabled");
  });

  it("ProviderUnavailableError redacts a path embedded in the reason", () => {
    const err = new ProviderUnavailableError("grok", `binary missing at ${CREDENTIAL_PATH}`);
    expect(err.kind).toBe("provider_unavailable");
    expect(err.userMessage).not.toContain(CREDENTIAL_PATH);
  });

  it("AcpProtocolError carries an optional JSON-RPC code", () => {
    const err = new AcpProtocolError("bad response", { provider: "mistral", code: -32601 });
    expect(err.kind).toBe("protocol");
    expect(err.code).toBe(-32601);
  });

  it("AcpTimeoutError records method and timeout", () => {
    const err = new AcpTimeoutError("initialize", 10000, { provider: "mistral" });
    expect(err.kind).toBe("timeout");
    expect(err.method).toBe("initialize");
    expect(err.timeoutMs).toBe(10000);
    expect(err.userMessage).toContain("initialize");
    expect(err.userMessage).toContain("10000");
  });

  it("AcpPermissionDeniedError reports denial without executing side effects", () => {
    const err = new AcpPermissionDeniedError("grok", "write denied by default policy");
    expect(err.kind).toBe("permission_denied");
    expect(err.userMessage).toContain("denied");
  });

  it("AcpProcessExitError carries exit code and signal", () => {
    const err = new AcpProcessExitError("mistral", { exitCode: 1, signal: null });
    expect(err.kind).toBe("process_exit");
    expect(err.exitCode).toBe(1);
    expect(err.signal).toBeNull();
  });

  it("isAcpError narrows non-ACP values to false", () => {
    expect(isAcpError(new Error("plain"))).toBe(false);
    expect(isAcpError("string")).toBe(false);
    expect(isAcpError(null)).toBe(false);
  });
});
