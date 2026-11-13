// Image on in the composer, against the in-memory server: Send goes to the image model with
// the app's one image choice, no chat model has to be ready or fit, a message queued with
// Image on keeps going to the image model, and the choice is the open thread's own, else the
// app's last pick (the saved setting), which a new thread starts from and a reload reads back.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ImageChoice, ImagePreset, ImagePresets, Message, Settings } from "@gates-local/contracts";
import { methodSamples } from "@gates-local/contracts/testing";
import { type Browser, installBrowser, tick, until } from "./harness.ts";

type Session = typeof import("../src/session.ts");
type Store = typeof import("../src/store.ts");

let b: Browser;
let session: Session;
let store: Store;
let drafts: typeof import("../src/drafts.ts");
let choice: typeof import("../src/image-choice.ts");
let disconnect: (() => void) | undefined;
let created: string[];
let turnsOf: Record<string, number>;

const GIB = 1024 ** 3;
const PIXEL: ImagePreset = { id: "flux2-klein-4b-pixel", name: "FLUX.2 Klein 4B pixel art", family: "flux", measured: false, sizes: [{ width: 768, height: 512, bytes: 9 * GIB }, { width: 1024, height: 1024, bytes: 10 * GIB }] };
const FLUX: ImagePreset = { id: "flux2-klein-4b", name: "FLUX.2 Klein 4B", family: "flux", measured: false, sizes: [{ width: 1024, height: 1024, bytes: 10 * GIB }, { width: 1024, height: 768, bytes: 10 * GIB }] };
const PRESETS: ImagePresets = { presets: [PIXEL, FLUX], readAt: 1, current: { preset: PIXEL, width: 768, height: 512 } };
const SETTINGS: Settings = { ...methodSamples["settings.get"].result, imageGen: true };

const st = () => store.getState();
const type = (text: string) => drafts.replaceDraft(st().threadId, { text });
const userMsg = (id: string, threadId: string, content: string): Message => ({ id, threadId, role: "user", content, createdAt: 1 });
const sends = () => b.server.calls("chat.send").map((r) => r.params as Record<string, unknown>);

async function start(settings: Settings = SETTINGS): Promise<void> {
  b = installBrowser();
  vi.resetModules();
  session = await import("../src/session.ts");
  store = await import("../src/store.ts");
  drafts = await import("../src/drafts.ts");
  choice = await import("../src/image-choice.ts");
  created = ["A", "B", "C"];
  turnsOf = {};
  b.server.answer("settings.get", () => settings);
  b.server.answer("image.presets", () => PRESETS);
  b.server.answer("threads.create", ({ title }) => ({ id: created.shift() ?? "Z", title: title ?? "", createdAt: 1, updatedAt: 1 }));
  b.server.answer("threads.get", ({ threadId }) => ({ thread: { id: threadId, title: threadId, createdAt: 1, updatedAt: 1 }, messages: [] }));
  b.server.answer("chat.send", ({ threadId, content }) => {
    const n = (turnsOf[threadId] = (turnsOf[threadId] ?? 0) + 1);
    return { turnId: `turn-${threadId}-${n}`, userMessage: userMsg(`u-${threadId}-${n}`, threadId, content) };
  });
  disconnect = session.connect();
  await until(() => st().imagePresets !== undefined && st().conn.kind === "open", 2000, "hydration");
  await tick();
}

async function stopSession(): Promise<void> {
  disconnect?.();
  b.server.accepting = false;
  for (const s of b.server.sockets) s.close();
  await tick();
  vi.unstubAllGlobals();
}

beforeEach(() => start());
afterEach(stopSession);

it("Image on: one chat.send that carries the image choice and no chat-model check", async () => {
  store.setState({ image: true });
  type("a lighthouse at dusk");
  const blockingBefore = b.server.calls("turns.blocking").length;
  await session.send("a lighthouse at dusk");
  await until(() => sends().length === 1, 2000, "the send");
  expect(sends()[0]).toMatchObject({ content: "a lighthouse at dusk", draw: { preset: PIXEL.id, width: 768, height: 512 } });
  expect(sends()[0], "the old tool flag is gone").not.toHaveProperty("image");
  expect(b.server.calls("turns.blocking").length, "no chat model loads, so nothing is asked about stopping chats").toBe(blockingBefore);
  expect(st().turns.A).toMatchObject({ image: true, model: PIXEL.id });
});

