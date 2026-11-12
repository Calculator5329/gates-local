// Model downloads against a local fake file server: Hugging Face's address on 127.0.0.1 redirects
// once to its "CDN" on localhost, which serves the bytes with HEAD, Range and If-Range like the
// real one. Like Hugging Face, the redirect names the upload (x-linked-etag, x-linked-size) and
// the CDN gives an ETag of its own.
import type { PullProgress } from "@gates-local/contracts";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { downloadFile, fetchFrom, huggingFace, type DownloadOptions } from "./download.ts";

const BODY = Buffer.from(Array.from({ length: 300_000 }, (_, i) => (i * 7) % 251));
const SHA = createHash("sha256").update(BODY).digest("hex");
/** A newer upload of the same file: same size, other bytes. */
const NEWER = Buffer.from(Array.from({ length: 300_000 }, (_, i) => (i * 11) % 241));
const NEWER_SHA = createHash("sha256").update(NEWER).digest("hex");

let server: Server, port = 0, dir = "";
const seen: { url: string; method: string; range?: string; ifRange?: string }[] = [];
let cutAt: number | undefined, ignoreRange = false, short = false;
/** What the fake serves now, and its ETags: the upload's (on the redirect) and the CDN's. */
let body = BODY, upload = '"upload-1"', cdnTag = '"cdn-1"';
let noLength = false, rangeOff = 0, extra = 0;
/** Set: the size a ranged answer's Content-Range gives for the file, instead of the file's. */
let rangeTotal: number | undefined;

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const ifRange = req.headers["if-range"];
    seen.push({ url: `${req.headers.host}${url.pathname}`, method: req.method ?? "", ...req.headers.range ? { range: req.headers.range } : {}, ...typeof ifRange === "string" ? { ifRange } : {} });
    if (url.pathname === "/hf/model.safetensors") {
      res.writeHead(302, { location: `http://localhost:${port}/cdn/model.safetensors?sig=${seen.length}`, "x-linked-etag": upload, "x-linked-size": String(body.length) }).end();
      return;
    }
    if (url.pathname === "/hf/twice") { res.writeHead(302, { location: `http://localhost:${port}/cdn/again` }).end(); return; }
    if (url.pathname === "/cdn/again") { res.writeHead(302, { location: `http://localhost:${port}/cdn/model.safetensors` }).end(); return; }
    if (url.pathname === "/hf/elsewhere") { res.writeHead(302, { location: "http://192.0.2.1/model.safetensors" }).end(); return; }
    if (url.pathname !== "/cdn/model.safetensors") { res.writeHead(404).end(); return; }
    // If-Range: the rest only while the ETag still matches, else the whole file
    const ranged = !ignoreRange && req.headers.range !== undefined && (ifRange === undefined || ifRange === cdnTag);
    const from = ranged ? Math.max(0, Number(/bytes=(\d+)-/.exec(req.headers.range!)?.[1]) - rangeOff) : 0;
    const slice = Buffer.concat([body.subarray(from), Buffer.alloc(req.method === "GET" ? extra : 0, 1)]);
    // a short or overlong answer sends no length (chunked), so the client sees a clean end, not a broken one
    const length = noLength || (req.method === "GET" && (short || extra > 0)) ? {} : { "content-length": String(slice.length) };
    res.writeHead(ranged ? 206 : 200, { ...length, etag: cdnTag, ...ranged ? { "content-range": `bytes ${from}-${body.length - 1}/${rangeTotal ?? body.length}` } : {} });
    if (req.method === "HEAD") { res.end(); return; }
    if (short) { res.end(slice.subarray(0, 150_000)); return; }
    if (cutAt !== undefined) { res.write(slice.subarray(0, cutAt)); setTimeout(() => res.destroy(), 100); return; }
    res.end(slice);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "gates-download-"));
  seen.length = 0; cutAt = undefined; ignoreRange = false; short = false;
  body = BODY; upload = '"upload-1"'; cdnTag = '"cdn-1"'; noLength = false; rangeOff = 0; extra = 0; rangeTotal = undefined;
  return () => rm(dir, { recursive: true, force: true });
});
const partFile = () => path.join(options().dir, "model.safetensors.part");
/** A first download cut off after `bytes`, leaving its part and the note of what it is a part of. */
async function cutOff(bytes = 100_000): Promise<number> {
  cutAt = bytes;
  await expect(downloadFile(options())).rejects.toThrow();
  cutAt = undefined; seen.length = 0;
  return (await readFile(partFile())).length;
}
const gets = () => seen.filter((s) => s.method === "GET" && s.url.includes("/cdn/"));

