import { expect, it } from "vitest";
import { recoverDraft } from "./draft-persistence.ts";

it("keeps a restored draft or queued copy's saved-message identity for a safe retry", () => {
  expect(recoverDraft({ draft: "retry words", images: [], sendId: "draft-send", sendThreadId: "A", queued: [{ id: "q", messageId: "queued-send", threadId: "t", text: "queued words", images: [], at: 1 }] })).toMatchObject({ sendId: "draft-send", sendThreadId: "A", queued: [expect.objectContaining({ messageId: "queued-send" })] });
});

it("restores image drafts and queued attachments on hold without losing their model or order", () => {
  const images = ["data:image/png;base64,eA=="];
  expect(recoverDraft({ draft: "look", images, editing: "q-first", queued: [{ id: "q-first", threadId: "t", text: "first", images, at: 1, model: "vision", waitFor: "reply", now: true }, { id: "q-second", threadId: "t", text: "second", at: 2, waitFor: "download" }] })).toEqual({
    draft: "look", images, editing: "q-first", queued: [{ id: "q-first", threadId: "t", text: "first", images, at: 1, model: "vision", waitFor: "reply", held: true }, { id: "q-second", threadId: "t", text: "second", images: [], at: 2, waitFor: "reply", held: true }],
  });
});

it("ignores invalid persisted values instead of starting a broken queue", () => {
  for (const value of [undefined, null, {}, { draft: "", images: [42], queued: [] }, { draft: "", images: [], queued: [{ text: "bad" }] }]) expect(recoverDraft(value)).toBeUndefined();
});
