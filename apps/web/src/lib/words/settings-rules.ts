import type { Source } from "@gates-local/contracts";

export type LibraryTool = "read" | "query" | "run";

export function libraryToolCanUse(tool: LibraryTool, sources: readonly Pick<Source, "kind" | "state">[]): boolean {
  return sources.some((s) => s.state === "ready" && (tool === "run" || (tool === "query") === (s.kind === "sqlite")));
}

export const homeTilde = (p: string): string => p.replace(/^(?:\/(?:home|Users)\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)/, "~");
