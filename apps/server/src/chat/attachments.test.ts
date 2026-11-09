import { mkdtemp, readFile, symlink, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { checkAttachments, saveAttachments, visionHistory } from "./attachments.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGOor6//DwAFewJ94ITM6gAAAABJRU5ErkJggg==";
const DATA = `data:image/png;base64,${PNG}`;

it("persists pasted bytes once and hydrates only saved user-image references", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "gates-paste-"));
  checkAttachments([DATA]);
  const images = await saveAttachments(dir, [DATA]);
  expect(await readFile(path.join(dir, images[0]!))).toEqual(Buffer.from(PNG, "base64"));
  expect(await visionHistory(dir, [{ role: "user", content: "look", images }])).toEqual([{ role: "user", content: "look", images: [PNG] }]);
  expect(() => checkAttachments(images)).not.toThrow();
  expect(await saveAttachments(dir, images)).toEqual(images);
  expect(await visionHistory(dir, [{ role: "assistant", content: "no attachments" }])).toEqual([{ role: "assistant", content: "no attachments" }]);
});

it("refuses oversized, excess, unsupported and malformed image inputs before saving", () => {
  expect(() => checkAttachments(Array.from({ length: 8 }, () => DATA))).not.toThrow();
  expect(() => checkAttachments(Array.from({ length: 9 }, () => DATA))).toThrow("8 images");
  for (const image of ["/srv/docs/a.pdf", "data:image/svg+xml;base64,PHN2Zz4=", `data:image/png;base64,${"A".repeat(14 * 1024 * 1024)}`]) {
    expect(() => checkAttachments([image])).toThrow("10 MB");
  }
  expect(() => checkAttachments(["data:image/png;base64,aGVsbG8="])).toThrow("malformed or truncated");
});

it("refuses a truncated PNG signature instead of passing it to downstream decoders", () => {
  expect(() => checkAttachments([`data:image/png;base64,${Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64")}`])).toThrow(/malformed|truncated|read/i);
});

it("refuses traversal and symlinks when hydrating model input", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "gates-paste-link-"));
  const outside = await mkdtemp(path.join(tmpdir(), "gates-paste-outside-"));
  const images = await saveAttachments(outside, [DATA]);
  await mkdir(path.join(dir, "images"));
  await symlink(path.join(outside, images[0]!), path.join(dir, images[0]!));
  await expect(visionHistory(dir, [{ role: "user", content: "look", images }])).rejects.toThrow("not available");
  await expect(visionHistory(dir, [{ role: "user", content: "look", images: ["images/../outside.png"] }])).rejects.toThrow("not available");
});
