// The rules for what is in GPU memory, as tests on the real modules (rules-harness.ts builds the
// world). Each rule is a script of steps and what must hold after them. A rule names the guards
// it rests on: for each one the same script runs again with that guard turned off and has to
// fail, so a rule that would pass either way is not counted.
//
// GATES_GPU_RULES_BREAK=<guard> runs every rule with that guard off, to watch a rule go red.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENGINE_BUSY_NOTE } from "./memory.ts";
import { createWorld, NUM_CTX, WHISPER_MIB, type Break, type Model, type World, type WorldOptions } from "./rules-harness.ts";

// Nothing is started: a process any module tried to start is written down and fails the test.
const effects = vi.hoisted(() => {
  const calls: string[] = [];
  const refuse = (name: string) => (...args: unknown[]) => {
    calls.push(`http.${name} ${String(args[0])}`);
    throw new Error("a GPU rules test opens no connection");
  };
  return { calls, refuse };
});
vi.mock("node:child_process", () => Object.fromEntries(["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"].map((name) => [name, (...args: unknown[]) => { effects.calls.push(`${name} ${args.map(String).join(" ")}`); }])));
// No connection is opened either: the world routes fetch itself, and node's own client is refused.
vi.mock("node:http", async (original) => {
  const real = await original<typeof import("node:http")>();
  const closed = { ...real, get: effects.refuse("get"), request: effects.refuse("request") };
  return { ...closed, default: closed };
});

type Open = (options?: Omit<WorldOptions, "advance" | "faultForTest">) => Promise<World>;
const FROM_ENV = process.env["GATES_GPU_RULES_BREAK"] as Break | undefined;
const opened: { world: World; guarded: boolean }[] = [];
const opener = (broken: Break | undefined): Open => async (options = {}) => {
  const world = await createWorld({ ...options, advance: async (ms) => { await vi.advanceTimersByTimeAsync(ms); }, ...broken === undefined ? {} : { faultForTest: broken } });
  // a world with every guard on, and an Ollama that gives up a dropped load, keeps the rules in afterEach whatever its script does
  opened.push({ world, guarded: broken === undefined && options.ollamaKeepsLoading !== true });
  return world;
};
const whole = opener(undefined);

beforeEach(() => { vi.useFakeTimers(); });
afterEach(async () => {
  try {
    for (const { world, guarded } of opened) {
      await world.close();
      if (!guarded) continue;
      // whatever the script was: nothing named whisper, whisper holds what it held, and no two things ever loaded at once
      expect(world.rec.whisper).toEqual([]);
      if (world.card().names.includes("whisper")) expect(world.card().holders.find((h) => h.name === "whisper")).toEqual({ name: "whisper", mib: WHISPER_MIB, state: "in" });
      expect(world.rec.overlaps).toEqual([]);
    }
    expect(effects.calls).toEqual([]);
  } finally {
    opened.length = 0;
    effects.calls.length = 0;
    vi.useRealTimers();
  }
});

/** A rule, and the guards whose loss it has to notice. */
function rule(name: string, guards: readonly Break[], script: (open: Open) => Promise<void>) {
  it(name, () => script(opener(FROM_ENV)));
  for (const guard of guards) {
    it(`${name}: seen failing with the guard off (${guard})`, async () => {
      await expect(script(opener(guard))).rejects.toMatchObject({ name: "AssertionError" });
    });
  }
}

/** `model` loaded by the app and idle: a chat that replied and ended. */
async function appLoaded(w: World, model: Model, id = `earlier-${model}`) {
  await w.chatSends(id, { model });
  await w.ollamaFinishesLoading(model);
  await w.chatEnds(id);
  expect(w.chat(id).state).toBe("ended");
}
/** A chat that is replying on `model`. */
async function replying(w: World, id: string, model: Model = "m1:7b") {
  await w.chatSends(id, { model });
  if (w.card().loading.includes(model)) await w.ollamaFinishesLoading(model);
  expect(w.chat(id).state).toBe("replying");
}

