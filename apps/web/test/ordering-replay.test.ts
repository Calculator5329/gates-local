import { expect, it, vi } from "vitest";
import { explore, replay, regression, schedules, type ReplayEvent, type ReplayFrame, type ReplayScenario } from "./ordering-replay.ts";
import { OrderingWorld } from "./ordering-world.ts";

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
// return before responding. FIFO applies separately to each recipient socket.
function settingsFrames(stem: string, sender: "A" | "B"): ReplayFrame[] {
  return [frame("A", stem + ".push-to-A"), frame("B", stem + ".push-to-B"), frame(sender, stem + ".response")];
}

function settingsDeliveries(stem: string, key: string, write: string, sender: "A" | "B", optional = false, tagged = true): Event[] {
  return [
    // Each push follows its producing settings.update; recipients are independent.
    event(stem + ".push-to-A", [write], (w) => w.step(() => {
      if (stem === "B.disconnect" && w.connectStarted) w.eligible = false;
      w.server.settingsPush(key, w.a.socket, tagged, optional);
    }), { delivery: true }),
    event(stem + ".push-to-B", [write], (w) => w.step(() => w.server.settingsPush(key, w.b.socket, true, optional)), { delivery: true }),
    // Sender receives broadcast before response on the same WebSocket.
    event(stem + ".response", [stem + ".push-to-" + sender], (w) => w.step(() => w.server.response(key, optional)), { delivery: true }),
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
    }, { delivery: true, emit: (prefix) => valid(prefix) ? settingsFrames(stem, "A") : [] }),
    ...settingsDeliveries(stem, key, complete, "A", true),
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

export function ownSpeech(staleHealth = false): ReplayScenario<World> {
  return {
    name: staleHealth ? "speech: superseded health" : "speech: own Disconnect during hydration",
    create: speechWorld, dispose, check: speechCheck,
    initialFrames: [frame("A", "hydration.snapshot")],
    events: [
      ...(staleHealth ? [connectRequest([], true)] : []),
      // Selected input script: optionally Connect, then Disconnect, then Connect.
      // These action edges specify the user's intent, not network guarantees.
      event("A.disconnect.request", staleHealth ? ["A.old-connect.request"] : [], (w) => w.step(() => {
        w.intent = "disconnect"; w.eligible = false; w.a.click("Disconnect");
      }), { emit: () => settingsFrames("A.disconnect", "A") }),
      connectRequest(["A.disconnect.request"]),
      ...settingsDeliveries("A.disconnect", "A-disconnect", "A.disconnect.request", "A"),
      ...healthEvents("A.connect.request"),
      ...(staleHealth ? healthEvents("A.old-connect.request", true) : []),
      ...hydrationEvents(),
    ],
  };
}

export function foreignSpeech(theme = false, tagged = true): ReplayScenario<World> {
  return {
    name: "speech: foreign Disconnect" + (theme ? " and theme" : "") + (tagged ? "" : " (legacy push)"),
    create: speechWorld, dispose, check: speechCheck,
    initialFrames: [frame("A", "hydration.snapshot")],
    events: [
      // The two windows' input actions have no cross-window causal edge.
      connectRequest([]),
      event("B.disconnect.request", [], (w) => w.step(() => { void w.b.session.updateSettings({ whisperUrl: null }); }), { emit: () => settingsFrames("B.disconnect", "B") }),
      ...settingsDeliveries("B.disconnect", "B-disconnect", "B.disconnect.request", "B", false, tagged),
      ...(theme ? [
        // Input script changes appearance after speech, without waiting for its ack.
        event("B.theme.request", ["B.disconnect.request"], (w) => w.step(() => { void w.b.session.updateSettings({ theme: "light" }); }), { emit: () => settingsFrames("B.theme", "B") }),
        ...settingsDeliveries("B.theme", "B-theme", "B.theme.request", "B"),
      ] : []),
      ...healthEvents("A.connect.request", false, true),
      ...hydrationEvents(),
    ],
  };
}

// app.ts stores the user row and broadcasts start before chat.send returns.
// Closed sockets receive no broadcast; a reconnect never resends an old start.
function chatFrames(turn: string, prefix: readonly string[], reconnecting = false): ReplayFrame[] {
  const target = !reconnecting ? "A" : prefix.includes("socket.reconnect") ? "A2" : prefix.includes("socket.drop") ? undefined : "A1";
  return [
    ...(target ? [frame(target, turn + ".push-to-A")] : []),
    frame("B", turn + ".push-to-B"),
    ...(!reconnecting || !prefix.includes("socket.drop") ? [frame(reconnecting ? "A1" : "A", turn + ".response")] : []),
  ];
}

function chatDeliveries(turn: string, admitted: string): Event[] {
  return [
    // A broadcast is emitted by admission, independently to each open socket.
    event(turn + ".push-to-A", [admitted], (w) => w.step(() => w.server.admittedPush(turn, "A")), { delivery: true }),
    event(turn + ".push-to-B", [admitted], (w) => w.step(() => w.server.admittedPush(turn, "B")), { delivery: true }),
    // app.ts returns after broadcasting start. Per-socket FIFO adds the edge
    // only when A's broadcast and response actually target the same socket.
    event(turn + ".response", [admitted], (w) => w.step(() => w.server.response(turn)), { delivery: true }),
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
      ...chatDeliveries("turn-1", "server.admission.complete"),
      ...hydrationEvents("socket.reconnect", "A2"),
    ],
    check(w, order) {
      const state = w.a.store.getState();
      expect(w.server.calls("chat.send"), "one user action must send once").toHaveLength(1);
      const visible = state.draft === "one message" || state.live?.pendingUser === "one message" ||
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
        const turnId = w.a.store.getState().live?.turnId;
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
        expect(w.a.store.getState().live).toMatchObject({ turnId: "turn-2", threadId: "t2", pendingUser: null });
        expect(w.a.store.getState().live?.end).toBeUndefined();
      }
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
  const seen: string[] = [];
  const scenario: ReplayScenario<string[]> = { name: "harness negative control", events: [{ name: "break", run: (w) => { w.push("broken"); } }], create: async () => [], dispose: async () => { seen.push("disposed"); }, check: (w) => { if (w.includes("broken")) throw new Error("planted invariant failure"); } };
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try { await expect(replay(scenario)).rejects.toThrow('REPLAY_ORDER=\'["break"]\''); }
  finally { error.mockRestore(); }
  expect(seen).toEqual(["disposed"]);
});

it("SL-01: explores sender push then response before hydration, with the other window independent", () => {
  for (const scenario of [ownSpeech(), ownSpeech(true), foreignSpeech(), foreignSpeech(false, false), foreignSpeech(true)]) {
    const { orders } = explore(scenario.events, LIMIT, scenario.initialFrames);
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
