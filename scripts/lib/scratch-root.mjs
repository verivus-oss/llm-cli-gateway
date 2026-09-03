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

// Directories never walked when looking for a tracked directory that the
// opened `.scratch` might alias. `.scratch` itself is the thing under test.
const UNWALKED = new Set([".git", "node_modules", SCRATCH_DIR_NAME]);

function sameInode(a, b) {
  return a.dev === b.dev && a.ino === b.ino;
}

/**
 * Round-4 board finding: a bind mount of `src` over `.scratch` (possible for
 * an unprivileged user inside their own mount namespace) is a real directory
 * to `open`, so the descriptor check passes and fixtures land in `src/`. The
 * mount is invisible from outside that namespace, so only the mounter's own
 * run is affected, but the defence is cheap: the opened directory must not be
 * the same inode as the repository root or any directory under it. Symlinks
 * are not followed during the walk.
 */
function aliasedTrackedDirectory(repoRoot, opened, fsApi, pathApi) {
  const pending = [repoRoot];
  while (pending.length > 0) {
    const current = pending.pop();
    if (sameInode(fsApi.lstatSync(current), opened)) {
      return pathApi.relative(repoRoot, current) || ".";
    }
    for (const entry of fsApi.readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory() && !UNWALKED.has(entry.name)) {
        pending.push(pathApi.join(current, entry.name));
      }
    }
  }
  return null;
}

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
  const alias = aliasedTrackedDirectory(repoRoot, fsApi.fstatSync(fd), fsApi, pathApi);
  if (alias !== null) {
    fsApi.closeSync(fd);
    throw new Error(
      `${dir} is the same directory as ${alias} under ${repoRoot}; refusing to write fixtures there.`
    );
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
