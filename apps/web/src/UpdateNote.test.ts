// The note after an unsuccessful update, on a phone: dismissing it clears the phone's own
// copy and never writes to the computer, so the button stays.
import { isValidElement, type ReactElement } from "react";
import { expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({ state: undefined as unknown, dismiss: vi.fn() }));
vi.mock("./store.ts", () => ({ NA: "na", useStore: (fn: (s: unknown) => unknown) => fn(store.state) }));
vi.mock("./session.ts", () => ({ dismissUpdateResult: store.dismiss }));

const { UpdateNote } = await import("./UpdateNote.tsx");

type Node = ReactElement<Record<string, unknown>>;
/** Expands function components (UpdateNoteView here uses no hooks) and lists every element. */
function nodes(node: unknown): Node[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  if (typeof node.type === "function") return nodes((node.type as (p: unknown) => unknown)(node.props));
  return [node, ...nodes(node.props["children"])];
}

it("a phone, where update.dismissResult is computer-only, still offers Dismiss for an unsuccessful update, and pressing it dismisses", () => {
  store.state = {
    update: { canControl: false, result: { at: 1, outcome: "stopped", line: "The update stopped. The previous version is restored." } },
    unavailable: { "update.dismissResult": true },
  };
  const dismiss = nodes(UpdateNote()).find(n => n.type === "button" && n.props["children"] === "Dismiss");
  if (dismiss === undefined) throw new Error("Expected a Dismiss button");
  expect(store.dismiss).not.toHaveBeenCalled();
  (dismiss.props["onClick"] as () => void)();
  expect(store.dismiss).toHaveBeenCalledTimes(1);
});
