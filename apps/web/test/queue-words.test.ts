// A message typed during setup: its queue row says "setup" only while setup runs. Once the
// engine is in, the row follows what is true then (a download, or nothing: the offer above the
// composer says a model is needed, and the row does not repeat it).
import { beforeAll, expect, it, vi } from "vitest";
import type { Queued } from "../src/store.ts";

type Mod = typeof import("../src/Composer.tsx");
let AFTER_DOWNLOAD: Mod["AFTER_DOWNLOAD"], AFTER_SETUP: Mod["AFTER_SETUP"], queueWords: Mod["queueWords"];
beforeAll(async () => {
  vi.stubGlobal("window", {});
  ({ AFTER_DOWNLOAD, AFTER_SETUP, queueWords } = await import("../src/Composer.tsx"));
});

const q = (over: Partial<Queued> = {}): Queued => ({ id: "q1", threadId: "t1", text: "hello", at: 1, waitFor: "setup", ...over });

it("a message waiting for setup says so while setup runs", () => {
  expect(queueWords(q(), false, undefined, undefined, true)).toBe(AFTER_SETUP);
});

it("once setup has ended it no longer says setup: a running download is named, and with none the row is quiet", () => {
  expect(queueWords(q(), false, "qwen3.5:9b", undefined, false)).toBe(AFTER_DOWNLOAD);
  expect(queueWords(q(), false, undefined, undefined, false)).toBeNull();
});

it("a message waiting for a download keeps its own words whatever setup does", () => {
  expect(queueWords(q({ waitFor: "download" }), false, "qwen3.5:9b", undefined, false)).toBe(AFTER_DOWNLOAD);
  expect(queueWords(q({ waitFor: "download" }), false, undefined, undefined, false)).toBe("Download stopped");
});
