import { expect, it } from "vitest";
import { crc32 } from "node:zlib";
import { imageDimensions, visionTokens } from "./image-header.ts";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGOor6//DwAFewJ94ITM6gAAAABJRU5ErkJggg==", "base64");
const pngChunk = (kind: string, data: Buffer) => {
  const bytes = Buffer.alloc(data.length + 12);
  bytes.writeUInt32BE(data.length); bytes.write(kind, 4, 4, "ascii"); data.copy(bytes, 8);
  bytes.writeUInt32BE(crc32(bytes.subarray(4, -4)), bytes.length - 4);
  return bytes;
};

it("rejects conflicting or repeated WebP payloads instead of accounting only the last one", () => {
  const tiny = Buffer.from("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA", "base64");
  const large = Buffer.from(tiny.subarray(12));
  large.writeUInt16LE(4096, 14); large.writeUInt16LE(4096, 16);
  const duplicate = Buffer.concat([tiny.subarray(0, 12), large, tiny.subarray(12)]);
  duplicate.writeUInt32LE(duplicate.length - 8, 4);
  expect(() => imageDimensions(duplicate, "webp")).toThrow(/malformed/);
});

const chunk = (kind: string, data: Buffer) => {
  const out = Buffer.alloc(8 + data.length + data.length % 2);
  out.write(kind); out.writeUInt32LE(data.length, 4); data.copy(out, 8); return out;
};
const riff = (...chunks: Buffer[]) => {
  const out = Buffer.concat([Buffer.from("RIFF0000WEBP"), ...chunks]);
  out.writeUInt32LE(out.length - 8, 4); return out;
};

it("rejects conflicting WebP animation containers and duplicate frame payloads", () => {
  const tiny = Buffer.from("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA", "base64").subarray(12);
  const extended = Buffer.alloc(10); extended[0] = 2;
  const canvas = chunk("VP8X", extended), anim = chunk("ANIM", Buffer.alloc(6));
  const frame = chunk("ANMF", Buffer.concat([Buffer.alloc(16), tiny]));
  expect(imageDimensions(riff(canvas, anim, frame), "webp")).toEqual({ width: 1, height: 1, frames: 1 });
  for (const input of [riff(canvas, tiny), riff(canvas, anim, anim, frame), riff(canvas, anim, frame, tiny), riff(canvas, anim, chunk("ANMF", Buffer.concat([Buffer.alloc(16), tiny, tiny])))]) {
    expect(() => imageDimensions(input, "webp")).toThrow(/malformed/);
  }
});

it("rejects duplicate PNG/JPEG dimension headers and counts every GIF frame", () => {
  expect(() => imageDimensions(Buffer.concat([PNG.subarray(0, 33), PNG.subarray(8)]), "png")).toThrow(/malformed/);
  const jpeg = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/wAALCAADAAIBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAA//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AJ//Z", "base64");
  const at = jpeg.indexOf(Buffer.from([255, 192])), end = at + 2 + jpeg.readUInt16BE(at + 2);
  expect(() => imageDimensions(Buffer.concat([jpeg.subarray(0, end), jpeg.subarray(at)]), "jpeg")).toThrow(/malformed/);
  const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
  const start = gif.indexOf(44), frame = gif.subarray(start, -1);
  expect(imageDimensions(Buffer.concat([gif.subarray(0, -1), frame, gif.subarray(-1)]), "gif")).toEqual({ width: 1, height: 1, frames: 2 });
  for (const [mime, bytes] of [["png", PNG], ["jpeg", jpeg], ["gif", gif]] as const) {
    expect(() => imageDimensions(Buffer.concat([bytes, bytes]), mime)).toThrow(/malformed/);
  }
});

it("reads all four formats and refuses every truncation of their containers", () => {
  const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
  const jpeg = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/wAALCAADAAIBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAA//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AJ//Z", "base64");
  const webp = Buffer.from("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA", "base64");
  expect(imageDimensions(PNG, "png")).toEqual({ width: 1, height: 1, frames: 1 });
  expect(imageDimensions(gif, "gif")).toEqual({ width: 1, height: 1, frames: 1 });
  expect(imageDimensions(jpeg, "jpeg")).toEqual({ width: 2, height: 3, frames: 1 });
  expect(imageDimensions(webp, "webp")).toEqual({ width: 1, height: 1, frames: 1 });
  for (const [mime, bytes] of [["png", PNG], ["gif", gif], ["jpeg", jpeg], ["webp", webp]] as const) {
    for (let n = 0; n < bytes.length; n++) expect(() => imageDimensions(bytes.subarray(0, n), mime)).toThrow(/malformed|truncated/);
  }
  const corrupt = Buffer.from(PNG); corrupt[45] = corrupt[45]! ^ 1;
  expect(() => imageDimensions(corrupt, "png")).toThrow(/malformed/);
});

