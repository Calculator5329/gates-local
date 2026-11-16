import { open } from "node:fs/promises";
import { inflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
// why: a larger text chunk is skipped; a graph is tens of kilobytes.
const MAX_TEXT = 4 * 1024 * 1024;

export interface PngFacts {
  width: number;
  height: number;
  text: Record<string, string>;
}

type Read = (position: number, length: number) => Promise<Buffer> | Buffer;

function readText(type: string, data: Buffer): [string, string] | undefined {
  const end = data.indexOf(0);
  if (end <= 0) return undefined;
  const key = data.toString("latin1", 0, end);
  if (type === "tEXt") return [key, data.toString("latin1", end + 1)];
  if (type === "zTXt") return [key, inflateSync(data.subarray(end + 2)).toString("latin1")];
  // why: iTXt is keyword, compression flag and method, language tag, translated keyword, then text.
  const compressed = data[end + 1] === 1;
  const lang = data.indexOf(0, end + 3);
  const translated = lang < 0 ? -1 : data.indexOf(0, lang + 1);
  if (translated < 0) return undefined;
  const body = data.subarray(translated + 1);
  return [key, (compressed ? inflateSync(body) : body).toString("utf8")];
}

async function facts(read: Read): Promise<PngFacts | undefined> {
  if (!(await read(0, 8)).equals(SIGNATURE)) return undefined;
  let position = 8, width = 0, height = 0;
  const text: Record<string, string> = {};
  for (;;) {
    const head = await read(position, 8);
    if (head.length < 8) break;
    const length = head.readUInt32BE(0), type = head.toString("latin1", 4, 8);
    if (type === "IHDR") {
      const data = await read(position + 8, 8);
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
    } else if ((type === "tEXt" || type === "zTXt" || type === "iTXt") && length <= MAX_TEXT) {
      // why: an unreadable text chunk says nothing, and the chunks after it are still read.
      try {
        const entry = readText(type, await read(position + 8, length));
        if (entry && !(entry[0] in text)) text[entry[0]] = entry[1];
      } catch {}
    } else if (type === "IDAT" || type === "IEND") break;
    position += 12 + length;
  }
  return width > 0 && height > 0 ? { width, height, text } : undefined;
}

export function pngFacts(bytes: Buffer): Promise<PngFacts | undefined> {
  return facts((position, length) => bytes.subarray(position, position + length));
}

export async function readPngFacts(file: string): Promise<PngFacts | undefined> {
  const handle = await open(file, "r");
  try {
    return await facts(async (position, length) => {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      return buffer.subarray(0, bytesRead);
    });
  } finally { await handle.close(); }
}

function only(graph: unknown, names: readonly string[]): number | undefined {
  if (typeof graph !== "object" || graph === null) return undefined;
  const values = new Set<number>();
  for (const node of Object.values(graph)) {
    const inputs: unknown = typeof node === "object" && node !== null ? (node as { inputs?: unknown }).inputs : undefined;
    if (typeof inputs !== "object" || inputs === null) continue;
    for (const name of names) {
      const value: unknown = (inputs as Record<string, unknown>)[name];
      if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) values.add(value);
    }
  }
  return values.size === 1 ? [...values][0] : undefined;
}

export function graphFacts(graph: unknown): { seed?: number; steps?: number } {
  const seed = only(graph, ["seed", "noise_seed"]);
  const steps = only(graph, ["steps"]);
  return { ...seed === undefined ? {} : { seed }, ...steps === undefined || steps === 0 ? {} : { steps } };
}

export function chunkFacts(text: Record<string, string>): { seed?: number; steps?: number } {
  // external: ComfyUI's Save Image writes the API graph it ran as the `prompt` text chunk before the pixels, and none under --disable-metadata.
  const prompt = text["prompt"];
  if (prompt === undefined) return {};
  try { return graphFacts(JSON.parse(prompt)); }
  catch { return {}; }
}
