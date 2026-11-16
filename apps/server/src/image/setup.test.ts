// Which Linux build Set up images fetches: a computer whose card runs pictures gets the card build as
// before, one with none the processor build. Fake plans and a fake image module; nothing is downloaded.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { removeDir, tmpDir } from "../runtime/test-fakes.ts";
import type { InstallProgress } from "../runtime/types.ts";
import { engineDir, engineFiles } from "./engine.ts";
import { LINUX_ENGINE, linuxBuild } from "./linux-build.ts";
import { createOwnComfy, writeDevice } from "./own.ts";
import { createImageHandlers } from "./handlers.ts";
import { addressSet, BUILD_MARGIN, CARD_NOT_STARTED, CPU_SECONDS, createImageSetup, GPU_UNREAD, NO_ENGINE, NOT_YET, smallCard, type BuildPlan, type EnginePlan, type ImageSetupDeps } from "./setup.ts";

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

describe("the setup's download leaves out what is already on disk", () => {
  it("model files already whole: the figure said first and the total the counter runs to are the engine's alone, and the counter never jumps", async () => {
    // a real run: "8.7 GB download" with the model in place, 1.16 GB fetched, the counter 0.9 then 8.7
    const ran: string[] = [];
    const pushed: { step: string; completedBytes: number; totalBytes: number }[] = [];
    let left = 0;
    const at = fixture(16 * GIB, fakeBuild("1.0.0", 3000, ran), {
      image: {
        status: async () => ({ state: "stopped", owner: "none" }) as never,
        engine: () => ({ owner: "none", state: "stopped", room: 16 * GIB }) as never,
        start: async () => ({}) as never,
        download: async () => ({ files: [] }),
        setupLeft: async () => left,
      },
      push: (_c, p) => { pushed.push(p); },
    });
    const info = await at.setup.info();
    expect(info.model).toMatchObject({ preset: "flux2-klein-4b-compact", bytes: 0 });
    // nothing of the model to put on the drive either
    expect(info.needBytes).toBe(3000 * 4);
    await at.setup.run();
    expect(await settled(at.setup)).toMatchObject({ progress: { step: "done", completedBytes: 3000, totalBytes: 3000 } });
    expect(new Set(pushed.map((p) => p.totalBytes))).toEqual(new Set([3000]));
    // one file of three still to fetch: that one counts
    left = 336_211_292;
    expect((await at.setup.info()).model?.bytes).toBe(left);
  });

  it("where what is left is not known (a size not read yet), the whole model is said, as before", async () => {
    const at = fixture(16 * GIB, fakeBuild("1.0.0", 3000, []), {
      image: {
        status: async () => ({ state: "stopped", owner: "none" }) as never,
        engine: () => ({ owner: "none", state: "stopped", room: 16 * GIB }) as never,
        start: async () => ({}) as never,
        download: async () => ({ files: [] }),
        setupLeft: async () => undefined,
      },
    });
    expect((await at.setup.info()).model?.bytes).toBe(4_070_624_520 + 3_848_213_998 + 336_211_292);
  });
});

/** What nvidia-smi says: a card of `gib`, or no NVIDIA card at all. */
const card = (gib: number | "none") => async () => (gib === "none"
  ? { vendor: "none", occupants: [], systemMemoryAvailableBytes: 0, measuredAt: 0 }
  : { vendor: "nvidia", name: "NVIDIA GeForce RTX 4060", totalBytes: gib * GIB, occupants: [], systemMemoryAvailableBytes: 0, measuredAt: 0 }) as never;

