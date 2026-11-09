import { expect, it, vi } from "vitest";
import { explore, replay, regression, schedules, type ReplayEvent, type ReplayFrame, type ReplayScenario } from "./ordering-replay.ts";
import { OrderingWorld, SPEECH_URL, drain, runningIds } from "./ordering-world.ts";

vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => [initial, () => {}],
  useRef: (initial: unknown) => ({ current: initial }),
  useEffect: () => {},
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}));

type World = OrderingWorld;
type Event = ReplayEvent<World>;
const event = (name: string, after: readonly string[], run: Event["run"], extra: Pick<Event, "delivery" | "emit" | "discard"> = {}): Event => ({ name, after, run, ...extra });
const frame = (socket: string, name: string): ReplayFrame => ({ socket, event: name });
const dispose = (w: World) => w.dispose();
const noop = () => {};
const LIMIT = 64;
const before = (order: readonly string[], a: string, b: string) => order.indexOf(a) < order.indexOf(b);

// settings/handlers.ts broadcasts synchronously, then ws/server.ts awaits its
// return before responding. Another buffered request can broadcast before that
// continuation runs. The server continuation queue is separate from wire FIFO.
function settingsFrames(stem: string): ReplayFrame[] {
  return [frame("A", stem + ".push-to-A"), frame("B", stem + ".push-to-B"), frame("server:responses", stem + ".response.ready")];
}

function settingsDeliveries(stem: string, key: string, write: string, sender: "A" | "B", optional = false, tagged = true, written: (prefix: readonly string[]) => boolean = () => true): Event[] {
  return [
    // Synchronous settings handlers queue await continuations in dispatch order;
    // their responses enter the socket only when those continuations resume.
    event(stem + ".response.ready", [write], noop, { delivery: true, emit: (prefix) =>
      written(prefix.slice(0, prefix.indexOf(write) + 1)) ? [frame(sender, stem + ".response")] : [] }),
    // Each push follows its producing settings.update; recipients are independent.
    event(stem + ".push-to-A", [write], (w) => w.step(() => {
      if (stem === "B.disconnect" && w.connectStarted) w.eligible = false;
      w.server.settingsPush(key, w.a.socket, tagged, optional);
    }), { delivery: true }),
    event(stem + ".push-to-B", [write], (w) => w.step(() => w.server.settingsPush(key, w.b.socket, true, optional)), { delivery: true }),
    // Sender receives broadcast before response on the same WebSocket.
    event(stem + ".response", [stem + ".response.ready", stem + ".push-to-" + sender], (w) => w.step(() => w.server.response(key, optional)), { delivery: true }),
  ];
}

function hydrationEvents(reconnect?: string, socket = "A"): Event[] {
  return [
    // settings.get was requested at reconnect; its result was captured then.
    event("hydration.snapshot", reconnect ? [reconnect] : [], (w) => w.step(() => w.server.response("snapshot")), { delivery: true }),
    // models.list can await catalog.refresh (app.ts). Its completion is independent.
    event("server.hydration.complete", reconnect ? [reconnect] : [], noop, { emit: () => [frame(socket, "hydration.release")] }),
    // hydrateWith's Promise.all releases only once this response is delivered.
    event("hydration.release", ["server.hydration.complete"], (w) => w.step(() => w.server.response("hydration")), { delivery: true }),
  ];
}

async function speechWorld(): Promise<World> {
  const w = await OrderingWorld.create();
  // Initial condition: A has reconnected, its first batch is in flight, and
  // settings.get has returned on the server. These are setup, not claimed
  // permutations of the user's actions around the earlier socket drop.
  await w.drop(); await w.reconnect();
  return w;
}

function connectRequest(after: readonly string[], old = false): Event {
  return event(old ? "A.old-connect.request" : "A.connect.request", after, (w) => w.step(() => {
    w.intent = old ? "old" : "connect"; w.connectStarted = true; w.eligible = true; w.a.click("Connect");
  }));
}

function healthEvents(request: string, old = false, foreign = false): Event[] {
  const ready = old ? "A.old-health.ready" : "A.health.ready";
  const complete = old ? "A.old-health.complete" : "A.health.complete";
  const stem = old ? "A.old-connect" : "A.connect";
  const key = old ? "A-old-connect" : "A-connect";
  const valid = (prefix: readonly string[]) => old
    ? !prefix.includes("A.disconnect.request")
    : !foreign || !prefix.includes("B.disconnect.push-to-A") || prefix.indexOf("B.disconnect.push-to-A") < prefix.indexOf(request);
  return [
    // VoiceSettings calls voice.check from Connect; service completion follows it.
    event(ready, [request], noop, { emit: () => [frame("A", complete)] }),
    // The check response triggers updateSettings only for the current attempt.
    event(complete, [ready], async (w) => {
      w.healthSaves.set(key, w.intent === (old ? "old" : "connect") && w.eligible);
      w.server.connectName = old ? "old-connect" : "connect";
      await w.step(() => w.server.response(old ? "health-1" : w.server.deliveries.has("health-2") ? "health-2" : "health-1"));
      w.server.connectName = "connect";
    }, { delivery: true, emit: (prefix) => valid(prefix) ? settingsFrames(stem) : [] }),
    ...settingsDeliveries(stem, key, complete, "A", true, true, valid),
  ];
}

