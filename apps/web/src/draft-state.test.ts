import { expect, it } from "vitest";
import { methodSamples } from "@gates-local/contracts/testing";
import * as store from "./store.ts";

it("VC-01: every draft replacement, clear, queued edit and thread switch changes its identity", () => {
  for (const patch of [{ draft: "replacement" }, { draft: "" }, { editingQueued: "queue-a" }, { editingQueued: "queue-b" }, { editingQueued: null }, { threadId: "another-thread" }]) {
    const previous = store.getState().draftVersion;
    store.setState(patch);
    expect(store.getState().draftVersion).not.toBe(previous);
  }
});

it("ordinary typing keeps the draft identity, but deleting the draft ends it", () => {
  const previous = store.getState().draftVersion;
  store.editDraft("more typing");
  expect(store.getState().draftVersion).toBe(previous);
  store.editDraft("");
  expect(store.getState().draftVersion).not.toBe(previous);
});

it("VC-03: shared speech settings changes have a version independent of unrelated settings", () => {
  const settings = { ...methodSamples["settings.get"].result, whisperUrl: "http://127.0.0.1:18078" };
  store.setState({ settings });
  const previous = store.getState().voiceConnectionVersion;
  store.setState({ settings: { ...settings, thinking: !settings.thinking } });
  expect(store.getState().voiceConnectionVersion).toBe(previous);
  store.setState({ settings: { ...settings, whisperUrl: undefined } });
  expect(store.getState().voiceConnectionVersion).not.toBe(previous);
  const disconnected = store.getState().voiceConnectionVersion;
  store.setState({ settings });
  expect(store.getState().voiceConnectionVersion).not.toBe(disconnected);
});
