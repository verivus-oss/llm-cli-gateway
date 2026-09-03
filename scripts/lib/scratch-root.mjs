/**
 * Resolve the directory a script may write throwaway fixtures into, and refuse
 * anything that could redirect those writes into the tracked tree.
 *
 * The round-2 board measured the hole this closes: with `.scratch` replaced by
 * a symlink to `src`, every fixture the gate test wrote landed under tracked
 * `src/` for the duration of the case, which is the defect class the test was
 * rewritten to remove. `.gitignore` lists `.scratch` without a trailing slash,
 * so a symlink of that name is ignored by git and invisible to porcelain.
 *
 * The rule is deliberately blunt: `.scratch` must be a real directory. A
 * symlink is refused whatever it points at, because deciding which targets are
 * harmless would need the same realpath reasoning the attack exploits.
 */
import nodeFs from "node:fs";
import nodePath from "node:path";

export const SCRATCH_DIR_NAME = ".scratch";

export function scratchRoot(repoRoot, fsApi = nodeFs, pathApi = nodePath) {
  const dir = pathApi.join(repoRoot, SCRATCH_DIR_NAME);
  let st;
  try {
    st = fsApi.lstatSync(dir);
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
    fsApi.mkdirSync(dir, { recursive: true });
    st = fsApi.lstatSync(dir);
  }
  if (st.isSymbolicLink()) {
    throw new Error(
      `${dir} is a symbolic link; refusing to write fixtures through it. ` +
        "Replace it with a real directory."
    );
  }
  if (!st.isDirectory()) {
    throw new Error(`${dir} exists and is not a directory; refusing to write fixtures there.`);
  }
  return dir;
}