function speechCheck(w: World, _order: readonly string[], complete: boolean): void {
  for (const [key, expected] of w.healthSaves) {
    expect(w.server.writes.filter((write) => write.key === key).length, "successful health check must save exactly the still-current Connect").toBe(Number(expected));
  }
  if (complete) for (const window of w.windows) {
    const settings = window.store.getState().settings;
    expect(settings === "na" ? undefined : settings?.whisperUrl, "both windows must match the last speech write in server order").toBe(w.server.settings.whisperUrl);
  }
}

function speechWitnesses(scenario: ReplayScenario<World>): ReplayScenario<World> {
  // Required SL-01 witnesses stay inside the 64-order budget, so adding a server
  // phase cannot silently remove them by perturbing the random sample.
  const lateOtherWindow = [
    "A.old-connect.request", "A.disconnect.request", "B.disconnect.request",
    "hydration.snapshot",
    "A.disconnect.push-to-A", "A.disconnect.push-to-B", "A.disconnect.response.ready", "A.disconnect.response",
    "B.disconnect.push-to-A", "B.disconnect.push-to-B", "B.disconnect.response.ready", "B.disconnect.response",
    "B.theme.request", "B.theme.push-to-A", "B.theme.push-to-B", "B.theme.response.ready", "B.theme.response",
    "A.connect.request", "A.health.ready", "A.health.complete",
    "A.connect.response.ready", "A.connect.push-to-A", "A.connect.response",
    "A.old-health.ready", "A.old-health.complete", "A.old-connect.response.ready",
    "A.old-connect.push-to-A", "A.old-connect.push-to-B", "A.old-connect.response",
    "server.hydration.complete", "hydration.release", "A.connect.push-to-B",
  ].filter((name) => scenario.events.some((candidate) => candidate.name === name));
  const otherWindowFirst = lateOtherWindow.filter((name) => name !== "A.connect.push-to-B");
  otherWindowFirst.splice(otherWindowFirst.indexOf("A.connect.push-to-A"), 0, "A.connect.push-to-B");
  const afterHydration = lateOtherWindow.filter((name) => !["server.hydration.complete", "hydration.release"].includes(name));
  afterHydration.splice(afterHydration.indexOf("A.health.ready"), 0, "server.hydration.complete", "hydration.release");
  return { ...scenario, witnesses: [lateOtherWindow, otherWindowFirst, afterHydration] };
}

export function ownSpeech(staleHealth = false): ReplayScenario<World> {
  return speechWitnesses({
    name: staleHealth ? "speech: superseded health" : "speech: own Disconnect during hydration",
    create: speechWorld, dispose, check: speechCheck,
    initialFrames: [frame("A", "hydration.snapshot")],
    events: [
      ...(staleHealth ? [connectRequest([], true)] : []),
      // Selected input script: optionally Connect, then Disconnect, then Connect.
      // These action edges specify the user's intent, not network guarantees.
      event("A.disconnect.request", staleHealth ? ["A.old-connect.request"] : [], (w) => w.step(() => {
        w.intent = "disconnect"; w.eligible = false; w.a.click("Disconnect");
      }), { emit: () => settingsFrames("A.disconnect") }),
      connectRequest(["A.disconnect.request"]),
      ...settingsDeliveries("A.disconnect", "A-disconnect", "A.disconnect.request", "A"),
      ...healthEvents("A.connect.request"),
      ...(staleHealth ? healthEvents("A.old-connect.request", true) : []),
      ...hydrationEvents(),
    ],
  });
}

