import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ImageChoice, ImageDownload, Thread } from "@gates-local/contracts";
import { methodSamples } from "@gates-local/contracts/testing";
import { type Browser, installBrowser, tick, until } from "../../../test/harness.ts";

type Session = typeof import("./index.ts");
type Store = typeof import("../store/store.ts");

let b: Browser;
let session: Session;
let store: Store;
let disconnect: (() => void) | undefined;

beforeEach(async () => {
  b = installBrowser();
  vi.resetModules();
  session = await import("./index.ts");
  store = await import("../store/store.ts");
  disconnect = undefined;
});

afterEach(async () => {
  disconnect?.();
  b.server.accepting = false;
  for (const s of b.server.sockets) s.close();
  await tick();
  vi.unstubAllGlobals();
});

const hydrated = () => store.getState().imageStatus !== undefined && store.getState().conn.kind === "open";

async function boot(): Promise<void> {
  disconnect = session.connect();
  await until(hydrated, 2000, "hydration");
  await tick();
}

const refuse = (code: string, message: string) => () => {
  throw Object.assign(new Error(message), { code });
};

const klein: ImageChoice = { preset: "klein", width: 1024, height: 1024 };
const kleinKey = "klein:1024x1024";
const picture = methodSamples["pictures.list"].result.pictures[0]!;
const pictures = (list: readonly (typeof picture)[]) => ({ ...methodSamples["pictures.list"].result, pictures: [...list] });

describe("the count menu's time for a setup and size", () => {
  it("a setup and size with no picture, or none with a kept time, stays without a time: never zero, never a placeholder", async () => {
    await boot();
    b.server.answer("pictures.list", () => pictures([]));
    await session.readImageRun(klein);
    expect(store.getState().imageRuns, "no picture at all").toEqual({});
    const { runMs: _dropped, ...untimed } = picture;
    b.server.answer("pictures.list", () => pictures([{ ...untimed, preset: "klein", width: 1024, height: 1024 }, { ...picture, preset: "klein", width: 768, height: 1024, runMs: 3000 }]));
    await session.readImageRun(klein);
    expect(store.getState().imageRuns, "a picture with no kept time, and one of another size").toEqual({});
    expect(kleinKey in store.getState().imageRuns).toBe(false);
  });

  it("a picture-time read that fails leaves the menu's rows without times and lets the menu open", async () => {
    await boot();
    b.server.answer("pictures.list", refuse("internal", "the picture list could not be read"));
    await expect(session.readImageRun(klein)).resolves.toBeUndefined();
    expect(store.getState().imageRuns).toEqual({});
  });
});

describe("the picker's image actions", () => {
  it("say what failed, why and what to do when the server refuses, with its own words in the details, and the connection's words when the connection failed", async () => {
    await boot();
    const own = "Set a ComfyUI HTTP address without credentials or query parameters in Settings.";
    b.server.answer("image.setup", refuse("image-config", own));
    expect(await session.startImageSetup()).toEqual({ message: "Couldn't set up images because the ComfyUI address has a user name, password or query in it; set a plain address in Settings › Images.", why: own });
    b.server.answer("image.stopDownload", refuse("image-download", "Nothing of klein is downloading."));
    expect(await session.stopImageDownload("klein")).toEqual({ message: "Couldn't stop the download because it had already ended; nothing is left to stop.", why: "Nothing of klein is downloading." });
    b.server.answer("image.setup", refuse("internal", "ENOSPC: no space left on device, write"));
    expect(await session.startImageSetup(), "a fault that is not the image module's own words").toEqual({ message: "Couldn't set up images because Gates Local refused it (ENOSPC: no space left on device, write); try again." });
    b.server.accepting = false;
    b.server.socket.close();
    await until(() => store.getState().conn.kind === "down", 2000, "the connection down");
    expect(await session.startImageSetup()).toEqual({ message: "Couldn't set up images because Gates Local isn't connected; try again once it reconnects." });
  });

  it("asking ComfyUI again shows its fresh answer where Settings reads the status", async () => {
    await boot();
    const fresh = { state: "missing", owner: "none", baseUrl: "http://127.0.0.1:9", detail: "No ComfyUI answers at http://127.0.0.1:9." } as const;
    expect(store.getState().imageStatus).toEqual(methodSamples["image.status"].result);
    b.server.answer("image.status", () => fresh);
    expect(await session.checkImageStatus()).toBeNull();
    expect(store.getState().imageStatus).toEqual(fresh);
  });

  it("at the end of Set up images, done or failed, what setup would fetch is read again once; a step on the way reads nothing", async () => {
    await boot();
    await until(() => b.server.calls("image.setupInfo").length > 0, 1000, "the hydrate's setup read");
    await tick();
    const reads = () => b.server.calls("image.setupInfo").length;
    const before = reads();
    b.server.push("image.setup", { step: "engine", completedBytes: 1_000_000_000, totalBytes: 14_506_218_860 });
    b.server.push("image.setup", { step: "model", completedBytes: 9_000_000_000, totalBytes: 14_506_218_860 });
    await tick();
    expect(reads(), "steps on the way").toBe(before);
    b.server.push("image.setup", { step: "done", completedBytes: 14_506_218_860, totalBytes: 14_506_218_860 });
    await until(() => reads() === before + 1, 1000, "the read after done");
    b.server.push("image.setup", { step: "error", completedBytes: 0, totalBytes: 14_506_218_860, message: "The image engine download did not match its pinned checksum. Nothing was installed." });
    await until(() => reads() === before + 2, 1000, "the read after an error");
    await tick();
    expect(reads()).toBe(before + 2);
  });
});

