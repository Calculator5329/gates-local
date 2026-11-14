// One model file downloaded into a ComfyUI model folder. The address must be Hugging Face's, and
// it may redirect once, to Hugging Face's own file hosts (its CDN), never anywhere else. The size
// comes from a HEAD of the file it redirects to; the free space is checked before a byte is
// written; the bytes go to `<name>.part` beside the file and are renamed once complete, never
// more than that size.
//
// A part already there is resumed only when it is of the same upload: `<name>.part.json` beside it
// keeps the address, the upload's ETag (Hugging Face's `x-linked-etag` on its redirect, else the
// file's own) and its size, and all three must match the HEAD. The Range request carries the
// file host's ETag as If-Range, and an answer whose Content-Range does not start where the part
// ends is not appended: the part starts again. The CDN's links expire, so each request starts
// from the first address.
//
// The sha256 is worked out as the bytes arrive. When the caller knows the hash the file should
// have (the app's record, or the pin from its first download) and the bytes differ, the file is
// not put in place: the bytes stay in the part and the download fails, saying so. The note goes,
// so the next download fetches the file again from the start.
import type { PullProgress } from "@gates-local/contracts";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import path from "node:path";

/** Hugging Face, and the hosts its downloads redirect to. */
export function huggingFace(url: URL, redirected: boolean): boolean {
  if (url.protocol !== "https:" || url.port !== "") return false;
  if (!redirected) return url.hostname === "huggingface.co";
  return url.hostname === "huggingface.co" || url.hostname.endsWith(".huggingface.co") || url.hostname.endsWith(".hf.co");
}

/**
 * Tests only (GATES_LOCAL_IMAGE_DOWNLOAD_ORIGIN): fetch every address from this http origin on this
 * computer instead, path and query kept, so a browser test downloads from its own fake server. The
 * address is still checked as Hugging Face's first.
 */
export function fetchFrom(origin: string, get: typeof fetch = fetch): typeof fetch {
  const base = new URL(origin);
  if (base.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname)) throw new Error(`${origin} is not an http address on this computer.`);
  return (input, init) => { const url = new URL(String(input)); return get(new URL(`${url.pathname}${url.search}`, base), init); };
}

export interface DownloadOptions {
  readonly url: string;
  /** The folder the file goes in, made when absent. */
  readonly dir: string;
  /** The file's name in that folder. */
  readonly name: string;
  /** The sha256 the file should have: the app's record of it, or the pin from its first download. */
  readonly sha256?: string;
  readonly signal?: AbortSignal;
  readonly progress?: (p: PullProgress) => void;
  readonly fetch?: typeof fetch;
  /** Which addresses may be fetched: the first, and the one it redirects to. */
  readonly allow?: (url: URL, redirected: boolean) => boolean;
  /** Free bytes on the folder's disk. */
  readonly freeBytes?: (dir: string) => Promise<number>;
  readonly now?: () => number;
  readonly intervalMs?: number;
}

export interface Downloaded { readonly file: string; readonly bytes: number; readonly sha256: string }

