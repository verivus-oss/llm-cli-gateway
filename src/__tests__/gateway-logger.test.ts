import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "../index.js";

describe("gateway logger secret redaction", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("redacts message strings and structured args before writing to stderr", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = new Error("failed with api_key=AbCdEf123456");
    error.name = "TokenError xai-ABCDEFGHIJKLMNOP1234";
    error.stack = "stack with Authorization: Bearer abcdef0123456789ghijkl";

    logger.error("Authorization: Bearer abcdef0123456789ghijkl", {
      nested: {
        error,
        shared: { next: { deep: { value: { secret: "sk-ant-abcdefghijklmnopqrstuvwx" } } } },
      },
    });

    const rendered = JSON.stringify(spy.mock.calls);
    expect(rendered).not.toContain("abcdef0123456789ghijkl");
    expect(rendered).not.toContain("AbCdEf123456");
    expect(rendered).not.toContain("xai-ABCDEFGHIJKLMNOP1234");
    expect(rendered).not.toContain("sk-ant-abcdefghijklmnopqrstuvwx");
    expect(rendered).toContain("[REDACTED]");
    expect(rendered).toContain("[Object]");
  });

  it("redacts debug logs only when DEBUG is enabled", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    logger.debug("api_key=AbCdEf123456");
    expect(spy).not.toHaveBeenCalled();

    vi.stubEnv("DEBUG", "1");
    logger.debug("api_key=AbCdEf123456");

    const rendered = JSON.stringify(spy.mock.calls);
    expect(rendered).not.toContain("AbCdEf123456");
    expect(rendered).toContain("api_key=[REDACTED]");
  });
});
