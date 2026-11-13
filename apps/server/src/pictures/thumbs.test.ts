import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { imageLifecycle } from "../chat/image-lifecycle.ts";
import { startWsServer, type WsServer } from "../ws/server.ts";
import { encodeThumbnail, makeThumbnail, readThumbnail } from "./thumbs.ts";
import { testPng, webpSize } from "./test-png.ts";

const dirs: string[] = [];
const servers: WsServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function dataDir() {
  const dir = await mkdtemp(path.join(tmpdir(), "gates-thumbs-"));
  dirs.push(dir);
  await mkdir(path.join(dir, "images"));
  return dir;
}
const exists = (file: string) => access(file).then(() => true, () => false);
const serial = <T>(work: () => Promise<T>) => work();

it("makes a 384 px WebP on the long edge, never larger than the picture", async () => {
  const wide = await encodeThumbnail(testPng(1344, 768));
  expect(wide.toString("latin1", 8, 12)).toBe("WEBP");
  expect(webpSize(wide)).toEqual({ width: 384, height: 219 });
  expect(wide.length).toBeLessThan(40_000);
  expect(webpSize(await encodeThumbnail(testPng(768, 1344)))).toEqual({ width: 219, height: 384 });
  expect(webpSize(await encodeThumbnail(testPng(200, 100)))).toEqual({ width: 200, height: 100 });
  await expect(encodeThumbnail(Buffer.from("not a PNG"))).rejects.toThrow();
});

it("keeps a thumbnail beside its picture, makes a missing one on request, and goes when the picture is collected", async () => {
  const dir = await dataDir();
  const made = randomUUID(), later = randomUUID(), absent = randomUUID();
  await writeFile(path.join(dir, "images", `${made}.png`), testPng(64, 32));
  await writeFile(path.join(dir, "images", `${later}.png`), testPng(32, 64));
  await makeThumbnail(dir, made, testPng(64, 32));
  const thumb = path.join(dir, "images", "thumbs", `${made}.webp`);
  expect(webpSize(await readFile(thumb))).toEqual({ width: 64, height: 32 });

  expect(webpSize((await readThumbnail(dir, later, serial))!)).toEqual({ width: 32, height: 64 });
  expect(await exists(path.join(dir, "images", "thumbs", `${later}.webp`))).toBe(true);
  expect(await readThumbnail(dir, absent, serial)).toBeUndefined();
  expect(await exists(path.join(dir, "images", "thumbs", `${absent}.webp`))).toBe(false);

  const files = imageLifecycle(dir, { imageReferences: () => new Map() });
  await files.collect([`images/${made}.png`]);
  expect(await exists(path.join(dir, "images", `${made}.png`))).toBe(false);
  expect(await exists(thumb)).toBe(false);
  expect(await exists(path.join(dir, "images", "thumbs", `${later}.webp`))).toBe(true);
});

it("serves thumbnails with the same token and Origin admission as pictures, cached for good", async () => {
  const dir = await dataDir();
  const job = randomUUID();
  await writeFile(path.join(dir, "images", `${job}.png`), testPng(40, 20));
  const server = await startWsServer({ port: 0, token: "test-launch", allowedOrigins: ["http://127.0.0.1:5187"], handlers: {}, dataDir: dir,
    thumbnails: (jobId) => readThumbnail(dir, jobId, serial) });
  servers.push(server);
  const base = `http://127.0.0.1:${server.port}`;
  const url = `${base}/files/thumbs/${job}.webp`;
  expect((await fetch(url)).status).toBe(401);
  expect((await fetch(`${url}?token=bad`)).status).toBe(401);
  expect((await fetch(`${url}?token=test-launch`, { headers: { origin: "http://evil.example" } })).status).toBe(403);
  expect(await exists(path.join(dir, "images", "thumbs", `${job}.webp`))).toBe(false);

  const ok = await fetch(`${url}?token=test-launch`, { headers: { origin: "http://127.0.0.1:5187" } });
  expect(ok.status).toBe(200);
  expect(ok.headers.get("content-type")).toBe("image/webp");
  expect(ok.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
  expect(webpSize(Buffer.from(await ok.arrayBuffer()))).toEqual({ width: 40, height: 20 });
  for (const missing of [`/files/thumbs/${randomUUID()}.webp`, "/files/thumbs/paste-1.webp", `/files/thumbs/..%2f${job}.webp`, `/files/thumbs/${job}.png`]) {
    expect((await fetch(`${base}${missing}?token=test-launch`)).status).toBe(404);
  }
});
