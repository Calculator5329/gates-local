// Thumbnails: 384 px on the long edge, WebP, in images/thumbs/<jobId>.webp. Made at save; a missing one
// (a picture from before thumbnails) is made on its first request, one at a time in the image files'
// serial queue, so it cannot pass a collect of the same picture.
//
// The encoder is libwebp compiled to WebAssembly (@jsquash/webp): the same file runs on every platform,
// so nothing is built per platform and nothing is rebuilt for Electron. The packaged server keeps the
// .wasm beside its bundle (apps/desktop/scripts/package.ts); a checkout reads it from the package.
import { constants } from "node:fs";
import { mkdir, open, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { PNG } from "pngjs";
import factory from "@jsquash/webp/codec/enc/webp_enc_simd.js";
import { defaultOptions } from "@jsquash/webp/meta.js";

export const THUMB_EDGE = 384;
const QUALITY = 78;
export const WEBP_WASM = "webp_enc_simd.wasm";
const JOB = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Queue = <T>(work: () => Promise<T>) => Promise<T>;
interface Encoder { encode(data: Uint8ClampedArray, width: number, height: number, options: typeof defaultOptions): Uint8Array | null }
// The server's types carry no WebAssembly lib; the few calls made here, by hand.
interface Instance { exports: object }
interface Wasm {
  compile(bytes: Uint8Array): Promise<object>;
  Instance: new (module: object, imports: object) => Instance;
}
type Factory = (options: { noInitialRun: boolean; instantiateWasm: (imports: object, done: (instance: Instance) => void) => object }) => Promise<Encoder>;
const { WebAssembly } = globalThis as unknown as { WebAssembly: Wasm };

let encoder: Promise<Encoder> | undefined;
function loadEncoder(): Promise<Encoder> {
  encoder ??= (async () => {
    // Beside the bundle when packaged; in the package in a checkout.
    const bytes = await readFile(new URL(`./${WEBP_WASM}`, import.meta.url))
      .catch(() => readFile(createRequire(import.meta.url).resolve(`@jsquash/webp/codec/enc/${WEBP_WASM}`)));
    const wasm = await WebAssembly.compile(bytes);
    return (factory as unknown as Factory)({
      noInitialRun: true,
      instantiateWasm: (imports, done) => { const instance = new WebAssembly.Instance(wasm, imports); done(instance); return instance.exports; },
    });
  })();
  encoder.catch(() => { encoder = undefined; });
  return encoder;
}

/** An area average: each thumbnail pixel is the mean of the picture pixels it covers. */
function shrink(data: Uint8Array, width: number, height: number, toWidth: number, toHeight: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(toWidth * toHeight * 4);
  const sx = width / toWidth, sy = height / toHeight;
  for (let y = 0; y < toHeight; y++) {
    const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < toWidth; x++) {
      const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      let r = 0, g = 0, b = 0, a = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const k = (yy * width + xx) * 4;
          r += data[k]!; g += data[k + 1]!; b += data[k + 2]!; a += data[k + 3]!;
        }
      }
      const n = (y1 - y0) * (x1 - x0), o = (y * toWidth + x) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = a / n;
    }
  }
  return out;
}

/** A PNG's thumbnail as WebP bytes. A picture smaller than the edge keeps its size. Throws for bytes that are not a PNG. */
export async function encodeThumbnail(png: Buffer): Promise<Buffer> {
  const picture = PNG.sync.read(png);
  const scale = Math.min(1, THUMB_EDGE / Math.max(picture.width, picture.height));
  const width = Math.max(1, Math.round(picture.width * scale)), height = Math.max(1, Math.round(picture.height * scale));
  const pixels = scale === 1 ? new Uint8ClampedArray(picture.data) : shrink(picture.data, picture.width, picture.height, width, height);
  const webp = (await loadEncoder()).encode(pixels, width, height, { ...defaultOptions, quality: QUALITY });
  if (!webp) throw new Error("The thumbnail could not be encoded.");
  return Buffer.from(webp.buffer, webp.byteOffset, webp.byteLength);
}

/** images/, when it is a real folder in the data dir and not a link out of it. */
async function imagesRoot(dataDir: string): Promise<string | undefined> {
  try {
    const root = path.join(await realpath(dataDir), "images");
    return await realpath(root) === root ? root : undefined;
  } catch { return undefined; }
}

/** A regular file's bytes, never through a link; undefined when it is not there. */
async function readPlain(file: string): Promise<Buffer | undefined> {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    return (await handle.stat()).isFile() ? await handle.readFile() : undefined;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ELOOP" || code === "ENOTDIR") return undefined;
    throw error;
  } finally { await handle?.close(); }
}

async function keep(root: string, jobId: string, webp: Buffer): Promise<void> {
  const folder = path.join(root, "thumbs");
  await mkdir(folder, { recursive: true });
  if (await realpath(folder) !== folder) throw new Error("The thumbnail folder is not available.");
  const pending = path.join(folder, `${jobId}.${process.pid}.pending`);
  await writeFile(pending, webp);
  try { await rename(pending, path.join(folder, `${jobId}.webp`)); }
  catch (error) { await unlink(pending).catch(() => undefined); throw error; }
}

/** At save: the new picture's thumbnail, from the bytes just written. */
export async function makeThumbnail(dataDir: string, jobId: string, png: Buffer): Promise<void> {
  if (!JOB.test(jobId)) throw new Error("Not a picture's job id.");
  const root = await imagesRoot(dataDir);
  if (root === undefined) throw new Error("The image folder is not available.");
  await keep(root, jobId, await encodeThumbnail(png));
}

/** A picture's thumbnail, made now in `queue` when it has none; undefined when there is no such picture. */
export async function readThumbnail(dataDir: string, jobId: string, queue: Queue): Promise<Buffer | undefined> {
  if (!JOB.test(jobId)) return undefined;
  const root = await imagesRoot(dataDir);
  if (root === undefined) return undefined;
  const thumb = path.join(root, "thumbs", `${jobId}.webp`);
  return await readPlain(thumb) ?? queue(async () => {
    const made = await readPlain(thumb); // by an earlier request that this one waited behind
    if (made) return made;
    const png = await readPlain(path.join(root, `${jobId}.png`));
    if (!png) return undefined;
    const webp = await encodeThumbnail(png);
    await keep(root, jobId, webp);
    return webp;
  });
}
