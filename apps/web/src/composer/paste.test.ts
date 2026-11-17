import type { ClipboardEvent } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { methodSamples } from "@gates-local/contracts/testing";
import { attachFiles, imageReason, paste, pasteKind, splitDropped } from "./paste.ts";
import { getRefused, removeRefused } from "./refused-files.ts";
import { getDraft, replaceDraft } from "../lib/store/drafts.ts";
import { getState, setState } from "../lib/store/store.ts";
import { compressImage } from "./image-compression.ts";

afterEach(() => vi.unstubAllGlobals());

it("uses file paths first, then T3's image-first mixed clipboard behavior", () => {
  const image = { type: "image/png" };
  expect(pasteKind(["/srv/pictures/雪.png"], [image])).toBe("paths");
  expect(pasteKind([], [image, { type: "text/plain" }])).toBe("images");
  expect(pasteKind([], [{ type: "application/pdf" }])).toBe("files");
  expect(pasteKind([], [])).toBe("text");
});

const item = (file: File | null, isDirectory: boolean, kind = "file") => ({ kind, getAsFile: () => file, webkitGetAsEntry: () => ({ isDirectory }) });

it("splits a drop into files and folders by entry, as T3 Code does; a folder named like an image is a folder", () => {
  const png = new File(["x"], "shot.png", { type: "image/png" });
  const dir = new File([""], "x.png", { type: "" });
  expect(splitDropped({ files: [png, dir], items: [item(png, false), item(dir, true), item(null, false), item(png, false, "string")] })).toEqual({ files: [png], folders: ["x.png"] });
  expect(splitDropped({ files: [png] })).toEqual({ files: [png], folders: [] });
});

it("refuses a folder and an empty image at their chips with reasons true for each", async () => {
  await attachFiles([new File([], "blank.png", { type: "image/png" })], ["x.png"]);
  const [folder, blank] = getRefused();
  // council climb-025 Q4: the chip shows the short reason; the sentence is for screen readers only
  expect(folder).toMatchObject({ name: "x.png", folder: true, library: true, short: "add it to Library" });
  expect(folder!.reason).toContain("x.png is a folder");
  expect(blank).toMatchObject({ name: "blank.png", size: 0, library: false, short: "empty" });
  expect(blank!.reason).toBe("blank.png is empty (0 bytes), so there is no image to send.");
  for (const f of getRefused()) removeRefused(null, f.id);
});

it("a file that is not an image is copied to the server and the draft names it (chat row 3)", async () => {
  const attached = { path: "files/att-0f8b5c1e-3a2d-4c7e-9b1a-2d3e4f5a6b7c", name: "notes.txt", size: 5, type: "text/plain" };
  const call = vi.fn().mockResolvedValue(attached);
  vi.doMock("../lib/session/index.ts", () => ({ call }));
  await attachFiles([new File(["hello"], "notes.txt", { type: "text/plain" })]);
  expect(call).toHaveBeenCalledWith("files.attach", { name: "notes.txt", type: "text/plain", data: "aGVsbG8=" });
  expect(getDraft().files).toEqual([attached]);
  expect(getRefused()).toEqual([]);
  replaceDraft(null, { files: [] });
  vi.doUnmock("../lib/session/index.ts");
});

it("a file the browser gives no type is sent with an empty type, never one the window made up", async () => {
  const attached = { path: "files/att-0f8b5c1e-3a2d-4c7e-9b1a-2d3e4f5a6b7c", name: "Makefile", size: 5, type: "" };
  const call = vi.fn().mockResolvedValue(attached);
  vi.doMock("../lib/session/index.ts", () => ({ call }));
  await attachFiles([new File(["hello"], "Makefile")]);
  expect(call).toHaveBeenCalledWith("files.attach", { name: "Makefile", type: "", data: "aGVsbG8=" });
  expect(getDraft().files).toEqual([attached]);
  replaceDraft(null, { files: [] });
  vi.doUnmock("../lib/session/index.ts");
});

it("a file over 50 MB is refused at its chip in plain words and never read", async () => {
  const big = new File([new Uint8Array(50 * 1024 * 1024 + 1)], "big.log", { type: "" });
  const read = vi.spyOn(big, "arrayBuffer");
  await attachFiles([big]);
  const [chip] = getRefused();
  expect(chip).toMatchObject({ name: "big.log", library: false, short: "over 50 MB", reason: "big.log is over 50 MB, so it was not attached." });
  expect(read).not.toHaveBeenCalled();
  for (const f of getRefused()) removeRefused(null, f.id);
});

