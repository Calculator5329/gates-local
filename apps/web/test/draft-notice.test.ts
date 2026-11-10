import { expect, it, vi } from "vitest";

it("R6: typing dismisses the notice and warning once, and they stay dismissed", async () => {
  vi.resetModules();
  const store = await import("../src/store.ts"), drafts = await import("../src/drafts.ts");
  store.setState({ threadId: "A", notice: "Your message is back in the box.", stopAsk: { blocking: [], content: "same words", model: "model", threadId: "A", keepDraft: false } });
  let publications = 0; const off = store.subscribe(() => { publications++; });
  drafts.editDraft("new words");
  expect(store.getState().notice).toBeNull();
  expect(store.getState().stopAsk).toBeNull();
  drafts.editDraft("same words");
  expect(store.getState().stopAsk).toBeNull();
  expect(publications).toBe(1); off();
});
