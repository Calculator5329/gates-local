import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ImageChoice } from "@gates-local/contracts";
import { createPicturesModule } from "../src/pictures/handlers.ts";
import { testPng } from "../src/pictures/test-png.ts";
import { openThreadStore, type ThreadStore } from "../src/threads/store.ts";

const REPO = path.resolve(import.meta.dirname, "..", "..", "..");

const dirs: string[] = [];
const stores: ThreadStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const klein: ImageChoice = { preset: "flux2-klein-4b", width: 1344, height: 768 };

function one(source: string, pattern: RegExp, what: string): string {
  const found = pattern.exec(source)?.[1];
  if (found === undefined) throw new Error(`${what} not found`);
  return found;
}

function stringArgs(list: string): string[] {
  return list.split(",").map((part) => JSON.parse(part.trim()) as string);
}

describe("what main wires", () => {
  it("a picture made before the index is in the first pictures list, which waits for the background backfill", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "gates-main-wiring-"));
    dirs.push(dataDir);
    await mkdir(path.join(dataDir, "images"));
    const store = openThreadStore(path.join(dataDir, "threads.sqlite"));
    stores.push(store);
    const thread = store.createThread({ title: "Earlier pictures" });
    store.saveImageJob({ jobId: "old-1", threadId: thread.id, state: "queued", choice: klein }, "a lighthouse");
    await writeFile(path.join(dataDir, "images", "old-1.png"), testPng(20, 10));
    store.saveImageJob({ jobId: "old-1", threadId: thread.id, state: "done", progress: 1, imagePath: "images/old-1.png", choice: klein }, "a lighthouse");
    expect(store.pictures.list({ limit: 50 }).count).toBe(0);

    const pictures = createPicturesModule({ store, dataDir, log: () => {} });
    const first = await pictures.handlers["pictures.list"]({ limit: 50 });
    expect(first.count).toBe(1);
    expect(first.pictures.map((p) => p.jobId)).toEqual(["old-1"]);
    await pictures.ready;
  });

  it("a test build's marker is read from the very file the packager puts beside the bundled server", async () => {
    const serverMain = await readFile(path.join(REPO, "apps/server/src/main.ts"), "utf8");
    const packager = await readFile(path.join(REPO, "apps/desktop/scripts/package.ts"), "utf8");

    const markerArgs = stringArgs(one(serverMain, /const TEST_BUILD_MARKER = path\.resolve\(import\.meta\.dirname, ([^)]*)\);/, "the server's marker path"));
    const bundleName = one(packager, /\["main\.ts", "([^"]+)"\]/, "the server bundle's name");
    const serverFolder = one(packager, /\{ from: server, to: "([^"]+)" \}/, "the server folder in resources");
    const markerInResources = one(packager, /\{ from: marker, to: "([^"]+)" \}/, "the marker in resources");

    const resources = path.resolve("/packaged", "resources");
    const bundle = path.join(resources, serverFolder, bundleName);
    expect(path.resolve(path.dirname(bundle), ...markerArgs)).toBe(path.join(resources, markerInResources));
    expect(bundle).toBe(path.join(resources, "server", "main.mjs"));
  });
});
