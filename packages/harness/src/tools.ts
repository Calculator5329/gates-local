import { constants, existsSync } from "node:fs";
import { open, opendir, stat } from "node:fs/promises";
import path from "node:path";
import { canonicalPath, containsPath, samePath, sourceUnavailable, type Realpath } from "./paths.ts";
import { runSandbox } from "./sandbox/index.ts";
import { runSnapshotQuery } from "./sql.ts";
import { MAX_IMAGES_PER_TURN, toolDefinitions } from "./prompt.ts";
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
  /** false: the sandbox probe failed on this machine, so the shell tool is neither offered nor run. */
  shell?: boolean;
  /** Tests inject a realpath; the app uses the native one from paths.ts. */
  realpath?: Realpath;
  /** Tests inject the read tool's filesystem calls to race them; the app uses node:fs/promises. */
  fs?: Partial<LibraryFs>;
  sqlTimeoutMs?: number;
}
export interface LibraryFs { stat: typeof stat; opendir: typeof opendir; open: typeof open; }
const text = (input: Record<string, unknown>, key: string) => {
  const value = input[key];
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${key} must be a non-empty string`);
  return value;
};
const texts = (input: Record<string, unknown>, key: string) => {
  const value = input[key];
  if (!Array.isArray(value) || value.length === 0 || !value.every((v) => typeof v === "string" && v.trim() !== "")) throw new TypeError(`${key} must be a list of non-empty strings`);
  return value as string[];
};
const integer = (input: Record<string, unknown>, key: string, fallback: number, max: number, min = 1) => {
  const value = input[key] ?? fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min) throw new TypeError(`${key} must be an integer >= ${min}`);
  return Math.min(max, value);
};

export function createTools(deps: ToolsDeps) {
  const platform = deps.platform ?? process.platform;
  const queueImage = deps.image === true ? deps.queueImage : undefined;
  // A turn's tools are made for that turn: this counts its images across calls.
  let imagesQueued = 0;
  return {
    definitions: toolDefinitions(platform, { image: queueImage !== undefined, ...(deps.shell === false ? { shell: false } : {}) }),
    async execute(call: ToolCall, signal: AbortSignal): Promise<ToolResult> {
      signal.throwIfAborted();
      switch (call.name) {
        case "read": return readLibrary(deps.sources, call.input, signal, deps.realpath ?? canonicalPath, platform, { stat, opendir, open, ...deps.fs });
        case "shell": {
          if (platform === "win32") throw new TypeError("Shell is unavailable on Windows; use sql or read");
          if (deps.shell === false) throw new TypeError("Run commands is off on this machine; use read");
          const output = await runSandbox({ command: text(call.input, "command"), sources: deps.sources, signal, timeoutMs: integer(call.input, "timeoutMs", 10000, 30000) });
          return { output, summary: "Searched your library" };
        }
        case "sql": {
          if (platform !== "win32") throw new TypeError("Use shell and sqlite3 on Linux");
          return querySnapshot(deps.sources, call.input, signal, deps.sqlTimeoutMs);
        }
        case "image": {
          if (!queueImage) throw new TypeError("The image tool is not on for this turn");
          const prompts = texts(call.input, "prompts");
          // One job per prompt, in order; every call this turn counts toward the one limit.
          const room = Math.max(0, MAX_IMAGES_PER_TURN - imagesQueued);
          const jobs: string[] = [];
          let failed: string | undefined;
          for (const prompt of prompts.slice(0, room)) {
            try { jobs.push((await queueImage(prompt, signal)).jobId); }
            catch (error) {
              // the first refusal stops the rest; the ones already queued stay and are said
              if (jobs.length === 0 || signal.aborted) throw error;
              failed = (error as Error).message;
              break;
            }
            imagesQueued++;
            signal.throwIfAborted();
          }
          const left = prompts.length - jobs.length;
          const queued = jobs.length === 1
            ? `Queued image job ${jobs[0]}. The image is not made yet. It starts after this reply ends and appears in this chat on its own; the job card shows its outcome.`
            : jobs.length > 1 ? `Queued ${jobs.length} image jobs: ${jobs.join(", ")}. The images are not made yet. They run in order after this reply ends and appear in this chat on their own; each job card shows its outcome.`
            : "Queued no images.";
          const why = failed === undefined ? `one message makes at most ${MAX_IMAGES_PER_TURN} images` : `the next one was refused: ${failed}`;
          const rest = left === 0 ? "" : ` Not queued: ${left} more, because ${why}. Tell the person how many are coming and why the rest are not.`;
          if (jobs.length === 0) throw new Error(`${queued}${rest}`);
          return { output: `${queued}${rest}`, summary: jobs.length === 1 ? "Queued an image" : `Queued ${jobs.length} images` };
        }
        default: throw new TypeError(`Unknown tool: ${call.name}`);
      }
    },
  };
}

/**
 * Whether a path joined under a source could leave it, judged from the text alone. The parser
 * follows the computer: drive, UNC and device roots mean something only on Windows, and on
 * Linux "C:notes.txt" is a file the person may have. A ".." segment is refused everywhere,
 * split on both separators. Windows also drops trailing dots and spaces from a name, so ".. "
 * is a parent there and only an odd file name elsewhere.
 */
function leavesByText(relative: string, platform: NodeJS.Platform): boolean {
  if ((platform === "win32" ? path.win32 : path.posix).parse(relative).root !== "") return true;
  const parent = platform === "win32" ? /^\.\.[. ]*$/ : /^\.\.$/;
  return relative.split(/[\\/]/).some(part => parent.test(part));
}

async function readLibrary(sources: readonly LibraryEntry[], input: Record<string, unknown>, signal: AbortSignal, realpath: Realpath, platform: NodeJS.Platform, fs: LibraryFs): Promise<ToolResult> {
  const contains = (parent: string, candidate: string) => containsPath(parent, candidate, platform);
  const requested = text(input, "path");
  const virtual = requested.match(/^\/?library\/([^/]+)(?:\/(.*))?$/);
  let source: LibraryEntry | undefined;
  let candidate: string;
  if (virtual) {
    source = sources.find(s => s.id === virtual[1] && s.kind !== "sqlite");
    if (!source && sources.some(s => s.id === virtual[1] && s.kind === "sqlite"))
      throw new Error(`${virtual[1]} is a SQLite source; ${platform === "win32" ? `use sql with source "${virtual[1]}"` : `use shell with sqlite3 /data/${virtual[1]}.db`}`);
    if (!source) throw new Error("Path is outside your Library; use /library/<source id>");
    const relative = virtual[2] ?? "";
    // Decided from the text, before anything below touches the disk: the model learns nothing
    // about paths outside the source, and a UNC path never makes Windows reach out to its host.
    const refused = libraryFsError(`/library/${source.id}${relative === "" ? "" : `/${relative}`}`, { code: "ENOENT" });
    if (leavesByText(relative, platform) || (source.kind === "file" && relative !== "")) throw refused;
    candidate = path.resolve(source.path, relative);
    if (source.kind === "file" ? !samePath(source.path, candidate, platform) : !contains(source.path, candidate)) throw refused;
  } else {
    candidate = path.resolve(requested);
    source = sources.find(s => s.kind !== "sqlite" && (s.kind === "folder" ? contains(s.path, candidate) : samePath(s.path, candidate, platform)));
    if (!source) throw new Error("Path is outside your Library; use /library/<source id>");
  }
  const root = await realpath(source.path).catch((e: unknown) => { throw sourceUnavailable(source, e); });
  if (!samePath(root, source.path, platform)) throw new Error("Library source path changed; reconnect this source before using it");
  // Every filesystem error past this point names the path as the model wrote it in Library
  // terms; Node's own message carries the host path (the source root, the app's data dir).
  const relative = path.relative(source.path, candidate).split(path.sep).join("/");
  const shown = `/library/${source.id}${relative === "" ? "" : `/${relative}`}`;
  const fsCall = <T>(pending: Promise<T>): Promise<T> => pending.catch((e: unknown) => { throw libraryFsError(shown, e); });
  const canonical = await fsCall(realpath(candidate));
  if (source.kind === "file" ? !samePath(canonical, root, platform) : !contains(root, canonical)) throw new Error("Symlink leaves your Library source");
  signal.throwIfAborted();
  const info = await fsCall(fs.stat(canonical));
  if (info.isDirectory()) {
    const limit = integer(input, "limit", 200, 1000);
    // opendir keeps very large folders from allocating an unbounded listing.
    const names: string[] = [];
    let capped = false;
    let bytes = 0;
    const entries = (await fsCall(fs.opendir(canonical)))[Symbol.asyncIterator]();
    try {
      for (let next = await fsCall(entries.next()); !next.done; next = await fsCall(entries.next())) {
        signal.throwIfAborted();
        const name = `${next.value.name}${next.value.isDirectory() ? "/" : ""}`;
        bytes += name.length;
        if (names.length >= limit || bytes > 50000) { capped = true; break; }
        names.push(name);
      }
    } finally { if (entries.return) await fsCall(entries.return()); }
    return { output: names.join("\n") + (capped ? "\n[listing capped]" : ""), summary: "Listed a library folder" };
  }
  if (!info.isFile()) throw new Error("Only regular files and folders can be read");
  const limit = integer(input, "limit", 50000, 50000);
  const offset = integer(input, "offset", 0, Number.MAX_SAFE_INTEGER, 0);
  const file = await fsCall(fs.open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)));
  try {
    const buffer = Buffer.alloc(limit);
    const { bytesRead } = await fsCall(file.read(buffer, 0, limit, offset));
    signal.throwIfAborted();
    const output = buffer.subarray(0, bytesRead).toString("utf8");
    return { output: output + (offset + bytesRead < info.size ? "\n[file capped; use offset to continue]" : ""), summary: `Read ${source.label}` };
  } finally { await fsCall(file.close()); }
}

const FS_WORDS: Readonly<Record<string, string>> = {
  ENOENT: "no such file", EACCES: "permission denied", EPERM: "permission denied",
  ENOTDIR: "not a folder", EISDIR: "is a folder", ELOOP: "symlink not followed",
};
/** `/library/f/x: permission denied`: the virtual path and a short word, never Node's message. */
function libraryFsError(shown: string, error: unknown): Error {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return new Error(`${shown}: ${(code !== undefined && FS_WORDS[code]) || "could not be read"}`);
}

async function querySnapshot(sources: readonly LibraryEntry[], input: Record<string, unknown>, signal: AbortSignal, timeoutMs?: number): Promise<ToolResult> {
  // Models also pass the file name or the Linux shell path ("books.db", "/data/books.db").
  const id = text(input, "source").replace(/^\/?data\//, "").replace(/\.db$/i, "");
  const sqlite = sources.filter(s => s.kind === "sqlite");
  const source = sqlite.find(s => s.id === id);
  if (!source?.snapshotPath) throw new Error(`SQLite snapshot was not found in your Library; ${sqlite.length ? `use source ${sqlite.map(s => `"${s.id}"`).join(" or ")}` : "no SQLite source is connected"}`);
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