const bar = (preset: string): ImageDownload => ({ preset, file: 1, files: 1, name: `${preset}.safetensors`, state: "downloading", completedBytes: 5, totalBytes: 10 });

describe("a setup's download row", () => {
  it("shows the download at once, queued, before the server has answered", async () => {
    await boot();
    const held = b.server.hold("image.download");
    const downloading = session.downloadImageSetup("klein");
    const request = await held;
    expect(store.getState().imageDownload).toMatchObject({ preset: "klein", state: "queued" });
    request.respond({ files: ["klein.safetensors"] });
    expect(await downloading).toBeNull();
    expect(store.getState().imageDownload, "a download that started keeps its row until its pushes").toMatchObject({ preset: "klein", state: "queued" });
  });

  it("the queued row goes when the download did not start, and a push since it keeps the say", async () => {
    await boot();
    const own = "Start ComfyUI on this computer first: downloads go into its model folders.";
    b.server.answer("image.download", refuse("image-download", own));
    expect(await session.downloadImageSetup("klein")).toEqual({ message: "Couldn't download the image setup because ComfyUI isn't running on this computer; start it first.", why: own });
    expect(store.getState().imageDownload, "a refused download").toBeUndefined();
    b.server.answer("image.download", () => ({ files: [] }));
    expect(await session.downloadImageSetup("klein")).toBeNull();
    expect(store.getState().imageDownload, "every file already in its folder").toBeUndefined();
    const pushed: ImageDownload = { preset: "klein", file: 1, files: 1, name: "klein.safetensors", state: "downloading", completedBytes: 5, totalBytes: 10 };
    const held = b.server.hold("image.download");
    const downloading = session.downloadImageSetup("klein");
    const request = await held;
    b.server.push("image.download", pushed);
    await until(() => store.getState().imageDownload?.state === "downloading", 1000, "the pushed progress");
    request.fail("image-download", "The download stopped.");
    await downloading;
    expect(store.getState().imageDownload).toEqual(pushed);
  });

  it("a Stop that finds nothing running takes that setup's bar away; another setup's bar stays", async () => {
    await boot();
    b.server.push("image.download", bar("klein"));
    await until(() => store.getState().imageDownload?.preset === "klein", 1000, "klein's bar");
    b.server.answer("image.stopDownload", () => ({ stopped: false }));
    expect(await session.stopImageDownload("moss-image")).toBeNull();
    expect(store.getState().imageDownload?.preset, "a Stop for another setup").toBe("klein");
    expect(await session.stopImageDownload("klein")).toBeNull();
    expect(store.getState().imageDownload).toBeUndefined();
  });
});

describe("the image download folder", () => {
  it("clearing it sends null, so the saved folder goes", async () => {
    await boot();
    expect(await session.saveImageFolder(null)).toBeNull();
    const sent = b.server.calls("settings.update").at(-1)?.params;
    expect(sent).toEqual({ imageFolder: null });
  });
});

describe("an image pick in an open chat", () => {
  it("its answer is the chat's row at the pick's number: it shows, and an older answer never undoes a newer pushed row", async () => {
    await boot();
    const row = methodSamples["threads.list"].result[0]!;
    const moss: ImageChoice = { preset: "moss-image", width: 1024, height: 1024 };
    const shown = () => store.getState().threads.find((t) => t.id === row.id)?.imageChoice;
    store.setState({ view: "thread", threadId: row.id });
    b.server.answer("threads.setImageChoice", ({ threadId, choice }) => ({ ...row, id: threadId, imageChoice: choice }));
    expect(await session.pickImage(klein)).toBeNull();
    expect(shown(), "the answer's row shows").toEqual(klein);
    const held = b.server.hold("threads.setImageChoice");
    const picking = session.pickImage(moss);
    const request = await held;
    const pushed: Thread = { ...row, imageChoice: { preset: "z-image-int8", width: 1024, height: 1024 } };
    b.server.push("threads.changed", { threadId: row.id, thread: pushed });
    await until(() => shown()?.preset === "z-image-int8", 1000, "the pushed row");
    request.respond({ ...row, imageChoice: moss });
    expect(await picking).toBeNull();
    expect(shown(), "the newer pushed row stays").toEqual(pushed.imageChoice);
  });
});