describe("what was built against what the computer has now", () => {
  it("the processor build on a computer that has a card now: the setup offers the card build, builds it beside the old one, and pictures run on the processor until it is in", async () => {
    const appDataDir = tmpDir("setup-card-later");
    try {
      // set up with no card: the processor build, on the processor
      writeTree(appDataDir, "1.0.0-cpu");
      writeDevice(appDataDir, "cpu");
      const own = createOwnComfy({ appDataDir, port: 1, platform: "linux" });
      const ran: string[] = [];
      let finish!: () => void;
      const held = new Promise<void>((resolve) => { finish = resolve; });
      const plan: EnginePlan = {
        ...fakeBuild("1.0.0", 3000, ran),
        run: async (onProgress) => { ran.push("1.0.0"); onProgress({ phase: "download", version: "1.0.0", receivedBytes: 1000, totalBytes: 3000 }); await held; writeTree(appDataDir, "1.0.0"); },
        cpu: fakeBuild("1.0.0-cpu", 1000, ran),
      };
      const pushed: { toCard?: boolean; step: string }[] = [];
      // the image module says the processor (room 0): the processor build is what it runs
      const at = fixture(0, plan, {
        appDataDir, own, setDevice: (d) => writeDevice(appDataDir, d), gpuStatus: card(8),
        push: (_c, p) => { pushed.push(p); },
      });
      const offer = await at.setup.info();
      expect(offer.toCard).toBe(true);
      expect(offer.engine).toEqual({ version: "1.0.0", bytes: 3000, installed: false });
      expect(offer.cpu).toBeUndefined();
      await at.setup.run();
      await vi.waitFor(() => expect(pushed.at(-1)?.step).toBe("engine"));
      // while the card build runs, the engine starts the processor build, on the processor
      expect(own.build?.()).toEqual({ version: "1.0.0-cpu", cpu: true });
      expect(pushed.every((p) => p.toCard === true)).toBe(true);
      finish();
      expect(await settled(at.setup)).toMatchObject({ progress: { step: "done", toCard: true } });
      expect(ran).toEqual(["1.0.0"]);
      expect(own.build?.()).toEqual({ version: "1.0.0", cpu: false });
      // the old build is left where it was
      expect(existsSync(engineFiles(engineDir(appDataDir, "1.0.0-cpu"), "uv-venv").main)).toBe(true);
      expect((await at.setup.info()).toCard).toBeUndefined();
    } finally { removeDir(appDataDir); }
  });

  it("a processor engine left idle is stopped before the setup's start, so the card build is the one that starts", async () => {
    const appDataDir = tmpDir("setup-card-restart");
    try {
      writeTree(appDataDir, "1.0.0-cpu");
      writeDevice(appDataDir, "cpu");
      const own = createOwnComfy({ appDataDir, port: 1, platform: "linux" });
      const ran: string[] = [];
      const calls: string[] = [];
      const plan: EnginePlan = { ...fakeBuild("1.0.0", 3000, ran), run: async () => { ran.push("1.0.0"); writeTree(appDataDir, "1.0.0"); }, cpu: fakeBuild("1.0.0-cpu", 1000, ran) };
      const deps ={ status: async () => ({ state: "ready", owner: "app" }) as never, engine: () => ({ owner: "app", state: "ready", room: 0 }) as never, start: async () => { calls.push(`start ${own.build?.()?.version}`); return {} as never; }, download: async () => ({ files: [] }), stopIdle: async () => { calls.push("stopIdle"); } };
      const setup = createImageSetup({ appDataDir, own, image: deps, setDevice: (d) => writeDevice(appDataDir, d), engine: () => plan, gpuStatus: card(16), settingsAddress: () => undefined, push: () => {}, freeBytes: async () => 500 * GIB });
      await setup.run();
      expect(await settled(setup)).toMatchObject({ progress: { step: "done" } });
      expect(calls).toEqual(["stopIdle", "start 1.0.0"]);
    } finally { removeDir(appDataDir); }
  });

  it("the model step fails after the card build is in: pictures stay on the processor's build, the row still offers the card, and Try again builds nothing twice", async () => {
    const appDataDir = tmpDir("setup-card-model-fails");
    try {
      writeTree(appDataDir, "1.0.0-cpu");
      writeDevice(appDataDir, "cpu");
      const own = createOwnComfy({ appDataDir, port: 1, platform: "linux" });
      const ran: string[] = [];
      const calls: string[] = [];
      let fails = true;
      const plan: EnginePlan = { ...fakeBuild("1.0.0", 3000, ran), run: async () => { ran.push("1.0.0"); writeTree(appDataDir, "1.0.0"); }, cpu: fakeBuild("1.0.0-cpu", 1000, ran) };
      const image = {
        status: async () => ({ state: "stopped", owner: "none" }) as never, engine: () => ({ owner: "none", state: "stopped", room: 0 }) as never,
        start: async () => { calls.push(`start ${own.build?.()?.version}`); return {} as never; },
        download: async () => { if (fails) throw new Error("The model download stopped."); return { files: [] }; },
        setupLeft: async () => 0,
      };
      const setup = createImageSetup({ appDataDir, own, image, setDevice: (d) => writeDevice(appDataDir, d), engine: () => plan, gpuStatus: card(16), settingsAddress: () => undefined, push: () => {}, freeBytes: async () => 500 * GIB });
      await setup.run();
      await vi.waitFor(async () => expect((await setup.info()).progress).toMatchObject({ step: "error", toCard: true, message: "The model download stopped." }));
      // the card's build is whole on disk and has never started: the one that works is still what runs
      expect(ran).toEqual(["1.0.0"]);
      expect(own.build?.()).toEqual({ version: "1.0.0-cpu", cpu: true });
      // and at the app's next start
      expect(createOwnComfy({ appDataDir, port: 1, platform: "linux" }).build?.()).toEqual({ version: "1.0.0-cpu", cpu: true });
      // the row is still there, with nothing of the engine left to fetch
      const again = await setup.info();
      expect(again.toCard).toBe(true);
      expect(again.engine).toEqual({ version: "1.0.0", bytes: 3000, installed: true });
      expect(again.needBytes).toBe(0);
      fails = false;
      await setup.run();
      expect(await settled(setup)).toMatchObject({ progress: { step: "done", toCard: true } });
      expect(ran).toEqual(["1.0.0"]);
      expect(calls).toEqual(["start 1.0.0"]);
    } finally { removeDir(appDataDir); }
  });

  it("the card's engine did not start and the processor's started in its place: the setup ends saying so, and the row stays", async () => {
    const appDataDir = tmpDir("setup-card-no-start");
    try {
      writeTree(appDataDir, "1.0.0-cpu");
      writeDevice(appDataDir, "cpu");
      const own = createOwnComfy({ appDataDir, port: 1, platform: "linux" });
      const plan: EnginePlan = { ...fakeBuild("1.0.0", 3000, []), run: async () => { writeTree(appDataDir, "1.0.0"); }, cpu: fakeBuild("1.0.0-cpu", 1000, []) };
      const pushed: { step: string; toCard?: boolean; message?: string }[] = [];
      const image = {
        status: async () => ({ state: "stopped", owner: "none" }) as never, engine: () => ({ owner: "none", state: "stopped", room: 0 }) as never,
        // the tree's python is an empty file, so the start fails as a build that cannot run does; then
        // what the image module does when the engine it started is not there (module.ts ensure)
        start: async () => { await own.start().catch(() => undefined); own.failed?.(); return {} as never; },
        download: async () => ({ files: [] }),
      };
      const setup = createImageSetup({ appDataDir, own, image, setDevice: (d) => writeDevice(appDataDir, d), engine: () => plan, gpuStatus: card(16), settingsAddress: () => undefined, push: (_c, p) => { pushed.push(p); }, freeBytes: async () => 500 * GIB });
      await setup.run();
      await vi.waitFor(() => expect(pushed.at(-1)).toMatchObject({ step: "error", toCard: true, message: CARD_NOT_STARTED }));
      expect(own.build?.()).toEqual({ version: "1.0.0-cpu", cpu: true });
      expect((await setup.info()).toCard).toBe(true);
      // the same word when it happens at a picture, with no setup running
      pushed.length = 0;
      own.tryCard?.();
      await image.start();
      await vi.waitFor(() => expect(pushed).toEqual([expect.objectContaining({ step: "error", toCard: true, message: CARD_NOT_STARTED })]));
    } finally { removeDir(appDataDir); }
  });

  it("after the app restarts, the row still says why the card's engine was passed over, until it is tried again", async () => {
    const appDataDir = tmpDir("setup-card-no-start-restart");
    try {
      writeTree(appDataDir, "1.0.0-cpu");
      writeDevice(appDataDir, "cpu");
      const plan: EnginePlan = { ...fakeBuild("1.0.0", 3000, []), run: async () => { writeTree(appDataDir, "1.0.0"); }, cpu: fakeBuild("1.0.0-cpu", 1000, []) };
      const started = (own: ReturnType<typeof createOwnComfy>, pushed: unknown[] = []) => {
        const image = {
          status: async () => ({ state: "stopped", owner: "none" }) as never, engine: () => ({ owner: "none", state: "stopped", room: 0 }) as never,
          start: async () => { await own.start().catch(() => undefined); own.failed?.(); return {} as never; },
          download: async () => ({ files: [] }),
        };
        return createImageSetup({ appDataDir, own, image, setDevice: (d) => writeDevice(appDataDir, d), engine: () => plan, gpuStatus: card(16), settingsAddress: () => undefined, push: (_c, p) => { pushed.push(p); }, freeBytes: async () => 500 * GIB });
      };
      const pushed: unknown[] = [];
      const first = started(createOwnComfy({ appDataDir, port: 1, platform: "linux" }), pushed);
      await first.run();
      await vi.waitFor(() => expect(pushed.at(-1)).toMatchObject({ step: "error", toCard: true, message: CARD_NOT_STARTED }));
      // the app's next start: a new server over the same folder
      const own = createOwnComfy({ appDataDir, port: 1, platform: "linux" });
      const again = started(own);
      expect(await again.info()).toMatchObject({ toCard: true, progress: { step: "error", toCard: true, message: CARD_NOT_STARTED } });
      // a card build held only while it is made (never started) says nothing after a restart
      const fresh = tmpDir("setup-card-held-restart");
      try {
        writeTree(fresh, "1.0.0-cpu"); writeTree(fresh, "1.0.0");
        const making = createOwnComfy({ appDataDir: fresh, port: 1, platform: "linux" });
        making.holdCard?.("1.0.0");
        expect(createOwnComfy({ appDataDir: fresh, port: 1, platform: "linux" }).failedCard?.()).toBeUndefined();
      } finally { removeDir(fresh); }
    } finally { removeDir(appDataDir); }
  });

  it("offers nothing where the processor build is right: no card, a card too small for pictures, or the card build already beside it", async () => {
    const appDataDir = tmpDir("setup-card-none");
    try {
      writeTree(appDataDir, "1.0.0-cpu");
      writeDevice(appDataDir, "cpu");
      const own = createOwnComfy({ appDataDir, port: 1, platform: "linux" });
      const plan: EnginePlan = { ...fakeBuild("1.0.0", 3000, []), cpu: fakeBuild("1.0.0-cpu", 1000, []) };
      const at = (gpuStatus: ImageSetupDeps["gpuStatus"]) => fixture(0, plan, { appDataDir, own, setDevice: (d) => writeDevice(appDataDir, d), gpuStatus }).setup;
      expect((await at(card("none")).info())).toMatchObject({ engine: { version: "1.0.0-cpu", installed: true }, cpu: CPU_SECONDS });
      expect((await at(card("none")).info()).toCard).toBeUndefined();
      expect((await at(card(2)).info()).toCard).toBeUndefined();
      // both builds whole: the card's is the one the engine runs, nothing to set up
      writeTree(appDataDir, "1.0.0");
      expect((await at(card(8)).info()).toCard).toBeUndefined();
      expect(own.build?.()).toEqual({ version: "1.0.0", cpu: false });
    } finally { removeDir(appDataDir); }
  });

  it("a card build whose card is gone runs on the processor from the start, with nothing to download, and on the card again once it is back", async () => {
    const appDataDir = tmpDir("setup-card-gone");
    try {
      writeTree(appDataDir, "1.0.0");
      writeDevice(appDataDir, "gpu");
      const own = createOwnComfy({ appDataDir, port: 1, platform: "linux" });
      const plan: EnginePlan = { ...fakeBuild("1.0.0", 3000, []), cpu: fakeBuild("1.0.0-cpu", 1000, []) };
      let now: number | "none" = "none";
      // created at the app's start: the check runs then, before any picture asks the engine to start
      const setup = fixture(0, plan, { appDataDir, own, setDevice: (d) => writeDevice(appDataDir, d), gpuStatus: async () => card(now)() }).setup;
      await vi.waitFor(() => expect(own.build?.()).toEqual({ version: "1.0.0", cpu: true }));
      expect(await setup.info()).toMatchObject({ engine: { version: "1.0.0", installed: true } });
      expect((await setup.info()).toCard).toBeUndefined();
      now = 8;
      await setup.info();
      expect(own.build?.()).toEqual({ version: "1.0.0", cpu: false });
    } finally { removeDir(appDataDir); }
  });
});

