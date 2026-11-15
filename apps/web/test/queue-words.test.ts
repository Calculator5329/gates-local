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
const turn = (threadId: string, end?: { kind: "stopped"; secs: number }) => ({ gen: 1, threadId, turnId: `turn-${threadId}`, model: "m", startedAt: 0, thinking: "", text: "", tools: [], pendingUser: null, ...(end ? { end } : {}) });

it("a message waiting for setup says so while setup runs", () => {
  expect(queueWords(q(), false, undefined, undefined, true)).toBe(AFTER_SETUP);
});

it("once setup has ended it no longer says setup: a running download is named, and with none the row is quiet", () => {
  expect(queueWords(q(), false, "qwen3.5:9b", undefined, false)).toBe(AFTER_DOWNLOAD);
  expect(queueWords(q(), false, undefined, undefined, false)).toBeNull();
});

it("a message that waits only for a reply in another chat says so, once, in Send's words for that reply", async () => {
  const { replyElsewhere } = await import("../src/Composer.tsx");
  const reply = q({ waitFor: "reply" });
  expect(queueWords(reply, false, undefined, undefined, false, true)).toBe("Sends when another chat's reply ends");
  // its own chat's reply in the way, or none anywhere: being in the queue says it
  expect(queueWords(reply, false, undefined, undefined, false, false)).toBeNull();
  // on hold it waits for Send now, and Send now waits only for its own chat
  expect(queueWords(q({ waitFor: "reply", held: true }), false, undefined, undefined, false, true)).toBe("On hold");
  expect(queueWords(q({ waitFor: "reply", now: true }), false, undefined, undefined, false, true)).toBeNull();
  type S = Parameters<typeof replyElsewhere>[0];
  expect(replyElsewhere({ threadId: "t1", turns: { t2: turn("t2") } } as unknown as S)).toBe(true);
  expect(replyElsewhere({ threadId: "t1", turns: { t1: turn("t1"), t2: turn("t2") } } as unknown as S), "its own chat's reply comes first").toBe(false);
  expect(replyElsewhere({ threadId: "t1", turns: { t1: { ...turn("t1"), listed: true }, t2: turn("t2") } } as unknown as S), "one another window started here").toBe(false);
  expect(replyElsewhere({ threadId: "t1", turns: { t2: turn("t2", { kind: "stopped", secs: 1 }) } } as unknown as S)).toBe(false);
  expect(replyElsewhere({ threadId: "t1", turns: { t2: { ...turn("t2"), image: true } } } as unknown as S), "a picture is not a reply").toBe(false);
});

it("a message waiting for a download keeps its own words whatever setup does", () => {
  expect(queueWords(q({ waitFor: "download" }), false, "qwen3.5:9b", undefined, false)).toBe(AFTER_DOWNLOAD);
  expect(queueWords(q({ waitFor: "download" }), false, undefined, undefined, false)).toBe("Download stopped");
});
