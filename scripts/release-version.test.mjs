import { describe, expect, it } from "vitest";
import { classifyReleaseVersion } from "./release-version.mjs";

describe("release version classification", () => {
  it("classifies a stable release", () => {
    expect(classifyReleaseVersion("2.18.0")).toBe("stable");
  });

  it("classifies prereleases without treating them as stable", () => {
    expect(classifyReleaseVersion("2.18.0-rc.1")).toBe("prerelease");
    expect(classifyReleaseVersion("2.18.0-next")).toBe("prerelease");
  });

  it("rejects values that the release and Pages policies cannot classify", () => {
    expect(() => classifyReleaseVersion("2.18")).toThrow(/not x\.y\.z/);
    expect(() => classifyReleaseVersion("2.18.0-rc..1")).toThrow(/not x\.y\.z/);
    expect(() => classifyReleaseVersion("2.18.0+build.1")).toThrow(/not x\.y\.z/);
  });
});
