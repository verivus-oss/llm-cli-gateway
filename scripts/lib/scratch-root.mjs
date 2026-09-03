/**
 * Create throwaway fixture directories under `<repoRoot>/.scratch` without ever
 * following a symlink named `.scratch` into the tracked tree.
 *
 * Two board findings shaped this file. Round 2 measured that a `.scratch`
 * symlinked to `src` sent every fixture into tracked `src/`. Round 3 measured
 * that checking `.scratch` and then handing back a path string leaves a window
 * (p50 about 18 microseconds, max about 2 ms on this host) in which a swap to a
 * symlink still lands `mkdtemp` under `src/`. A check followed by a path-based
 * write cannot close that window, so the write is bound to the directory the
 * check saw: `.scratch` is opened with O_DIRECTORY | O_NOFOLLOW, which refuses
 * a symlink or a file atomically, and on Linux the unique directory is created
 * through that descriptor (`/proc/self/fd/<n>/<prefix>`). A later swap of the
 * name then either lands in the original directory (rename) or fails closed
 * (delete); it cannot retarget the write. Elsewhere the descriptor still serves
 * as the atomic check and the write falls back to the path; CI for this
 * repository runs only on Linux.
 */
import nodeFs from "node:fs";
import nodePath from "node:path";

export const SCRATCH_DIR_NAME = ".scratch";

function describeRefusal(dir, fsApi) {
  let st;
  try {
    st = fsApi.lstatSync(dir);
  } catch {
    return `${dir} could not be opened as a directory; refusing to write fixtures there.`;
  }
  if (st.isSymbolicLink()) {
    return (
      `${dir} is a symbolic link; refusing to write fixtures through it. ` +
      "Replace it with a real directory."
    );
  }
  return `${dir} exists and is not a directory; refusing to write fixtures there.`;
}

function openDirectoryNoFollow(dir, fsApi) {
  const { O_RDONLY, O_DIRECTORY, O_NOFOLLOW } = fsApi.constants ?? nodeFs.constants;
  return fsApi.openSync(dir, O_RDONLY | (O_DIRECTORY ?? 0) | (O_NOFOLLOW ?? 0));
}

/**
 * Open `<repoRoot>/.scratch` as a real directory, creating it when absent.
 * Returns `{ dir, fd }`; the caller owns the descriptor.
 */
export function openScratchRoot(repoRoot, fsApi = nodeFs, pathApi = nodePath) {
  const dir = pathApi.join(repoRoot, SCRATCH_DIR_NAME);
  let fd;
  try {
    fd = openDirectoryNoFollow(dir, fsApi);
  } catch (err) {
    if (err?.code === "ENOENT") {
      fsApi.mkdirSync(dir, { recursive: true });
      try {
        fd = openDirectoryNoFollow(dir, fsApi);
      } catch (again) {
        if (again?.code === "ENOTDIR" || again?.code === "ELOOP") {
          throw new Error(describeRefusal(dir, fsApi), { cause: again });
        }
        throw again;
      }
    } else if (err.code === "ENOTDIR" || err.code === "ELOOP") {
      throw new Error(describeRefusal(dir, fsApi), { cause: err });
    } else {
      throw err;
    }
  }
  return { dir, fd };
}

/** Check-only form: the path of a real `.scratch` directory, or a throw. */
export function scratchRoot(repoRoot, fsApi = nodeFs, pathApi = nodePath) {
  const { dir, fd } = openScratchRoot(repoRoot, fsApi, pathApi);
  fsApi.closeSync(fd);
  return dir;
}

/**
 * Create a unique directory `<repoRoot>/.scratch/<prefix>XXXXXX` bound to the
 * directory the check saw, and return its path under `.scratch`.
 */
export function makeScratchDir(
  repoRoot,
  prefix,
  fsApi = nodeFs,
  pathApi = nodePath,
  platform = process.platform
) {
  const { dir, fd } = openScratchRoot(repoRoot, fsApi, pathApi);
  try {
    const created =
      platform === "linux"
        ? fsApi.mkdtempSync(`/proc/self/fd/${fd}/${prefix}`)
        : fsApi.mkdtempSync(pathApi.join(dir, prefix));
    return pathApi.join(dir, pathApi.basename(created));
  } finally {
    fsApi.closeSync(fd);
  }
}
