// Container/header validation only: no image decoder, native library or pixel allocation.
import { crc32 } from "node:zlib";
export interface ImageDimensions { width: number; height: number; frames: number; }
export const MAX_IMAGE_PIXELS = 40_000_000;
const malformed = (): never => { throw new Error("This image is malformed or truncated. Paste a complete GIF, JPEG, PNG or WebP image."); };
const dimensions = (width: number, height: number, frames = 1): ImageDimensions => {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || frames < 1) return malformed();
  if (width * height * frames > MAX_IMAGE_PIXELS) throw new Error("This image is over 40 megapixels when decoded. Paste a smaller image.");
  return { width, height, frames };
};

function png(bytes: Buffer): ImageDimensions {
  if (bytes.length < 45 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return malformed();
  let size: ImageDimensions | undefined;
  let data = false, animated = false, poster = false, frameData = false, frames = 1, frameHeaders = 0, sequence = 0;
  for (let at = 8; at < bytes.length;) {
    if (at + 12 > bytes.length) return malformed();
    const length = bytes.readUInt32BE(at), end = at + 12 + length;
    if (end > bytes.length) return malformed();
    const kind = bytes.toString("ascii", at + 4, at + 8);
    if (crc32(bytes.subarray(at + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) return malformed();
    if (at === 8 && kind !== "IHDR") return malformed();
    if (kind === "IHDR") {
      if (size || length !== 13 || bytes[at + 18] !== 0 || bytes[at + 19] !== 0 || (bytes[at + 20] ?? 2) > 1) return malformed();
      const depth = bytes[at + 16]!, color = bytes[at + 17]!;
      const allowed: Record<number, readonly number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!allowed[color]?.includes(depth)) return malformed();
      size = dimensions(bytes.readUInt32BE(at + 8), bytes.readUInt32BE(at + 12));
    } else if (kind === "acTL") {
      if (!size || animated || length !== 8 || data) return malformed();
      animated = true;
      frames = bytes.readUInt32BE(at + 8);
      dimensions(size.width, size.height, frames);
    } else if (kind === "fcTL") {
      if (!size || !animated || length !== 26 || (frameHeaders > 0 && !frameData) || ++frameHeaders > frames || bytes.readUInt32BE(at + 8) !== sequence++) return malformed();
      frameData = false;
      const width = bytes.readUInt32BE(at + 12), height = bytes.readUInt32BE(at + 16);
      dimensions(width, height);
      if (bytes.readUInt32BE(at + 20) + width > size.width || bytes.readUInt32BE(at + 24) + height > size.height || bytes[at + 32]! > 2 || bytes[at + 33]! > 1) return malformed();
      if (frameHeaders === 1 && data) poster = true;
      if (!data && (width !== size.width || height !== size.height)) return malformed();
      dimensions(size.width, size.height, frames + Number(poster));
    }
    else if (kind === "IDAT") {
      if (!size || poster || frameHeaders > 1) return malformed();
      data ||= length > 0;
      if (frameHeaders > 0) frameData ||= length > 0;
    } else if (kind === "fdAT") {
      if (!animated || !data || !frameHeaders || (!poster && frameHeaders === 1) || length <= 4 || bytes.readUInt32BE(at + 8) !== sequence++) return malformed();
      frameData = true;
    }
    else if (kind === "IEND") {
      if (!size || !data || length !== 0 || end !== bytes.length || (animated && (frameHeaders !== frames || !frameData))) return malformed();
      return dimensions(size.width, size.height, frames + Number(poster));
    }
    at = end;
  }
  return malformed();
}

function jpeg(bytes: Buffer): ImageDimensions {
  if (bytes.length < 12 || bytes[0] !== 255 || bytes[1] !== 216) return malformed();
  let size: ImageDimensions | undefined, scan = false, at = 2;
  while (at < bytes.length) {
    if (bytes[at++] !== 255) return malformed();
    while (bytes[at] === 255) at++;
    const marker = bytes[at++];
    if (marker === 217) return size && scan && at === bytes.length ? size : malformed();
    if (marker === undefined || marker === 0 || marker === 216 || (marker >= 208 && marker <= 215) || at + 2 > bytes.length) return malformed();
    const length = bytes.readUInt16BE(at);
    if (length < 2 || at + length > bytes.length) return malformed();
    if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) {
      if (size || length < 11 || length !== 8 + 3 * bytes[at + 7]!) return malformed();
      size = dimensions(bytes.readUInt16BE(at + 5), bytes.readUInt16BE(at + 3));
    }
    at += length;
    if (marker === 218) {
      if (!size || length < 6) return malformed();
      scan = true;
      const start = at;
      while (at < bytes.length) {
        if (bytes[at] !== 255) { at++; continue; }
        if (bytes[at + 1] === 0 || (bytes[at + 1]! >= 208 && bytes[at + 1]! <= 215)) { at += 2; continue; }
        break;
      }
      if (at === start) return malformed();
    }
  }
  return malformed();
}

function gif(bytes: Buffer): ImageDimensions {
  if (bytes.length < 14 || !/^GIF8[79]a$/.test(bytes.toString("ascii", 0, 6))) return malformed();
  const size = dimensions(bytes.readUInt16LE(6), bytes.readUInt16LE(8));
  let at = 13 + (bytes[10]! & 128 ? 3 * (2 ** ((bytes[10]! & 7) + 1)) : 0), frames = 0;
  const blocks = () => {
    let total = 0;
    for (;;) {
      if (at >= bytes.length) return malformed();
      const length = bytes[at++]!;
      if (length === 0) return total;
      if (at + length > bytes.length) return malformed();
      total += length; at += length;
    }
  };
  while (at < bytes.length) {
    const block = bytes[at++];
    if (block === 59) return frames && at === bytes.length ? dimensions(size.width, size.height, frames) : malformed();
    if (block === 33) { if (at >= bytes.length) return malformed(); at++; blocks(); continue; }
    if (block !== 44 || at + 9 > bytes.length) return malformed();
    const width = bytes.readUInt16LE(at + 4), height = bytes.readUInt16LE(at + 6);
    if (!width || !height || bytes.readUInt16LE(at) + width > size.width || bytes.readUInt16LE(at + 2) + height > size.height) return malformed();
    const table = bytes[at + 8]!;
    at += 9 + (table & 128 ? 3 * (2 ** ((table & 7) + 1)) : 0);
    if (at >= bytes.length || bytes[at]! < 2 || bytes[at]! > 8) return malformed();
    at++;
    if (!blocks()) return malformed();
    frames++;
    dimensions(size.width, size.height, frames);
  }
  return malformed();
}

function webp(bytes: Buffer): ImageDimensions {
  if (bytes.length < 26 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WEBP" || bytes.readUInt32LE(4) !== bytes.length - 8) return malformed();
  let size: ImageDimensions | undefined, encoded: ImageDimensions | undefined, frames = 0, animation = false, flags = 0, alpha = false;
  const frame = (kind: string, data: Buffer): ImageDimensions => {
    if (kind === "VP8 " && data.length >= 11 && (data[0]! & 1) === 0 && data.subarray(3, 6).equals(Buffer.from([157, 1, 42]))) return dimensions(data.readUInt16LE(6) & 0x3fff, data.readUInt16LE(8) & 0x3fff);
    if (kind === "VP8L" && data.length >= 6 && data[0] === 47) {
      const bits = data.readUInt32LE(1);
      if (bits >>> 29) return malformed();
      return dimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
    }
    return malformed();
  };
  for (let at = 12; at < bytes.length;) {
    if (at + 8 > bytes.length) return malformed();
    const kind = bytes.toString("ascii", at, at + 4), length = bytes.readUInt32LE(at + 4), end = at + 8 + length;
    if (end + (length % 2) > bytes.length) return malformed();
    const data = bytes.subarray(at + 8, end);
    if (kind === "VP8X") {
      if (at !== 12 || length !== 10 || data[0]! & 0xc1 || data.readUIntLE(1, 3) !== 0) return malformed();
      flags = data[0]!;
      size = dimensions(data.readUIntLE(4, 3) + 1, data.readUIntLE(7, 3) + 1);
    } else if (kind === "VP8 " || kind === "VP8L") {
      if (encoded || animation || flags & 2 || (kind === "VP8L" && alpha)) return malformed();
      encoded = frame(kind, data);
    } else if (kind === "ALPH") {
      if (!size || !(flags & 16) || alpha || encoded || animation || !length) return malformed();
      alpha = true;
    } else if (kind === "ANIM") {
      if (!size || !(flags & 2) || animation || encoded || alpha || length !== 6) return malformed();
      animation = true;
    }
    else if (kind === "ANMF") {
      if (!size || !animation || encoded || length < 24 || data[15]! & 0xfc) return malformed();
      const width = data.readUIntLE(6, 3) + 1, height = data.readUIntLE(9, 3) + 1;
      if (2 * data.readUIntLE(0, 3) + width > size.width || 2 * data.readUIntLE(3, 3) + height > size.height) return malformed();
      let found = false, frameAlpha = false;
      for (let offset = 16; offset < data.length;) {
        if (offset + 8 > data.length) return malformed();
        const inner = data.toString("ascii", offset, offset + 4), count = data.readUInt32LE(offset + 4), until = offset + 8 + count;
        if (until + count % 2 > data.length) return malformed();
        if (inner === "ALPH") {
          if (frameAlpha || found || !count) return malformed();
          frameAlpha = true;
        } else if (inner === "VP8 " || inner === "VP8L") {
          if (found || (inner === "VP8L" && frameAlpha)) return malformed();
          const item = frame(inner, data.subarray(offset + 8, until));
          if (item.width !== width || item.height !== height) return malformed();
          found = true;
        } else return malformed();
        offset = until + count % 2;
      }
      if (!found) return malformed();
      frames++; dimensions(size.width, size.height, frames);
    }
    at = end + length % 2;
  }
  if (animation) return size && frames ? dimensions(size.width, size.height, frames) : malformed();
  if (flags & 2 || !encoded || (size && (size.width !== encoded.width || size.height !== encoded.height))) return malformed();
  return encoded;
}

export function imageDimensions(bytes: Buffer, mime: string): ImageDimensions {
  switch (mime) {
    case "png": return png(bytes);
    case "jpeg": return jpeg(bytes);
    case "gif": return gif(bytes);
    case "webp": return webp(bytes);
    default: return malformed();
  }
}

/** GGUF vision metadata is preferred. Without a reported resize cap, budget the full input. */
export function visionTokens(size: ImageDimensions, info: Readonly<Record<string, unknown>> = {}): number {
  const positive = (key: string, fallback: number) => typeof info[key] === "number" && Number.isFinite(info[key]) && info[key] > 0 ? info[key] : fallback;
  const patch = Math.min(14, positive("clip.vision.patch_size", 14));
  const merge = Math.min(2, positive("clip.vision.spatial_merge_size", 2));
  // image_size can be a nominal crop size for dynamic encoders, so only explicit maxima cap the estimate.
  const edge = positive("clip.vision.max_image_size", Infinity);
  const pixels = positive("clip.vision.max_pixels", Infinity);
  const scale = Math.min(1, edge / Math.max(size.width, size.height), Math.sqrt(pixels / (size.width * size.height)));
  const columns = Math.ceil(size.width * scale / (patch * merge)), rows = Math.ceil(size.height * scale / (patch * merge));
  // A floor covers fixed-size encoders and minimum-size upscaling; row markers and boundaries get room too.
  return Math.max(4096, columns * rows + rows + 64) * size.frames;
}
