import { constants, existsSync } from "node:fs";
import { open, opendir, stat } from "node:fs/promises";
import path from "node:path";
import { canonicalPath, containsPath, samePath, sourceUnavailable, type Realpath } from "./paths.ts";
import { runSandbox } from "./sandbox/index.ts";
import { runSnapshotQuery } from "./sql.ts";
import { toolDefinitions } from "./prompt.ts";
import type { LibraryEntry, ToolCall, ToolResult } from "./types.ts";

export interface ToolsDeps {
  sources: readonly LibraryEntry[];
  platform?: NodeJS.Platform;
  /**
   * Queues an image job and returns its id at once. The job needs the GPU alone
   * and the turn holds a shared claim until it ends, so the tool never waits for
   * the picture: it lands in the thread as its own message after the reply.
   */
  queueImage?: (prompt: string, signal: AbortSignal) => Promise<{ jobId: string }>;
  /** The turn asked for images (`chat.send` `image: true`). The image tool exists only with this and `queueImage`. */
  image?: boolean;
  /** Tests inject a realpath; the app uses the native one from paths.ts. */
  realpath?: Realpath;
  sqlTimeoutMs?: number;
}
const text = (input: Record<string, unknown>, key: string) => {
  const value = input[key];
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${key} must be a non-empty string`);
  return value;
};
const integer = (input: Record<string, unknown>, key: string, fallback: number, max: number, min = 1) => {
  const value = input[key] ?? fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min) throw new TypeError(`${key} must be an integer >= ${min}`);
  return Math.min(max, value);
};

export function createTools(deps: ToolsDeps) {
  const platform = deps.platform ?? process.platform;
  const queueImage = deps.image === true ? deps.queueImage : undefined;
  return {
    definitions: toolDefinitions(platform, { image: queueImage !== undefined }),
    async execute(call: ToolCall, signal: AbortSignal): Promise<ToolResult> {
      signal.throwIfAborted();
      switch (call.name) {
        case "read": return readLibrary(deps.sources, call.input, signal, deps.realpath ?? canonicalPath, platform);
        case "shell": {
          if (platform === "win32") throw new TypeError("Shell is unavailable on Windows; use sql or read");
          const output = await runSandbox({ command: text(call.input, "command"), sources: deps.sources, signal, timeoutMs: integer(call.input, "timeoutMs", 10000, 30000) });
          return { output, summary: "Searched your library" };
        }
        case "sql": {
          if (platform !== "win32") throw new TypeError("Use shell and sqlite3 on Linux");
          return querySnapshot(deps.sources, call.input, signal, deps.sqlTimeoutMs);
        }
        case "image": {
          if (!queueImage) throw new TypeError("The image tool is not on for this turn");
          const prompt = text(call.input, "prompt");
          const { jobId } = await queueImage(prompt, signal);
          signal.throwIfAborted();
          return { output: `Queued image job ${jobId}. It starts after this reply ends and appears in this chat on its own; it is not made yet.`, summary: "Queued an image" };
        }
        default: throw new TypeError(`Unknown tool: ${call.name}`);
      }
    },
  };
}

async function readLibrary(sources: readonly LibraryEntry[], input: Record<string, unknown>, signal: AbortSignal, realpath: Realpath, platform: NodeJS.Platform): Promise<ToolResult> {
  const contains = (parent: string, candidate: string) => containsPath(parent, candidate, platform);
  const requested = text(input, "path");
  const virtual = requested.match(/^\/?library\/([^/]+)(?:\/(.*))?$/);
  let source: LibraryEntry | undefined;
  let candidate: string;
  if (virtual) {
    source = sources.find(s => s.id === virtual[1] && s.kind !== "sqlite");
    if (!source) throw new Error("Path is outside your Library; use /library/<source id>");
    const relative = virtual[2] ?? "";
    if (relative.split(/[\\/]/).includes("..") || (source.kind === "file" && relative !== "")) throw new Error("Path is outside your Library source");
    candidate = path.resolve(source.path, relative);
  } else {
    candidate = path.resolve(requested);
    source = sources.find(s => s.kind !== "sqlite" && (s.kind === "folder" ? contains(s.path, candidate) : samePath(s.path, candidate, platform)));
    if (!source) throw new Error("Path is outside your Library; use /library/<source id>");
  }
  const root = await realpath(source.path).catch((e: unknown) => { throw sourceUnavailable(source, e); });
  if (!samePath(root, source.path, platform)) throw new Error("Library source path changed; reconnect this source before using it");
  const canonical = await realpath(candidate);
  if (source.kind === "file" ? !samePath(canonical, root, platform) : !contains(root, canonical)) throw new Error("Symlink leaves your Library source");
  signal.throwIfAborted();
  const info = await stat(canonical);
  if (info.isDirectory()) {
    const limit = integer(input, "limit", 200, 1000);
    // opendir keeps very large folders from allocating an unbounded listing.
    const names: string[] = [];
    let capped = false;
    let bytes = 0;
    for await (const entry of await opendir(canonical)) {
      signal.throwIfAborted();
      const name = `${entry.name}${entry.isDirectory() ? "/" : ""}`;
      bytes += name.length;
      if (names.length >= limit || bytes > 50000) { capped = true; break; }
      names.push(name);
    }
    return { output: names.join("\n") + (capped ? "\n[listing capped]" : ""), summary: "Listed a library folder" };
  }
  if (!info.isFile()) throw new Error("Only regular files and folders can be read");
  const limit = integer(input, "limit", 50000, 50000);
  const offset = integer(input, "offset", 0, Number.MAX_SAFE_INTEGER, 0);
  const file = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const buffer = Buffer.alloc(limit);
    const { bytesRead } = await file.read(buffer, 0, limit, offset);
    signal.throwIfAborted();
    const output = buffer.subarray(0, bytesRead).toString("utf8");
    return { output: output + (offset + bytesRead < info.size ? "\n[file capped; use offset to continue]" : ""), summary: `Read ${source.label}` };
  } finally { await file.close(); }
}

async function querySnapshot(sources: readonly LibraryEntry[], input: Record<string, unknown>, signal: AbortSignal, timeoutMs?: number): Promise<ToolResult> {
  const id = text(input, "source");
  const source = sources.find(s => s.id === id && s.kind === "sqlite");
  if (!source?.snapshotPath) throw new Error("SQLite snapshot was not found in your Library");
  const query = text(input, "query");
  // The read-only handle and PRAGMA query_only (sql.ts) stop changes to the snapshot, but
  // neither stops VACUUM INTO from creating its destination file: with both set it still
  // makes a zero-byte file at any path before it fails. This lexical check is what prevents
  // that external-file creation. It allows one SELECT or WITH statement and nothing after
  // a `;`, which keeps out ATTACH, PRAGMA and VACUUM, and refuses a second statement that
  // prepare() would otherwise drop without a word.
  const syntax = query.replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|--[^\n]*|\/\*[\s\S]*?\*\//g, " ").trim();
  if (!/^(SELECT|WITH)\b/i.test(syntax) || /;\s*\S/.test(syntax)) throw new TypeError("sql accepts one SELECT or WITH query; no PRAGMA, ATTACH or VACUUM");
  const limit = integer(input, "limit", 100, 1000);
  const file = source.snapshotPath;
  // Removed since the turn began: name the source; SQLite's own error says only "unable to open".
  const removed = () => sourceUnavailable(source, Object.assign(new Error("snapshot removed"), { code: "ENOENT" }));
  if (!existsSync(file)) throw removed();
  let rows: unknown[];
  try { rows = await runSnapshotQuery({ file, query, limit, signal, ...(timeoutMs === undefined ? {} : { timeoutMs }) }); }
  catch (e) { throw existsSync(file) ? e : removed(); }
  return { output: JSON.stringify(rows), summary: `Read ${rows.length} ${rows.length === 1 ? "row" : "rows"} from ${source.label}` };
}
