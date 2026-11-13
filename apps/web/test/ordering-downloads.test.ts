// RS-01: reconcile missed terminal pushes without hiding live download jobs.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { ModelInfo, PullProgress } from "@gates-local/contracts";
import { methodSamples } from "@gates-local/contracts/testing";
import { drain, OrderingWorld } from "./ordering-world.ts";
import { replay, type ReplayEvent, type ReplayScenario } from "./ordering-replay.ts";

vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => [initial, () => {}],
  useRef: (initial: unknown) => ({ current: initial }),
  useEffect: () => {},
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}));

const NAME = "fresh:7b", BRIDGE = "bridge:7b", FAILED = "previous:7b";
const installed = methodSamples["models.list"].result;
const first = installed[0];
if (!first) throw new Error("Missing model fixture");
const downloaded: ModelInfo = { ...first, name: NAME };
const bridge: PullProgress = { name: BRIDGE, state: "done", completedBytes: 100, totalBytes: 100 };
const failed: PullProgress = { name: FAILED, state: "error", completedBytes: 0, message: "Earlier download failed" };
const frame = (socket: string, event: string) => ({ socket, event });
const noop = () => {};
const MESSAGE = "waiting for the first model";
const STOPPED = "Download stopped";
const STOPPED_TIP = 'data-tip="Download stopped. Download a model to send this."';
// the row shows a clock; these are its tip and its words for a screen reader (chat row 29)
const WAITING = "Sends when the download finishes";
type QueueWords = typeof import("../src/Composer.tsx")["queueWords"];

interface World {
  wire: OrderingWorld;
  models: readonly ModelInfo[];
  pending: readonly PullProgress[];
  initial: PullProgress;
  advanced: PullProgress;
  next: PullProgress;
  words: QueueWords;
}
type Event = ReplayEvent<World>;
const event = (name: string, after: readonly string[], run: Event["run"], extra: Pick<Event, "emit" | "delivery" | "discard"> = {}): Event => ({ name, after, run, ...extra });
const dispose = (w: World) => w.wire.dispose();

async function create(state: "queued" | "downloading" | "verifying", firstModel = false, available = true): Promise<World> {
  const initial: PullProgress = { name: NAME, state, completedBytes: state === "queued" ? 0 : state === "verifying" ? 100 : 20, totalBytes: 100 };
  const w: World = {
    wire: await OrderingWorld.create(), models: firstModel ? [] : installed,
    pending: [initial], initial,
    advanced: { ...initial, completedBytes: state === "downloading" ? 55 : initial.completedBytes },
    next: { ...initial, state: state === "verifying" ? "done" : "downloading", completedBytes: state === "verifying" ? 100 : 75 },
    words: (await import("../src/Composer.tsx")).queueWords,
  };
  w.wire.server.modelsSnapshot = w.models;
  w.wire.server.answer("models.list", () => w.models);
  w.wire.server.answer("models.refresh", () => w.models);
  w.wire.server.answer("models.pulls", () => {
    if (!available) throw { code: "not-implemented", message: "Older server" };
    return w.pending;
  });
  w.wire.server.answer("models.pull", () => initial);
  w.wire.server.broadcast("models.changed", w.models); await drain();
  void w.wire.a.session.pull(NAME); await drain();
  w.wire.server.broadcast("models.pull", initial); await drain();
  return w;
}

const reconnect: readonly Event[] = [
  // session.loop reconnects only after close/backoff. The snapshot is captured at request time.
  event("socket.reconnect", ["server.offline-change"], (w) => w.wire.reconnect(), { emit: () => [frame("A", "settings.snapshot")] }),
  event("settings.snapshot", ["socket.reconnect"], (w) => w.wire.step(() => w.wire.server.response("snapshot")), { delivery: true }),
  // models.list can await catalog discovery; its completion releases the first batch.
  event("hydration.ready", ["socket.reconnect"], noop, { emit: () => [frame("A", "hydration.release")] }),
  event("hydration.release", ["hydration.ready"], (w) => w.wire.step(() => w.wire.server.response("hydration")), { delivery: true }),
];