export function foreignSpeech(theme = false, tagged = true): ReplayScenario<World> {
  return speechWitnesses({
    name: "speech: foreign Disconnect" + (theme ? " and theme" : "") + (tagged ? "" : " (legacy push)"),
    create: speechWorld, dispose, check: speechCheck,
    initialFrames: [frame("A", "hydration.snapshot")],
    events: [
      // The two windows' input actions have no cross-window causal edge.
      connectRequest([]),
      event("B.disconnect.request", [], (w) => w.step(() => { void w.b.session.updateSettings({ whisperUrl: null }); }), { emit: () => settingsFrames("B.disconnect") }),
      ...settingsDeliveries("B.disconnect", "B-disconnect", "B.disconnect.request", "B", false, tagged),
      ...(theme ? [
        // Input script changes appearance after speech, without waiting for its ack.
        event("B.theme.request", ["B.disconnect.request"], (w) => w.step(() => { void w.b.session.updateSettings({ theme: "light" }); }), { emit: () => settingsFrames("B.theme") }),
        ...settingsDeliveries("B.theme", "B-theme", "B.theme.request", "B"),
      ] : []),
      ...healthEvents("A.connect.request", false, true),
      ...hydrationEvents(),
    ],
  });
}

function batchedSettings(orderedSettings?: boolean): ReplayScenario<World> {
  const themes: string[] = [];
  return {
    name: "RP-01: two broadcasts before either settings response",
    create: async () => {
      const w = await OrderingWorld.create(true, orderedSettings);
      themes.length = 0;
      vi.spyOn(document.documentElement, "setAttribute").mockImplementation((name, value) => {
        if (name === "data-theme") themes.push(value);
      });
      return w;
    }, dispose,
    events: [
      event("B.disconnect.request", [], (w) => w.step(() => { void w.b.session.updateSettings({ whisperUrl: null }); }), { emit: () => settingsFrames("B.disconnect") }),
      // Chosen input: B changes appearance without waiting for Disconnect.
      event("B.theme.request", ["B.disconnect.request"], (w) => w.step(() => { void w.b.session.updateSettings({ theme: "light" }); }), { emit: () => settingsFrames("B.theme") }),
      ...settingsDeliveries("B.disconnect", "B-disconnect", "B.disconnect.request", "B"),
      ...settingsDeliveries("B.theme", "B-theme", "B.theme.request", "B"),
    ],
    check(w, order) {
      if (order.includes("B.theme.push-to-B")) {
        const settings = w.b.store.getState().settings;
        expect({ settingsTheme: settings === "na" ? undefined : settings?.theme, themeAttribute: themes.at(-1) },
          "an older acknowledgement must not roll back the published theme or its DOM attribute").toEqual({ settingsTheme: "light", themeAttribute: "light" });
      }
      expect(w.server.writes).toHaveLength(order.includes("B.theme.request") ? 2 : 1);
    },
  };
}

it("RP-01: a batched older response never overwrites the newer theme push", async () => {
  const scenario = batchedSettings();
  // Installed ws.Receiver dispatches both writes before either await-handler
  // continuation. This explicit witness is separate from the 64 sampled orders.
  const order = [
    "B.disconnect.request", "B.theme.request",
    "B.disconnect.response.ready", "B.theme.response.ready",
    "B.disconnect.push-to-A", "B.theme.push-to-A",
    "B.disconnect.push-to-B", "B.theme.push-to-B",
    "B.disconnect.response", "B.theme.response",
  ];
  await replay(scenario, { order: JSON.stringify(order) });
});

it("RP-01 ordered settings preserves the newest theme across three explicit FIFO witnesses", async () => {
  const orders = [
    ["B.disconnect.request", "B.theme.request", "B.disconnect.response.ready", "B.theme.response.ready", "B.disconnect.push-to-A", "B.theme.push-to-A", "B.disconnect.push-to-B", "B.theme.push-to-B", "B.disconnect.response", "B.theme.response"],
    ["B.disconnect.request", "B.disconnect.response.ready", "B.disconnect.push-to-A", "B.disconnect.push-to-B", "B.theme.request", "B.theme.response.ready", "B.theme.push-to-A", "B.disconnect.response", "B.theme.push-to-B", "B.theme.response"],
    ["B.disconnect.request", "B.theme.request", "B.disconnect.response.ready", "B.theme.response.ready", "B.disconnect.push-to-B", "B.disconnect.push-to-A", "B.theme.push-to-A", "B.theme.push-to-B", "B.disconnect.response", "B.theme.response"],
  ];
  for (const order of orders) await replay(batchedSettings(true), { order: JSON.stringify(order) });
  process.stdout.write("RP-01 ordered settings: 3 orders (explicit FIFO witnesses)\n");
});

