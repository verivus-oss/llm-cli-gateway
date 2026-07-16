/**
 * Delete only this repository's generated TypeScript output before a build.
 *
 * TypeScript overwrites files it still emits but does not remove files for
 * deleted or renamed sources. A clean output directory prevents stale modules
 * from becoming candidates for the npm `files` allowlist.
 */
import { lstat, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDirectory = path.join(repositoryRoot, "dist");

if (path.relative(repositoryRoot, distDirectory) !== "dist") {
  throw new Error(`Refusing to clean an unexpected directory: ${distDirectory}`);
}

const existing = await lstat(distDirectory).catch(error => {
  if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
    return undefined;
  }
  throw error;
});

if (existing?.isSymbolicLink()) {
  throw new Error(`Refusing to clean a symbolic-link dist directory: ${distDirectory}`);
}

await rm(distDirectory, { force: true, maxRetries: 3, recursive: true, retryDelay: 150 });
