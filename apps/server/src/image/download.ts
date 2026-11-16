// external: Hugging Face's redirect gives the upload's ETag as x-linked-etag, and CDN links expire
import { gb, type PullProgress } from "@gates-local/contracts";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, readFile, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import path from "node:path";

export function huggingFace(url: URL, redirected: boolean): boolean {
  if (url.protocol !== "https:" || url.port !== "") return false;
  if (!redirected) return url.hostname === "huggingface.co";
  return url.hostname === "huggingface.co" || url.hostname.endsWith(".huggingface.co") || url.hostname.endsWith(".hf.co");
}

export function fetchFrom(origin: string, get: typeof fetch = fetch): typeof fetch {
  const base = new URL(origin);
  if (base.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname)) throw new Error(`${origin} is not an http address on this computer.`);
  return (input, init) => { const url = new URL(String(input)); return get(new URL(`${url.pathname}${url.search}`, base), init); };
}

export interface DownloadOptions {
  readonly url: string;
  readonly dir: string;
  readonly name: string;
  readonly sha256?: string;
  readonly signal?: AbortSignal;
  readonly progress?: (p: PullProgress) => void;
  readonly fetch?: typeof fetch;
  readonly allow?: (url: URL, redirected: boolean) => boolean;
  readonly freeBytes?: (dir: string) => Promise<number>;
  readonly now?: () => number;
  readonly intervalMs?: number;
}

export interface Downloaded {
  readonly file: string; readonly bytes: number; readonly sha256: string;
  readonly replaced?: string;
}

const fail = (message: string) => Object.assign(new Error(message), { code: "image-download" });
const diskFree = async (dir: string) => { const s = await statfs(dir); return s.bavail * s.bsize; };

export async function nearestFolder(dir: string): Promise<string> {
  for (let at = path.resolve(dir); ; at = path.dirname(at)) {
    if (await stat(at).then((s) => s.isDirectory(), () => false)) return at;
    if (path.dirname(at) === at) return at;
  }
}

export async function volumeFree(dir: string): Promise<number> {
  return diskFree(await nearestFolder(dir));
}

export async function volumeOf(dir: string): Promise<number> {
  return (await stat(await nearestFolder(dir))).dev;
}

export async function partBytes(dir: string, name: string, url: string): Promise<number> {
  const part = path.join(dir, `${name}.part`);
  const kept = await readPartOf(`${part}.json`);
  if (kept?.url !== url) return 0;
  return stat(part).then((s) => Math.min(s.size, kept.size), () => 0);
}

export async function haveFile(dir: string, name: string, bytes: number | undefined): Promise<boolean> {
  return stat(path.join(dir, name)).then((s) => s.isFile() && (bytes === undefined || s.size === bytes), () => false);
}

export async function sizeOf(options: Pick<DownloadOptions, "url" | "name" | "signal" | "fetch" | "allow">): Promise<number> {
  const head = await locate(options, "HEAD");
  if (!head.response.ok) throw fail(`${options.name}: the download answered ${head.response.status}.`);
  const total = Number(head.response.headers.get("content-length"));
  if (!Number.isSafeInteger(total) || total <= 0) throw fail(`${options.name}: the download did not say its size.`);
  return total;
}

interface Located { readonly response: Response; readonly first: Headers }

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

async function hashOf(file: string): Promise<ReturnType<typeof createHash>> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash;
}

interface PartOf { readonly url: string; readonly etag: string; readonly size: number }

async function readPartOf(sidecar: string): Promise<PartOf | undefined> {
  try {
    const v = JSON.parse(await readFile(sidecar, "utf8")) as Partial<PartOf>;
    return typeof v.url === "string" && typeof v.etag === "string" && typeof v.size === "number" ? { url: v.url, etag: v.etag, size: v.size } : undefined;
  } catch { return undefined; }
}

// external: HTTP If-Range accepts only a strong ETag, never a weak W/ one
const strong = (etag: string | null) => etag !== null && etag !== "" && !etag.startsWith("W/") ? etag : undefined;

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
  const same = upload.etag !== "" && kept?.url === upload.url && kept.etag === upload.etag && kept.size === total;
  if (!same || have > total || (have < total && ifRange === undefined)) have = 0;
  const free = await (options.freeBytes ?? diskFree)(dir);
  if (free < total - have) throw fail(`Not enough disk space for ${name}: it needs ${gb(total - have)} more, and ${gb(free)} is free.`);

  report({ state: "downloading", completedBytes: have, totalBytes: total });
  let hash: ReturnType<typeof createHash>, done = have;
  if (have === total) hash = await hashOf(part);
  else {
    const get = async (from: number) => (await locate(options, "GET", from > 0 ? { range: `bytes=${from}-`, "if-range": ifRange! } : {})).response;
    let response = await get(have);
    if (have > 0 && response.status === 206) {
      const range = rangeOf(response.headers.get("content-range"));
      if (range?.start !== have || range.total !== total) { await response.body?.cancel(); have = 0; response = await get(0); }
    } else if (response.status === 200) have = 0;
    if (response.status !== (have > 0 ? 206 : 200)) { await response.body?.cancel(); throw fail(`${name}: the download answered ${response.status}.`); }
    hash = have > 0 ? await hashOf(part) : createHash("sha256");
    const handle = await open(part, have > 0 ? "a" : "w");
    await writeFile(sidecar, JSON.stringify(upload)).catch(async (error: unknown) => { await handle.close(); throw error; });
    let lastAt = now(), lastBytes = have, rate: number | undefined, over = false;
    done = have;
    try {
      for await (const chunk of response.body ?? []) {
        const bytes = chunk as Uint8Array;
        // external: in Node, leaving a for-await over a web ReadableStream cancels the stream
        if (done + bytes.length > total) { over = true; break; }
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
      throw fail(`${name}: the download sent more than the ${gb(total)} it said it was, so it was stopped and its part removed.`);
    }
    if (done !== total) throw fail(`${name}: the download stopped at ${gb(done)} of ${gb(total)}. Download it again to carry on.`);
  }

  report({ state: "verifying", completedBytes: done, totalBytes: total });
  const sha256 = hash.digest("hex");
  if (options.sha256 !== undefined && options.sha256 !== sha256) {
    await rm(sidecar, { force: true });
    throw fail(`${name} is not the file expected: its sha256 is ${sha256}, not ${options.sha256}. It was not put with ComfyUI's models; the bytes stay in ${name}.part.`);
  }
  const replaced = await moveAside(file, now());
  await rename(part, file);
  await rm(sidecar, { force: true });
  const message = replaced === undefined ? {} : { message: `A file named ${name} was already there. It was kept as ${path.basename(replaced)}.` };
  report({ state: "done", completedBytes: done, totalBytes: total, ...message });
  return { file, bytes: done, sha256, ...replaced === undefined ? {} : { replaced } };
}

async function moveAside(file: string, at: number): Promise<string | undefined> {
  if (!await taken(file)) return undefined;
  const base = `${file}.replaced-${new Date(at).toISOString().replace(/[:.]/g, "-")}`;
  let aside = base;
  for (let i = 1; await taken(aside); i++) aside = `${base}.${i}`;
  await rename(file, aside);
  return aside;
}

const taken = (file: string) => lstat(file).then(() => true, () => false);