it("ordered shared/model acknowledgements retain both commits and a no-op voice echo preserves intent", async () => {
  const w = await OrderingWorld.create(true, true);
  try {
    const shared = w.a.session.updateSettings({ theme: "light" }); await drain();
    const model = w.b.session.updateModelSettings("model:latest", { systemPrompt: "Keep this prompt" }); await drain();
    for (const socket of [w.a.socket, w.b.socket]) {
      w.server.settingsPush("A-theme", socket);
      w.server.settingsPush("B-model", socket);
    }
    w.server.response("B-model"); await drain();
    w.server.response("A-theme"); await drain();
    expect(await shared).toBeNull(); expect(await model).toBeNull();
    for (const window of w.windows) expect(window.store.getState().settings).toMatchObject({ theme: "light", modelSettings: { "model:latest": { systemPrompt: "Keep this prompt" } } });
    const version = w.a.store.getState().voiceConnectionVersion;
    const unchanged = w.a.session.updateSettings({ whisperUrl: SPEECH_URL }, { voiceActionStarted: true }); await drain();
    w.server.settingsPush("A-connect", w.a.socket); w.server.response("A-connect"); await drain();
    expect(await unchanged).toBeNull();
    expect(w.a.store.getState().voiceConnectionVersion).toBe(version);
  } finally { await w.dispose(); }
});

it("ordered settings accepted during bootstrap cannot roll back when the last response and socket close share a task", async () => {
  const w = await OrderingWorld.create(true, true);
  try {
    await w.drop(); await w.reconnect();
    const saved = w.b.session.updateSettings({ theme: "light" }); await drain();
    w.server.settingsPush("B-theme", w.b.socket); w.server.settingsPush("B-theme", w.a.socket);
    w.server.response("B-theme"); await drain(); await saved;
    w.server.response("snapshot"); w.server.response("hydration"); w.a.socket.close();
    await drain();
    expect(w.a.store.getState().settings).toMatchObject({ theme: "light" });
  } finally { await w.dispose(); }
});

it("ordered bootstrap missing its required settings stamp retains failed-startup backoff", async () => {
  const w = await OrderingWorld.create(true, true);
  const timers = vi.spyOn(globalThis, "setTimeout");
  try {
    await w.drop(); await w.reconnect();
    w.server.response("hydration"); await drain();
    const snapshot = w.server.deliveries.get("snapshot");
    if (!snapshot) throw new Error("Missing captured settings read");
    w.server.deliveries.set("snapshot", { ...snapshot, sync: undefined });
    w.server.response("snapshot"); await drain();
    expect(w.a.store.getState().conn.kind).toBe("down");
    const retry = timers.mock.calls.map(([, ms]) => ms).filter(ms => ms !== undefined && [250, 500, 1000, 2000, 4000].includes(ms)).at(-1);
    expect(retry).toBe(500);
  } finally { timers.mockRestore(); await w.dispose(); }
});

// app.ts stores the user row and broadcasts start before chat.send returns.
// Closed sockets receive no broadcast; a reconnect never resends an old start.
function chatFrames(turn: string, prefix: readonly string[], reconnecting = false): ReplayFrame[] {
  const target = !reconnecting ? "A" : prefix.includes("socket.reconnect") ? "A2" : prefix.includes("socket.drop") ? undefined : "A1";
  return [
    ...(target ? [frame(target, turn + ".push-to-A")] : []),
    frame("B", turn + ".push-to-B"),
    frame("server:responses", turn + ".response.ready"),
  ];
}

function chatDeliveries(turn: string, admitted: string, reconnecting = false): Event[] {
  return [
    // app.ts returns after start broadcast; ws/server.ts emits its response
    // from the await continuation. A later admission may broadcast in between.
    event(turn + ".response.ready", [admitted], noop, { delivery: true, emit: (prefix) =>
      !reconnecting || !prefix.includes("socket.drop") ? [frame(reconnecting ? "A1" : "A", turn + ".response")] : [] }),
    // A broadcast is emitted by admission, independently to each open socket.
    event(turn + ".push-to-A", [admitted], (w) => w.step(() => w.server.admittedPush(turn, "A")), { delivery: true }),
    event(turn + ".push-to-B", [admitted], (w) => w.step(() => w.server.admittedPush(turn, "B")), { delivery: true }),
    // app.ts returns after broadcasting start. Per-socket FIFO adds the edge
    // only when A's broadcast and response actually target the same socket.
    event(turn + ".response", [turn + ".response.ready"], (w) => w.step(() => w.server.response(turn)), { delivery: true }),
  ];
}

