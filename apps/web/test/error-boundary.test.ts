import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ErrorBoundary } from "../src/ErrorBoundary.tsx";

it("SN-14 a retry that commits and then fails in an effect still offers Reload window", () => {
  const boundary = new ErrorBoundary({ scope: "app", children: createElement("p", null, "Conversation") });
  boundary.state = { error: null, retried: true };
  // Replay the queued update from a successful commit, followed by effect failure.
  // The browser probe also drives this order with a real useLayoutEffect.
  boundary.setState = update => {
    const next = typeof update === "function" ? update(boundary.state, boundary.props) : update;
    if (next) boundary.state = { ...boundary.state, ...next };
  };
  const committed: unknown = Reflect.get(boundary, "componentDidUpdate");
  if (typeof committed === "function") committed.call(boundary);
  boundary.state = { ...boundary.state, ...ErrorBoundary.getDerivedStateFromError(new Error("Effect failed")) };
  expect(renderToStaticMarkup(boundary.render())).toContain(">Reload window</button>");
});

it("SN-16 thread retries always offer Try again", () => {
  const boundary = new ErrorBoundary({ scope: "thread", children: null });
  boundary.state = { error: "Message failed", retried: true };
  const html = renderToStaticMarkup(boundary.render());
  expect(html).toContain(">Try again</button>");
  expect(html).not.toContain("Reload window");
});
