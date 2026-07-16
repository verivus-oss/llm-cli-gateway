#!/usr/bin/env node
// Shared release-version classification for release automation and static-site
// metadata. The project intentionally accepts only plain stable versions or
// prereleases, because npm and the public Pages site have different policies
// for those two forms.

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const STABLE_VERSION_RE = /^\d+\.\d+\.\d+$/;
export const PRERELEASE_VERSION_RE = /^\d+\.\d+\.\d+-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*$/;

/**
 * Classify a package version accepted by the release pipeline.
 *
 * @param {string} version
 * @returns {"stable" | "prerelease"}
 */
export function classifyReleaseVersion(version) {
  if (STABLE_VERSION_RE.test(version)) return "stable";
  if (PRERELEASE_VERSION_RE.test(version)) return "prerelease";
  throw new Error(`Release version "${version}" is not x.y.z or x.y.z-<prerelease>`);
}

const modulePath = fileURLToPath(import.meta.url);

if (process.argv[1] && resolve(process.argv[1]) === modulePath) {
  try {
    const version = process.argv[2];
    if (typeof version !== "string") {
      throw new Error("Usage: node scripts/release-version.mjs <version>");
    }
    process.stdout.write(`${classifyReleaseVersion(version)}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
