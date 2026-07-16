/**
 * Verify that the npm tarball contains exactly the JavaScript and declaration
 * files that the production TypeScript project emits, plus deliberately
 * packaged documentation.
 *
 * This intentionally inspects npm's own pack manifest instead of the working
 * directory. It catches a future broad `files` pattern, a stale dist artifact,
 * and a missing generated module before a package is published.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configPath = path.join(repositoryRoot, "tsconfig.build.json");
// Intentionally narrow npm-package contract: these are non-README documents
// that must work after installation. It is not a docs/** or README-link
// packaging rule; add an entry only when it is deliberately part of the
// package surface.
const requiredPackagedDocumentation = ["docs/guides/PERSONAL_AGENT_CONFIG_KIT.md"];

function toPackagePath(absolutePath) {
  return path.relative(repositoryRoot, absolutePath).split(path.sep).join("/");
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return (
    relative !== "" &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== ".." &&
    !path.isAbsolute(relative)
  );
}

function formatDiagnostic(diagnostic) {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
}

function expectedDistFiles() {
  const config = ts.getParsedCommandLineOfConfigFile(
    configPath,
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic(diagnostic) {
        throw new Error(`Could not parse ${configPath}: ${formatDiagnostic(diagnostic)}`);
      },
    }
  );

  if (!config) {
    throw new Error(`Could not parse ${configPath}`);
  }

  const distDirectory = path.resolve(config.options.outDir ?? path.join(repositoryRoot, "dist"));
  const expected = new Set();

  for (const sourceFile of config.fileNames) {
    for (const outputFile of ts.getOutputFileNames(config, sourceFile, false)) {
      const absoluteOutput = path.resolve(outputFile);
      if (!isWithin(distDirectory, absoluteOutput)) continue;

      const packagePath = toPackagePath(absoluteOutput);
      if (packagePath.endsWith(".js") || packagePath.endsWith(".d.ts")) {
        expected.add(packagePath);
      }
    }
  }

  return expected;
}

function packedFiles() {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(
    npmCommand,
    ["pack", "--dry-run", "--json", "--ignore-scripts", "--silent"],
    { cwd: repositoryRoot, encoding: "utf8" }
  );

  if (result.error) {
    throw new Error(`Could not run npm pack: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`npm pack --dry-run failed:\n${result.stderr || result.stdout}`);
  }

  let manifest;
  try {
    manifest = JSON.parse(result.stdout);
  } catch {
    throw new Error(`npm pack --dry-run returned invalid JSON:\n${result.stdout}`);
  }

  const files = Array.isArray(manifest) ? manifest[0]?.files : undefined;
  if (!Array.isArray(files)) {
    throw new Error("npm pack --dry-run did not return a package file manifest");
  }

  return new Set(files.map(entry => entry?.path).filter(file => typeof file === "string"));
}

function printList(label, files) {
  if (files.length === 0) return;
  console.error(`${label}:`);
  for (const file of files) console.error(`  ${file}`);
}

const expected = expectedDistFiles();
const packedFilesManifest = packedFiles();
const packed = new Set([...packedFilesManifest].filter(file => file.startsWith("dist/")));
const missing = [...expected].filter(file => !packed.has(file)).sort();
const unexpected = [...packed].filter(file => !expected.has(file)).sort();
const missingPackagedDocumentation = requiredPackagedDocumentation.filter(
  document => !packedFilesManifest.has(document)
);

if (missing.length > 0 || unexpected.length > 0 || missingPackagedDocumentation.length > 0) {
  console.error("Packed release manifest does not match the production output.");
  printList("Missing generated files", missing);
  printList("Unexpected dist files", unexpected);
  printList("Missing required packaged documentation", missingPackagedDocumentation);
  process.exit(1);
}

// npm's release audit captures `npm pack` stdout as the tarball filename. Keep
// lifecycle confirmation on stderr so this prepack gate never contaminates it.
console.error(
  `Packed release manifest verified (${packed.size} generated files and ${requiredPackagedDocumentation.length} required packaged document).`
);
