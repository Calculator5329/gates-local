// Which Linux build Set up images fetches: a computer whose card runs pictures gets the card build as
// before, one with none the processor build. Fake plans and a fake image module; nothing is downloaded.
import { describe, expect, it } from "vitest";
import type { InstallProgress } from "../runtime/types.ts";
import { LINUX_ENGINE, linuxBuild } from "./linux-build.ts";
import { createImageSetup, type BuildPlan, type EnginePlan, type ImageSetupDeps } from "./setup.ts";

const GIB = 1024 ** 3;

function fixture(room: number, plan: EnginePlan) {
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
  };
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

  it("the disk it says it takes is the measured engine tree plus the model, not four times the download", async () => {
    const plan = linuxBuild({ appDataDir: "/nowhere", pins: LINUX_ENGINE });
    const card = await fixture(16 * GIB, plan).setup.info();
    expect(card.needBytes).toBe(LINUX_ENGINE.diskBytes! + card.model!.bytes);
    // the fresh install read 22.1 GB on disk on a 16 GB card, a third of it uv's cache
    expect(card.needBytes! / GIB).toBeLessThan(15);
    const none = await fixture(0, plan).setup.info();
    expect(none.needBytes).toBe(LINUX_ENGINE.cpu!.diskBytes! + none.model!.bytes);
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

  it("a build with no processor lock (an older pin) builds the card one on either computer", async () => {
    const ran: string[] = [];
    const noCard = fixture(0, fakeBuild("1.0.0", 3000, ran));
    expect((await noCard.setup.info()).engine).toMatchObject({ version: "1.0.0", bytes: 3000 });
  });
});
