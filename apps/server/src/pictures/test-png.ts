// Test PNGs: a real encoded picture, optionally with ComfyUI's `prompt` text chunk (the API graph it ran).
import { crc32 } from "node:zlib";
import { PNG } from "pngjs";

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** A width × height picture of a gradient, with a tEXt chunk per entry of `text` before its pixels, as ComfyUI saves them. */
export function testPng(width: number, height: number, text: Record<string, string> = {}): Buffer {
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i++) {
    png.data[i * 4] = (i % width) & 255;
    png.data[i * 4 + 1] = Math.floor(i / width) & 255;
    png.data[i * 4 + 2] = 128;
    png.data[i * 4 + 3] = 255;
  }
  const bytes = PNG.sync.write(png);
  const ihdrEnd = 8 + 8 + 13 + 4;
  const texts = Object.entries(text).map(([key, value]) => chunk("tEXt", Buffer.concat([Buffer.from(key, "latin1"), Buffer.from([0]), Buffer.from(value, "latin1")])));
  return Buffer.concat([bytes.subarray(0, ihdrEnd), ...texts, bytes.subarray(ihdrEnd)]);
}

function hsl(h: number, s: number, l: number): [number, number, number] {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [f(0), f(8), f(4)];
}

/** A picture that still reads as one at thumbnail size, for screenshots: a sky in two colours from `hue`, a sun, and ground. */
export function scenePng(width: number, height: number, hue: number): Buffer {
  const png = new PNG({ width, height });
  const top = hsl(hue, 0.55, 0.2), low = hsl((hue + 35) % 360, 0.65, 0.58), sun = hsl((hue + 60) % 360, 0.9, 0.86), ground = hsl((hue + 190) % 360, 0.3, 0.13);
  const horizon = height * 0.7, cx = width * 0.66, cy = height * 0.42, r = Math.min(width, height) * 0.13;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const t = Math.min(1, y / horizon);
      let c: readonly number[] = y > horizon + Math.sin(x / width * 9) * height * 0.03 ? ground : top.map((v, k) => v + (low[k]! - v) * t);
      if (c !== ground && (x - cx) ** 2 + (y - cy) ** 2 < r * r) c = sun;
      const i = (y * width + x) * 4;
      png.data[i] = c[0]!;
      png.data[i + 1] = c[1]!;
      png.data[i + 2] = c[2]!;
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

/** ComfyUI's `prompt` chunk for a one-sampler graph. */
export function promptChunk(seed: number, steps: number): Record<string, string> {
  return { prompt: JSON.stringify({ "3": { class_type: "KSampler", inputs: { seed, steps, cfg: 1, model: ["4", 0] } }, "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "x.safetensors" } } }) };
}

/** The pixel size a WebP file says it is (VP8, VP8L or VP8X). */
export function webpSize(bytes: Buffer): { width: number; height: number } {
  if (bytes.toString("latin1", 0, 4) !== "RIFF" || bytes.toString("latin1", 8, 12) !== "WEBP") throw new Error("not a WebP");
  const kind = bytes.toString("latin1", 12, 16);
  if (kind === "VP8 ") return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
  if (kind === "VP8X") return { width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 };
  if (kind === "VP8L") { const bits = bytes.readUInt32LE(21); return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }; }
  throw new Error(`unknown WebP chunk ${kind}`);
}