it("refuses a tiny compressed image whose declared decoded canvas exceeds 40 megapixels", () => {
  const bomb = Buffer.from(PNG);
  bomb.writeUInt32BE(10_000, 16); bomb.writeUInt32BE(10_000, 20);
  bomb.writeUInt32BE(crc32(bomb.subarray(12, 29)), 29);
  expect(() => imageDimensions(bomb, "png")).toThrow("40 megapixels");
});

it("refuses animated PNG frame rectangles outside their declared canvas", () => {
  const animation = Buffer.alloc(8); animation.writeUInt32BE(1);
  const frame = Buffer.alloc(26); frame.writeUInt32BE(10_000, 4); frame.writeUInt32BE(10_000, 8);
  const input = Buffer.concat([PNG.subarray(0, 33), pngChunk("acTL", animation), pngChunk("fcTL", frame), PNG.subarray(33)]);
  expect(() => imageDimensions(input, "png")).toThrow(/malformed|megapixels/);
});

it("accepts legal empty IDAT chunks when image data is present", () => {
  expect(imageDimensions(Buffer.concat([PNG.subarray(0, 33), pngChunk("IDAT", Buffer.alloc(0)), PNG.subarray(33)]), "png")).toEqual({ width: 1, height: 1, frames: 1 });
});

it("requires data for every announced animated PNG frame", () => {
  const animation = Buffer.alloc(8); animation.writeUInt32BE(1);
  const frame = Buffer.alloc(26); frame.writeUInt32BE(1, 4); frame.writeUInt32BE(1, 8);
  const valid = Buffer.concat([PNG.subarray(0, 33), pngChunk("acTL", animation), pngChunk("fcTL", frame), PNG.subarray(33)]);
  expect(imageDimensions(valid, "png")).toEqual({ width: 1, height: 1, frames: 1 });
  const noData = Buffer.concat([PNG.subarray(0, 33), pngChunk("acTL", animation), PNG.subarray(33, -12), pngChunk("fcTL", frame), PNG.subarray(-12)]);
  expect(() => imageDimensions(noData, "png")).toThrow(/malformed|truncated/);
  const frameData = Buffer.concat([Buffer.alloc(4), PNG.subarray(41, 41 + PNG.readUInt32BE(33))]);
  frameData.writeUInt32BE(1);
  const poster = Buffer.concat([PNG.subarray(0, 33), pngChunk("acTL", animation), PNG.subarray(33, -12), pngChunk("fcTL", frame), pngChunk("fdAT", frameData), PNG.subarray(-12)]);
  expect(imageDimensions(poster, "png")).toEqual({ width: 1, height: 1, frames: 2 });
  animation.writeUInt32BE(2); frame.writeUInt32BE(1); frameData.writeUInt32BE(2);
  const twoFrames = Buffer.concat([valid.subarray(0, 33), pngChunk("acTL", animation), valid.subarray(53, -12), pngChunk("fcTL", frame), pngChunk("fdAT", frameData), PNG.subarray(-12)]);
  expect(imageDimensions(twoFrames, "png")).toEqual({ width: 1, height: 1, frames: 2 });
});

it("reserves more than Mistral's 3025 positions and budgets unreported Qwen resize caps conservatively", () => {
  expect(visionTokens({ width: 1540, height: 1540, frames: 1 })).toBeGreaterThanOrEqual(3025);
  expect(visionTokens({ width: 4096, height: 4096, frames: 1 })).toBeGreaterThanOrEqual(16_384);
  expect(visionTokens({ width: 7000, height: 5000, frames: 1 })).toBeGreaterThan(40_000);
  expect(visionTokens({ width: 7000, height: 5000, frames: 1 }, { "clip.vision.max_image_size": 1540 })).toBe(4096);
  expect(visionTokens({ width: 7000, height: 5000, frames: 1 }, { "clip.vision.image_size": 224 })).toBeGreaterThan(40_000);
});