it("Image off: the send is a chat send with no image choice", async () => {
  type("hello");
  await session.send("hello");
  await until(() => sends().length === 1, 2000, "the send");
  expect(sends()[0]).not.toHaveProperty("draw");
  expect(sends()[0]).not.toHaveProperty("image");
});

it("Image on sends with no chat model installed", async () => {
  store.setState({ models: [], model: undefined });
  store.setState({ image: true });
  type("a red kite");
  await session.send("a red kite");
  await until(() => sends().length === 1, 2000, "the send");
  expect(sends()[0]).toMatchObject({ draw: { preset: PIXEL.id } });
});

it("Image on before the image models are read says so and sends nothing", async () => {
  store.setState({ image: true, imagePresets: undefined });
  type("a red kite");
  await session.send("a red kite");
  await tick();
  expect(sends()).toEqual([]);
  expect(st().notice).toBe("The image models are still being read. Send again in a moment.");
});

it("the saved choice is what the button names and the send carries, in every thread", async () => {
  b.server.push("settings.changed", { ...SETTINGS, imageChoice: { preset: FLUX.id, width: 1024, height: 768 } });
  await until(() => choice.chosenImage(st())?.preset.id === FLUX.id, 2000, "the saved choice");
  store.setState({ image: true });
  type("first");
  await session.send("first");
  await until(() => sends().length === 1, 2000, "first send");
  b.server.push("chat.event", { turnId: "turn-A-1", threadId: "A", event: { type: "done", message: { id: "job-1", threadId: "A", role: "assistant", content: "", createdAt: 2 }, stopReason: "stop" } });
  await until(() => st().turns.A === undefined, 2000, "first turn over");
  session.newThread();
  expect(choice.chosenImage(st())).toMatchObject({ preset: { id: FLUX.id }, width: 1024, height: 768 });
  type("second");
  await session.send("second");
  await until(() => sends().length === 2, 2000, "second send");
  expect(sends().map((p) => p.draw)).toEqual([{ preset: FLUX.id, width: 1024, height: 768 }, { preset: FLUX.id, width: 1024, height: 768 }]);
  expect(sends().map((p) => p.threadId)).toEqual(["A", "B"]);
});

const listedThread = (id: string, imageChoice?: ImageChoice) => ({ id, title: id, createdAt: 1, updatedAt: 1, ...imageChoice ? { imageChoice } : {} });

it("each thread keeps its own choice: a pick in B leaves A's, and a new thread starts from the last pick", async () => {
  const kept: Record<string, ImageChoice> = { A: { preset: FLUX.id, width: 1024, height: 768 } };
  let saved = SETTINGS;
  b.server.answer("threads.list", () => ["A", "B"].map((id) => listedThread(id, kept[id])));
  b.server.answer("threads.setImageChoice", ({ threadId, choice: picked }) => { kept[threadId] = picked; return listedThread(threadId, picked); });
  b.server.answer("settings.update", (patch) => (saved = { ...saved, ...patch as Partial<Settings> }));
  b.server.push("threads.changed", { threadId: "A" });
  await until(() => st().threads.length === 2, 2000, "the thread list");
  session.openThread("A");
  expect(choice.chosenImage(st())).toMatchObject({ preset: { id: FLUX.id }, width: 1024, height: 768 });
  session.openThread("B");
  // B has none of its own: it shows the app's last pick (Settings)
  expect(choice.chosenImage(st())).toMatchObject({ preset: { id: PIXEL.id }, width: 768, height: 512 });
  expect(await session.pickImage({ preset: PIXEL.id, width: 1024, height: 1024 })).toBeNull();
  expect(b.server.calls("threads.setImageChoice").map((r) => r.params)).toEqual([{ threadId: "B", choice: { preset: PIXEL.id, width: 1024, height: 1024 } }]);
  expect(choice.chosenImage(st())).toMatchObject({ preset: { id: PIXEL.id }, width: 1024, height: 1024 });
  session.openThread("A");
  expect(choice.chosenImage(st())).toMatchObject({ preset: { id: FLUX.id }, width: 1024, height: 768 });
  store.setState({ image: true });
  type("A again");
  await session.send("A again");
  await until(() => sends().length === 1, 2000, "A's send");
  expect(sends()[0]).toMatchObject({ threadId: "A", draw: { preset: FLUX.id, width: 1024, height: 768 } });
  // a new thread has no thread to keep it on: the pick is the app's, and its first send carries it
  session.newThread();
  expect(choice.chosenImage(st())).toMatchObject({ preset: { id: PIXEL.id }, width: 1024, height: 1024 });
  expect(await session.pickImage({ preset: FLUX.id, width: 1024, height: 1024 })).toBeNull();
  expect(b.server.calls("threads.setImageChoice")).toHaveLength(1);
  expect(choice.chosenImage(st())).toMatchObject({ preset: { id: FLUX.id }, width: 1024, height: 1024 });
  // B kept its pick although the app's last pick moved on
  session.openThread("B");
  expect(choice.chosenImage(st())).toMatchObject({ preset: { id: PIXEL.id }, width: 1024, height: 1024 });
});