describe("the world the rules run in", () => {
  it("a chat loads its model, replies and ends; the model stays, idle", async () => {
    const w = await whole();
    expect(w.card().names).toEqual(["whisper"]);
    await w.chatSends("c1");
    expect(w.chat("c1").state).toBe("loading");
    expect(w.card().loading).toEqual(["m1:7b"]);
    await w.ollamaFinishesLoading("m1:7b");
    expect(w.chat("c1").state).toBe("replying");
    expect(w.record.oursAt("m1:7b")).toBe(NUM_CTX);
    await w.chatEnds("c1");
    expect(w.chat("c1").state).toBe("ended");
    expect(w.card().names).toEqual(["whisper", "m1:7b"]);
    expect(w.card().loading).toEqual([]);
    expect(w.lease.status()).toMatchObject({ holders: 0, waiting: [] });
  });

  it("a picture starts ComfyUI, loads its setup, is made and leaves the setup in memory", async () => {
    const w = await whole({ comfy: "stopped" });
    await w.pictureSends();
    expect(w.rec.starts).toEqual(["comfyui"]);
    expect(w.card().loading).toEqual(["ComfyUI"]);
    await w.pictureFinishes();
    expect(w.picture()?.state).toBe("done");
    expect(w.card().names).toEqual(["whisper", "ComfyUI"]);
    expect(w.card().loading).toEqual([]);
  });

  it("a request to any address but a fake's is refused", async () => {
    await whole();
    await expect(fetch("http://127.0.0.1:11434/api/ps")).rejects.toThrow(/reaches no real address/);
  });
});

describe("never two things loading at once", () => {
  rule("a picture ComfyUI will not stop keeps the card until ComfyUI lets go", ["stuck-picture-gives-the-card-back"], async (open) => {
    const w = await open({ comfy: "stopped", comfySticks: true });
    await w.pictureSends();
    expect(w.card().loading).toEqual(["ComfyUI"]);
    await w.personStopsPicture();
    await w.pictureStopTimesOut();
    // small enough to fit beside what ComfyUI is still loading: only the claim keeps it out
    await w.chatSends("c1", { model: "small:1b" });
    expect(w.rec.overlaps).toEqual([]);
    expect(w.chat("c1").state).toBe("waiting");
    expect(w.card().loading).toEqual(["ComfyUI"]);
    await w.comfyLetsGo();
    await w.pass(2_000);
    expect(w.chat("c1").state).toBe("loading");
    expect(w.card().loading).toEqual(["small:1b"]);
    expect(w.rec.overlaps).toEqual([]);
  });

  // Not a rule the app keeps by itself: it relies on Ollama giving up a load whose request was
  // dropped. The first test is that Ollama; the second writes down what happens with one that
  // goes on loading, so a change either way shows up here.
  it("a stopped chat's load is over before the next one starts, with an Ollama that gives up a dropped load", async () => {
    const w = await whole();
    await w.chatSends("c1");
    expect(w.card().loading).toEqual(["m1:7b"]);
    await w.personStopsChat("c1");
    expect(w.card().loading).toEqual([]);
    await w.chatSends("c2", { model: "small:1b" });
    expect(w.card().loading).toEqual(["small:1b"]);
    expect(w.rec.overlaps).toEqual([]);
  });

  it("today's assumption, written down: an Ollama that goes on loading a stopped chat's model is waited for 20 s, then loaded beside", async () => {
    const w = await whole({ ollamaKeepsLoading: true });
    await w.chatSends("c1");
    await w.personStopsChat("c1");
    expect(w.card().loading).toEqual(["m1:7b"]);
    await w.chatSends("c2", { model: "small:1b" });
    // asked to leave, and waited for as long as any model that will not go
    expect(w.askedToLeave()).toEqual(["m1:7b"]);
    expect(w.chat("c2").state).toBe("waiting");
    expect(w.rec.overlaps).toEqual([]);
    await w.pass(21_000);
    expect(w.chat("c2").state).toBe("loading");
    expect(w.rec.overlaps).toEqual([["m1:7b", "small:1b"]]);
  });

  const PARTIES = ["c1", "c2", "p"] as const;
  type Party = (typeof PARTIES)[number];
  const MODEL: Record<"c1" | "c2", Model> = { c1: "m1:7b", c2: "small:1b" };
  const orders: Party[][] = [["c1", "c2", "p"], ["c1", "p", "c2"], ["c2", "c1", "p"], ["c2", "p", "c1"], ["p", "c1", "c2"], ["p", "c2", "c1"]];
  const stopSets: Party[][] = [[], ["c1"], ["c2"], ["p"], ["c1", "c2"], ["c1", "p"], ["c2", "p"], ["c1", "c2", "p"]];
  /** Two chats and a picture arrive in `order`; each is driven to its end, the ones in `stops` by the person's Stop. */
  async function everyoneRuns(w: World, order: readonly Party[], stops: readonly Party[]) {
    const one = () => expect(w.card().loading.length, `loading at once: ${w.card().loading.join(", ")}`).toBeLessThanOrEqual(1);
    for (const who of order) {
      if (who === "p") await w.pictureSends();
      else await w.chatSends(who, { model: MODEL[who] });
      one();
    }
    const stopped = new Set<Party>();
    const chatOver = (id: "c1" | "c2") => ["ended", "stopped", "refused", "failed"].includes(w.chat(id).state);
    const pictureOver = () => ["done", "error", "cancelled"].includes(w.picture()?.state ?? "");
    const stop = async (who: Party) => {
      stopped.add(who);
      if (who === "p") await w.personStopsPicture();
      else await w.personStopsChat(who);
    };
    for (let step = 0; step < 40 && !(chatOver("c1") && chatOver("c2") && pictureOver()); step++) {
      const [loading] = w.card().loading;
      const chat = (["c1", "c2"] as const).find((id) => !chatOver(id) && (loading === undefined ? w.chat(id).state === "replying" : MODEL[id] === loading));
      const who: Party | undefined = loading === "ComfyUI" ? "p" : chat ?? (loading === undefined && w.picture()?.state === "running" && w.lease.status().holder === "image" ? "p" : undefined);
      if (who !== undefined && stops.includes(who) && !stopped.has(who)) await stop(who);
      else if (loading === "ComfyUI" || who === "p") await w.pictureFinishes();
      else if (loading !== undefined) await w.ollamaFinishesLoading(loading as Model);
      else if (chat !== undefined) await w.chatEnds(chat);
      else await w.pass();
      one();
    }
    expect(w.rec.overlaps).toEqual([]);
    expect({ c1: w.chat("c1").state, c2: w.chat("c2").state, p: w.picture()?.state }).toEqual({
      c1: stops.includes("c1") ? "stopped" : "ended",
      c2: stops.includes("c2") ? "stopped" : "ended",
      p: stops.includes("p") ? "cancelled" : "done",
    });
    expect(w.lease.status()).toMatchObject({ holders: 0, waiting: [] });
  }
  rule("two chats and a picture in every order, each stopped or not: one load at a time, and everyone ends", ["picture-without-lease", "gate-let-go-at-send"], async (open) => {
    for (const order of orders) {
      for (const stops of stopSets) {
        const w = await open({ comfy: "stopped" });
        try {
          await everyoneRuns(w, order, stops);
        } catch (e) {
          if (e instanceof Error) e.message = `order ${order.join(", ")}; stopped: ${stops.join(", ") || "nobody"}\n${e.message}`;
          throw e;
        }
      }
    }
  });
});

