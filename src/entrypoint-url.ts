import { realpathSync } from "fs";
import { pathToFileURL } from "url";

export function entrypointFileURL(path: string | undefined): string {
  return path ? pathToFileURL(realpathSync(path)).href : "";
}
