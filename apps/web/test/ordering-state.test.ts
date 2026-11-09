// Guard-specific replays: real sessions, stepped time, and captured wire replies.
import { expect, it, vi } from "vitest";
import type { Channel, FitReport, MethodName, Payload, ResultOf } from "@gates-local/contracts";
import { methodSamples } from "@gates-local/contracts/testing";
import { type Held, type FakeSocket } from "./harness.ts";
import { drain, OrderingWorld } from "./ordering-world.ts";
import { replay, type ReplayEvent, type ReplayFrame, type ReplayScenario } from "./ordering-replay.ts";

vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => [initial, () => {}],
  useRef: (initial: unknown) => ({ current: initial }),
  useEffect: () => {},
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}));

const MODEL = "gemma3:4b", OLD_MODEL = "qwen3:14b", CTX = 16384;
const FIT_CTX = 32768, KEY = `${MODEL}@${FIT_CTX}`;
const initialModels = methodSamples["models.list"].result;
const remainingModels = initialModels.filter((model) => model.name !== OLD_MODEL);
const report = (verdict: FitReport["verdict"], measuredAt: number): FitReport => ({ ...methodSamples["fit.check"].result, model: MODEL, numCtx: FIT_CTX, verdict, measuredAt });
const noop = () => {};
const frame = (socket: string, name: string): ReplayFrame => ({ socket, event: name });
const before = (order: readonly string[], a: string, b: string) => order.indexOf(a) < order.indexOf(b);

class World {
  readonly replies = new Map<string, () => void>();
  models = initialModels;
  terminalTarget: FakeSocket | undefined;
  readonly wire: OrderingWorld;
  constructor(wire: OrderingWorld) { this.wire = wire; }
  static async create(): Promise<World> { return new World(await OrderingWorld.create()); }
  async capture<M extends MethodName>(name: string, method: M, invoke: () => void, result: ResultOf<M>): Promise<void> {
    let request: Held<M> | undefined;
    void this.wire.server.hold(method).then((held) => { request = held; });
    invoke(); await drain();
    if (!request) throw new Error(`No ${method} request for ${name} after the microtask drain`);
    const captured = request;
    this.replies.set(name, () => captured.respond(result));
  }
  async respond(name: string): Promise<void> {
    const reply = this.replies.get(name);
    if (!reply) throw new Error(`No captured reply: ${name}`);
    this.replies.delete(name); reply(); await drain();
  }
  async push<C extends Channel>(socket: FakeSocket, channel: C, payload: Payload<C>): Promise<void> {
    socket.frame({ type: "push", channel, payload }); await drain();
  }
}

type Event = ReplayEvent<World>;
const event = (name: string, after: readonly string[], run: Event["run"], extra: Pick<Event, "delivery" | "emit" | "discard"> = {}): Event => ({ name, after, run, ...extra });
const dispose = (w: World) => w.wire.dispose();
const run = async (scenario: ReplayScenario<World>): Promise<void> => { await replay(scenario, { limit: 64, order: process.env["REPLAY_ORDER"] }); };