describe("a running reply's model is never asked to leave", () => {
  rule("a chat for another model asks first, then waits its turn in Ollama; the reply's model is not asked", ["ask-replying-models"], async (open) => {
    const w = await open();
    await replying(w, "c1", "m1:7b");
    // the first try: refused with the reply it would stop, and nothing was asked of anyone
    await w.chatSends("c2", { model: "m2:7b", askFirst: true });
    expect(w.chat("c2")).toMatchObject({ state: "refused", wouldStop: ["m1:7b"] });
    expect(w.askedToLeave()).toEqual([]);
    // sent again without stopping the reply: Ollama starts the load when the reply ends
    await w.chatSends("c3", { model: "m2:7b" });
    expect(w.askedToLeave()).toEqual([]);
    expect(w.chat("c1").state).toBe("replying");
    expect(w.card().names).toEqual(["whisper", "m1:7b"]);
    await w.chatEnds("c1");
    expect(w.card().loading).toEqual(["m2:7b"]);
    expect(w.askedToLeave()).toEqual([]);
  });

  it("an idle model is asked to leave for a picture; the replying one's chat keeps the card first", async () => {
    const w = await whole({ comfy: "stopped" });
    await replying(w, "c1", "m1:7b");
    await w.pictureSends();
    expect(w.picture()?.state).toBe("queued");
    expect(w.askedToLeave()).toEqual([]);
    await w.chatEnds("c1");
    expect(w.askedToLeave()).toEqual(["m1:7b"]);
    expect(w.card().loading).toEqual(["ComfyUI"]);
  });
});

describe("whisper is never asked to leave, stopped or changed", () => {
  rule("everything else on the card is asked to leave for a chat; nothing names whisper", ["ask-everything-on-the-card"], async (open) => {
    const w = await open({ comfy: "holding", loadedByOthers: ["small:1b"], otherProgramMib: 1_000 });
    await w.chatSends("c1");
    expect(w.askedToLeave()).toEqual(["small:1b"]);
    expect(w.rec.freed).toHaveLength(1);
    expect(w.rec.whisper).toEqual([]);
    expect(w.rec.stops).toEqual([]);
    expect(w.card().holders[0]).toEqual({ name: "whisper", mib: WHISPER_MIB, state: "in" });
    expect(w.chat("c1").state).toBe("loading");
  });

  it("a refusal never tells the person to close whisper", async () => {
    // only whisper is on the card, and the picture needs more than the rest of it
    const w = await whole({ comfy: "idle", pictureNeedMib: 15_000 });
    await w.pictureSends();
    expect(w.picture()?.state).toBe("error");
    expect(w.picture()?.message).not.toMatch(/whisper/i);
    // a chat model that can never fit
    await w.chatSends("c1", { model: "big:30b" });
    expect(w.chat("c1").state).toBe("refused");
    expect(w.chat("c1").refusal).not.toMatch(/whisper/i);
  });
});