export function sendReconnect(): ReplayScenario<World> {
  return {
    name: "send across disconnect", dispose,
    create: async () => { const w = await OrderingWorld.create(); w.server.holdChat = true; w.server.deferAdmission = true; return w; },
    events: [
      event("A.send.request", [], (w) => w.step(() => {
        w.a.store.setState({ view: "thread", threadId: "t1", draft: "one message", messages: { t1: [] } }); void w.a.session.send("one message");
      })),
      // Chosen input: drop a socket after it has transmitted this send.
      event("socket.drop", ["A.send.request"], (w) => w.drop(), { discard: ["A1"] }),
      // session.loop waits for closed, then advances its reconnect backoff.
      event("socket.reconnect", ["socket.drop"], (w) => w.reconnect(), { emit: () => [frame("A2", "hydration.snapshot")] }),
      // app.ts's async admission can complete on either side of the drop.
      event("server.admission.complete", ["A.send.request"], (w) => w.step(() => w.server.admit("turn-1")), { emit: (prefix) => chatFrames("turn-1", prefix, true) }),
      ...chatDeliveries("turn-1", "server.admission.complete", true),
      ...hydrationEvents("socket.reconnect", "A2"),
    ],
    check(w, order) {
      const state = w.a.store.getState();
      expect(w.server.calls("chat.send"), "one user action must send once").toHaveLength(1);
      const visible = state.draft === "one message" || state.turns["t1"]?.pendingUser === "one message" ||
        state.queued.some((queued) => queued.text === "one message") || (state.messages["t1"] ?? []).some((message) => message.content === "one message");
      expect(visible, "message must remain visible after " + order.at(-1)).toBe(true);
      if (w.server.admissions.has("turn-1") || w.server.turns.has("turn-1")) expect(state.queued.filter((queued) => queued.text === "one message"), "active admission must never return to queue").toEqual([]);
    },
  };
}

export function stopSend(): ReplayScenario<World> {
  return {
    name: "Stop and Send around acknowledgement", dispose,
    create: async () => { const w = await OrderingWorld.create(); w.server.holdChat = true; w.server.deferAdmission = true; return w; },
    events: [
      event("A.first-send.request", [], (w) => w.step(() => {
        w.a.store.setState({ view: "thread", threadId: "t1", draft: "first" }); void w.a.session.send("first");
      })),
      // Selected input script targets the first admission with Stop, then sends
      // in another chat. Neither press waits for a server acknowledgement.
      event("A.Stop", ["A.first-send.request"], (w) => w.step(() => {
        const turnId = w.a.store.getState().turns["t1"]?.turnId;
        if (turnId !== null && turnId !== undefined) expect(turnId).toBe("turn-1");
        w.expectedCancelled.add("turn-1"); w.a.session.stop();
      })),
      event("A.next-send.request", ["A.Stop"], (w) => w.step(() => {
        w.a.store.setState({ view: "thread", threadId: "t2", draft: "second" }); void w.a.session.send("second");
      })),
      // app.ts reserves turn ids on request, then awaits admission. Two chats'
      // admissions and start broadcasts can finish in either order.
      event("server.first-admission.complete", ["A.first-send.request"], (w) => w.step(() => w.server.admit("turn-1")), { emit: (prefix) => chatFrames("turn-1", prefix) }),
      event("server.next-admission.complete", ["A.next-send.request"], (w) => w.step(() => w.server.admit("turn-2")), { emit: (prefix) => chatFrames("turn-2", prefix) }),
      ...chatDeliveries("turn-1", "server.first-admission.complete"),
      ...chatDeliveries("turn-2", "server.next-admission.complete"),
    ],
    check(w, _order, complete) {
      expect(w.server.cancelled.every((turn) => w.expectedCancelled.has(turn)), "Stop may cancel only the reply it named").toBe(true);
      expect(w.server.cancelled, "the newer reply must not receive an old Stop").not.toContain("turn-2");
      if (complete) {
        expect(w.server.cancelled).toContain("turn-1");
        expect(w.a.store.getState().turns["t2"]).toMatchObject({ turnId: "turn-2", threadId: "t2", pendingUser: null });
        expect(w.a.store.getState().turns["t2"]?.end).toBeUndefined();
      }
    },
  };
}

