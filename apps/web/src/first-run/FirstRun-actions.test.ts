// First run's buttons do what they say when pressed. FirstRun.test.ts reads the
// screen's words; this calls the handlers from the element tree, with React's
// hooks stubbed so the screen's components can be expanded outside a render.
import { isValidElement, type ReactElement } from "react";
import { expect, it, vi } from "vitest";

const probe = vi.hoisted(() => ({ state: undefined as unknown, recheck: vi.fn(), pull: vi.fn(), finish: vi.fn() }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useEffect: () => undefined,
  useState: (initial: unknown) => [typeof initial === "function" ? (initial as () => unknown)() : initial, () => undefined],
}));
vi.mock("../lib/store/store.ts", () => ({ NA: "na", useStore: (fn: (s: unknown) => unknown) => fn(probe.state) }));
vi.mock("../lib/session/index.ts", () => ({
  ...Object.fromEntries(["firstPull", "openSettings", "cancelPull"].map((name) => [name, () => undefined])),
  recheckRuntime: probe.recheck,
  pull: probe.pull,
  finishFirstRun: probe.finish,
}));
vi.mock("../composer/focus.ts", () => ({ focusComposer: () => undefined }));
vi.mock("../settings/Settings.tsx", () => ({ DlDetail: () => null }));
vi.mock("../lib/ui/ui.tsx", () => ({ VLabel: () => null }));

const { FirstRun } = await import("./FirstRun.tsx");

type Node = ReactElement<Record<string, unknown>>;
function nodes(node: unknown): Node[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  if (typeof node.type === "function") return nodes((node.type as (p: unknown) => unknown)(node.props));
  return [node, ...nodes(node.props["children"])];
}
const words = (node: Node): string => {
  const children = node.props["children"];
  return (Array.isArray(children) ? children : [children]).filter(c => typeof c === "string").join("");
};

it("Retry on a phone with no model asks the server to look for models again", () => {
  probe.state = {
    conn: { kind: "open" },
    runtime: { state: "ready", owner: "external" },
    models: [], catalog: [], numCtx: 16384, pulls: {}, fitTable: undefined, settings: {},
    unavailable: { "models.pull": true },
  };
  const retry = nodes(FirstRun()).filter(n => n.type === "button" && words(n) === "Retry");
  expect(retry).toHaveLength(1);
  (retry[0]!.props["onClick"] as () => void)();
  expect(probe.recheck).toHaveBeenCalledTimes(1);
});

it("Download and start starts the download and opens the chat at once, so the first message can wait in the composer", () => {
  probe.state = {
    conn: { kind: "open" },
    runtime: { state: "ready", owner: "app" },
    models: [], numCtx: 16384, pulls: {}, settings: {}, unavailable: {}, hydrationSettled: true,
    fitTable: { reading: { boot: "b", seq: 1, measuredAt: 0 }, memory: { kind: "gpu", freeBytes: 2 ** 34, usableBytes: 2 ** 34 }, rows: [{ model: "qwen3.5:9b", numCtx: 16384, freeVramBytes: 2 ** 34, needVramBytes: 2 ** 30, spillRamBytes: 0, shortfallBytes: 0, verdict: "fits", source: "estimate", stops: [] }] },
    catalog: [{ name: "qwen3.5:9b", label: "Qwen 3.5 9B", downloadBytes: 6e9, installed: false, recommended: true, rank: 0 }],
  };
  const go = nodes(FirstRun()).filter(n => n.type === "button" && n.props["data-testid"] === "first-run.cta.go");
  expect(go).toHaveLength(1);
  (go[0]!.props["onClick"] as () => void)();
  expect(probe.pull).toHaveBeenCalledWith("qwen3.5:9b");
  expect(probe.finish).toHaveBeenCalledWith("chat");
});