it("keeps images while naming an installed vision model; vision and text-only turns pass", () => {
  const { models } = methodSamples["models.list"].result;
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

class ImageReader extends EventTarget {
  result: string | null = null;
  readAsDataURL(file: File): void {
    queueMicrotask(() => {
      this.result = `data:${file.type};base64,${file.name}`;
      this.dispatchEvent(new Event("load"));
    });
  }
}

function sized(name: string, size: number, type = ""): File {
  const file = new File(["x"], name, { type });
  Object.defineProperty(file, "size", { value: size });
  return file;
}

function pasted(files: File[]): ClipboardEvent<HTMLTextAreaElement> & { preventDefault: ReturnType<typeof vi.fn> } {
  return { clipboardData: { files }, preventDefault: vi.fn() } as unknown as ClipboardEvent<HTMLTextAreaElement> & { preventDefault: ReturnType<typeof vi.fn> };
}

const CAP = 50 * 1024 * 1024;
const pictures = (from: string) => Array.from({ length: 5 }, (_, i) => new File(["png"], `${from}-${i}.png`, { type: "image/png" }));

it("a file one byte under 50 MB is read and attached, while one a byte over is refused at its chip and never read", async () => {
  const attached = { path: "files/att-0f8b5c1e-3a2d-4c7e-9b1a-2d3e4f5a6b7c", name: "under.log", size: CAP - 1, type: "" };
  const call = vi.fn().mockResolvedValue(attached);
  vi.doMock("../lib/session/index.ts", () => ({ call }));
  const under = sized("under.log", CAP - 1), over = sized("over.log", CAP + 1);
  const readUnder = vi.spyOn(under, "arrayBuffer"), readOver = vi.spyOn(over, "arrayBuffer");
  await attachFiles([under, over]);
  expect(readUnder).toHaveBeenCalledOnce();
  expect(call).toHaveBeenCalledWith("files.attach", expect.objectContaining({ name: "under.log" }));
  expect(getDraft().files).toEqual([attached]);
  expect(readOver).not.toHaveBeenCalled();
  expect(getRefused().map(f => f.name)).toEqual(["over.log"]);
  for (const f of getRefused()) removeRefused(null, f.id);
  replaceDraft(null, { files: [] });
  vi.doUnmock("../lib/session/index.ts");
});

it("a pasted file that is not a picture attaches as a drop does; with a picture beside it, only the picture is pasted", async () => {
  vi.stubGlobal("FileReader", ImageReader);
  const attached = { path: "files/att-0f8b5c1e-3a2d-4c7e-9b1a-2d3e4f5a6b7c", name: "report.pdf", size: 1, type: "application/pdf" };
  const call = vi.fn().mockResolvedValue(attached);
  vi.doMock("../lib/session/index.ts", () => ({ call }));
  const alone = pasted([new File(["%PDF"], "report.pdf", { type: "application/pdf" })]);
  paste(alone);
  expect(alone.preventDefault).toHaveBeenCalledOnce();
  await vi.waitFor(() => expect(getDraft().files).toEqual([attached]));
  expect(call).toHaveBeenCalledWith("files.attach", expect.objectContaining({ name: "report.pdf", type: "application/pdf" }));
  replaceDraft(null, { files: [] });
  call.mockClear();
  const mixed = pasted([new File(["png"], "shot.png", { type: "image/png" }), new File(["%PDF"], "report.pdf", { type: "application/pdf" })]);
  paste(mixed);
  expect(mixed.preventDefault).toHaveBeenCalledOnce();
  await vi.waitFor(() => expect(getState().pasting).toBe(0));
  expect(getDraft().images).toEqual(["data:image/png;base64,shot.png"]);
  expect(call).not.toHaveBeenCalled();
  expect(getDraft().files ?? []).toEqual([]);
  replaceDraft(null, { images: [] });
  vi.doUnmock("../lib/session/index.ts");
});

it("a picture the browser gives no type, or only octet-stream, is attached as the picture its name says", async () => {
  vi.stubGlobal("FileReader", ImageReader);
  const call = vi.fn();
  vi.doMock("../lib/session/index.ts", () => ({ call }));
  await attachFiles([new File(["png"], "shot.png"), new File(["jpg"], "photo.jfif", { type: "application/octet-stream" })]);
  expect(getDraft().images).toEqual(["data:image/png;base64,shot.png", "data:image/jpeg;base64,photo.jfif"]);
  expect(call).not.toHaveBeenCalled();
  replaceDraft(null, { images: [] });
  vi.doUnmock("../lib/session/index.ts");
});

it("two attaches that overlap cannot hold more than 8 pictures together, and the second says so", async () => {
  vi.stubGlobal("FileReader", ImageReader);
  await Promise.all([attachFiles(pictures("paste")), attachFiles(pictures("drop"))]);
  expect(getDraft().images).toHaveLength(8);
  expect(getState().notice).toBe("Attach up to 8 images per message.");
  replaceDraft(null, { images: [] });
  setState({ notice: null });
});