// The person stops a reply and sends in another chat. The saved row may reach
// this window before or after the send is admitted, and either way is one row.
export function stopSavedPartial(): ReplayScenario<World> {
  return {
    name: "Stop with a saved partial, moving on before it arrives", dispose,
    create: async () => {
      const w = await OrderingWorld.create();
      await w.step(() => { w.a.store.setState({ view: "thread", threadId: "t1", draft: "first" }); void w.a.session.send("first"); });
      await w.step(() => w.server.admittedPush("turn-1", "A"));
      await w.step(() => w.server.chatWords("turn-1", w.a.socket, "so far"));
      w.server.holdChat = true; w.server.deferAdmission = true;
      return w;
    },
    events: [
      event("A.Stop", [], (w) => w.step(() => { w.expectedCancelled.add("turn-1"); w.a.session.stop(); })),
      // runTurn saves the partial on abort and broadcasts its end to every open socket.
      event("server.stop.saved", ["A.Stop"], noop, { emit: () => [frame("A", "saved.push-to-A"), frame("B", "saved.push-to-B")] }),
      event("saved.push-to-A", ["server.stop.saved"], (w) => w.step(() => w.server.chatWords("turn-1", w.a.socket, "so far", true)), { delivery: true }),
      event("saved.push-to-B", ["server.stop.saved"], (w) => w.step(() => w.server.chatWords("turn-1", w.b.socket, "so far", true)), { delivery: true }),
      event("A.next-send.request", ["A.Stop"], (w) => w.step(() => {
        w.a.store.setState({ view: "thread", threadId: "t2", draft: "second" }); void w.a.session.send("second");
      })),
      event("server.next-admission.complete", ["A.next-send.request"], (w) => w.step(() => w.server.admit("turn-2")), { emit: (prefix) => chatFrames("turn-2", prefix) }),
      ...chatDeliveries("turn-2", "server.next-admission.complete"),
    ],
    check(w, order, complete) {
      const state = w.a.store.getState();
      const replies = (state.messages["t1"] ?? []).filter((m) => m.role === "assistant");
      expect(replies.length, "the stopped reply is never two rows, after " + order.at(-1)).toBeLessThanOrEqual(1);
      expect(w.server.cancelled.every((turn) => w.expectedCancelled.has(turn)), "Stop may cancel only the reply it named").toBe(true);
      if (complete) {
        expect(replies).toMatchObject([{ id: "reply-turn-1", content: "so far", interrupted: true }]);
        expect(state.turns["t2"]).toMatchObject({ turnId: "turn-2", threadId: "t2", pendingUser: null });
        expect(state.turns["t2"]?.end).toBeUndefined();
      }
    },
  };
}

// A reply breaks after some words. The note under the saved row says why,
// in whichever order the two open windows hear about it.
export function errorSavedPartial(): ReplayScenario<World> {
  const reason = "the model runner crashed";
  return {
    name: "A runtime error after some words keeps its reason", dispose,
    create: async () => {
      const w = await OrderingWorld.create();
      await w.step(() => { w.a.store.setState({ view: "thread", threadId: "t1", draft: "first" }); void w.a.session.send("first"); });
      await w.step(() => w.server.admittedPush("turn-1", "A"));
      await w.step(() => w.server.chatWords("turn-1", w.a.socket, "so far"));
      return w;
    },
    events: [
      event("server.failed", [], noop, { emit: () => [frame("A", "failed.push-to-A"), frame("B", "failed.push-to-B")] }),
      event("failed.push-to-A", ["server.failed"], (w) => w.step(() => w.server.chatFailed("turn-1", w.a.socket, "so far", reason)), { delivery: true }),
      event("failed.push-to-B", ["server.failed"], (w) => w.step(() => w.server.chatFailed("turn-1", w.b.socket, "so far", reason)), { delivery: true }),
    ],
    check(w, _order, complete) {
      if (!complete) return;
      const state = w.a.store.getState();
      expect(state.turns["t1"]).toBeUndefined();
      expect(state.messages["t1"]?.filter((m) => m.role === "assistant")).toMatchObject([{ id: "reply-turn-1", content: "so far", interrupted: true }]);
      expect(state.stopNotes["reply-turn-1"]).toBe("The reply didn't finish. The model runner crashed.");
    },
  };
}

// Retry of an unfinished reply, with a history load landing while the server
// has not answered yet: the load brings new objects for the same rows.
export function retryThroughHistory(): ReplayScenario<World> {
  return {
    name: "Retry replaces the old rows when history reloads before its answer", dispose,
    create: async () => {
      const w = await OrderingWorld.create(false);
      await w.step(() => { w.a.store.setState({ view: "thread", threadId: "t1", draft: "first" }); void w.a.session.send("first"); });
      await w.step(() => w.server.admittedPush("turn-1", "A"));
      await w.step(() => w.server.chatWords("turn-1", w.a.socket, "so far"));
      await w.step(() => { w.expectedCancelled.add("turn-1"); w.a.session.stop(); });
      await w.step(() => w.server.chatWords("turn-1", w.a.socket, "so far", true));
      w.server.messages.push({ id: "reply-turn-1", threadId: "t1", role: "assistant", content: "so far", interrupted: true, createdAt: 1_000 });
      w.server.holdChat = true; w.server.deferAdmission = true;
      return w;
    },
    events: [
      event("A.Retry", [], (w) => w.step(() => w.a.session.retry())),
      event("A.history", ["A.Retry"], (w) => w.step(() => w.a.session.reloadThread("t1"))),
      // chat.send with retryOf drops the old question and its unfinished rows as it saves the new question.
      event("server.retry.admitted", ["A.history"], (w) => w.step(() => { w.server.messages.length = 0; w.server.admit("turn-2"); })),
      event("A.retry.response", ["server.retry.admitted"], (w) => w.step(() => w.server.response("turn-2"))),
    ],
    check(w, _order, complete) {
      if (!complete) return;
      expect(w.a.store.getState().messages["t1"]?.map((m) => m.id)).toEqual(["user-2"]);
    },
  };
}

