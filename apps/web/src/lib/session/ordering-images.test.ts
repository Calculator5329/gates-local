// The images kind at the client boundary: a read that lands after a newer value of its thing (a
// push, or an action's answer) must not undo it. The window keeps no ticket of its own for the
// engine's status, the presets, a setup's download or the setup's steps; the numbers the socket
// server gives each frame decide.
import { afterEach, expect, it, vi } from "vitest";
import type { ImageDownload, ImagePresets, ImageSetup, ImageSetupProgress, ImageStatus } from "@gates-local/contracts";
import { methodSamples } from "@gates-local/contracts/testing";
import { installBrowser } from "../../../test/harness.ts";
import { numberServer } from "../../../test/numbered-server.ts";
import { drain } from "../../../test/ordering-world.ts";

const ready: ImageStatus = methodSamples["image.status"].result;
const off: ImageStatus = { state: "off", owner: "none" };
const listed: ImagePresets = methodSamples["image.presets"].result;
const started: ImagePresets = methodSamples["image.start"].result;
const running = started.download;
if (running === undefined) throw new Error("Missing download fixture");
const ended: ImageDownload = { ...running, state: "done", completedBytes: running.totalBytes ?? 0, ended: true };
const info: ImageSetup = methodSamples["image.setupInfo"].result;
const engineStep: ImageSetupProgress = { step: "engine", completedBytes: 1_000_000_000, totalBytes: 10_314_400_000 };
const modelStep: ImageSetupProgress = { step: "model", completedBytes: 6_000_000_000, totalBytes: 10_314_400_000 };

async function boot() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  const browser = installBrowser();
  const server = numberServer(browser.server, { serves: ["settings", "sources", "updates", "models", "images"] });
  vi.resetModules();
  const session = await import("./index.ts");
  const store = await import("../store/store.ts");
  const presets = () => { const value = store.getState().imagePresets; return value === undefined || value === "na" ? undefined : value; };
  const status = () => { const value = store.getState().imageStatus; return value === undefined || value === "na" ? undefined : value; };
  return { browser, server, session, store, presets, status };
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("a slow engine status read never undoes a newer image.status push", async () => {
  const { browser, server, session, status } = await boot();
  const reading = browser.server.hold("image.status");
  const close = session.connect();
  const slow = await reading;
  server.push("image.status", off);
  await drain();
  slow.respond(ready);
  await drain();
  expect(status()?.state, "the pushed status stays").toBe("off");
  close();
});

it("a slow presets read never undoes the list Start ComfyUI answered while it was out", async () => {
  const { browser, session, presets } = await boot();
  const reading = browser.server.hold("image.presets");
  const close = session.connect();
  const slow = await reading;
  expect(await session.startImage()).toBeNull();
  await drain();
  slow.respond(listed);
  await drain();
  expect(presets()?.others?.map((p) => p.id), "Start's list stays").toEqual(started.others?.map((p) => p.id));
  close();
});

it("a slow presets read never brings back a download whose end was pushed", async () => {
  const { browser, server, session, store } = await boot();
  const reading = browser.server.hold("image.presets");
  const close = session.connect();
  const slow = await reading;
  server.push("image.download", ended);
  await drain();
  slow.respond(started);
  await drain();
  expect(store.getState().imageDownload?.ended, "the download stays ended").toBe(true);
  close();
});

it("a slow setup read never puts back a step the setup has passed", async () => {
  const { browser, server, session, store } = await boot();
  const reading = browser.server.hold("image.setupInfo");
  const close = session.connect();
  const slow = await reading;
  server.push("image.setup", modelStep);
  await drain();
  slow.respond({ ...info, progress: engineStep });
  await drain();
  expect(store.getState().imageSetup?.progress?.step, "the pushed step stays").toBe("model");
  expect(store.getState().imageSetup?.model, "what the read found is still taken").toEqual(info.model);
  close();
});

it("a card put in or taken out reads what Set up images would fetch once; a reading of the same card reads nothing", async () => {
  const { browser, server, session } = await boot();
  const close = session.connect();
  await drain();
  const gpu = methodSamples["gpu.status"].result;
  const reads = () => browser.server.calls("image.setupInfo").length;
  const first = reads();
  server.push("gpu.changed", { ...gpu, measuredAt: gpu.measuredAt + 1 });
  await drain();
  expect(reads(), "the same card again").toBe(first);
  server.push("gpu.changed", { vendor: "none", occupants: [], systemMemoryAvailableBytes: 9_000_000_000, measuredAt: gpu.measuredAt + 2 });
  await drain();
  expect(reads(), "the card is gone").toBe(first + 1);
  close();
});

it("a slow presets read never undoes a newer image.presets push", async () => {
  const { browser, server, session, presets } = await boot();
  const reading = browser.server.hold("image.presets");
  const close = session.connect();
  const slow = await reading;
  server.push("image.presets", started);
  await drain();
  slow.respond(listed);
  await drain();
  expect(presets()?.others?.map((p) => p.id), "the pushed list stays").toEqual(started.others?.map((p) => p.id));
  close();
});
