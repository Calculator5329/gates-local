import { mkdtemp, readFile, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { saveAttachments } from "./attachments.ts";
import { imageLifecycle } from "./image-lifecycle.ts";

it("keeps a fresh unreferenced upload through startup sweep", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "gates-image-age-"));
  const [image] = await saveAttachments(dir, ["data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGOor6//DwAFewJ94ITM6gAAAABJRU5ErkJggg=="]);
  await imageLifecycle(dir, { imageReferences: () => new Map() }).sweep();
  expect((await stat(path.join(dir, image!))).isFile()).toBe(true);
});

it("keeps shared saved-message images through collection and age sweeps", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "gates-image-refs-"));
  const [image] = await saveAttachments(dir, ["data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGOor6//DwAFewJ94ITM6gAAAABJRU5ErkJggg=="]);
  const filename = path.join(dir, image!);
  let messages = 2;
  const refs = {
    imageReferences: () => messages ? new Map([[image!, messages]]) : new Map<string, number>(),
  };
  const lifecycle = imageLifecycle(dir, refs);
  const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
  await utimes(filename, old, old);
  await lifecycle.sweep();
  expect((await stat(filename)).isFile()).toBe(true);
  messages--;
  await lifecycle.collect([image!]);
  expect((await stat(filename)).isFile()).toBe(true);
  messages--;
  await lifecycle.collect([image!]);
  await expect(stat(filename)).rejects.toMatchObject({ code: "ENOENT" });
});

it("sweeps an orphan only after a full day", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "gates-image-old-"));
  const [image] = await saveAttachments(dir, ["data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGOor6//DwAFewJ94ITM6gAAAABJRU5ErkJggg=="]);
  const filename = path.join(dir, image!);
  const lifecycle = imageLifecycle(dir, { imageReferences: () => new Map() });
  const young = new Date(Date.now() - 23 * 60 * 60 * 1000);
  await utimes(filename, young, young);
  await lifecycle.sweep();
  expect((await stat(filename)).isFile()).toBe(true);
  const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
  await utimes(filename, old, old);
  await lifecycle.sweep();
  await expect(stat(filename)).rejects.toMatchObject({ code: "ENOENT" });
});

const ONE_PIXEL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGOor6//DwAFewJ94ITM6gAAAABJRU5ErkJggg==";

it("work run in the collection queue finishes before a collect that comes after it, and a collect before it finishes first", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "gates-image-queue-"));
  const [image] = await saveAttachments(dir, [ONE_PIXEL]);
  const filename = path.join(dir, image!);
  const lifecycle = imageLifecycle(dir, { imageReferences: () => new Map() });
  const read = lifecycle.queue(async () => {
    await new Promise(resolve => setTimeout(resolve, 20));
    return readFile(filename);
  });
  const collected = lifecycle.collect([image!]);
  expect((await read).length).toBeGreaterThan(0);
  await collected;
  await expect(stat(filename)).rejects.toMatchObject({ code: "ENOENT" });
  const [next] = await saveAttachments(dir, [ONE_PIXEL]);
  const gone = lifecycle.collect([next!]);
  await expect(lifecycle.queue(() => stat(path.join(dir, next!)))).rejects.toMatchObject({ code: "ENOENT" });
  await gone;
});

it("a message saved with an image a collect has just taken is refused and never written, and one saved first keeps its image", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "gates-image-save-"));
  const [image] = await saveAttachments(dir, [ONE_PIXEL]);
  const held = new Map<string, number>();
  const lifecycle = imageLifecycle(dir, { imageReferences: () => held });
  const append = vi.fn(() => { held.set(image!, 1); return "saved"; });
  const collected = lifecycle.collect([image!]);
  await expect(lifecycle.save([image!], append)).rejects.toThrow("An attached image is no longer available. Paste it again; your words are kept.");
  await collected;
  expect(append).not.toHaveBeenCalled();
  const [kept] = await saveAttachments(dir, [ONE_PIXEL]);
  const keep = vi.fn(() => { held.set(kept!, 1); return "saved"; });
  const saved = lifecycle.save([kept!], keep);
  await lifecycle.collect([kept!]);
  await expect(saved).resolves.toBe("saved");
  expect((await stat(path.join(dir, kept!))).isFile()).toBe(true);
});