const imageAt = (room: number | undefined, fetched: string[] = []): ImageSetupDeps["image"] => ({
  status: async () => ({ state: "stopped", owner: "none" }) as never,
  engine: () => ({ owner: "none", state: "stopped", ...room === undefined ? {} : { room } }) as never,
  start: async () => ({}) as never,
  download: async (preset) => { fetched.push(preset); return { files: [] }; },
});

const CANNOT_RUN: ReadonlyArray<readonly [string, Partial<ImageSetupDeps>, string]> = [
  ["an address in Settings", { settingsAddress: () => "http://10.0.0.5:8188" }, addressSet("http://10.0.0.5:8188")],
  ["a computer this release does not set up yet", { engine: () => "later" }, NOT_YET],
  ["a computer the app cannot set up", { engine: () => undefined }, NO_ENGINE],
  ["a card it cannot read", { image: imageAt(undefined) }, GPU_UNREAD],
  ["a card too small for pictures", { image: imageAt(2 * GIB) }, smallCard(2 * GIB)],
];

describe("why Set up images cannot run here", () => {
  it("where it cannot run, the setup read says why and offers nothing to fetch", async () => {
    const plan = fakeBuild("1.0.0", 3000, []);
    for (const [where, more, why] of CANNOT_RUN) {
      const info = await fixture(16 * GIB, plan, more).setup.info();
      expect(info.why, where).toBe(why);
      expect(info.engine, where).toBeUndefined();
      expect(info.model, where).toBeUndefined();
    }
    expect(await createImageHandlers({ image: {} as never })["image.setupInfo"]()).toEqual({ why: NO_ENGINE });
  });

  it("the reason names no service or unit, and a setup that can run carries no reason", async () => {
    const plan = fakeBuild("1.0.0", 3000, []);
    for (const [where, more] of CANNOT_RUN) {
      expect((await fixture(16 * GIB, plan, more).setup.info()).why, where).not.toMatch(/\.service|\.socket|systemd|systemctl|\bunit\b/i);
    }
    expect(await fixture(16 * GIB, plan).setup.info()).not.toHaveProperty("why");
    expect(await fixture(0, { ...plan, cpu: fakeBuild("1.0.0-cpu", 1000, []) }).setup.info()).not.toHaveProperty("why");
  });
});

