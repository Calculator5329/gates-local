import { expect, it, vi } from "vitest";
import { replay, regression, schedules, type ReplayEvent, type ReplayScenario } from "./ordering-replay.ts";
import { OrderingWorld, SPEECH_URL } from "./ordering-world.ts";

vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => [initial, () => {}],
  useRef: (initial: unknown) => ({ current: initial }),
  useEffect: () => {},
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}));

type World = OrderingWorld;
const event = (name: string, after: readonly string[], run: (world: World) => void | Promise<void>): ReplayEvent<World> => ({ name, after, run });
const reconnect = [
  event("socket.drop", [], (w) => w.drop()),
  event("socket.reconnect", ["socket.drop"], (w) => w.reconnect()),
  event("hydration.snapshot", ["socket.reconnect"], (w) => w.step(() => w.server.response("snapshot"))),
] as const;
const release = event("hydration.release", ["hydration.snapshot"], (w) => w.step(() => w.server.response("hydration")));
const connect = (after: readonly string[]) => event("A.connect.request", after, (w) => w.step(() => {
  w.connectStarted = true; w.eligible = true; w.a.click("Connect");
}));
const health = (after: readonly string[], key = "health-1") => event("A.health.complete", after, (w) => w.step(() => {
  w.server.response(key);
}));
const dispose = (w: World) => w.dispose();

function speechCheck(w: World, order: readonly string[], complete: boolean): void {
  // Independent oracle: only a speech action received after this attempt can
  // cancel it. Theme pushes and older local completions cannot do so.
  if (order.at(-1) === "A.health.complete" || order.at(-1) === "A.old-health.complete") {
    const commits = w.server.writes.filter(({ socket, patch }) => socket === w.a.socket && patch.whisperUrl === SPEECH_URL);
    expect(commits.length, "successful health check must save exactly the still-current Connect").toBe(Number(w.eligible));
  }
  if (complete) {
    for (const window of w.windows) {
      const settings = window.store.getState().settings;
      expect(settings === "na" ? undefined : settings?.whisperUrl, "both windows must match the last speech write in server order").toBe(w.server.settings.whisperUrl);
    }
  }
}

function finishConnect(after: readonly string[]): ReplayEvent<World>[] {
  return [
    event("A.connect.response", after, (w) => w.step(() => w.server.response("A-connect", true))),
    event("A.connect.push", ["A.connect.response"], (w) => w.step(() => {
      for (const window of w.windows) w.server.settingsPush("A-connect", window.socket, true, true);
    })),
  ];
}

export function ownSpeech(staleHealth = false): ReplayScenario<World> {
  return {
    name: staleHealth ? "speech: older health completion" : "speech: own Disconnect during hydration",
    create: () => OrderingWorld.create(), dispose, check: speechCheck,
    events: [
      ...reconnect,
      ...(staleHealth ? [event("A.old-connect.request", ["hydration.snapshot"], (w) => w.step(() => w.a.click("Connect")))] : []),
      event("A.disconnect.request", [staleHealth ? "A.old-connect.request" : "hydration.snapshot"], (w) => w.step(() => w.a.click("Disconnect"))),
      event("A.disconnect.push", ["A.disconnect.request"], (w) => w.step(() => {
        for (const window of w.windows) w.server.settingsPush("A-disconnect", window.socket);
      })),
      event("A.disconnect.response", ["A.disconnect.request"], (w) => w.step(() => w.server.response("A-disconnect"))),
      connect(["A.disconnect.request"]),
      ...(staleHealth ? [event("A.old-health.complete", ["A.health.complete"], (w) => w.step(() => w.server.response("health-1")))] : []),
      health(["A.connect.request"], staleHealth ? "health-2" : "health-1"),
      release,
      ...finishConnect(["A.health.complete", "A.disconnect.response", "A.disconnect.push", "hydration.release", ...(staleHealth ? ["A.old-health.complete"] : [])]),
    ],
  };
}

export function foreignSpeech(theme = false, tagged = true): ReplayScenario<World> {
  return {
    name: `speech: foreign Disconnect${theme ? " and unrelated theme" : ""}${tagged ? "" : " (legacy push)"}`,
    create: () => OrderingWorld.create(), dispose, check: speechCheck,
    events: [
      ...reconnect,
      event("B.disconnect.request", [theme ? "hydration.snapshot" : "A.connect.request"], (w) => w.step(() => {
        void w.b.session.updateSettings({ whisperUrl: null });
      })),
      // B observes its own write normally; delivery to A is independently held.
      event("B.disconnect.response", ["B.disconnect.request"], (w) => w.step(() => {
        w.server.response("B-disconnect"); w.server.settingsPush("B-disconnect", w.b.socket);
      })),
      event("B.disconnect.push-to-A", ["B.disconnect.request"], (w) => w.step(() => {
        if (w.connectStarted) w.eligible = false;
        w.server.settingsPush("B-disconnect", w.a.socket, tagged);
      })),
      connect(["hydration.snapshot"]),
      ...(theme ? [
        event("B.theme.request", ["B.disconnect.response"], (w) => w.step(() => { void w.b.session.updateSettings({ theme: "light" }); })),
        event("B.theme.push-to-A", ["B.theme.request", "B.disconnect.push-to-A"], (w) => w.step(() => {
          w.server.response("B-theme");
          for (const window of w.windows) w.server.settingsPush("B-theme", window.socket);
        })),
      ] : []),
      health(["A.connect.request", theme ? "B.theme.request" : "B.disconnect.request"]),
      release,
      ...finishConnect(["A.health.complete", "B.disconnect.response", "B.disconnect.push-to-A", "hydration.release", ...(theme ? ["B.theme.push-to-A"] : [])]),
    ],
  };
}

