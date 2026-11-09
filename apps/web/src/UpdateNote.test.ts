// The note after an update, on a phone: dismissing it clears the phone's own
// copy and never writes to the computer, so the button stays.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({ state: undefined as unknown }));
vi.mock("./store.ts", () => ({ NA: "na", useStore: (fn: (s: unknown) => unknown) => fn(store.state) }));
vi.mock("./session.ts", () => ({ dismissUpdateResult: () => undefined }));

const { UpdateNote } = await import("./UpdateNote.tsx");

it("a phone, where update.dismissResult is computer-only, still offers Dismiss", () => {
  store.state = {
    update: { canControl: false, result: { at: 1, outcome: "updated", line: "Updated to v0.2.0." } },
    unavailable: { "update.dismissResult": true },
  };
  expect(renderToStaticMarkup(createElement(UpdateNote))).toContain("Dismiss");
});