describe("what the setup read says before anything is fetched", () => {
  it("on the processor it says the measured seconds a picture takes before anything downloads; with a card it says nothing of the processor", async () => {
    const ran: string[] = [];
    const fetched: string[] = [];
    const plan: EnginePlan = { ...fakeBuild("1.0.0", 3000, ran), cpu: fakeBuild("1.0.0-cpu", 1000, ran) };
    const none = await fixture(0, plan, { image: imageAt(0, fetched) }).setup.info();
    expect(none.cpu).toEqual({ low: 100, high: 235 });
    expect(none.engine).toMatchObject({ installed: false });
    expect(ran).toEqual([]);
    expect(fetched).toEqual([]);
    expect((await fixture(8 * GIB, plan, { image: imageAt(8 * GIB, fetched) }).setup.info()).cpu).toBeUndefined();
  });

  it("each read asks the machine again: free space and the card are as they are at that ask", async () => {
    let free = 500 * GIB;
    let room = 16 * GIB;
    const plan: EnginePlan = { ...fakeBuild("1.0.0", 3000, []), cpu: fakeBuild("1.0.0-cpu", 1000, []) };
    const { setup } = fixture(16 * GIB, plan, {
      freeBytes: async () => free,
      image: { ...imageAt(undefined), engine: () => ({ owner: "none", state: "stopped", room }) as never },
    });
    const first = await setup.info();
    expect(first).toMatchObject({ freeBytes: 500 * GIB, engine: { version: "1.0.0" } });
    expect(first.cpu).toBeUndefined();
    free = 7 * GIB;
    room = 0;
    expect(await setup.info()).toMatchObject({ freeBytes: 7 * GIB, engine: { version: "1.0.0-cpu" }, cpu: CPU_SECONDS });
    room = 2 * GIB;
    expect((await setup.info()).why).toBe(smallCard(2 * GIB));
  });
});
