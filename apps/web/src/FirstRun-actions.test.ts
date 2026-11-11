// First run's buttons do what they say when pressed. FirstRun.test.ts reads the
// screen's words; this calls the handlers from the element tree, with React's
// hooks stubbed so the screen's components can be expanded outside a render.
import { isValidElement, type ReactElement } from "react";
import { expect, it, vi } from "vitest";

const probe = vi.hoisted(() => ({ state: undefined as unknown, recheck: vi.fn() }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useEffect: () => undefined,
  useState: (initial: unknown) => [typeof initial === "function" ? (initial as () => unknown)() : initial, () => undefined],
}));
vi.mock("./store.ts", () => ({ NA: "na", useStore: (fn: (s: unknown) => unknown) => fn(probe.state) }));
vi.mock("./session.ts", () => ({
  ...Object.fromEntries(["finishFirstRun", "firstPull", "openSettings", "pull", "cancelPull"].map((name) => [name, () => undefined])),
  recheckRuntime: probe.recheck,
}));
vi.mock("./Sidebar.tsx", () => ({ focusComposer: () => undefined }));
vi.mock("./Settings.tsx", () => ({ DlDetail: () => null }));
vi.mock("./ui.tsx", () => ({ VLabel: () => null }));

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
