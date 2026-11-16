import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { serveImage } from "./files.ts";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
let dataDir = "";

beforeEach(async () => { dataDir = await mkdtemp(path.join(tmpdir(), "gates-files-")); });
afterEach(async () => { await rm(dataDir, { recursive: true, force: true }); });

async function ask(method: string, url: string, at: string): Promise<{ status: number; body?: Buffer }> {
  let status = 0, body: Buffer | undefined;
  const res = { headersSent: false, writeHead(code: number) { status = code; return { end(bytes?: Buffer) { body = bytes; } }; } };
  await serveImage({ method, url } as never, res as never, at);
  return { status, ...body === undefined ? {} : { body } };
}

describe("serveImage", () => {
  it("only a GET of an exact image name is served: other methods and other kinds of file are not found", async () => {
    const images = path.join(dataDir, "images");
    await mkdir(images);
    for (const name of ["a.png", "a.svg", "a.txt", "a.html"]) await writeFile(path.join(images, name), PNG);
    expect(await ask("GET", "/files/images/a.png", dataDir)).toEqual({ status: 200, body: PNG });
    for (const method of ["HEAD", "POST", "PUT", "DELETE"]) expect((await ask(method, "/files/images/a.png", dataDir)).status, method).toBe(404);
    for (const name of ["a.svg", "a.txt", "a.html"]) expect((await ask("GET", `/files/images/${name}`, dataDir)).status, name).toBe(404);
  });

  it("an images folder that is itself a link to elsewhere serves nothing from it", async () => {
    const elsewhere = path.join(dataDir, "elsewhere");
    await mkdir(elsewhere);
    await writeFile(path.join(elsewhere, "a.png"), PNG);
    await symlink(elsewhere, path.join(dataDir, "images"));
    expect((await ask("GET", "/files/images/a.png", dataDir)).status).toBe(404);
  });
});