describe("an Ollama or a picture engine the app did not start is never stopped", () => {
  rule("switching to the app's own Ollama and back stops the app's own, never the one the person runs", ["stop-any-runtime"], async (open) => {
    const w = await open();
    await w.switchBegins("app");
    await w.switchGoesAhead();
    expect(w.runtime.mode()).toBe("app");
    expect(w.rec.starts).toEqual(["ollama app"]);
    expect(w.rec.stops).toEqual([]);
    await w.switchBegins("system");
    await w.switchGoesAhead();
    expect(w.runtime.mode()).toBe("system");
    expect(w.rec.stops).toEqual(["ollama app"]);
  });

  rule("the app's own Ollama left running by an earlier run is not stopped either", ["stop-any-runtime"], async (open) => {
    const w = await open({ appOllamaRuns: [] });
    await w.switchBegins("app");
    await w.switchGoesAhead();
    await w.switchBegins("system");
    await w.switchGoesAhead();
    expect(w.rec.starts).toEqual([]);
    expect(w.rec.stops).toEqual([]);
  });

  rule("a ComfyUI somebody else started is not stopped when the app gives up on a stuck picture", ["stop-an-engine-the-app-did-not-start"], async (open) => {
    const w = await open({ comfy: "idle", comfySticks: true });
    await w.pictureSends();
    await w.personStopsPicture();
    await w.pictureStopTimesOut();
    await w.stuckHoldRunsOut();
    expect(w.rec.starts).toEqual([]);
    expect(w.rec.stops).toEqual([]);
    expect(w.comfyUp()).toBe(true);
    expect(w.lease.status()).toMatchObject({ holders: 0 });
  });

  it("the ComfyUI the app started is stopped when the app gives up on a stuck picture", async () => {
    const w = await whole({ comfy: "stopped", comfySticks: true });
    await w.pictureSends();
    await w.personStopsPicture();
    await w.pictureStopTimesOut();
    expect(w.rec.stops).toEqual([]);
    await w.stuckHoldRunsOut();
    expect(w.rec.stops).toEqual(["comfyui"]);
    expect(w.card().names).toEqual(["whisper"]);
    expect(w.lease.status()).toMatchObject({ holders: 0 });
  });
});

describe("a switch of runtime never leaves a stale record", () => {
  rule("a refused switch forgets nothing the app loaded", ["forget-on-refused-switch"], async (open) => {
    const w = await open();
    // a turn that does not end when its runtime tells it to
    await w.chatSends("c1", { endsWhenTold: false });
    await w.ollamaFinishesLoading("m1:7b");
    expect(w.record.oursAt("m1:7b")).toBe(NUM_CTX);
    await w.switchBegins("app");
    const why = await w.switchIsRefused();
    expect(why.message).toMatch(/still running/);
    expect(w.runtime.mode()).toBe("system");
    expect(w.rec.stops).toEqual([]);
    expect(w.record.oursAt("m1:7b")).toBe(NUM_CTX);
    expect(w.record.listed()).toEqual(["m1:7b"]);
    // the app's own model at another context is the app's to reload, not "loaded by another program"
    await w.chatEnds("c1");
    await w.preloads("m1:7b", 8_192);
    expect(w.card().loading).toEqual(["m1:7b"]);
    await w.ollamaFinishesLoading("m1:7b");
    const [load] = await w.preloaded();
    expect(load).toMatchObject({ model: "m1:7b", numCtx: 8_192, state: "ready" });
    expect((load as { message?: string }).message).toBeUndefined();
  });

  rule("a first token that arrives after the switch began records nothing", ["record-without-generation-check"], async (open) => {
    const w = await open();
    await w.chatSends("c1", { endsWhenTold: false });
    expect(w.chat("c1").state).toBe("loading");
    await w.switchBegins("app");
    // the old runtime answers late, and the turn ends after it
    await w.ollamaFinishesLoading("m1:7b");
    await w.chatEnds("c1");
    await w.switchGoesAhead();
    expect(w.runtime.mode()).toBe("app");
    expect(w.record.ours()).toEqual([]);
    expect(w.record.oursAt("m1:7b")).toBeUndefined();
    expect(w.record.listed()).toEqual([]);
  });

  it("a model that leaves the old runtime after the switch takes nothing out of the new runtime's record", async () => {
    // the old runtime goes on listing its idle model after it was asked to unload it; the app's
    // own Ollama, left by an earlier run, holds the same model
    const w = await whole({ comfy: "stopped", loadedByOthers: ["m1:7b"], slowToLeave: ["m1:7b"], appOllamaRuns: ["small:1b"] });
    await w.pictureSends();
    expect(w.askedToLeave()).toEqual(["m1:7b"]);
    await w.switchBegins("app");
    await w.switchGoesAhead();
    await w.statusPolls();
    expect(w.record.listed()).toEqual(["small:1b"]);
    // the old runtime lets its model go now: that says nothing about the new one
    await w.slowModelLeaves("m1:7b", "system");
    expect(w.record.listed()).toEqual(["small:1b"]);
  });

  it("a model with the same name in both runtimes stays listed when the old runtime's copy leaves late", async () => {
    const w = await whole({ comfy: "stopped", loadedByOthers: ["m1:7b"], slowToLeave: ["m1:7b"], appOllamaRuns: ["m1:7b"] });
    await w.pictureSends();
    expect(w.askedToLeave()).toEqual(["m1:7b"]);
    await w.switchBegins("app");
    await w.switchGoesAhead();
    await w.statusPolls();
    expect(w.record.listed()).toEqual(["m1:7b"]);
    await w.slowModelLeaves("m1:7b", "system");
    expect(w.record.listed()).toEqual(["m1:7b"]);
  });
});

