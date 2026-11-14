// Decision 26: a typed model name reaches the Ollama registry only on Enter or
// on Download, never while it is typed (README, Privacy). The rendered
// handlers run without a browser; the hooks are a stand-in that keeps state
// between renders.
import { isValidElement, type ReactElement } from "react";
import { beforeEach, expect, it, vi } from "vitest";

const probe = vi.hoisted(() => ({
  states: [] as unknown[], cursor: 0,
  estimate: vi.fn(), start: vi.fn(),
}));
vi.mock("react", async original => ({
  ...await original<typeof import("react")>(),
  // effects run on every render, so a lookup an effect would start (the old debounce) is seen
  useEffect: (effect: () => unknown) => { effect(); }, useLayoutEffect: () => undefined,
  useState: (initial: unknown) => {
    const i = probe.cursor++;
    if (!(i in probe.states)) probe.states[i] = typeof initial === "function" ? initial() : initial;
    return [probe.states[i], (next: unknown) => { probe.states[i] = typeof next === "function" ? next(probe.states[i]) : next; }];
  },
  useRef: (initial: unknown) => ({ current: initial }),
}));
vi.mock("./store.ts", () => ({
  NA: "na", getState: () => ({}), setState: vi.fn(),
  useStore: (select: (s: unknown) => unknown) => select({ gpu: { vendor: "nvidia" }, unavailable: {}, models: [], catalog: [], pulls: {} }),
}));
vi.mock("./session.ts", () => ({ estimateModel: probe.estimate, pull: vi.fn(), cancelPull: vi.fn() }));
vi.mock("./settings-ui.tsx", async original => ({ ...await original<typeof import("./settings-ui.tsx")>(), useOutside: () => undefined }));
const { CustomPull } = await import("./ModelDownloads.tsx");

const GIB = 1024 ** 3;
const actions = { start: (name: string) => { probe.start(name); return Promise.resolve(true); }, cancel: vi.fn(), error: () => null };
function nodes(node: unknown): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...nodes(node.props.children)];
}
const render = () => { probe.cursor = 0; return CustomPull({ actions, numCtx: 16384 }); };
const input = () => nodes(render()).find(n => n.type === "input")!;
const download = () => nodes(render()).find(n => typeof n.props["onStart"] === "function")!;
const type = (value: string) => (input().props["onChange"] as (e: unknown) => void)({ target: { value } });
const press = (key: string) => (input().props["onKeyDown"] as (e: unknown) => void)({ key, preventDefault: () => undefined });
const settle = () => new Promise(r => setTimeout(r, 0));
const fit = (verdict: "fits" | "refuse") => ({ model: "x", numCtx: 16384, freeVramBytes: 16 * GIB, needVramBytes: (verdict === "fits" ? 8 : 40) * GIB, spillRamBytes: 0, verdict, source: "estimate", measuredAt: 0 });

beforeEach(() => {
  vi.clearAllMocks(); probe.states = [];
  probe.estimate.mockResolvedValue({ found: "yes", downloadBytes: 5 * GIB, fit: fit("fits") });
});

it("typing a name asks nothing, however long it waits; Enter asks once, for that name at the chat's context", async () => {
  vi.useFakeTimers();
  type("gemma4:26b");
  render();
  type("ollama run gemma4:27b");
  render();
  vi.advanceTimersByTime(60_000);
  vi.useRealTimers();
  await settle();
  expect(probe.estimate).not.toHaveBeenCalled();
  press("a");
  expect(probe.estimate).not.toHaveBeenCalled();
  press("Enter");
  await settle();
  expect(probe.estimate).toHaveBeenCalledExactlyOnceWith("gemma4:27b", 16384);
  expect(probe.start).not.toHaveBeenCalled();
});

it("Download with no answer yet asks first, then starts a model that runs", async () => {
  type("gemma4:26b");
  (download().props["onStart"] as () => void)();
  await settle();
  expect(probe.estimate).toHaveBeenCalledExactlyOnceWith("gemma4:26b", 16384);
  expect(probe.start).toHaveBeenCalledExactlyOnceWith("gemma4:26b");
});

it("Download after Enter uses the answer it has and asks nothing more", async () => {
  type("gemma4:26b");
  press("Enter");
  await settle();
  (download().props["onStart"] as () => void)();
  await settle();
  expect(probe.estimate).toHaveBeenCalledTimes(1);
  expect(probe.start).toHaveBeenCalledExactlyOnceWith("gemma4:26b");
});

it.each([
  ["a name the library lacks", { found: "no" }],
  ["a model too big for this computer", { found: "yes", downloadBytes: 30 * GIB, fit: fit("refuse") }],
])("Download stops at %s and says so under the field", async (_what, answer) => {
  probe.estimate.mockResolvedValue(answer);
  type("huge:1t");
  (download().props["onStart"] as () => void)();
  await settle();
  expect(probe.start).not.toHaveBeenCalled();
  // the button is now disabled, as it would be after Enter
  expect(download().props["disabled"]).toBe(true);
});
