import { createElement, isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";

// The failure screen's Copy button is not under test; its hook would need a render.
vi.mock("../src/copy.ts", () => ({ useCopy: () => [undefined, () => undefined] }));
const { ErrorBoundary } = await import("../src/ErrorBoundary.tsx");

afterEach(() => vi.unstubAllGlobals());

type Node = ReactElement<Record<string, unknown>>;
/** Expands function components and lists every element, so a button's own handler can be called. */
function nodes(node: unknown): Node[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  if (typeof node.type === "function") return nodes((node.type as (p: unknown) => unknown)(node.props));
  return [node, ...nodes(node.props["children"])];
}
function press(boundary: InstanceType<typeof ErrorBoundary>, label: string) {
  const button = nodes(boundary.render()).find(n => n.type === "button" && n.props["children"] === label);
  if (button === undefined) throw new Error(`Expected a ${label} button`);
  (button.props["onClick"] as () => void)();
}
/** Applies setState at once, as a committed update would. */
function applyUpdates(boundary: InstanceType<typeof ErrorBoundary>) {
  boundary.setState = update => {
    const next = typeof update === "function" ? update(boundary.state, boundary.props) : update;
    if (next) boundary.state = { ...boundary.state, ...next };
  };
}

it("SN-14 a retry that commits and then fails in an effect still offers Reload window, which reloads", () => {
  const boundary = new ErrorBoundary({ scope: "app", children: createElement("p", null, "Conversation") });
  boundary.state = { error: null, retried: true };
  // Replay the queued update from a successful commit, followed by effect failure.
  // The browser probe also drives this order with a real useLayoutEffect.
  applyUpdates(boundary);
  const committed: unknown = Reflect.get(boundary, "componentDidUpdate");
  if (typeof committed === "function") committed.call(boundary);
  boundary.state = { ...boundary.state, ...ErrorBoundary.getDerivedStateFromError(new Error("Effect failed")) };
  expect(renderToStaticMarkup(boundary.render())).toContain(">Reload window</button>");
  const reload = vi.fn();
  vi.stubGlobal("window", { location: { reload } });
  press(boundary, "Reload window");
  expect(reload).toHaveBeenCalledTimes(1);
});

it("SN-16 thread retries always offer Try again, which shows the conversation again", () => {
  const boundary = new ErrorBoundary({ scope: "thread", children: createElement("p", null, "Conversation") });
  boundary.state = { error: "Message failed", retried: true };
  const html = renderToStaticMarkup(boundary.render());
  expect(html).toContain(">Try again</button>");
  expect(html).not.toContain("Reload window");
  applyUpdates(boundary);
  press(boundary, "Try again");
  expect(boundary.state).toEqual({ error: null, retried: true });
  expect(renderToStaticMarkup(boundary.render())).toBe("<p>Conversation</p>");
});