/** The fake's two hosts stand in for Hugging Face (127.0.0.1) and its CDN (localhost). */
const allow = (url: URL, redirected: boolean) => url.port === String(port) && url.hostname === (redirected ? "localhost" : "127.0.0.1");
const options = (over: Partial<DownloadOptions> = {}): DownloadOptions => ({
  url: `http://127.0.0.1:${port}/hf/model.safetensors`, dir: path.join(dir, "loras", "gates-local"), name: "model.safetensors",
  allow, freeBytes: async () => 10 ** 12, ...over,
});

describe("huggingFace", () => {
  it("starts at huggingface.co over https, and may move to its own file hosts only", () => {
    expect(huggingFace(new URL("https://huggingface.co/a/b/resolve/0123/m.safetensors"), false)).toBe(true);
    expect(huggingFace(new URL("http://huggingface.co/m.safetensors"), false)).toBe(false);
    expect(huggingFace(new URL("https://cas-bridge.xethub.hf.co/x"), false)).toBe(false);
    expect(huggingFace(new URL("https://cas-bridge.xethub.hf.co/x"), true)).toBe(true);
    expect(huggingFace(new URL("https://cdn-lfs.huggingface.co/x"), true)).toBe(true);
    expect(huggingFace(new URL("https://huggingface.co.example.com/x"), true)).toBe(false);
    expect(huggingFace(new URL("https://hf.co.example.com/x"), true)).toBe(false);
    expect(huggingFace(new URL("https://huggingface.co:8443/x"), false)).toBe(false);
  });
});

describe("fetchFrom (tests' download origin)", () => {
  it("fetches the same path and query from an http origin on this computer, and takes no other origin", async () => {
    const asked: string[] = [];
    const get = fetchFrom("http://127.0.0.1:4100", async (input) => { asked.push(String(input)); return new Response("x"); });
    await get(new URL("https://huggingface.co/org/repo/resolve/main/c.safetensors?download=1"));
    expect(asked).toEqual(["http://127.0.0.1:4100/org/repo/resolve/main/c.safetensors?download=1"]);
    for (const origin of ["http://192.0.2.5:4100", "https://127.0.0.1:4100", "http://huggingface.co"]) expect(() => fetchFrom(origin), origin).toThrow(`${origin} is not an http address on this computer.`);
  });
});