const run = async (scenario: ReplayScenario<World>): Promise<void> => {
  await replay(scenario, { limit: LIMIT, order: process.env["REPLAY_ORDER"] });
};

it("enumerates causal orders, respects socket FIFO and samples deterministically above its bound", async () => {
  const events = [event("request", [], noop), event("response", ["request"], noop), event("push", ["request"], noop)];
  expect(schedules(events)).toEqual({ exhaustive: true, orders: [["request", "response", "push"], ["request", "push", "response"]] });
  expect(schedules(events, 1)).toMatchObject({ exhaustive: false, orders: [["request", "response", "push"]] });
  expect(regression(events, '["request","push","response"]')).toEqual(["request", "push", "response"]);
  for (const invalid of ['["response","request","push"]', '["request","request","push"]', '["request","response","unknown"]', '[1,2,3]']) expect(() => regression(events, invalid)).toThrow();
  expect(() => schedules([event("x", ["y"], noop), event("y", ["x"], noop)])).toThrow("Cyclic");
  expect(() => schedules([event("x", ["missing"], noop)])).toThrow("Unknown");
  expect(() => schedules([event("x", [], noop), event("x", [], noop)])).toThrow("Duplicate");
  const fifo = [
    event("write", [], noop, { emit: () => [frame("A", "push-A"), frame("B", "push-B"), frame("A", "response")] }),
    event("push-A", ["write"], noop, { delivery: true }),
    event("push-B", ["write"], noop, { delivery: true }),
    event("response", ["write"], noop, { delivery: true }),
  ];
  expect(schedules(fifo).orders).toHaveLength(3);
  expect(() => regression(fifo, '["write","response","push-A","push-B"]')).toThrow("FIFO");
  const larger = ["a", "b", "c", "d", "e"].map((name) => event(name, [], noop));
  const sampled = explore(larger, 16);
  expect(sampled.exhaustive).toBe(false);
  expect(sampled.orders).toHaveLength(16);
  expect(explore(larger, 16)).toEqual(sampled);
  for (const order of sampled.orders) expect(regression(larger, JSON.stringify(order))).toEqual(order);
  const required = ["e", "d", "c", "b", "a"];
  expect(explore(larger, 16, [], [required]).orders).toContainEqual(required);
  expect(explore(larger, 16, [], [required]).orders).toHaveLength(16);
  expect(() => explore(larger, 1, [], [required, ["a", "b", "c", "d", "e"]])).toThrow("witnesses exceed");
  expect(() => explore(larger, 16, [], [["missing"]])).toThrow();
  const seen: string[] = [];
  const scenario: ReplayScenario<string[]> = { name: "harness negative control", events: [{ name: "break", run: (w) => { w.push("broken"); } }], create: async () => [], dispose: async () => { seen.push("disposed"); }, check: (w) => { if (w.includes("broken")) throw new Error("planted invariant failure"); } };
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try { await expect(replay(scenario)).rejects.toThrow('REPLAY_ORDER=\'["break"]\''); }
  finally { error.mockRestore(); }
  expect(seen).toEqual(["disposed"]);
});

it("SL-01: explores sender push then response before hydration, with the other window independent", () => {
  for (const scenario of [ownSpeech(), ownSpeech(true), foreignSpeech(), foreignSpeech(false, false), foreignSpeech(true)]) {
    const { orders } = explore(scenario.events, LIMIT, scenario.initialFrames, scenario.witnesses);
    const committed = (order: readonly string[]) => !order.includes("B.disconnect.push-to-A") ||
      before(order, "A.health.complete", "B.disconnect.push-to-A") || before(order, "B.disconnect.push-to-A", "A.connect.request");
    expect(orders.some((order) => committed(order) && before(order, "A.connect.push-to-A", "A.connect.response") &&
      before(order, "A.connect.response", "hydration.release") && before(order, "hydration.release", "A.connect.push-to-B")), scenario.name + ": independent late second-window delivery").toBe(true);
    expect(orders.some((order) => committed(order) && before(order, "A.connect.push-to-B", "A.connect.push-to-A")), scenario.name + ": second window can receive first").toBe(true);
    expect(orders.some((order) => committed(order) && before(order, "hydration.release", "A.connect.push-to-A")), scenario.name + ": push can arrive after hydration too").toBe(true);
    for (const order of orders) expect(regression(scenario.events, JSON.stringify(order), scenario.initialFrames)).toEqual(order);
  }
});

