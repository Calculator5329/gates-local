import { mkdtemp, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
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
