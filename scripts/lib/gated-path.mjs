/**
 * Decide whether a program source file is gated by the promise-in-condition
 * checker, and return its repository-relative path in POSIX form when it is.
 *
 * The predicate is written against POSIX form so a Windows checkout, where
 * `path.relative` yields `src\probe.ts`, is gated exactly like a POSIX one.
 * `pathApi` exists so the test can exercise the win32 rules on a POSIX host.
 */
import nodePath from "node:path";

export function gatedRelativePath(root, fileName, pathApi = nodePath) {
  const rel = pathApi.relative(root, fileName).split(pathApi.sep).join("/");
  return rel.startsWith("src/") ? rel : null;
}