const GB = (n: number) => n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${(n / 1e6).toFixed(1)} MB`;
const fail = (message: string) => Object.assign(new Error(message), { code: "image-download" });
const diskFree = async (dir: string) => { const s = await statfs(dir); return s.bavail * s.bsize; };

/** The nearest folder of `dir` that exists: itself, or a parent (a Windows drive's root at the top, `F:\`). */
export async function nearestFolder(dir: string): Promise<string> {
  for (let at = path.resolve(dir); ; at = path.dirname(at)) {
    if (await stat(at).then((s) => s.isDirectory(), () => false)) return at;
    if (path.dirname(at) === at) return at;
  }
}

/** Free bytes on the volume `dir` is on (or will be, once made): statfs of its nearest existing folder. */
export async function volumeFree(dir: string): Promise<number> {
  return diskFree(await nearestFolder(dir));
}

/** The volume `dir` is on, to add up what goes to one disk: the device of its nearest existing folder. */
export async function volumeOf(dir: string): Promise<number> {
  return (await stat(await nearestFolder(dir))).dev;
}

/** The bytes a part of `name` in `dir` already holds, when they are vouched for by its note (so a resume keeps them). */
export async function partBytes(dir: string, name: string, url: string): Promise<number> {
  const part = path.join(dir, `${name}.part`);
  const kept = await readPartOf(`${part}.json`);
  if (kept?.url !== url) return 0;
  return stat(part).then((s) => Math.min(s.size, kept.size), () => 0);
}

/** The file is already in `dir`, whole: a download of it would only fetch it again. */
export async function haveFile(dir: string, name: string, bytes: number | undefined): Promise<boolean> {
  return stat(path.join(dir, name)).then((s) => s.isFile() && (bytes === undefined || s.size === bytes), () => false);
}

/** The file's size, from a HEAD of where it is served (no record of it, or records not trusted). */
export async function sizeOf(options: Pick<DownloadOptions, "url" | "name" | "signal" | "fetch" | "allow">): Promise<number> {
  const head = await locate(options, "HEAD");
  if (!head.response.ok) throw fail(`${options.name}: the download answered ${head.response.status}.`);
  const total = Number(head.response.headers.get("content-length"));
  if (!Number.isSafeInteger(total) || total <= 0) throw fail(`${options.name}: the download did not say its size.`);
  return total;
}

/** The answer from where the file is served now, and the headers of the first answer (Hugging Face's own, before its CDN). */
interface Located { readonly response: Response; readonly first: Headers }

/** The address the file is served from now: the first, or the one place it redirects to. */
async function locate(options: Pick<DownloadOptions, "url" | "name" | "signal" | "fetch" | "allow">, method: "HEAD" | "GET", headers: Record<string, string> = {}): Promise<Located> {
  const get = options.fetch ?? fetch, allow = options.allow ?? huggingFace;
  let url = new URL(options.url);
  if (!allow(url, false)) throw fail(`Downloads come from Hugging Face only, not ${url.host}.`);
  let first: Headers | undefined;
  for (let hop = 0; ; hop++) {
    const response = await get(url, { method, redirect: "manual", signal: options.signal, headers });
    first ??= response.headers;
    if (response.status < 300 || response.status >= 400) return { response, first };
    await response.body?.cancel();
    const next = new URL(response.headers.get("location") ?? "", url);
    if (hop > 0) throw fail(`${options.name}: the download redirected more than once.`);
    if (!allow(next, true)) throw fail(`${options.name}: the download redirected to ${next.host}, which is not Hugging Face.`);
    url = next;
  }
}

/** The sha256 of what a part file already holds. */
async function hashOf(file: string): Promise<ReturnType<typeof createHash>> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash;
}

/** What a part file is a part of, kept beside it in `<name>.part.json`. */
interface PartOf { readonly url: string; readonly etag: string; readonly size: number }

async function readPartOf(sidecar: string): Promise<PartOf | undefined> {
  try {
    const v = JSON.parse(await readFile(sidecar, "utf8")) as Partial<PartOf>;
    return typeof v.url === "string" && typeof v.etag === "string" && typeof v.size === "number" ? { url: v.url, etag: v.etag, size: v.size } : undefined;
  } catch { return undefined; }
}

/** An ETag If-Range may carry: a strong one. */
const strong = (etag: string | null) => etag !== null && etag !== "" && !etag.startsWith("W/") ? etag : undefined;

/** Content-Range's first byte and the file's size: `bytes 100-199/200`. */
function rangeOf(header: string | null): { start: number; total: number } | undefined {
  const m = /^bytes (\d+)-\d+\/(\d+)$/.exec(header?.trim() ?? "");
  return m ? { start: Number(m[1]), total: Number(m[2]) } : undefined;
}

export async function downloadFile(options: DownloadOptions): Promise<Downloaded> {
  const { dir, name } = options;
  const now = options.now ?? Date.now, interval = options.intervalMs ?? 250;
  const file = path.join(dir, name), part = `${file}.part`, sidecar = `${part}.json`;
  const report = (p: Omit<PullProgress, "name">) => options.progress?.({ name, ...p });

  const head = await locate(options, "HEAD");
  if (!head.response.ok) throw fail(`${name}: the download answered ${head.response.status}.`);
  const total = Number(head.response.headers.get("content-length"));
  if (!Number.isSafeInteger(total) || total <= 0) throw fail(`${name}: the download did not say its size.`);
  const upload: PartOf = { url: options.url, etag: head.first.get("x-linked-etag") ?? head.response.headers.get("etag") ?? "", size: total };
  const ifRange = strong(head.response.headers.get("etag"));

  await mkdir(dir, { recursive: true });
  const kept = await readPartOf(sidecar);
  let have = await stat(part).then((s) => s.size, () => 0);
  // a part of another upload, or of one that cannot be told apart, starts again
  const same = upload.etag !== "" && kept?.url === upload.url && kept.etag === upload.etag && kept.size === total;
  if (!same || have > total || (have < total && ifRange === undefined)) have = 0;
  const free = await (options.freeBytes ?? diskFree)(dir);
  if (free < total - have) throw fail(`Not enough disk space for ${name}: it needs ${GB(total - have)} more, and ${GB(free)} is free.`);

  report({ state: "downloading", completedBytes: have, totalBytes: total });
  let hash: ReturnType<typeof createHash>, done = have;
  if (have === total) hash = await hashOf(part); // complete already: only the check is left
  else {
    const get = async (from: number) => (await locate(options, "GET", from > 0 ? { range: `bytes=${from}-`, "if-range": ifRange! } : {})).response;
    let response = await get(have);
    if (have > 0 && response.status === 206) {
      const range = rangeOf(response.headers.get("content-range"));
      if (range?.start !== have || range.total !== total) { await response.body?.cancel(); have = 0; response = await get(0); }
    } else if (response.status === 200) have = 0; // the whole file, from the start
    if (response.status !== (have > 0 ? 206 : 200)) { await response.body?.cancel(); throw fail(`${name}: the download answered ${response.status}.`); }
    hash = have > 0 ? await hashOf(part) : createHash("sha256");
    const handle = await open(part, have > 0 ? "a" : "w");
    // only once the part is this upload's (emptied, or the rest about to follow): a note written
    // before would vouch for an older part's bytes if the app stopped in between
    await writeFile(sidecar, JSON.stringify(upload)).catch(async (error: unknown) => { await handle.close(); throw error; });
    let lastAt = now(), lastBytes = have, rate: number | undefined, over = false;
    done = have;
    try {
      for await (const chunk of response.body ?? []) {
        const bytes = chunk as Uint8Array;
        if (done + bytes.length > total) { over = true; break; } // leaving the loop cancels the rest
        hash.update(bytes);
        await handle.write(bytes);
        done += bytes.length;
        const at = now();
        if (at - lastAt >= interval) {
          const sample = (done - lastBytes) / ((at - lastAt) / 1000);
          rate = rate === undefined ? sample : rate * 0.7 + sample * 0.3;
          lastAt = at; lastBytes = done;
          report({ state: "downloading", completedBytes: done, totalBytes: total, bytesPerSecond: rate });
        }
      }
    } finally { await handle.close(); }
    if (over) {
      await rm(part, { force: true }); await rm(sidecar, { force: true });
      throw fail(`${name}: the download sent more than the ${GB(total)} it said it was, so it was stopped and its part removed.`);
    }
    if (done !== total) throw fail(`${name}: the download stopped at ${GB(done)} of ${GB(total)}. Download it again to carry on.`);
  }

  report({ state: "verifying", completedBytes: done, totalBytes: total });
  const sha256 = hash.digest("hex");
  if (options.sha256 !== undefined && options.sha256 !== sha256) {
    // the part is no longer vouched for, so the next download fetches the file again instead of checking these bytes for ever
    await rm(sidecar, { force: true });
    throw fail(`${name} is not the file expected: its sha256 is ${sha256}, not ${options.sha256}. It was not put with ComfyUI's models; the bytes stay in ${name}.part.`);
  }
  await rename(part, file);
  await rm(sidecar, { force: true });
  report({ state: "done", completedBytes: done, totalBytes: total });
  return { file, bytes: done, sha256 };
}