function ended(outcome: "done" | "error" | "cancelled", firstModel: boolean, available = true): ReplayScenario<World> {
  return {
    name: `RS-01: ${outcome} while offline (first=${firstModel}, read=${available})`,
    create: async () => {
      const w = await create("downloading", firstModel, available);
      if (firstModel) { void w.wire.a.session.send(MESSAGE); await drain(); expect(w.wire.a.store.getState().queued).toHaveLength(1); }
      return w;
    }, dispose,
    witnesses: [["socket.drop", "server.offline-change", "terminal.push-B", "socket.reconnect", "settings.snapshot", "hydration.ready", "hydration.release"]],
    events: [
      event("socket.drop", [], (w) => w.wire.drop()),
      // Chosen input: the terminal transition happens with A disconnected; B stays connected.
      event("server.offline-change", ["socket.drop"], (w) => {
        w.pending = [];
        if (outcome === "done") w.models = [...w.models, downloaded];
        w.wire.server.modelsSnapshot = w.models;
      }, { emit: () => [frame("B", "terminal.push-B")] }),
      event("terminal.push-B", ["server.offline-change"], (w) => w.wire.step(() => {
        w.wire.b.socket.frame({ type: "push", channel: "models.pull", payload: { ...w.initial, state: outcome } });
      }), { delivery: true }),
      ...reconnect,
    ],
    check(w, order) {
      const state = w.wire.a.store.getState();
      if (!order.includes("hydration.release") || !available) {
        expect(state.pulls[NAME], "disconnect and unavailable reads must preserve the download row").toEqual(w.initial);
      } else {
        expect(state.pulls[NAME], "a job that ended offline cannot remain Downloading").toBeUndefined();
        expect(w.wire.a.session.queueReason(state), "first-model messages cannot wait for a nonexistent download").toBeNull();
        if (firstModel && outcome === "done") {
          expect(state.queued, "a first-model send resumes after the installed snapshot").toEqual([]);
          expect(w.wire.server.calls("chat.send")).toHaveLength(1);
        }
      }
      if (firstModel && (outcome !== "done" || !order.includes("hydration.release") || !available)) {
        expect(state.queued, "the unsent message and its text survive").toHaveLength(1);
        const q = state.queued[0];
        if (!q) throw new Error("Missing queued message");
        expect(q.text).toBe(MESSAGE);
        expect(q.waitFor, "render derives the words without changing the stored queue").toBe("download");
        const firstDownload = w.wire.a.session.firstPull(state);
        const stopped = available && order.includes("hydration.release") && outcome !== "done";
        if (stopped) expect(firstDownload, "the entry cannot promise an absent download").toBeUndefined();
        expect(w.words(q, false, firstDownload, state.model), "queue words must describe the current download, including during a drop").toBe(stopped ? STOPPED : WAITING);
      }
    },
  };
}