function fitEpoch(): ReplayScenario<World> {
  return {
    name: "fitEpoch: delayed verdict and blocker preflight cross a memory change", create: async () => {
      const w = await World.create();
      await w.wire.step(() => w.wire.a.store.setState({ numCtx: FIT_CTX }));
      return w;
    }, dispose,
    witnesses: [["fit.request", "gpu.change", "gpu.push-B", "gpu.push-A", "fit.old.ready", "fit.old.response", "fit.new.ready", "fit.new.response", "blockers.old.ready", "blockers.old.response"]],
    events: [
      event("fit.request", [], (w) => w.capture("fit.old", "fit.check", () => w.wire.a.session.ensureFit(MODEL, FIT_CTX), report("refuse", 1))),
      // Input story: an already-requested fit crosses a later GPU reading.
      event("gpu.change", ["fit.request"], noop, { emit: () => [frame("A", "gpu.push-A"), frame("B", "gpu.push-B")] }),
      // gpu.changed calls invalidateFits, advancing fitEpoch and requesting a replacement.
      event("gpu.push-A", ["gpu.change"], (w) => w.capture("fit.new", "fit.check", () => {
        w.wire.a.socket.frame({ type: "push", channel: "gpu.changed", payload: { ...methodSamples["gpu.status"].result, measuredAt: 2 } });
      }, report("fits", 2)), { delivery: true }),
      event("gpu.push-B", ["gpu.change"], (w) => w.push(w.wire.b.socket, "gpu.changed", { ...methodSamples["gpu.status"].result, measuredAt: 2 }), { delivery: true }),
      // app.ts fit.check awaits memory planning; its result may complete on either side of the push.
      event("fit.old.ready", ["fit.request"], noop, { emit: () => [frame("A", "fit.old.response")] }),
      // checkFit awaits turns.blocking for a refusal before applying the epoch guard.
      event("fit.old.response", ["fit.old.ready"], (w) => w.capture("blockers.old", "turns.blocking", () => {
        const reply = w.replies.get("fit.old"); if (!reply) throw new Error("Missing old fit"); w.replies.delete("fit.old"); reply();
      }, [{ threadId: "busy", title: "Another reply", model: OLD_MODEL, turnId: "busy-turn" }]), { delivery: true }),
      event("fit.new.ready", ["gpu.push-A"], noop, { emit: () => [frame("A", "fit.new.response")] }),
      event("fit.new.response", ["fit.new.ready"], (w) => w.respond("fit.new"), { delivery: true }),
      event("blockers.old.ready", ["fit.old.response"], noop, { emit: () => [frame("A", "blockers.old.response")] }),
      event("blockers.old.response", ["blockers.old.ready"], (w) => w.respond("blockers.old"), { delivery: true }),
    ],
    check(w, order) {
      const state = w.wire.a.store.getState();
      if (order.includes("fit.new.response")) {
        expect(state.fits[KEY], "an old fit/preflight cannot replace the new memory verdict").toMatchObject({ verdict: "fits", measuredAt: 2 });
        expect(state.stopFrees[KEY], "stale preflight cannot tell Send to stop another reply").toBeUndefined();
      }
    },
  };
}

function preloadChoice(): ReplayScenario<World> {
  return {
    name: "preload: older blocker preflight cannot load a superseded model", create: World.create, dispose,
    witnesses: [["pick.old", "pick.new", "preflight.new.ready", "preflight.new.response", "preflight.old.ready", "preflight.old.response"]],
    events: [
      event("pick.old", [], (w) => w.capture("preflight.old", "turns.blocking", () => w.wire.a.session.pickModel(OLD_MODEL), [])),
      // Chosen input sequence; neither pick waits for its asynchronous preflight.
      event("pick.new", ["pick.old"], (w) => w.capture("preflight.new", "turns.blocking", () => w.wire.a.session.pickModel(MODEL), [])),
      // preload awaits blockingFor, then checks the current model before models.load.
      event("preflight.old.ready", ["pick.old"], noop, { emit: () => [frame("A", "preflight.old.response")] }),
      event("preflight.old.response", ["preflight.old.ready"], (w) => w.respond("preflight.old"), { delivery: true }),
      event("preflight.new.ready", ["pick.new"], noop, { emit: () => [frame("A", "preflight.new.response")] }),
      event("preflight.new.response", ["preflight.new.ready"], (w) => w.respond("preflight.new"), { delivery: true }),
    ],
    check(w, order) {
      const expected = order.filter((name) => name === "preflight.new.response" || (name === "preflight.old.response" && (!order.includes("pick.new") || before(order, name, "pick.new")))).map((name) => name === "preflight.old.response" ? OLD_MODEL : MODEL);
      expect(w.wire.server.calls("models.load").map((call) => call.params), "only a still-current pick may start loading").toEqual(expected.map((model) => ({ model, numCtx: CTX })));
    },
  };
}