describe("an exclusive claim does not wait for ever", () => {
  rule("a picture waiting behind a reply runs when it ends, whatever chats arrived after the picture", ["shared-claims-jump-the-queue"], async (open) => {
    const w = await open({ comfy: "stopped" });
    await replying(w, "c0");
    await w.pictureSends();
    expect(w.picture()?.state).toBe("queued");
    const later = Array.from({ length: 10 }, (_, i) => `c${i + 1}`);
    for (const id of later) await w.chatSends(id);
    await w.chatEnds("c0");
    expect(w.picture()?.state).toBe("running");
    expect(w.card().loading).toEqual(["ComfyUI"]);
    expect(later.map((id) => w.chat(id).state)).toEqual(later.map(() => "waiting"));
    // and the chats behind it run when the picture is done
    await w.pictureFinishes();
    expect(w.picture()?.state).toBe("done");
    expect(w.card().loading).toEqual(["m1:7b"]);
    await w.ollamaFinishesLoading("m1:7b");
    expect(later.map((id) => w.chat(id).state)).toEqual(later.map(() => "replying"));
  });

  rule("a preload never holds the load gate while it waits for the card", ["gate-before-lease"], async (open) => {
    const w = await open({ comfy: "idle" });
    // the picture has the card and has not reached the gate yet
    w.comfyHoldsItsAnswer();
    await w.pictureSends();
    expect(w.lease.status()).toMatchObject({ holder: "image" });
    await w.preloads("m1:7b");
    await w.comfyAnswers();
    // the picture gets the gate: a preload holding it while waiting for the card would stop both for good
    expect(w.card().loading).toEqual(["ComfyUI"]);
    await w.pictureFinishes();
    expect(w.picture()?.state).toBe("done");
    expect(w.card().loading).toEqual(["m1:7b"]);
    await w.ollamaFinishesLoading("m1:7b");
    expect(await w.preloaded()).toMatchObject([{ model: "m1:7b", state: "ready" }]);
  });
});

describe("a load is refused, or let in, from a measurement taken after everything left", () => {
  rule("a full card with an idle model: the model leaves, and the load fits from the reading after it", ["fit-from-the-first-reading"], async (open) => {
    const w = await open({ loadedByOthers: ["m2:7b"] });
    await w.chatSends("c1", { model: "m1:7b" });
    expect(w.askedToLeave()).toEqual(["m2:7b"]);
    expect(w.chat("c1").state).toBe("loading");
    expect(w.card().names).toEqual(["whisper", "m1:7b"]);
    // the reading the fit decided from was taken after the model was asked to leave
    expect(w.chat("c1").report?.measuredAt).toBeGreaterThan(w.rec.asked[0]!.at);
  });

  rule("room at arrival that another program takes during the handoff: refused from the later reading", ["fit-from-the-first-reading"], async (open) => {
    const w = await open({ loadedByOthers: ["m2:7b"] });
    w.whenNextAskedToLeave(() => w.otherProgramTakes(7_000));
    await w.chatSends("c1", { model: "m1:7b" });
    expect(w.askedToLeave()).toEqual(["m2:7b"]);
    expect(w.chat("c1").state).toBe("refused");
    expect(w.chat("c1").report?.measuredAt).toBeGreaterThan(w.rec.asked[0]!.at);
    expect(w.card().names).toEqual(["whisper", "another program"]);
    expect(w.rec.overfull).toEqual([]);
  });
});

