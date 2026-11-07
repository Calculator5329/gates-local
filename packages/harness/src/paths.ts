import { realpathSync } from "node:fs";
import { realpath } from "node:fs/promises";
import path from "node:path";

/**
 * The one way Library code resolves a path: the OS's own realpath (realpath(3),
 * GetFinalPathNameByHandle on Windows). Node's JS `realpathSync` walks the path
 * itself and can disagree with it on Windows case and short names, so sources,
 * the sandbox and the tools all use this pair and compare with `samePath`.
 */
export const canonicalPathSync = (file: string): string => realpathSync.native(file);
export const canonicalPath = (file: string): Promise<string> => realpath(file);
export type Realpath = (file: string) => Promise<string>;

/** Windows paths compare without case; Linux paths are exact. */
export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function containsPath(parent: string, candidate: string, platform: NodeJS.Platform = process.platform): boolean {
  const fold = (p: string) => platform === "win32" ? p.toLowerCase() : p;
  const relative = path.relative(fold(parent), fold(candidate));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
