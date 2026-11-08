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

/**
 * What the model reads when a source cannot be resolved: its label, never the host path
 * (a raw realpath/stat/open error names the app's private snapshots folder).
 */
export function sourceUnavailable(source: { label: string; kind: string }, error: unknown): Error {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (source.kind === "sqlite") return new Error(code === "ENOENT" ? `The source ${source.label} was removed during this reply.` : `The source ${source.label} could not be opened; refresh it and try again.`);
  return new Error(code === "ENOENT" ? `The source ${source.label} is no longer where it was added; reconnect it.` : `The source ${source.label} could not be opened; reconnect it.`);
}

/** Windows paths compare without case; Linux paths are exact. */
export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function containsPath(parent: string, candidate: string, platform: NodeJS.Platform = process.platform): boolean {
  const fold = (p: string) => platform === "win32" ? p.toLowerCase() : p;
  const relative = path.relative(fold(parent), fold(candidate));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