describe("a refusal says what would have to leave", () => {
  rule("a chat refused while ComfyUI runs somebody else's job says ComfyUI was not asked", ["refusal-names-nothing"], async (open) => {
    const w = await open({ comfy: "busy" });
    await w.chatSends("c1", { model: "m1:7b" });
    expect(w.chat("c1").state).toBe("refused");
    expect(w.rec.freed).toEqual([]);
    expect(w.chat("c1").refusal).toContain(ENGINE_BUSY_NOTE);
  });

  it("a preload refused while ComfyUI runs somebody else's job says the same", async () => {
    const w = await whole({ comfy: "busy" });
    await w.preloads("m1:7b");
    const [load] = await w.preloaded();
    expect(load).toMatchObject({ state: "error" });
    expect((load as { message?: string }).message).toContain(ENGINE_BUSY_NOTE);
  });

  it("a chat that needs a reply's memory is told which reply", async () => {
    const w = await whole();
    await replying(w, "c1", "m1:7b");
    await w.chatSends("c2", { model: "m2:7b", askFirst: true });
    expect(w.chat("c2").wouldStop).toEqual(["m1:7b"]);
  });

  it("a picture refused beside a model that would not leave names that model", async () => {
    const w = await whole({ comfy: "idle", loadedByOthers: ["m2:7b"], slowToLeave: ["m2:7b"] });
    await w.pictureSends();
    await w.pass(21_000);
    expect(w.askedToLeave()).toEqual(["m2:7b"]);
    expect(w.picture()?.state).toBe("error");
    expect(w.picture()?.message).toBe("The image needs 8.0 GiB and 7.0 GiB is free; this app's chat model m2:7b still holds 7.1 GiB, try again in a moment.");
  });

  it("a picture refused beside another program names it, and nothing that is not on the card", async () => {
    const w = await whole({ comfy: "idle", otherProgramMib: 9_000 });
    await w.pictureSends();
    expect(w.picture()?.state).toBe("error");
    expect(w.picture()?.message).toBe("The image needs 8.0 GiB and 5.3 GiB is free; render-farm holds 8.8 GiB, close it.");
    expect(w.askedToLeave()).toEqual([]);
    expect(w.rec.stops).toEqual([]);
  });
});

// Every arrival against every card. Whisper is on each card, and afterEach holds each world to
// the rules above. A chat here is the client's first try (it asks before it stops a reply).
type Arrival = "a chat for a model not loaded" | "a chat for the model already loaded" | "a picture" | "a picture for the setup ComfyUI holds";
const ARRIVALS: readonly Arrival[] = ["a chat for a model not loaded", "a chat for the model already loaded", "a picture", "a picture for the setup ComfyUI holds"];
/** What the one arriving got, and what was asked of the card for it. */
interface Got {
  /** Chat models asked to unload. */
  readonly asked: readonly string[];
  /** ComfyUI was asked to free its memory. */
  readonly freed: boolean;
  /**
   * "loads": its model or setup is loading now. "replies" / "runs": it went ahead with what was in
   * memory. "waits": behind the card's holder. "refused": with `says`.
   */
  readonly outcome: "loads" | "replies" | "runs" | "waits" | "refused";
  readonly says?: string | readonly string[];
}
/** The card of one row, ready for `arrival`; resolves with the world and the chat model that arrival asks for. */
type Card = (open: Open, arrival: Arrival) => Promise<{ w: World; model: Model }>;
const wantsLoaded = (arrival: Arrival) => arrival === "a chat for the model already loaded";
const CARDS: Record<string, Card> = {
  // the model already loaded: loaded by the app earlier, the only other thing on the card
  "nothing": async (open, arrival) => {
    const w = await open({ comfy: "stopped" });
    if (wantsLoaded(arrival)) await appLoaded(w, "small:1b");
    return { w, model: wantsLoaded(arrival) ? "small:1b" : "m1:7b" };
  },
  "an idle model": async (open, arrival) => ({ w: await open({ comfy: "stopped", loadedByOthers: ["m2:7b"] }), model: wantsLoaded(arrival) ? "m2:7b" : "m1:7b" }),
  "a replying model": async (open, arrival) => {
    const w = await open({ comfy: "stopped" });
    await replying(w, "c0", "m2:7b");
    return { w, model: wantsLoaded(arrival) ? "m2:7b" : "m1:7b" };
  },
  // the model already loaded: by another program, beside a ComfyUI somebody else started (the app never has both in memory)
  "ComfyUI idle, holding its models": async (open, arrival) => {
    if (wantsLoaded(arrival)) return { w: await open({ comfy: "holding", loadedByOthers: ["small:1b"] }), model: "small:1b" };
    const w = await open({ comfy: "stopped" });
    await w.pictureSends({ setup: "one" });
    await w.pictureFinishes();
    return { w, model: "m1:7b" };
  },
  "ComfyUI busy with somebody else's job": async (open, arrival) => {
    if (wantsLoaded(arrival)) return { w: await open({ comfy: "busy", loadedByOthers: ["small:1b"] }), model: "small:1b" };
    const w = await open({ comfy: "stopped" });
    await w.pictureSends({ setup: "one" });
    await w.pictureFinishes();
    await w.othersJobStarts();
    return { w, model: "m1:7b" };
  },
  // the model already loaded: the stuck picture asked it to leave when it started, as any picture does
  "ComfyUI with a stopped picture it has not let go of": async (open, arrival) => {
    const w = await open({ comfy: "stopped", comfySticks: true, ...wantsLoaded(arrival) ? { loadedByOthers: ["small:1b"] as const } : {} });
    await w.pictureSends({ setup: "one" });
    await w.personStopsPicture();
    await w.pictureStopTimesOut();
    return { w, model: wantsLoaded(arrival) ? "small:1b" : "m1:7b" };
  },
  "another program": async (open, arrival) => {
    const w = await open({ comfy: "stopped", otherProgramMib: 9_000 });
    if (wantsLoaded(arrival)) await appLoaded(w, "small:1b");
    return { w, model: wantsLoaded(arrival) ? "small:1b" : "m1:7b" };
  },
};

