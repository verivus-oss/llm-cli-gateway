#!/usr/bin/env node
// Keep every public static-site product-version surface in sync. The Pages
// production site represents npm `latest`, not an unpublished or RC package.
//
// Modes:
//   node scripts/sync-site-version.mjs
//   node scripts/sync-site-version.mjs --check
//   node scripts/sync-site-version.mjs --check --require-stable
//
// A stable package version becomes the target for every surface. For a valid
// prerelease, package.json#publicSiteVersion is the independent stable target,
// so the site cannot validate stale metadata against one of its own labels.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { STABLE_VERSION_RE, classifyReleaseVersion } from "./release-version.mjs";

const modulePath = fileURLToPath(import.meta.url);
const defaultRepoRoot = join(dirname(modulePath), "..");

const htmlVersionAnchors = [
  {
    name: "JSON-LD softwareVersion",
    re: /("softwareVersion":\s*")(\d+\.\d+\.\d+)(")/,
  },
  {
    name: "footer version",
    re: /(llm-cli-gateway v)(\d+\.\d+\.\d+)(<\/span>)/,
  },
];

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function readText(rootDirectory, relativePath) {
  return readFileSync(join(rootDirectory, relativePath), "utf8");
}

function readJson(rootDirectory, relativePath) {
  try {
    return JSON.parse(readText(rootDirectory, relativePath));
  } catch (error) {
    throw new Error(`${relativePath} is not valid JSON: ${error.message}`, { cause: error });
  }
}

function htmlVersion(content, anchor) {
  const match = content.match(anchor.re);
  if (!match) {
    throw new Error(`Could not find ${anchor.name} in site/index.html`);
  }
  return match[2];
}

function updatedHtmlVersion(content, anchor, targetVersion) {
  return content.replace(anchor.re, `$1${targetVersion}$3`);
}

function assertVersionField(value, relativePath, field) {
  if (typeof value !== "string" || !STABLE_VERSION_RE.test(value)) {
    throw new Error(`${relativePath} has invalid ${field} version metadata`);
  }
  return value;
}

function mismatchMessage(name, actual, expected) {
  return `${name}: site has ${actual}, expected ${expected}`;
}

/**
 * Synchronize or verify the static Pages product-version contract.
 *
 * @param {{ rootDirectory?: string; checkOnly?: boolean; requireStable?: boolean }} options
 * @returns {{ changed: string[]; packageVersion: string; targetVersion: string; prerelease: boolean }}
 */