describe("downloadFile", () => {
  it("follows the one redirect, writes a .part file and renames it once every byte is in", async () => {
    const pushed: PullProgress[] = [];
    const done = await downloadFile(options({ progress: (p) => pushed.push(p), sha256: SHA }));
    expect(done).toEqual({ file: path.join(dir, "loras", "gates-local", "model.safetensors"), bytes: BODY.length, sha256: SHA });
    expect(await readFile(done.file)).toEqual(BODY);
    expect(await readdir(path.dirname(done.file))).toEqual(["model.safetensors"]);
    expect(pushed.map((p) => p.state)).toEqual(["downloading", "verifying", "done"]);
    expect(pushed[0]).toEqual({ name: "model.safetensors", state: "downloading", completedBytes: 0, totalBytes: BODY.length });
    // a HEAD for the size, then the GET, each through the redirect to the CDN
    expect(seen.map((s) => `${s.method} ${s.url.replace(String(port), "P")}`)).toEqual([
      "HEAD 127.0.0.1:P/hf/model.safetensors", "HEAD localhost:P/cdn/model.safetensors",
      "GET 127.0.0.1:P/hf/model.safetensors", "GET localhost:P/cdn/model.safetensors",
    ]);
  });

  it("refuses a second redirect, and a redirect to a host that is not Hugging Face's, before fetching it", async () => {
    await expect(downloadFile(options({ url: `http://127.0.0.1:${port}/hf/twice` }))).rejects.toThrow("redirected more than once");
    seen.length = 0;
    await expect(downloadFile(options({ url: `http://127.0.0.1:${port}/hf/elsewhere` }))).rejects.toThrow("redirected to 192.0.2.1, which is not Hugging Face");
    expect(seen.map((s) => s.url.replace(String(port), "P"))).toEqual(["127.0.0.1:P/hf/elsewhere"]);
    await expect(downloadFile(options({ url: `http://localhost:${port}/cdn/model.safetensors` }))).rejects.toThrow("Downloads come from Hugging Face only, not localhost");
  });

  it("checks the free space before writing a byte", async () => {
    await expect(downloadFile(options({ freeBytes: async () => 200_000 }))).rejects.toThrow("Not enough disk space for model.safetensors: it needs 0.3 MB more, and 0.2 MB is free.");
    expect(seen.filter((s) => s.method === "GET")).toEqual([]);
  });

  it("a download cut off keeps its part, and the next one asks for the rest on a fresh link, If-Range the CDN's ETag", async () => {
    const have = await cutOff();
    expect(have).toBeGreaterThan(0);
    expect(have).toBeLessThanOrEqual(100_000);
    expect(JSON.parse(await readFile(`${partFile()}.json`, "utf8"))).toEqual({ url: options().url, etag: '"upload-1"', size: BODY.length });
    // the free space asked for is what is left to fetch
    const done = await downloadFile(options({ freeBytes: async () => BODY.length - have }));
    expect(done.sha256).toBe(SHA);
    expect(seen.filter((s) => s.method === "GET")).toEqual([
      { url: `127.0.0.1:${port}/hf/model.safetensors`, method: "GET", range: `bytes=${have}-`, ifRange: '"cdn-1"' },
      { url: `localhost:${port}/cdn/model.safetensors`, method: "GET", range: `bytes=${have}-`, ifRange: '"cdn-1"' },
    ]);
    expect(await readdir(options().dir)).toEqual(["model.safetensors"]);
  });

  it("a part of an older upload is not resumed against a newer one: it starts again", async () => {
    await cutOff();
    body = NEWER; upload = '"upload-2"'; cdnTag = '"cdn-2"';
    const done = await downloadFile(options());
    expect(done.sha256).toBe(NEWER_SHA);
    expect(gets().map((s) => s.range)).toEqual([undefined]);
  });

  it("a part with no note of what it is a part of, or one longer than the file, starts again", async () => {
    await mkdir(options().dir, { recursive: true });
    await writeFile(partFile(), BODY.subarray(0, 1000));
    expect((await downloadFile(options())).sha256).toBe(SHA);
    expect(gets().map((s) => s.range)).toEqual([undefined]);
    await cutOff();
    await writeFile(partFile(), Buffer.alloc(BODY.length + 10));
    expect((await downloadFile(options())).sha256).toBe(SHA);
    expect(gets().map((s) => s.range)).toEqual([undefined]);
  });

  it("starts the part again when the file host sends the whole file instead of the rest", async () => {
    await cutOff();
    ignoreRange = true;
    expect((await downloadFile(options())).sha256).toBe(SHA);
    // the CDN's ETag changed under the same upload: If-Range gets the whole file
    ignoreRange = false;
    await cutOff();
    cdnTag = '"cdn-other"';
    expect((await downloadFile(options())).sha256).toBe(SHA);
    expect(gets()).toHaveLength(1);
  });

  it("an answer whose Content-Range does not start where the part ends is not appended: the part starts again", async () => {
    const have = await cutOff();
    rangeOff = 10; // the fake answers from 10 bytes before what was asked, and says so
    expect((await downloadFile(options())).sha256).toBe(SHA);
    expect(gets().map((s) => s.range)).toEqual([`bytes=${have}-`, undefined]);
  });

  it("a weak ETag cannot carry If-Range, so a part is not resumed", async () => {
    cdnTag = 'W/"cdn-1"';
    await cutOff();
    expect((await downloadFile(options())).sha256).toBe(SHA);
    expect(gets().map((s) => s.range)).toEqual([undefined]);
  });

  it("a download that ends short of its size fails and keeps its part", async () => {
    short = true;
    await expect(downloadFile(options())).rejects.toThrow("model.safetensors: the download stopped at 0.1 MB of 0.3 MB. Download it again to carry on.");
    expect((await readFile(partFile())).length).toBe(150_000);
  });

  it("a download that sends more than its size is stopped there and its part removed", async () => {
    extra = 70_000;
    await expect(downloadFile(options())).rejects.toThrow("model.safetensors: the download sent more than the 0.3 MB it said it was, so it was stopped and its part removed.");
    expect(await readdir(options().dir)).toEqual([]);
  });

  it("a download whose HEAD gives no size is refused before a byte is fetched", async () => {
    noLength = true;
    await expect(downloadFile(options())).rejects.toThrow("model.safetensors: the download did not say its size.");
    expect(seen.filter((s) => s.method === "GET")).toEqual([]);
  });

  it("a file whose sha256 differs from the one expected is not put in place: the download fails and the bytes stay in the part", async () => {
    const pushed: PullProgress[] = [];
    const wrong = "0".repeat(64);
    const message = `model.safetensors is not the file expected: its sha256 is ${SHA}, not ${wrong}. It was not put with ComfyUI's models; the bytes stay in model.safetensors.part.`;
    await expect(downloadFile(options({ sha256: wrong, progress: (p) => pushed.push(p) }))).rejects.toThrow(message);
    // the note of what the part is goes with it, so Retry fetches the file again instead of checking the same bytes
    expect((await readdir(options().dir)).toSorted()).toEqual(["model.safetensors.part"]);
    expect(pushed.map((p) => p.state)).not.toContain("done");
    seen.length = 0;
    await expect(downloadFile(options({ sha256: wrong }))).rejects.toThrow(message);
    expect(gets().map((s) => s.range)).toEqual([undefined]);
    // the host serves the right bytes again: Retry puts the file in place
    seen.length = 0;
    expect((await downloadFile(options({ sha256: SHA }))).sha256).toBe(SHA);
    expect(gets().map((s) => s.range)).toEqual([undefined]);
    expect(await readdir(options().dir)).toEqual(["model.safetensors"]);
  });

  it("writes the note of what the part is only once the part is opened for this upload", async () => {
    // a folder where the part goes: it cannot be opened, and no note may say its bytes are this upload's
    await mkdir(partFile(), { recursive: true });
    await expect(downloadFile(options())).rejects.toThrow();
    expect(await readdir(options().dir)).toEqual(["model.safetensors.part"]);
  });

  it("a part whose note names another address or another size starts again", async () => {
    for (const note of [{ url: "https://huggingface.co/other/model.safetensors" }, { size: BODY.length + 1 }]) {
      await cutOff();
      const kept = JSON.parse(await readFile(`${partFile()}.json`, "utf8")) as object;
      await writeFile(`${partFile()}.json`, JSON.stringify({ ...kept, ...note }));
      expect((await downloadFile(options())).sha256).toBe(SHA);
      expect(gets().map((s) => s.range)).toEqual([undefined]);
    }
  });

  it("an answer whose Content-Range gives another size for the file is not appended: the part starts again", async () => {
    const have = await cutOff();
    rangeTotal = BODY.length + 5;
    expect((await downloadFile(options())).sha256).toBe(SHA);
    expect(gets().map((s) => s.range)).toEqual([`bytes=${have}-`, undefined]);
  });
});
