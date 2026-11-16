import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, symlink, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { crc32 } from "node:zlib";
import { expect, it, vi } from "vitest";
import { MODEL, rig, until, type Rig } from "../../test/send-rig.ts";
import { checkAttachments, saveAttachments, visionHistory } from "./attachments.ts";
import { sendStarted } from "./send-started.ts";
import { OMITTED_IMAGE } from "./window.ts";

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

type ChatBody = { messages: { role: string; content: string; images?: string[] }[] };

function watchModel(): { chats: ChatBody[]; asked: string[] } {
  const inner = globalThis.fetch;
  const chats: ChatBody[] = [];
  const asked: string[] = [];
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const where = new URL(String(url)).pathname;
    asked.push(where);
    if (where === "/api/chat") chats.push(JSON.parse(String(init?.body)) as ChatBody);
    return inner(url, init);
  });
  return { chats, asked };
}

function declaring(width: number, height: number): string {
  const bytes = Buffer.from(PNG, "base64");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes.writeUInt32BE(crc32(bytes.subarray(12, 29)), 29);
  return `data:image/png;base64,${bytes.toString("base64")}`;
}

const dataDirOf = (r: Rig) => path.dirname(r.db.dbPath);
const savedImages = (r: Rig) => existsSync(path.join(dataDirOf(r), "images")) ? readdirSync(path.join(dataDirOf(r), "images")) : [];

it("a pasted image that is malformed or over 10 MB is refused at send, before any model is asked or anything is saved", async () => {
  const r = rig();
  const seen = watchModel();
  r.open();
  for (const [n, image] of ["data:image/png;base64,aGVsbG8=", `data:image/png;base64,${"A".repeat(14 * 1024 * 1024)}`].entries()) {
    await expect(r.h["reply.send"]({ ...r.entry(`bad-${n}`, "look"), images: [image] }, { clientId: 1 })).rejects.toMatchObject({ code: "image-input" });
  }
  expect(seen.asked.filter(where => where === "/api/show" || where === "/api/chat")).toEqual([]);
  expect(await r.h["reply.list"]({}, { clientId: 1 })).toEqual([]);
  expect(r.db.getThread(r.thread.id).messages).toEqual([]);
  expect(savedImages(r)).toEqual([]);
});

it("a pasted image is costed by the size its header declares, so one too big for the context is refused before it is saved", async () => {
  const r = rig();
  const seen = watchModel();
  r.open();
  await expect(sendStarted(r.app, { threadId: r.thread.id, content: "look", model: MODEL, numCtx: 16384, images: [declaring(4096, 4096)] })).rejects.toMatchObject({ code: "image-input", message: expect.stringContaining("do not fit") });
  expect(seen.chats).toEqual([]);
  expect(r.db.getThread(r.thread.id).messages).toEqual([]);
  expect(savedImages(r)).toEqual([]);
});

async function askPastOldImage(r: Rig, image: string): Promise<ChatBody> {
  const seen = watchModel();
  r.open();
  r.db.appendMessage({ threadId: r.thread.id, role: "user", content: "the old chart", images: [image] });
  r.db.appendMessage({ threadId: r.thread.id, role: "assistant", content: "a".repeat(12_000) });
  await sendStarted(r.app, { threadId: r.thread.id, content: "and now?", model: MODEL, numCtx: 8192 });
  await until(() => seen.chats.length === 1, "the model asked");
  return seen.chats[0]!;
}

it("an earlier image too old for the window is never read: a missing one there changes nothing the model is sent", async () => {
  const r = rig();
  const body = await askPastOldImage(r, `images/paste-${randomUUID()}.png`);
  expect(body.messages.map(m => m.content)).toEqual([OMITTED_IMAGE, "and now?"]);
});

it("an image on an assistant's message is never sent back to the model as something to look at", async () => {
  const r = rig();
  const seen = watchModel();
  r.open();
  const [image] = await saveAttachments(dataDirOf(r), [DATA]);
  r.db.appendMessage({ threadId: r.thread.id, role: "user", content: "draw a dot" });
  r.db.appendMessage({ threadId: r.thread.id, role: "assistant", content: "here it is", images: [image!] });
  await sendStarted(r.app, { threadId: r.thread.id, content: "what colour is it?", model: MODEL, numCtx: 16384 });
  await until(() => seen.chats.length === 1, "the model asked");
  expect(seen.chats[0]!.messages).toEqual([
    { role: "user", content: "draw a dot" },
    { role: "assistant", content: `here it is\n${OMITTED_IMAGE}` },
    { role: "user", content: "what colour is it?" },
  ]);
});