it("audits Send and Stop samples against admission and socket guarantees", () => {
  const stop = stopSend();
  const stopOrders = explore(stop.events, LIMIT).orders;
  expect(stopOrders.some((order) => before(order, "server.next-admission.complete", "server.first-admission.complete"))).toBe(true);
  expect(stopOrders.some((order) => before(order, "turn-2.response", "turn-1.response"))).toBe(true);
  expect(stopOrders.some((order) => before(order, "turn-1.response", "turn-1.push-to-B"))).toBe(true);
  for (const order of stopOrders) {
    expect(before(order, "turn-1.push-to-A", "turn-1.response")).toBe(true);
    expect(before(order, "turn-2.push-to-A", "turn-2.response")).toBe(true);
    expect(regression(stop.events, JSON.stringify(order))).toEqual(order);
  }
  const send = sendReconnect();
  const sendOrders = explore(send.events, LIMIT).orders;
  expect(sendOrders.some((order) => before(order, "server.admission.complete", "socket.drop"))).toBe(true);
  expect(sendOrders.some((order) => before(order, "socket.drop", "server.admission.complete") && before(order, "server.admission.complete", "socket.reconnect"))).toBe(true);
  expect(sendOrders.some((order) => before(order, "socket.reconnect", "server.admission.complete"))).toBe(true);
  for (const order of sendOrders) expect(regression(send.events, JSON.stringify(order))).toEqual(order);
});

it("speech preserves a newer Connect across its own Disconnect", () => run(ownSpeech()));
it("speech ignores a superseded health completion", () => run(ownSpeech(true)));
it.each([true, false])("speech cancels Connect at foreign receipt (tagged=%s)", (tagged) => run(foreignSpeech(false, tagged)));
it("speech ignores unrelated foreign settings during hydration", () => run(foreignSpeech(true)));
it("a message stays visible and sends once across reconnect", () => run(sendReconnect()));
it("Stop applies only to its original reply around acknowledgements", () => run(stopSend()));
it("Stop with a saved partial is one row whenever the saved row arrives", async () => {
  const scenario = stopSavedPartial();
  const { orders } = explore(scenario.events, LIMIT);
  expect(orders.some((order) => before(order, "saved.push-to-A", "A.next-send.request"))).toBe(true);
  expect(orders.some((order) => before(order, "A.next-send.request", "saved.push-to-A") && before(order, "saved.push-to-A", "turn-2.response"))).toBe(true);
  expect(orders.some((order) => before(order, "turn-2.response", "saved.push-to-A"))).toBe(true);
  await run(scenario);
});

it("a runtime error after some words keeps the server's reason in the one note", () => run(errorSavedPartial()));
it("Retry removes the old rows even when history reloaded them as new objects", () => run(retryThroughHistory()));

it("TL-01: active-turn hydration restores ongoing replies and orders terminal events around its snapshot", async () => {
  for (const ending of ["running", "offline", "during-hydration"] as const) {
    const reconnect = "socket.reconnect";
    await run({
      name: `active turns: ${ending}`,
      create: async () => {
        const w = await OrderingWorld.create(false);
        w.server.answer("turns.active", () => [...w.server.turns].map(([turnId, message]) => ({ turnId, threadId: message.threadId })));
        w.server.turns.set("existing", { id: "user-existing", threadId: "t1", role: "user", content: "hello", createdAt: 1 });
        await w.step(() => w.server.chatPush("existing", w.a.socket));
        expect(runningIds(w.a.store)).toEqual({ t1: "existing" });
        await w.drop();
        if (ending === "offline") w.server.turns.delete("existing");
        return w;
      },
      events: [
        event(reconnect, [], w => w.reconnect()),
        ...hydrationEvents(reconnect),
        ...(ending === "during-hydration" ? [event("server.done", [reconnect], w => w.step(() => {
          w.server.chatPush("existing", w.a.socket, true);
          w.server.turns.delete("existing");
        }))] : []),
      ],
      check: (w, prefix) => {
        if (!prefix.includes("hydration.snapshot") || !prefix.includes("hydration.release") ||
          (ending === "during-hydration" && !prefix.includes("server.done"))) return;
        expect(runningIds(w.a.store)).toEqual(ending === "running" ? { t1: "existing" } : {});
      },
      dispose,
    });
  }
});
