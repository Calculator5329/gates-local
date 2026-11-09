import { type ComponentProps, type ReactElement, type ReactNode, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";

// Keep Markdown's refs across server renders to exercise its element cache
// without a browser. React still renders the real block components.
const refs = vi.hoisted(() => {
  let cursor = 0;
  const slots: { current: unknown }[] = [];
  return {
    reset() { cursor = 0; slots.length = 0; },
    render() { cursor = 0; },
    useRef(value: unknown) { return slots[cursor++] ??= { current: value }; },
  };
});
vi.mock("react", async (original) => ({ ...await original<typeof import("react")>(), useRef: refs.useRef }));
import { Markdown } from "./markdown.tsx";

beforeEach(() => refs.reset());
const url = "https://tool.example/report";
const render = (text: string, allowedLinks: ReadonlySet<string> | undefined, live = true) => {
  refs.render();
  return renderToStaticMarkup(createElement(Markdown, { text, live, allowedLinks }));
};

it.each([true, false])("updates completed blocks when provenance %s gains then loses a URL", (restricted) => {
  const absent = restricted ? new Set<string>() : undefined;
  const text = `[Report](${url})\n\nTail`;
  render(text, absent);
  render(text + " grows", absent);
  expect(render(text + " grows", new Set([url]))).toContain(`href="${url}"`);
  expect(render(text + " grows", new Set())).not.toContain("<a ");
});

it("retains completed elements on ordinary frames and invalidates them on permission changes", () => {
  // Markdown returns its real keyed children; inspect element identity before
  // React renders them, rather than using timing as a proxy for saved work.
  // React's runtime memo object exposes its wrapped component, though the
  // function-component overload types only the public callable signature.
  const component = Reflect.get(Markdown, "type") as (props: ComponentProps<typeof Markdown>) => ReactElement<{ children: ReactNode[] }>;
  const allowedLinks = new Set([url]);
  const props = { text: `[Report](${url})\n\nTail`, live: true, allowedLinks };
  const rows = (text: string, links = allowedLinks) => {
    refs.render();
    return component({ ...props, text, allowedLinks: links }).props.children;
  };
  const first = rows(props.text);
  const second = rows(props.text + " grows");
  expect(second[0]).toBe(first[0]);
  expect(rows(props.text + " grows more")[0]).toBe(first[0]);
  expect(rows(props.text + " grows more", new Set())[0]).not.toBe(first[0]);
});
