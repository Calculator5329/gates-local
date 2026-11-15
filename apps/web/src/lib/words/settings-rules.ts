import type { Source } from "@gates-local/contracts";

export type LibraryTool = "read" | "query" | "run";

/**
 * Whether a tool has a ready source it can really use: `read` leaves SQLite
 * out (readLibrary), `query` reads only SQLite (querySnapshot), and `run`'s
 * sandbox mounts every source.
 */
export function libraryToolCanUse(tool: LibraryTool, sources: readonly Pick<Source, "kind" | "state">[]): boolean {
  return sources.some((s) => s.state === "ready" && (tool === "run" || (tool === "query") === (s.kind === "sqlite")));
}

/** A path with the home folder written as ~. */
export const homeTilde = (p: string): string => p.replace(/^(?:\/(?:home|Users)\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)/, "~");
