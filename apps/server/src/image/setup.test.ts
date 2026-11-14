// Which Linux build Set up images fetches: a computer whose card runs pictures gets the card build as
// before, one with none the processor build. Fake plans and a fake image module; nothing is downloaded.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { removeDir, tmpDir } from "../runtime/test-fakes.ts";
import type { InstallProgress } from "../runtime/types.ts";
import { engineDir, engineFiles } from "./engine.ts";
import { LINUX_ENGINE, linuxBuild } from "./linux-build.ts";
import { createOwnComfy, writeDevice } from "./own.ts";
import { BUILD_MARGIN, createImageSetup, type BuildPlan, type EnginePlan, type ImageSetupDeps } from "./setup.ts";

const GIB = 1024 ** 3;

/** A whole engine tree (what own.ts looks for), without the engine. */
function writeTree(appDataDir: string, version: string) {
  const files = engineFiles(engineDir(appDataDir, version), "uv-venv");
  for (const file of [files.python, files.main]) { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, ""); }
}

function fixture(room: number, plan: EnginePlan, more: Partial<ImageSetupDeps> = {}) {
  const devices: string[] = [];
  const deps: ImageSetupDeps = {
    appDataDir: "/nowhere",
    own: { installed: () => false },
    image: {
      status: async () => ({ state: "stopped", owner: "none" }) as never,
      engine: () => ({ owner: "none", state: "stopped", room }) as never,
      start: async () => ({}) as never,
      download: async () => ({ files: [] }),
    },
    setDevice: (d) => { devices.push(d); },
    engine: () => plan,
    gpuStatus: async () => ({}) as never,
    settingsAddress: () => undefined,
    push: () => {},
    freeBytes: async () => 500 * GIB,
    ...more,
  };
  const setDevice = deps.setDevice;
  deps.setDevice = (d) => { devices.push(d); if (more.setDevice !== undefined) setDevice(d); };
  return { setup: createImageSetup(deps), devices };
}

/** A build that records it ran, in place of uv. */
const fakeBuild = (version: string, bytes: number, ran: string[]): BuildPlan => ({
  kind: "build", version, bytes,
  run: async (onProgress: (p: InstallProgress) => void) => { ran.push(version); onProgress({ phase: "done", version, receivedBytes: bytes, totalBytes: bytes }); },
});

const settled = async (setup: ReturnType<typeof fixture>["setup"]) => {
  for (let i = 0; i < 50 && (await setup.info()).progress?.step !== "done"; i++) await new Promise((r) => setTimeout(r, 5));
  return setup.info();
};

