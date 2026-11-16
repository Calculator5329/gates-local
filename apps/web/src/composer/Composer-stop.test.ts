// The compact Stop beside a queued edit or a touch draft stops the reply when
// pressed. Composer.test.ts counts that button in static markup; this presses
// it, calling the handler from the element tree with React's hooks stubbed.
import { isValidElement, type ReactElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { LiveTurn, State } from "../lib/store/store.ts";

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
vi.mock("../lib/store/store.ts", async (original) => {
  const store = await original<typeof import("../lib/store/store.ts")>();
  return { ...store, useStore: <T,>(selector: (s: State) => T): T => selector(store.getState()) };
});
vi.mock("../lib/session/index.ts", () => ({
  ...Object.fromEntries(["cancelQueuedEdit", "cancelStopAsk", "confirmStopAsk", "editQueued", "openSettings", "pickModel", "pull", "removeQueued", "send", "sendQueuedNow", "setContext", "stop", "recheckRuntime"].map((name) => [name, vi.fn()])),
  firstPull: () => undefined,
  sendsBeforeReady: () => false,
}));
vi.mock("../fit/FitPanel.tsx", () => ({ openFit: vi.fn() }));
vi.mock("./focus.ts", () => ({ focusComposer: vi.fn() }));
vi.mock("../lib/ui/ui.tsx", async (original) => ({ ...await original<typeof import("../lib/ui/ui.tsx")>(), useMedia: () => probe.touch, isTouch: () => probe.touch }));

const { Composer } = await import("./Composer.tsx");
const { stop } = await import("../lib/session/index.ts");
const { getState, setState } = await import("../lib/store/store.ts");
const { clearDraft, replaceDraft } = await import("../lib/store/drafts.ts");
const initial = getState();
afterEach(() => { clearDraft("thread"); setState(initial); probe.touch = false; vi.mocked(stop).mockClear(); });

const live: LiveTurn = { threadId: "thread", turnId: "turn", model: "qwen3.5:9b", startedAt: 0, thinking: "", text: "Reply", tools: [] };
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
    const stops = nodes(Composer()).filter(n => n.type === "button" && n.props["aria-label"] === "Stop");
    expect(stops).toHaveLength(1);
    const press = stops[0]!.props as { onPointerDown(): void; onClick(event: unknown): void };
    press.onPointerDown();
    press.onClick({ preventDefault: () => undefined, detail: 1 });
    expect(stop).toHaveBeenCalledTimes(1);
  });
}