export function sendReconnect(): ReplayScenario<World> {
  return {
    name: "send across disconnect", dispose,
    create: async () => { const w = await OrderingWorld.create(); w.server.holdChat = true; w.server.deferAdmission = true; return w; },
    events: [
      event("A.send.request", [], (w) => w.step(() => {
        w.a.store.setState({ view: "thread", threadId: "t1", draft: "one message", messages: { t1: [] } });
        void w.a.session.send("one message");
      })),
      { ...reconnect[0], after: ["A.send.request"] },
      reconnect[1], reconnect[2], release,
      event("server.admission.complete", ["A.send.request"], (w) => w.step(() => w.server.admit("turn-1"))),
      event("A.send.response", ["server.admission.complete"], (w) => w.step(() => w.server.response("turn-1"))),
      event("server.start.push", ["socket.reconnect", "server.admission.complete"], (w) => w.step(() => w.server.chatPush("turn-1", w.a.socket))),
    ],
    check(w, order) {
      const state = w.a.store.getState();
      expect(w.server.calls("chat.send"), "one user action must send once").toHaveLength(1);
      const visible = state.draft === "one message" || state.live?.pendingUser === "one message" ||
        state.queued.some((queued) => queued.text === "one message") || (state.messages["t1"] ?? []).some((message) => message.content === "one message");
      expect(visible, `message must remain visible after ${order.at(-1)}`).toBe(true);
      if (w.server.admissions.has("turn-1") || w.server.turns.has("turn-1")) expect(state.queued.filter((queued) => queued.text === "one message"), "active admission must never return to queue").toEqual([]);
    },
  };
}

export function stopSend(): ReplayScenario<World> {
  return {
    name: "Stop and Send around acknowledgement", dispose,
    create: async () => { const w = await OrderingWorld.create(); w.server.holdChat = true; return w; },
    events: [
      event("A.first-send.request", [], (w) => w.step(() => {
        w.a.store.setState({ view: "thread", threadId: "t1", draft: "first" }); void w.a.session.send("first");
      })),
      event("A.first-send.response", ["A.first-send.request"], (w) => w.step(() => w.server.response("turn-1"))),
      event("A.Stop", ["A.first-send.request"], (w) => w.step(() => {
        const turnId = w.a.store.getState().live?.turnId;
        if (turnId !== null && turnId !== undefined) expect(turnId).toBe("turn-1");
        w.expectedCancelled.add("turn-1"); w.a.session.stop();
      })),
      event("A.next-send.request", ["A.Stop"], (w) => w.step(() => {
        w.a.store.setState({ view: "thread", threadId: "t2", draft: "second" }); void w.a.session.send("second");
      })),
      event("A.next-send.response", ["A.next-send.request"], (w) => w.step(() => w.server.response("turn-2"))),
      event("server.first-start.push", ["A.first-send.request"], (w) => w.step(() => w.server.chatPush("turn-1", w.a.socket))),
      event("server.next-start.push", ["A.next-send.request", "server.first-start.push"], (w) => w.step(() => w.server.chatPush("turn-2", w.a.socket))),
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
  expect(schedules(scenario.events, 1024).exhaustive, "split the scenario instead of silently losing exhaustive coverage").toBe(true);
  await replay(scenario, { limit: 1024, order: process.env["REPLAY_ORDER"] });
};

it("enumerates every legal order, bounds larger schedules and validates pasted regressions", async () => {
  const events = [event("request", [], () => {}), event("response", ["request"], () => {}), event("push", ["request"], () => {})];
  expect(schedules(events)).toEqual({ exhaustive: true, orders: [["request", "response", "push"], ["request", "push", "response"]] });
  expect(schedules(events, 1)).toMatchObject({ exhaustive: false, orders: [["request", "response", "push"]] });
  expect(regression(events, '["request","push","response"]')).toEqual(["request", "push", "response"]);
  for (const invalid of ['["response","request","push"]', '["request","request","push"]', '["request","response","unknown"]', '[1,2,3]']) expect(() => regression(events, invalid)).toThrow();
  expect(() => schedules([event("x", ["y"], () => {}), event("y", ["x"], () => {})])).toThrow("Cyclic");
  expect(() => schedules([event("x", ["missing"], () => {})])).toThrow("Unknown");
  expect(() => schedules([event("x", [], () => {}), event("x", [], () => {})])).toThrow("Duplicate");
  const seen: string[] = [];
  const scenario: ReplayScenario<string[]> = { name: "harness negative control", events: [{ name: "break", run: (w) => { w.push("broken"); } }], create: async () => [], dispose: async () => { seen.push("disposed"); }, check: (w) => { if (w.includes("broken")) throw new Error("planted invariant failure"); } };
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try { await expect(replay(scenario)).rejects.toThrow('REPLAY_ORDER=\'["break"]\''); }
  finally { error.mockRestore(); }
  expect(seen).toEqual(["disposed"]);
});

it("speech preserves a newer Connect across its own Disconnect", () => run(ownSpeech()));
it("speech ignores a superseded health completion", () => run(ownSpeech(true)));
it.each([true, false])("speech cancels Connect at foreign receipt (tagged=%s)", (tagged) => run(foreignSpeech(false, tagged)));
it("speech ignores unrelated foreign settings during hydration", () => run(foreignSpeech(true)));
it("a message stays visible and sends once across reconnect", () => run(sendReconnect()));
it("Stop applies only to its original reply around acknowledgements", () => run(stopSend()));