describe("Set up images on Linux: the build follows the card", () => {
  it("the shipped plan: a 16 GB card gets the cu130 build it got before, no card the processor build, 2.8 GB less", async () => {
    const plan = linuxBuild({ appDataDir: "/nowhere", pins: LINUX_ENGINE });
    const card = await fixture(16 * GIB, plan).setup.info();
    expect(card.engine).toMatchObject({ version: "0.44.0", bytes: LINUX_ENGINE.uv.sizeBytes + LINUX_ENGINE.source.sizeBytes + LINUX_ENGINE.wheelBytes });
    expect(card.cpu).toBeUndefined();
    const none = await fixture(0, plan).setup.info();
    expect(none.engine).toMatchObject({ version: "0.44.0-cpu", bytes: LINUX_ENGINE.uv.sizeBytes + LINUX_ENGINE.source.sizeBytes + LINUX_ENGINE.cpu!.wheelBytes });
    expect(none.cpu).toBeDefined();
    expect(card.engine!.bytes - none.engine!.bytes).toBeGreaterThan(2.8e9);
  });

  it("the disk it says it takes is the measured engine tree, its margin and the model, not four times the download", async () => {
    const plan = linuxBuild({ appDataDir: "/nowhere", pins: LINUX_ENGINE });
    const card = await fixture(16 * GIB, plan).setup.info();
    expect(card.needBytes).toBe(LINUX_ENGINE.diskBytes! + BUILD_MARGIN + card.model!.bytes);
    // the fresh install read 22.1 GB on disk on a 16 GB card, a third of it uv's cache
    expect(card.needBytes!).toBeLessThan(card.engine!.bytes * 4 + card.model!.bytes);
    const none = await fixture(0, plan).setup.info();
    expect(none.needBytes).toBe(LINUX_ENGINE.cpu!.diskBytes! + BUILD_MARGIN + none.model!.bytes);
    // what the measured tree leaves out: on one processor build, 0.17 GB after its first start
    expect(BUILD_MARGIN).toBeGreaterThanOrEqual(5 * 0.17e9);
    // the words that refuse say the same figure
    const short = fixture(0, plan, { freeBytes: async () => none.needBytes! - 1 });
    await expect(short.setup.run()).rejects.toThrow(`Needs ${(none.needBytes! / GIB).toFixed(1)} GB free`);
  });

  it("the setup runs that build: the card build with a card, the processor build with none, and records the device", async () => {
    const ran: string[] = [];
    const plan: EnginePlan = { ...fakeBuild("1.0.0", 3000, ran), cpu: fakeBuild("1.0.0-cpu", 1000, ran) };
    const withCard = fixture(8 * GIB, plan);
    await withCard.setup.run();
    expect(await settled(withCard.setup)).toMatchObject({ progress: { step: "done" } });
    expect(ran).toEqual(["1.0.0"]);
    expect(withCard.devices).toEqual(["gpu"]);
    const noCard = fixture(0, plan);
    await noCard.setup.run();
    expect(await settled(noCard.setup)).toMatchObject({ progress: { step: "done" } });
    expect(ran).toEqual(["1.0.0", "1.0.0-cpu"]);
    expect(noCard.devices).toEqual(["cpu"]);
  });

  it("a build with no processor lock (an older pin) builds the card one on either computer, and with no card the engine starts it on the processor", async () => {
    const appDataDir = tmpDir("setup-old-pin");
    try {
      const ran: string[] = [];
      const own = createOwnComfy({ appDataDir, port: 1, platform: "linux" });
      // the build writes a whole tree, as the real one renames it into place
      const plan: BuildPlan = { ...fakeBuild("1.0.0", 3000, ran), run: async () => { ran.push("1.0.0"); writeTree(appDataDir, "1.0.0"); } };
      for (const room of [16 * GIB, 0]) {
        const at = fixture(room, plan, { appDataDir, own, setDevice: (d) => writeDevice(appDataDir, d) });
        expect((await at.setup.info()).engine).toMatchObject({ version: "1.0.0", bytes: 3000 });
        await at.setup.run();
        expect(await settled(at.setup)).toMatchObject({ progress: { step: "done" } });
        expect(own.build?.()).toMatchObject({ version: "1.0.0", cpu: room === 0 });
      }
      // built once, on the computer with the card; the one with none found it on disk
      expect(ran).toEqual(["1.0.0"]);
    } finally { removeDir(appDataDir); }
  });

  it("two setups at once start one build, and both callers get its outcome", async () => {
    const ran: string[] = [];
    let readCard!: () => void;
    const card = new Promise<void>((resolve) => { readCard = resolve; });
    let builds = 0;
    const slow: BuildPlan = { ...fakeBuild("1.0.0", 3000, ran), run: async (onProgress) => { builds++; await new Promise((r) => setTimeout(r, 20)); ran.push("1.0.0"); onProgress({ phase: "done", version: "1.0.0", receivedBytes: 3000, totalBytes: 3000 }); } };
    const at = fixture(8 * GIB, slow, { gpuStatus: async () => { await card; return {} as never; } });
    // two windows' clicks, both before the first one's read of the card resolves
    const first = at.setup.run();
    const second = at.setup.run();
    readCard();
    const both = await Promise.all([first, second]);
    expect(both[0]).toEqual(both[1]);
    expect(both[0]).toEqual({ started: true });
    expect(await settled(at.setup)).toMatchObject({ progress: { step: "done" } });
    expect(builds).toBe(1);
    expect(at.devices).toEqual(["gpu"]);
    // a refusal is the same for both too, and the next click is free to try again
    const full = fixture(8 * GIB, fakeBuild("1.0.0", 3000, ran), { freeBytes: async () => GIB });
    const refused = await Promise.allSettled([full.setup.run(), full.setup.run()]);
    expect(refused.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    expect((refused[0] as PromiseRejectedResult).reason).toBe((refused[1] as PromiseRejectedResult).reason);
    await expect(full.setup.run()).rejects.toThrow(/free/);
  });
});