function modelRefresh(): ReplayScenario<World> {
  return {
    name: "modelsOrder: an old refresh cannot restore a removed model", dispose,
    create: async () => { const w = await World.create(); w.wire.server.answer("models.refresh", () => w.models); return w; },
    witnesses: [["refresh.request", "remove.request", "remove.complete", "models.push-A", "models.push-B", "remove.response.ready", "remove.response", "refresh.old.ready", "refresh.old.response"]],
    events: [
      event("refresh.request", [], (w) => w.capture("refresh.old", "models.refresh", () => { void w.wire.a.session.refreshModels(); }, initialModels)),
      // Input story: B removes a model after A has requested its old list.
      event("remove.request", ["refresh.request"], (w) => w.capture("remove", "models.remove", () => { void w.wire.b.session.removeModel(OLD_MODEL); }, { name: OLD_MODEL })),
      // runtime/handlers.ts awaits deletion and catalog.refresh, whose onChange broadcasts.
      event("remove.complete", ["remove.request"], (w) => { w.models = remainingModels; }, { emit: () => [frame("A", "models.push-A"), frame("B", "models.push-B")] }),
      event("models.push-A", ["remove.complete"], (w) => w.push(w.wire.a.socket, "models.changed", w.models), { delivery: true }),
      event("models.push-B", ["remove.complete"], (w) => w.push(w.wire.b.socket, "models.changed", w.models), { delivery: true }),
      // Server response emission follows async completion, not the other window's receipt.
      event("remove.response.ready", ["remove.complete"], noop, { emit: () => [frame("B", "remove.response")] }),
      event("remove.response", ["remove.response.ready"], (w) => w.respond("remove"), { delivery: true }),
      event("refresh.old.ready", ["refresh.request"], noop, { emit: () => [frame("A", "refresh.old.response")] }),
      event("refresh.old.response", ["refresh.old.ready"], (w) => w.respond("refresh.old"), { delivery: true }),
    ],
    check(w, order) {
      if (order.includes("models.push-A")) expect(w.wire.a.store.getState().models?.map((model) => model.name), "a newer installed list must stay authoritative").toEqual(remainingModels.map((model) => model.name));
    },
  };
}

function offscreenReconnect(): ReplayScenario<World> {
  return {
    name: "lostTurn: off-screen completion crosses reconnect hydration", dispose,
    create: async () => {
      const w = await World.create(); w.wire.server.holdChat = true;
      w.wire.b.store.setState({ view: "thread", threadId: "t1", draft: "background reply", messages: { t1: [] } });
      void w.wire.b.session.send("background reply"); await drain();
      w.wire.server.admittedPush("turn-1", "A"); w.wire.server.admittedPush("turn-1", "B");
      w.wire.server.response("turn-1"); await drain();
      expect(w.wire.a.store.getState().live).toBeNull();
      expect(w.wire.a.store.getState().runningTurns).toEqual({ t1: "turn-1" });
      return w;
    },
    witnesses: [
      ["socket.drop", "socket.reconnect", "hydration.snapshot", "server.done", "done.push-A", "done.push-B", "hydration.ready", "hydration.release"],
      ["server.done", "done.push-A", "done.push-B", "socket.drop", "socket.reconnect", "hydration.snapshot", "hydration.ready", "hydration.release"],
      ["socket.drop", "socket.reconnect", "hydration.snapshot", "hydration.ready", "hydration.release", "server.done", "done.push-A", "done.push-B"],
    ],
    events: [
      event("socket.drop", [], (w) => w.wire.drop(), { discard: ["A1"] }),
      // session.loop reconnects after close/backoff; settings.get is captured then.
      event("socket.reconnect", ["socket.drop"], (w) => w.wire.reconnect(), { emit: () => [frame("A2", "hydration.snapshot")] }),
      event("hydration.snapshot", ["socket.reconnect"], (w) => w.wire.step(() => w.wire.server.response("snapshot")), { delivery: true }),
      event("hydration.ready", ["socket.reconnect"], noop, { emit: () => [frame("A2", "hydration.release")] }),
      event("hydration.release", ["hydration.ready"], (w) => w.wire.step(() => w.wire.server.response("hydration")), { delivery: true }),
      // app.ts persists done before broadcasting; only currently open sockets receive it.
      event("server.done", [], (w) => {
        const user = w.wire.server.turns.get("turn-1"); if (!user) throw new Error("Missing admitted turn");
        w.wire.server.messages.push({ ...user, id: "reply-turn-1", role: "assistant", content: "reply" });
        w.terminalTarget = w.wire.a.socket.readyState === 1 ? w.wire.a.socket : undefined;
      }, { emit: (prefix) => [
        ...(!prefix.includes("socket.drop") ? [frame("A1", "done.push-A")] : prefix.includes("socket.reconnect") ? [frame("A2", "done.push-A")] : []), frame("B", "done.push-B"),
      ] }),
      event("done.push-A", ["server.done"], (w) => w.wire.step(() => { if (w.terminalTarget) w.wire.server.chatPush("turn-1", w.terminalTarget, true); }), { delivery: true }),
      event("done.push-B", ["server.done"], (w) => w.wire.step(() => w.wire.server.chatPush("turn-1", w.wire.b.socket, true)), { delivery: true }),
    ],
    check(w, order, complete) {
      if (order.includes("socket.drop")) expect(w.wire.a.store.getState().runningTurns, "a disconnected off-screen stream cannot remain marked as running").toEqual({});
      expect(w.wire.b.store.getState().runningTurns).toEqual(order.includes("done.push-B") ? {} : { t1: "turn-1" });
      if (complete) expect(w.wire.a.store.getState().conn.kind).toBe("open");
    },
  };
}

