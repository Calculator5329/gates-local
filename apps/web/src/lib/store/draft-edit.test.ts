import { expect, it, vi } from "vitest";

it("M09: moving between queued editors preserves the first backup", async () => {
  vi.resetModules(); const d = await import("./drafts.ts");
  d.replaceDraft("A", { text: "original draft", images: ["original image"], sendId: "original-id" });
  d.beginQueuedDraft("A", "first queue", [], null);
  d.replaceDraft("A", { text: "first queue edited" }, true);
  d.beginQueuedDraft("A", "second queue", [], null);
  d.cancelQueuedDraft("A");
  expect(d.getDraft("A")).toMatchObject({ text: "original draft", images: ["original image"], sendId: "original-id" });
});