async function arrives(open: Open, card: Card, arrival: Arrival): Promise<Got> {
  const { w, model } = await card(open, arrival);
  const before = { asked: w.rec.asked.length, freed: w.rec.freed.length, stops: w.rec.stops.length };
  let got: Pick<Got, "outcome" | "says">;
  if (arrival.startsWith("a chat")) {
    await w.chatSends("arrival", { model, askFirst: true });
    const view = w.chat("arrival");
    if (view.state === "refused") got = { outcome: "refused", says: view.wouldStop ?? view.refusal ?? "" };
    else if (view.state === "replying") got = { outcome: "replies" };
    else if (view.state === "loading" && w.card().loading.includes(model)) got = { outcome: "loads" };
    else if (view.state === "waiting") got = { outcome: "waits" };
    else throw new Error(`the chat is ${view.state}${view.error === undefined ? "" : `: ${view.error}`}`);
  } else {
    await w.pictureSends({ setup: arrival === "a picture" ? "other" : "one" });
    const event = w.picture();
    if (event?.state === "error") got = { outcome: "refused", says: event.message ?? "" };
    else if (event?.state === "queued") got = { outcome: "waits" };
    else if (event?.state === "running") got = { outcome: w.card().loading.includes("ComfyUI") ? "loads" : "runs" };
    else throw new Error(`the picture is ${event?.state}`);
  }
  // nothing the app did not start was stopped for it
  expect(w.rec.stops.slice(before.stops)).toEqual([]);
  expect(JSON.stringify(got.says ?? "")).not.toMatch(/whisper/i);
  return { asked: w.rec.asked.slice(before.asked).map((a) => a.model), freed: w.rec.freed.length > before.freed, ...got };
}