function imageStatus(kind: "check" | "post-save"): ReplayScenario<World> {
  const old = { ...methodSamples["image.status"].result, state: "ready" as const };
  const busy = { ...old, state: "busy" as const };
  return {
    name: `image status (${kind}): a late probe cannot erase busy`, dispose,
    create: async () => {
      const w = await World.create();
      if (kind === "check") {
        // A job and a ready discovery both require image generation enabled.
        w.wire.server.settings = { ...w.wire.server.settings, imageGen: true };
        await w.push(w.wire.a.socket, "settings.changed", w.wire.server.settings);
        await w.push(w.wire.b.socket, "settings.changed", w.wire.server.settings);
        await w.capture("image.old", "image.status", () => { void w.wire.a.session.checkImageStatus(); }, old);
      }
      else {
        void w.wire.a.session.updateSettings({ imageGen: true }); await drain();
        await w.capture("image.old", "image.status", () => {
          w.wire.server.settingsPush("A-theme", w.wire.a.socket);
          w.wire.server.settingsPush("A-theme", w.wire.b.socket);
          w.wire.server.response("A-theme");
        }, old);
      }
      // image.discover updates/broadcasts before returning its immutable status.
      // That initial push is delivered in setup; the dispatcher has not emitted the response yet.
      await w.push(w.wire.a.socket, "image.status", old); await w.push(w.wire.b.socket, "image.status", old);
      return w;
    },
    witnesses: [["job.start", "busy.push-A", "busy.push-B", "image.old.ready", "image.old.response"]],
    events: [
      // image jobs can set busy independently while a discover result unwinds.
      event("job.start", [], noop, { emit: () => [frame("A", "busy.push-A"), frame("B", "busy.push-B")] }),
      event("busy.push-A", ["job.start"], (w) => w.push(w.wire.a.socket, "image.status", busy), { delivery: true }),
      event("busy.push-B", ["job.start"], (w) => w.push(w.wire.b.socket, "image.status", busy), { delivery: true }),
      event("image.old.ready", [], noop, { emit: () => [frame("A", "image.old.response")] }),
      event("image.old.response", ["image.old.ready"], (w) => w.respond("image.old"), { delivery: true }),
    ],
    check(w, order) {
      if (order.includes("busy.push-A")) expect(w.wire.a.store.getState().imageStatus, "a received busy push must survive the older image status response").toMatchObject({ state: "busy" });
    },
  };
}

