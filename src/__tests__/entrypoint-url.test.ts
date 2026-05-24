import { describe, expect, it } from "vitest";
import { pathToFileURL } from "url";
import { entrypointFileURL } from "../entrypoint-url.js";

describe("entrypointFileURL", () => {
  it("uses Node file URL conversion for the real entrypoint path", () => {
    expect(entrypointFileURL(process.execPath)).toBe(pathToFileURL(process.execPath).href);
  });
});
