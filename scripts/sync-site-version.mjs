#!/usr/bin/env node
// Keep the hard-coded version strings in site/index.html in lock-step with
// package.json. The static Cloudflare Pages site (site/) carries the version
// in two places — the JSON-LD `softwareVersion` and the footer `v<x.y.z>` — and
// nothing else reads package.json at build time, so without this they drift
// (the site sat at 2.6.0 through the 2.7/2.8/2.9 releases).
//
// Modes:
//   node scripts/sync-site-version.mjs           # rewrite site/index.html to match package.json
//   node scripts/sync-site-version.mjs --check    # exit 1 if they differ (no write); used by CI + deploy
//
// The companion test (src/__tests__/site-version.test.ts) is the CI guard that
// makes a mismatch a red build; this script is the one-command fix + the
// deploy-time assertion.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkgPath = join(repoRoot, "package.json");
const sitePath = join(repoRoot, "site", "index.html");

const version = JSON.parse(readFileSync(pkgPath, "utf8")).version;
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`Refusing to sync: package.json version "${version}" is not x.y.z`);
  process.exit(2);
}

// Each entry: a regex with three capture groups (prefix, version, suffix). The
// version group is what we read/replace; prefix/suffix anchor it precisely so we
// never touch an unrelated semver-looking string elsewhere in the HTML.
const SITES = [
  { name: "JSON-LD softwareVersion", re: /("softwareVersion":\s*")(\d+\.\d+\.\d+)(")/ },
  { name: "footer version", re: /(llm-cli-gateway v)(\d+\.\d+\.\d+)(<\/span>)/ },
];

const checkOnly = process.argv.includes("--check");
let html = readFileSync(sitePath, "utf8");
const mismatches = [];
let changed = false;

for (const site of SITES) {
  const m = html.match(site.re);
  if (!m) {
    console.error(`Could not find the ${site.name} version anchor in site/index.html`);
    process.exit(2);
  }
  if (m[2] !== version) {
    mismatches.push(`${site.name}: site has ${m[2]}, package.json has ${version}`);
    if (!checkOnly) {
      html = html.replace(site.re, `$1${version}$3`);
      changed = true;
    }
  }
}

if (checkOnly) {
  if (mismatches.length > 0) {
    console.error("site/index.html version is out of sync with package.json:");
    for (const m of mismatches) console.error(`  - ${m}`);
    console.error("Run: node scripts/sync-site-version.mjs");
    process.exit(1);
  }
  console.log(`site/index.html version matches package.json (${version}).`);
  process.exit(0);
}

if (changed) {
  writeFileSync(sitePath, html);
  console.log(`Synced site/index.html to ${version} (${mismatches.length} string(s) updated).`);
} else {
  console.log(`site/index.html already at ${version}; nothing to do.`);
}