function updateHydration(): ReplayScenario<World> {
  const checked = { ...methodSamples["update.check"].result, checkedAt: 99 };
  return {
    name: "update hydration: keep a fresh check and a dismissed result", dispose,
    create: async () => {
      const w = await World.create(); await w.wire.drop(); await w.wire.reconnect();
      await w.wire.step(() => w.wire.server.response("snapshot"));
      // All second-batch responses, including update.status, are delivered except
      // GPU. Promise.all has not published them. No wire reordering is needed.
      await w.capture("gpu", "gpu.status", () => w.wire.server.response("hydration"), methodSamples["gpu.status"].result);
      return w;
    },
    witnesses: [["check.request", "check.ready", "check.response", "dismiss", "batch.ready", "batch.release"]],
    events: [
      event("check.request", [], (w) => w.capture("check", "update.check", () => { void w.wire.a.session.checkForUpdates(); }, checked)),
      event("check.ready", ["check.request"], noop, { emit: () => [frame("A", "check.response")] }),
      event("check.response", ["check.ready"], (w) => w.respond("check"), { delivery: true }),
      // dismissUpdateResult changes the local cached result immediately.
      event("dismiss", [], (w) => w.wire.step(() => { void w.wire.a.session.dismissUpdateResult(); })),
      event("batch.ready", [], noop, { emit: () => [frame("A", "batch.release")] }),
      event("batch.release", ["batch.ready"], (w) => w.respond("gpu"), { delivery: true }),
    ],
    check(w, order) {
      const expected = { ...(order.includes("check.response") ? { lastCheck: checked } : {}), ...(order.includes("dismiss") ? { result: null } : {}) };
      if (Object.keys(expected).length) expect(w.wire.a.store.getState().update, "hydration cannot replace a fresh check or restore a dismissed result").toMatchObject(expected);
    },
  };
}

function pullTimeout(): ReplayScenario<World> {
  const name = "new:7b";
  const progress = { name, state: "downloading" as const, completedBytes: 0 };
  return {
    name: "pull: an acknowledgement timeout must keep received download progress", dispose,
    create: async () => {
      const w = await World.create();
      await w.capture("pull", "models.pull", () => { void w.wire.a.session.pull(name); }, { name, state: "queued", completedBytes: 0 });
      return w;
    },
    witnesses: [["pull.accepted", "progress.push-A", "progress.push-B", "ack.timeout"]],
    events: [
      // pull.run emits downloading synchronously before models.pull returns.
      // Its response can be lost/delayed behind that initial frame; later pushes
      // cannot pass a missing response on TCP, so this uses no such later push.
      event("pull.accepted", [], noop, { emit: () => [frame("A", "progress.push-A"), frame("B", "progress.push-B")] }),
      event("progress.push-A", ["pull.accepted"], (w) => w.push(w.wire.a.socket, "models.pull", progress), { delivery: true }),
      event("progress.push-B", ["pull.accepted"], (w) => w.push(w.wire.b.socket, "models.pull", progress), { delivery: true }),
      // Chosen failure: the initial progress arrived, its following ack did not.
      event("ack.timeout", ["progress.push-A"], async () => { await vi.advanceTimersByTimeAsync(30_001); await drain(); }),
    ],
    check(w, order) {
      if (order.includes("progress.push-A")) expect(w.wire.a.store.getState().pulls[name], "a failed acknowledgement must not delete known server progress").toEqual(progress);
    },
  };
}

it("fitEpoch rejects stale fit and blocker results", () => run(fitEpoch()));
it("preload rejects a superseded model choice", () => run(preloadChoice()));
it("modelsOrder rejects an old model refresh after a push", () => run(modelRefresh()));
it("lostTurn clears off-screen marks across completion and hydration", () => run(offscreenReconnect()));
it.each(["check", "post-save"] as const)("image status %s preserves a newer push", (kind) => run(imageStatus(kind)));
it("update hydration preserves a check and dismissal", () => run(updateHydration()));
it("pull timeout preserves newer server progress", () => run(pullTimeout()));