export function syncSiteVersion(options = {}) {
  const rootDirectory = options.rootDirectory ?? defaultRepoRoot;
  const checkOnly = options.checkOnly ?? false;
  const requireStable = options.requireStable ?? false;
  const packageJson = readJson(rootDirectory, "package.json");
  const packageJsonContent = readText(rootDirectory, "package.json");
  const packageVersion = packageJson.version;
  if (typeof packageVersion !== "string") {
    throw new Error("package.json has no string version");
  }

  const prerelease = classifyReleaseVersion(packageVersion) === "prerelease";
  if (requireStable && prerelease) {
    throw new Error(
      `Refusing a production Pages deployment for prerelease package version "${packageVersion}"`
    );
  }

  const indexPath = "site/index.html";
  let indexContent = readText(rootDirectory, indexPath);
  const declaredPublicSiteVersion = assertVersionField(
    packageJson.publicSiteVersion,
    "package.json",
    "publicSiteVersion"
  );
  const targetVersion = prerelease ? declaredPublicSiteVersion : packageVersion;
  if (!STABLE_VERSION_RE.test(targetVersion)) {
    throw new Error("site/index.html JSON-LD softwareVersion must be a stable x.y.z version");
  }

  const mismatches = [];
  const changed = [];
  let nextPackageJsonContent = packageJsonContent;
  if (!prerelease && declaredPublicSiteVersion !== targetVersion) {
    mismatches.push(
      mismatchMessage("package.json publicSiteVersion", declaredPublicSiteVersion, targetVersion)
    );
    packageJson.publicSiteVersion = targetVersion;
    nextPackageJsonContent = stableJson(packageJson);
  }
  for (const anchor of htmlVersionAnchors) {
    const actual = htmlVersion(indexContent, anchor);
    if (actual !== targetVersion) {
      mismatches.push(mismatchMessage(`site/index.html ${anchor.name}`, actual, targetVersion));
      indexContent = updatedHtmlVersion(indexContent, anchor, targetVersion);
    }
  }

  const serverCardPath = "site/.well-known/mcp/server-card.json";
  const serverCardContent = readText(rootDirectory, serverCardPath);
  const serverCard = readJson(rootDirectory, serverCardPath);
  if (!isRecord(serverCard)) throw new Error(`${serverCardPath} must contain an object`);
  const serverCardVersion = assertVersionField(serverCard.version, serverCardPath, "version");
  let nextServerCardContent = serverCardContent;
  if (serverCardVersion !== targetVersion) {
    mismatches.push(mismatchMessage(`${serverCardPath} version`, serverCardVersion, targetVersion));
    serverCard.version = targetVersion;
    nextServerCardContent = stableJson(serverCard);
  }

  const openapiPath = "site/openapi.json";
  const openapiContent = readText(rootDirectory, openapiPath);
  const openapi = readJson(rootDirectory, openapiPath);
  if (!isRecord(openapi) || !isRecord(openapi.info)) {
    throw new Error(`${openapiPath} must contain an info object`);
  }
  const openapiVersion = assertVersionField(openapi.info.version, openapiPath, "info.version");
  let nextOpenapiContent = openapiContent;
  if (openapiVersion !== targetVersion) {
    mismatches.push(mismatchMessage(`${openapiPath} info.version`, openapiVersion, targetVersion));
    openapi.info.version = targetVersion;
    nextOpenapiContent = stableJson(openapi);
  }

  const mcpAliasPath = "site/.well-known/mcp.json";
  const mcpAliasContent = readText(rootDirectory, mcpAliasPath);
  if (mcpAliasContent !== nextServerCardContent) {
    mismatches.push(
      `${mcpAliasPath} must be byte-identical to ${serverCardPath}, its generated source`
    );
  }

  if (checkOnly && mismatches.length > 0) {
    throw new Error(
      `Static site version contract is out of sync:\n${mismatches.map(item => `  - ${item}`).join("\n")}\nRun: node scripts/sync-site-version.mjs`
    );
  }

  if (!checkOnly) {
    if (nextPackageJsonContent !== packageJsonContent) {
      writeFileSync(join(rootDirectory, "package.json"), nextPackageJsonContent);
      changed.push("package.json");
    }
    if (indexContent !== readText(rootDirectory, indexPath)) {
      writeFileSync(join(rootDirectory, indexPath), indexContent);
      changed.push(indexPath);
    }
    if (nextServerCardContent !== serverCardContent) {
      writeFileSync(join(rootDirectory, serverCardPath), nextServerCardContent);
      changed.push(serverCardPath);
    }
    if (mcpAliasContent !== nextServerCardContent) {
      writeFileSync(join(rootDirectory, mcpAliasPath), nextServerCardContent);
      changed.push(mcpAliasPath);
    }
    if (nextOpenapiContent !== openapiContent) {
      writeFileSync(join(rootDirectory, openapiPath), nextOpenapiContent);
      changed.push(openapiPath);
    }
  }

  return { changed, packageVersion, targetVersion, prerelease };
}

function main() {
  const checkOnly = process.argv.includes("--check");
  const result = syncSiteVersion({
    checkOnly,
    requireStable: process.argv.includes("--require-stable"),
  });
  const action = checkOnly
    ? "verified"
    : result.changed.length > 0
      ? "synchronized"
      : "already aligned";
  const policy = result.prerelease ? "stable site target for prerelease" : "release target";
  console.log(`Static site version contract ${action} (${policy} ${result.targetVersion}).`);
}

if (process.argv[1] && resolve(process.argv[1]) === modulePath) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