it("the chosen image is the same object until the presets or the saved choice change (a store selector must not loop)", async () => {
  b.server.push("settings.changed", { ...SETTINGS, imageChoice: { preset: FLUX.id, width: 1024, height: 768 } });
  await until(() => choice.chosenImage(st())?.preset.id === FLUX.id, 2000, "the saved choice");
  const first = choice.chosenImage(st());
  expect(choice.chosenImage(st())).toBe(first);
  b.server.push("settings.changed", { ...SETTINGS, imageChoice: { preset: FLUX.id, width: 1024, height: 1024 } });
  await until(() => choice.chosenImage(st())?.height === 1024, 2000, "the new choice");
  expect(choice.chosenImage(st())).not.toBe(first);
});

it("a reload reads the choice back from the saved settings", async () => {
  await stopSession();
  await start({ ...SETTINGS, imageChoice: { preset: FLUX.id, width: 1024, height: 1024 } });
  expect(choice.chosenImage(st())).toMatchObject({ preset: { id: FLUX.id }, width: 1024, height: 1024 });
});

it("a choice ComfyUI no longer lists falls back to what the server says a send runs", async () => {
  b.server.push("settings.changed", { ...SETTINGS, imageChoice: { preset: "gone-preset", width: 512, height: 512 } });
  await until(() => {
    const settings = st().settings;
    return settings !== "na" && settings?.imageChoice?.preset === "gone-preset";
  }, 2000, "settings");
  expect(choice.chosenImage(st())).toMatchObject({ preset: { id: PIXEL.id }, width: 768, height: 512 });
});

it("a message typed with Image on while a reply runs waits, then goes to the image model", async () => {
  type("question");
  await session.send("question");
  await until(() => sends().length === 1, 2000, "chat send");
  b.server.push("chat.event", { turnId: "turn-A-1", threadId: "A", event: { type: "start", model: "gemma3:4b", userMessage: userMsg("u-A-1", "A", "question") } });
  store.setState({ image: true });
  type("now a picture");
  await session.send("now a picture");
  expect(st().queued).toMatchObject([{ text: "now a picture", draw: { preset: PIXEL.id } }]);
  // Image turned off before it goes: it still goes as it was typed
  store.setState({ image: false });
  b.server.push("chat.event", { turnId: "turn-A-1", threadId: "A", event: { type: "done", message: { id: "a-A-1", threadId: "A", role: "assistant", content: "answer", createdAt: 2 }, stopReason: "stop" } });
  await until(() => sends().length === 2, 2000, "queued send");
  expect(sends()[1]).toMatchObject({ content: "now a picture", draw: { preset: PIXEL.id, width: 768, height: 512 } });
});

it("another client's Image turn arrives marked as one", async () => {
  session.openThread("A");
  await until(() => st().messages.A !== undefined, 2000, "thread A");
  b.server.push("chat.event", { turnId: "turn-x", threadId: "A", event: { type: "start", model: PIXEL.id, userMessage: userMsg("u-x", "A", "from the phone"), image: true } });
  await until(() => st().turns.A !== undefined, 2000, "the turn");
  expect(st().turns.A).toMatchObject({ image: true, model: PIXEL.id });
});
