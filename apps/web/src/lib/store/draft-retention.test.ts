import { expect, it, vi } from "vitest";

it.each([false, true])("R2: omitted images invalidate that copy's send identity (backup: %s)", async backup => {
  vi.resetModules();
  const d = await import("./drafts.ts");
  d.replaceDraft("A", { text: "look", images: ["image-A"], sendId: "with-image" });
  if (backup) d.beginQueuedDraft("A", "queued text", [], "queued-id");
  d.replaceDraft("B", { text: "b", images: ["image-B"] });
  d.replaceDraft("C", { text: "c", images: ["image-C"] });
  const copy = d.savedDrafts().find(slot => slot.key === "A")?.draft;
  const words = backup ? copy?.beforeEdit : copy;
  expect(words?.images).toEqual([]);
  expect(words?.sendId).toBeNull();
  expect(backup ? d.getDraft("A").beforeEdit?.sendId : d.getDraft("A").sendId).toBe("with-image");
});
