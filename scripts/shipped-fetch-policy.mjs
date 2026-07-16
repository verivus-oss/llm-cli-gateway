// The Personal Agent Config Kit intentionally synchronizes its verified Git
// baseline and labels that Git operation in a safe error mapper. Keep this
// allowlist exact so it cannot hide browser-style or other JavaScript network
// fetches in the shipped package.
const APPROVED_GIT_FETCH_LINES = new Set([
  'case "fetch":',
  'git(layout.baselineDir, ["fetch", "origin"], false, options);',
  'const upstreamSynchronization = git(layout.baselineDir, ["fetch", "origin"], true, options);',
]);
const FETCH_TOKEN_RE = /\bfetch\b/i;

/**
 * Return true for a JavaScript or declaration source file that can ship in the
 * npm package. Keep this shared with both release scanners so they cannot drift.
 *
 * @param {string} relativePath path relative to the repository root
 * @returns {boolean} whether the path is a shipped dist source file
 */
export function isShippedDistSourcePath(relativePath) {
  const normalizedPath = relativePath.replaceAll("\\", "/");
  return (
    normalizedPath.startsWith("dist/") &&
    !normalizedPath.split("/").includes("__tests__") &&
    (normalizedPath.endsWith(".js") || normalizedPath.endsWith(".d.ts"))
  );
}

/**
 * Return true only for the reviewed Git operation discriminator and subprocess
 * invocations emitted by the Kit's baseline publish and synchronization paths.
 *
 * @param {string} relativePath path relative to the repository root
 * @param {string} line one generated JavaScript line
 * @returns {boolean} whether the literal fetch token is approved
 */
export function isApprovedShippedFetchLine(relativePath, line) {
  const normalizedPath = relativePath.replaceAll("\\", "/");
  return normalizedPath === "dist/personal-config.js" && APPROVED_GIT_FETCH_LINES.has(line.trim());
}

/**
 * Find each unapproved literal fetch token in a shipped source file.
 *
 * @param {string} relativePath path relative to the repository root
 * @param {string} contents complete generated file contents
 * @returns {Array<{line: string, lineNumber: number}>} unapproved source lines
 */
export function findShippedFetchViolations(relativePath, contents) {
  if (!isShippedDistSourcePath(relativePath)) return [];

  return contents.split(/\r?\n/).flatMap((line, index) => {
    if (!FETCH_TOKEN_RE.test(line) || isApprovedShippedFetchLine(relativePath, line)) return [];
    return [{ line, lineNumber: index + 1 }];
  });
}