type Expected = Omit<Got, "says"> & { readonly says?: string | readonly string[] | RegExp };
const nothingAsked = { asked: [], freed: false } as const;
/** A chat model that does not fit: the fit's own numbers, and no name of anything to stop. */
const CHAT_DOES_NOT_FIT = /^m1:7b at num_ctx 16384 needs 7\.58 GB \(estimate\); VRAM usable [\d.]+ GB \([\d.]+ GB free minus 0\.54 GB margin\); RAM usable for spill [\d.]+ GB \([\d.]+ GB available minus [\d.]+ GB margin\): refused, short by [\d,]+ bytes \([\d.]+ GB\)\.$/;
const TABLE: Record<keyof typeof CARDS, Record<Arrival, Expected>> = {
  "nothing": {
    "a chat for a model not loaded": { ...nothingAsked, outcome: "loads" },
    "a chat for the model already loaded": { ...nothingAsked, outcome: "replies" },
    "a picture": { ...nothingAsked, outcome: "loads" },
    // ComfyUI holds no setup on this card: the same as a picture
    "a picture for the setup ComfyUI holds": { ...nothingAsked, outcome: "loads" },
  },
  "an idle model": {
    "a chat for a model not loaded": { asked: ["m2:7b"], freed: false, outcome: "loads" },
    "a chat for the model already loaded": { ...nothingAsked, outcome: "replies" },
    "a picture": { asked: ["m2:7b"], freed: false, outcome: "loads" },
    "a picture for the setup ComfyUI holds": { asked: ["m2:7b"], freed: false, outcome: "loads" },
  },
  "a replying model": {
    // refused with the reply it would stop, before anything is asked of the card
    "a chat for a model not loaded": { ...nothingAsked, outcome: "refused", says: ["m2:7b"] },
    "a chat for the model already loaded": { ...nothingAsked, outcome: "replies" },
    "a picture": { ...nothingAsked, outcome: "waits" },
    "a picture for the setup ComfyUI holds": { ...nothingAsked, outcome: "waits" },
  },
  "ComfyUI idle, holding its models": {
    "a chat for a model not loaded": { asked: [], freed: true, outcome: "loads" },
    // asked to free its memory even so: one thing in memory, whatever the chat needs
    "a chat for the model already loaded": { asked: [], freed: true, outcome: "replies" },
    "a picture": { asked: [], freed: true, outcome: "loads" },
    "a picture for the setup ComfyUI holds": { ...nothingAsked, outcome: "runs" },
  },
  "ComfyUI busy with somebody else's job": {
    "a chat for a model not loaded": { ...nothingAsked, outcome: "refused", says: new RegExp(`${CHAT_DOES_NOT_FIT.source.slice(0, -1)} ${ENGINE_BUSY_NOTE.replaceAll(".", "\\.")}$`) },
    "a chat for the model already loaded": { ...nothingAsked, outcome: "replies" },
    // the way out it names is the setup ComfyUI holds, which is smaller in the picker's list than this world's 8 GiB
    "a picture": { ...nothingAsked, outcome: "refused", says: `The image needs 8.0 GiB and 6.0 GiB is free; Z-Image Turbo int8 1024×1024 would fit. ${ENGINE_BUSY_NOTE}` },
    "a picture for the setup ComfyUI holds": { ...nothingAsked, outcome: "refused", says: "ComfyUI is busy; wait for its other job to finish and try again." },
  },
  // the picture keeps the card until ComfyUI lets go of it: everyone waits, and nothing is asked meanwhile
  "ComfyUI with a stopped picture it has not let go of": {
    "a chat for a model not loaded": { ...nothingAsked, outcome: "waits" },
    "a chat for the model already loaded": { ...nothingAsked, outcome: "waits" },
    "a picture": { ...nothingAsked, outcome: "waits" },
    "a picture for the setup ComfyUI holds": { ...nothingAsked, outcome: "waits" },
  },
  // never asked to leave, and never stopped; a picture's refusal names it for the person to close
  "another program": {
    "a chat for a model not loaded": { ...nothingAsked, outcome: "refused", says: CHAT_DOES_NOT_FIT },
    "a chat for the model already loaded": { ...nothingAsked, outcome: "replies" },
    "a picture": { ...nothingAsked, outcome: "refused", says: "The image needs 8.0 GiB and 5.3 GiB is free; render-farm holds 8.8 GiB, close it." },
    "a picture for the setup ComfyUI holds": { ...nothingAsked, outcome: "refused", says: "The image needs 8.0 GiB and 5.3 GiB is free; render-farm holds 8.8 GiB, close it." },
  },
};

describe("every arrival against every card: who is asked to leave, and what the one arriving gets", () => {
  it("the table has a case for every card", () => {
    expect(Object.keys(TABLE)).toEqual(Object.keys(CARDS));
    for (const row of Object.values(TABLE)) expect(Object.keys(row)).toEqual(ARRIVALS);
  });
  for (const [name, row] of Object.entries(TABLE)) {
    for (const arrival of ARRIVALS) {
      const { says, ...expected } = row[arrival];
      it(`${name}; ${arrival} arrives: ${expected.outcome}${expected.asked.length > 0 ? `, ${expected.asked.join(", ")} asked to leave` : ""}${expected.freed ? ", ComfyUI asked to free its memory" : ""}`, async () => {
        const { says: said, ...got } = await arrives(opener(FROM_ENV), CARDS[name]!, arrival);
        expect(got).toEqual(expected);
        if (says instanceof RegExp) expect(said).toMatch(says);
        else expect(said).toEqual(says);
      });
    }
  }
});