function ongoing(state: "queued" | "downloading" | "verifying"): ReplayScenario<World> {
  return {
    name: `RS-01: keep ${state} through reconnect and a newer push`,
    create: async () => {
      const w = await create(state);
      w.wire.server.broadcast("models.pull", bridge); w.wire.server.broadcast("models.pull", failed); await drain();
      return w;
    }, dispose,
    witnesses: [
      ["socket.drop", "server.offline-change", "progress.push-B", "socket.reconnect", "settings.snapshot", "next.progress", "next.push-A", "next.push-B", "hydration.ready", "hydration.release"],
      ["socket.drop", "server.offline-change", "progress.push-B", "socket.reconnect", "settings.snapshot", "hydration.ready", "hydration.release", "next.progress", "next.push-A", "next.push-B"],
    ],
    events: [
      event("socket.drop", [], (w) => w.wire.drop()),
      event("server.offline-change", ["socket.drop"], (w) => {
        w.pending = [w.advanced];
        // An installed done row is retired by settlePulls; others keep bridging.
        if (state === "queued") w.models = [...w.models, { ...downloaded, name: BRIDGE }];
        w.wire.server.modelsSnapshot = w.models;
      }, { emit: () => [frame("B", "progress.push-B")] }),
      event("progress.push-B", ["server.offline-change"], (w) => w.wire.step(() => w.wire.b.socket.frame({ type: "push", channel: "models.pull", payload: w.advanced })), { delivery: true }),
      ...reconnect,
      // The next progress is newer than the already-captured pending snapshot.
      event("next.progress", ["socket.reconnect"], noop, { emit: () => [frame("A", "next.push-A"), frame("B", "next.push-B")] }),
      event("next.push-A", ["next.progress"], (w) => w.wire.step(() => w.wire.a.socket.frame({ type: "push", channel: "models.pull", payload: w.next })), { delivery: true }),
      event("next.push-B", ["next.progress"], (w) => w.wire.step(() => w.wire.b.socket.frame({ type: "push", channel: "models.pull", payload: w.next })), { delivery: true }),
    ],
    check(w, order) {
      const pulls = w.wire.a.store.getState().pulls;
      if (!order.includes("hydration.release")) expect(pulls[NAME], "a quiet live job keeps its row until the first batch lands").toEqual(w.initial);
      else {
        expect(pulls[NAME], "server progress must survive reconnect and newer pushes must win").toEqual(order.includes("next.push-A") ? w.next : w.advanced);
        expect(pulls[BRIDGE]).toEqual(state === "queued" ? undefined : bridge);
        expect(pulls[FAILED]).toEqual(failed);
      }
    },
  };
}

const run = async (scenario: ReplayScenario<World>): Promise<void> => { await replay(scenario, { limit: 64, order: process.env["REPLAY_ORDER"] }); };
it.each(["done", "error", "cancelled"] as const)("RS-01: reconcile %s received only by another window", async (outcome) => {
  await run(ended(outcome, false)); await run(ended(outcome, true));
});
it.each(["queued", "downloading", "verifying"] as const)("RS-01: preserve %s and its next push", (state) => run(ongoing(state)));
it("RS-01: an unavailable pending read preserves cached rows", () => run(ended("error", true, false)));

it.each(["error", "cancelled"] as const)("RS-01: connected %s keeps the message with honest tray words", async (outcome) => {
  const w = await create("downloading", true);
  const client = w.wire.b;
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  const { Composer } = await import("../src/Composer.tsx");
  const tray = () => renderToStaticMarkup(createElement(Composer)).match(/<ul class="qt"[\s\S]*?<\/ul>/)?.[0];
  try {
    void client.session.send(MESSAGE); await drain();
    const queued = client.store.getState().queued;
    expect(queued).toHaveLength(1);
    expect(tray()).toContain(WAITING);
    if (outcome === "cancelled") {
      w.wire.server.answer("models.cancelPull", () => ({ cancelled: true }));
      await client.session.cancelPull(NAME);
    } else {
      w.wire.server.broadcast("models.pull", { ...w.initial, state: "error", message: "Download failed" }); await drain();
    }
    expect(client.store.getState().queued, "the same entry and its text remain editable").toEqual(queued);
    expect(client.session.firstPull(client.store.getState())).toBeUndefined();
    const stopped = tray();
    expect(stopped).toContain(MESSAGE);
    expect(stopped).toContain(`>${STOPPED}<`);
    expect(stopped, "the full sentence is the word's tip").toContain(STOPPED_TIP);
    expect(stopped).not.toContain(WAITING);
    expect(stopped).toContain("data-edit-queued");
    expect(stopped).toContain("data-unqueue");
    const q = queued[0];
    if (!q) throw new Error("Missing queued message");
    client.session.editQueued(q.id);
    expect(tray()).toContain(">Editing<");
    client.session.cancelQueuedEdit();
    expect(tray()).toContain(STOPPED);
    void client.session.pull(NAME); await drain();
    expect(tray()).toContain(WAITING);
    client.socket.close(); await drain();
    expect(client.session.queueReason(client.store.getState())).toBeNull();
    expect(tray(), "a disconnect retains the live download and must not say stopped").toContain(WAITING);
    client.session.removeQueued(q.id);
    expect(tray()).toBeUndefined();
  } finally { await dispose(w); }
});
