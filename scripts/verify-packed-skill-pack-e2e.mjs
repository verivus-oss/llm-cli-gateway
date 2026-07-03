#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

function writeExternalSkillPack(root, options = {}) {
  const skillName = options.skillName ?? "packed-e2e-retro";
  const packRoot = join(root, `${skillName}-pack`);
  const skillDir = join(packRoot, skillName);
  mkdirSync(skillDir, { recursive: true });

  const skillMd = [
    "---",
    `name: ${skillName}`,
    `description: ${options.description ?? "Packed install external skill"}`,
    "---",
    "",
    "# Packed E2E Retro",
    "",
    options.marker ?? "Loaded from an external skill pack by an installed gateway package.",
    "",
  ].join("\n");
  writeFileSync(join(skillDir, "SKILL.md"), skillMd, "utf8");

  const sha256 = options.sha256 ?? createHash("sha256").update(skillMd, "utf8").digest("hex");
  writeFileSync(
    join(packRoot, "skill-pack.json"),
    JSON.stringify(
      {
        name: "packed-e2e-pack",
        version: "1.0.0",
        skills: [{ name: skillName, sha256 }],
      },
      null,
      2
    ),
    "utf8"
  );

  return { packRoot, skillName };
}

async function verifyInstalledGatewayLoadsExternalSkill(packageRoot, root) {
  const { packRoot, skillName } = writeExternalSkillPack(root);
  const configPath = join(root, "config.toml");
  writeFileSync(configPath, `[skills]\npaths = [${JSON.stringify(packRoot)}]\n`, "utf8");

  const transport = new StdioClientTransport({
    command: "node",
    args: [join(packageRoot, "dist", "index.js")],
    env: {
      ...process.env,
      HOME: join(root, "home"),
      LLM_GATEWAY_CONFIG: configPath,
    },
  });
  const client = new Client({
    name: "packed-skill-pack-e2e",
    version: "1.0.0",
  });

  try {
    await client.connect(transport);
    const resourceUri = `skills://${skillName}`;
    const resources = await client.listResources();
    const skillResource = resources.resources.find(resource => resource.uri === resourceUri);
    if (!skillResource) {
      const skillUris = resources.resources
        .map(resource => resource.uri)
        .filter(uri => uri.startsWith("skills://"))
        .sort();
      throw new Error(`${resourceUri} missing from packed install; saw ${skillUris.join(", ")}`);
    }

    if (skillResource.name !== `skill-${skillName}`) {
      throw new Error(`Unexpected resource name for ${resourceUri}: ${skillResource.name}`);
    }
    if (!skillResource.description?.includes("Packed install external skill")) {
      throw new Error(
        `Unexpected resource description for ${resourceUri}: ${skillResource.description}`
      );
    }

    const read = await client.readResource({ uri: resourceUri });
    const text = read.contents?.[0]?.text ?? "";
    if (!text.includes("installed gateway package")) {
      throw new Error(`${resourceUri} did not return the external SKILL.md content`);
    }

    return {
      resourceUri,
      contentBytes: text.length,
      skillResourceCount: resources.resources.filter(resource =>
        resource.uri.startsWith("skills://")
      ).length,
    };
  } finally {
    await client.close().catch(() => {});
  }
}

async function verifyInstalledGatewayRejectsBadManifestHash(packageRoot, root) {
  const { packRoot, skillName } = writeExternalSkillPack(root, {
    skillName: "packed-e2e-bad-hash",
    description: "Bad hash external skill",
    marker: "This skill must not be loaded because its manifest hash is wrong.",
    sha256: "0".repeat(64),
  });
  const configPath = join(root, "bad-hash-config.toml");
  writeFileSync(configPath, `[skills]\npaths = [${JSON.stringify(packRoot)}]\n`, "utf8");

  const transport = new StdioClientTransport({
    command: "node",
    args: [join(packageRoot, "dist", "index.js")],
    env: {
      ...process.env,
      HOME: join(root, "bad-hash-home"),
      LLM_GATEWAY_CONFIG: configPath,
    },
  });
  const client = new Client({
    name: "packed-skill-pack-bad-hash-e2e",
    version: "1.0.0",
  });

  try {
    await client.connect(transport);
    const resourceUri = `skills://${skillName}`;
    const resources = await client.listResources();
    const skillResource = resources.resources.find(resource => resource.uri === resourceUri);
    if (skillResource) {
      throw new Error(`${resourceUri} loaded even though skill-pack.json declared a bad hash`);
    }
    return {
      resourceUri,
      skillResourceCount: resources.resources.filter(resource =>
        resource.uri.startsWith("skills://")
      ).length,
    };
  } finally {
    await client.close().catch(() => {});
  }
}

async function main() {
  const root = mkdtempSync(join(tmpdir(), "llm-gateway-packed-skill-pack-e2e-"));
  try {
    const packDir = join(root, "pack");
    const consumerDir = join(root, "consumer");
    mkdirSync(packDir, { recursive: true });
    mkdirSync(consumerDir, { recursive: true });

    const tgzName = run("npm", ["pack", "--pack-destination", packDir, "--silent"]).trim();
    if (!tgzName.endsWith(".tgz")) {
      throw new Error(`npm pack did not report a tarball name: ${tgzName}`);
    }
    const tgzPath = join(packDir, tgzName);

    run("npm", ["init", "-y"], { cwd: consumerDir, stdio: "ignore" });
    run("npm", ["install", tgzPath, "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], {
      cwd: consumerDir,
      stdio: "ignore",
    });

    const packageRoot = join(consumerDir, "node_modules", "llm-cli-gateway");
    const result = await verifyInstalledGatewayLoadsExternalSkill(packageRoot, root);
    const badHashResult = await verifyInstalledGatewayRejectsBadManifestHash(packageRoot, root);
    console.log(
      `Packed skill-pack E2E passed: ${result.resourceUri} (${result.contentBytes} bytes, ${result.skillResourceCount} skill resources).`
    );
    console.log(
      `Packed skill-pack bad-hash E2E passed: ${badHashResult.resourceUri} rejected (${badHashResult.skillResourceCount} skill resources).`
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch(err => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
