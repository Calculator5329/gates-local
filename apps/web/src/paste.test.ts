import { afterEach, expect, it, vi } from "vitest";
import { methodSamples } from "@gates-local/contracts/testing";
import { imageReason, pasteKind } from "./paste.ts";
import { compressImage } from "./image-compression.ts";

afterEach(() => vi.unstubAllGlobals());

it("uses file paths first, then T3's image-first mixed clipboard behavior", () => {
  const image = { type: "image/png" };
  expect(pasteKind(["/srv/pictures/雪.png"], [image])).toBe("paths");
  expect(pasteKind([], [image, { type: "text/plain" }])).toBe("images");
  expect(pasteKind([], [{ type: "application/pdf" }])).toBe("unavailable");
  expect(pasteKind([], [])).toBe("text");
});

it("keeps images while naming an installed vision model; vision and text-only turns pass", () => {
  const models = methodSamples["models.list"].result;
  const images = ["data:image/png;base64,eA=="];
  const vision = models.find(m => m.capabilities?.includes("vision"))!;
  const text = models.find(m => m.capabilities?.includes("completion") && !m.capabilities.includes("vision"))!;
  expect(imageReason(models, text.name, images)).toContain(`${text.name} cannot see images`);
  expect(imageReason(models, text.name, images)).toContain(vision.name);
  expect(imageReason(models, vision.name, images)).toBeNull();
  expect(imageReason(models, text.name, [])).toBeNull();
  expect(imageReason([], undefined, images)).toContain("Download a model");
  expect(images).toHaveLength(1);
});

it("keeps small image bytes unchanged and refuses source files above T3's decode limit", async () => {
  const file = new File(["small"], "image.png", { type: "image/png" });
  expect(await compressImage(file)).toBe(file);
  const huge = new File([new Uint8Array(50 * 1024 * 1024 + 1)], "huge.png", { type: "image/png" });
  await expect(compressImage(huge)).rejects.toThrow("50 MB");
});

it("compresses oversized images, releases their bitmap, and reports unreadable images", async () => {
  const close = vi.fn();
  const bitmap = { width: 4096, height: 2048, close };
  const drawImage = vi.fn();
  const canvas = { width: 0, height: 0, getContext: () => ({ drawImage }), toDataURL: () => "data:image/webp;base64,", toBlob: (done: (blob: Blob) => void) => done(new Blob(["compressed"], { type: "image/webp" })) };
  vi.stubGlobal("document", { createElement: () => canvas });
  vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue(bitmap));
  const big = new File([new Uint8Array(11 * 1024 * 1024)], "big.png", { type: "image/png" });
  const prepared = await compressImage(big);
  expect(prepared.size).toBeLessThan(10 * 1024 * 1024);
  expect(prepared.type).toBe("image/webp");
  expect(drawImage).toHaveBeenCalledWith(bitmap, 0, 0, 2048, 1024);
  expect(close).toHaveBeenCalledOnce();
  vi.stubGlobal("createImageBitmap", vi.fn().mockRejectedValue(new Error("decode")));
  await expect(compressImage(big)).rejects.toThrow("could not be read");
});
