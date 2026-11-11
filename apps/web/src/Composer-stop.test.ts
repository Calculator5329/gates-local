// The compact Stop beside a queued edit or a touch draft stops the reply when
// pressed. Composer.test.ts counts that button in static markup; this presses
// it, calling the handler from the element tree with React's hooks stubbed.
import { isValidElement, type ReactElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { LiveTurn, State } from "./store.ts";

const probe = vi.hoisted(() => ({ touch: false }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useEffect: () => undefined, useLayoutEffect: () => undefined,
  useState: (initial: unknown) => [typeof initial === "function" ? (initial as () => unknown)() : initial, () => undefined],
  useRef: (initial: unknown) => ({ current: initial }),
  useCallback: (fn: unknown) => fn,
  useMemo: (fn: () => unknown) => fn(),
  useSyncExternalStore: (_subscribe: unknown, get: () => unknown) => get(),
}));
vi.mock("./store.ts", async (original) => {
  const store = await original<typeof import("./store.ts")>();
  return { ...store, useStore: <T,>(selector: (s: State) => T): T => selector(store.getState()) };
});
vi.mock("./session.ts", () => ({
  ...Object.fromEntries(["cancelQueuedEdit", "cancelStopAsk", "confirmStopAsk", "editQueued", "ensureFit", "openSettings", "pickModel", "pull", "removeQueued", "send", "sendQueuedNow", "setContext", "stop", "recheckRuntime"].map((name) => [name, vi.fn()])),
  firstPull: () => undefined,
  queueReason: () => null,
}));
vi.mock("./FitPanel.tsx", () => ({ openFit: vi.fn() }));
vi.mock("./Sidebar.tsx", () => ({ focusComposer: vi.fn() }));
vi.mock("./ui.tsx", async (original) => ({ ...await original<typeof import("./ui.tsx")>(), useMedia: () => probe.touch, isTouch: () => probe.touch }));

const { Composer } = await import("./Composer.tsx");
const { stop } = await import("./session.ts");
const { getState, setState } = await import("./store.ts");
const { clearDraft, replaceDraft } = await import("./drafts.ts");
const initial = getState();
afterEach(() => { clearDraft("thread"); setState(initial); probe.touch = false; vi.mocked(stop).mockClear(); });

const live: LiveTurn = { gen: 1, threadId: "thread", turnId: "turn", model: "qwen3.5:9b", startedAt: 0, thinking: "", text: "Reply", tools: [], pendingUser: null };
const running: State = {
  ...initial,
  conn: { kind: "open" },
  runtime: { state: "ready", owner: "external", baseUrl: "http://127.0.0.1:5288", version: "test" },
  models: [{ name: "qwen3.5:9b", digest: "test", sizeBytes: 1, modifiedAt: "", capabilities: ["completion", "thinking"] }],
  model: "qwen3.5:9b",
  view: "thread",
  threadId: "thread",
  turns: { thread: live },
};

function nodes(node: unknown): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...nodes(node.props["children"])];
}

for (const touch of [false, true]) {
  it(`the compact Stop beside ${touch ? "a touch draft" : "a queued edit"} stops the running reply`, () => {
    probe.touch = touch;
    setState({ ...running, editingQueued: touch ? null : "queued" });
    replaceDraft("thread", { text: "Keep this draft" });
    const stops = nodes(Composer()).filter(n => n.type === "button" && n.props["aria-label"] === "Stop reply");
    expect(stops).toHaveLength(1);
    const press = stops[0]!.props as { onPointerDown(): void; onClick(event: unknown): void };
    press.onPointerDown();
    press.onClick({ preventDefault: () => undefined, detail: 1 });
    expect(stop).toHaveBeenCalledTimes(1);
  });
}
