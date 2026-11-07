import { constants } from "node:fs";
import { open, opendir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runSandbox } from "./sandbox/index.ts";
import { toolDefinitions } from "./prompt.ts";
import type { LibraryEntry, ToolCall, ToolResult } from "./types.ts";

export interface ToolsDeps {
  sources: readonly LibraryEntry[];
  platform?: NodeJS.Platform;
  generateImage?: (prompt: string, signal: AbortSignal) => Promise<string>;
}
const contains = (parent: string, candidate: string) => {
  const relative = path.relative(parent, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};
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
  return {
    definitions: toolDefinitions(platform),
    async execute(call: ToolCall, signal: AbortSignal): Promise<ToolResult> {
      signal.throwIfAborted();
      switch (call.name) {
        case "read": return readLibrary(deps.sources, call.input, signal);
        case "shell": {
          if (platform === "win32") throw new TypeError("Shell is unavailable on Windows; use sql or read");
          const output = await runSandbox({ command: text(call.input, "command"), sources: deps.sources, signal, timeoutMs: integer(call.input, "timeoutMs", 10000, 30000) });
          return { output, summary: "Searched your library" };
        }
        case "sql": {
          if (platform !== "win32") throw new TypeError("Use shell and sqlite3 on Linux");
          return querySnapshot(deps.sources, call.input, signal);
        }
        case "image": {
          const prompt = text(call.input, "prompt");
          if (!deps.generateImage) return { output: "Image generation is not set up", summary: "Image generation is not set up" };
          const imagePath = await deps.generateImage(prompt, signal);
          signal.throwIfAborted();
          return { output: imagePath, summary: "Made an image", imagePath };
        }
        default: throw new TypeError(`Unknown tool: ${call.name}`);
      }
    },
  };
}

async function readLibrary(sources: readonly LibraryEntry[], input: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult> {
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
    source = sources.find(s => s.kind !== "sqlite" && (s.kind === "folder" ? contains(s.path, candidate) : s.path === candidate));
    if (!source) throw new Error("Path is outside your Library; use /library/<source id>");
  }
  const root = await realpath(source.path);
  if (root !== source.path) throw new Error("Library source path changed; reconnect this source before using it");
  const canonical = await realpath(candidate);
  if (source.kind === "file" ? canonical !== root : !contains(root, canonical)) throw new Error("Symlink leaves your Library source");
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

function querySnapshot(sources: readonly LibraryEntry[], input: Record<string, unknown>, signal: AbortSignal): ToolResult {
  const id = text(input, "source");
  const source = sources.find(s => s.id === id && s.kind === "sqlite");
  if (!source?.snapshotPath) throw new Error("SQLite snapshot was not found in your Library");
  const query = text(input, "query");
  // A single SELECT/WITH statement only. SQLite's read-only handle and query_only are
  // the write guarantee; this lexical check excludes ATTACH/PRAGMA and trailing statements.
  const syntax = query.replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|--[^\n]*|\/\*[\s\S]*?\*\//g, " ").trim();
  if (!/^(SELECT|WITH)\b/i.test(syntax) || /;\s*\S/.test(syntax)) throw new TypeError("sql accepts one SELECT or WITH query; no PRAGMA or ATTACH");
  const limit = integer(input, "limit", 100, 1000);
  const db = new DatabaseSync(source.snapshotPath, { readOnly: true, allowExtension: false });
  try {
    db.exec("PRAGMA query_only=ON");
    const rows: unknown[] = [];
    let size = 0;
    for (const row of db.prepare(query).iterate()) {
      signal.throwIfAborted();
      size += JSON.stringify(row, jsonValue).length;
      if (rows.length >= limit || size > 50000) break;
      rows.push(row);
    }
    return { output: JSON.stringify(rows, jsonValue), summary: `Read ${rows.length} ${rows.length === 1 ? "row" : "rows"} from ${source.label}` };
  } finally { db.close(); }
}
function jsonValue(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}
