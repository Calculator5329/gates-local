// The note under a refused send prints the words the server judged each offer with: it holds no verdict of its own.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { fitWords, gb } from "@gates-local/contracts";
import type { FitOffer } from "@gates-local/contracts";
import { repliesOf } from "../../test/queue.ts";

const session = vi.hoisted(() => ({
  chosen: [] as [string, string, number][],
  sentNow: [] as string[],
  sent: [] as string[],
  picked: [] as string[],
  sized: [] as number[],
  answer: { fn: null as unknown as () => Promise<boolean> },
}));
vi.mock("../lib/session/index.ts", async (original) => ({
  ...await original<typeof import("../lib/session/index.ts")>(),
  chooseForQueued: (id: string, model: string, numCtx: number) => { session.chosen.push([id, model, numCtx]); return session.answer.fn(); },
  sendQueuedNow: (id: string) => { session.sentNow.push(id); },
  send: (text: string) => { session.sent.push(text); return Promise.resolve(); },
  pickModel: (model: string) => { session.picked.push(model); },
  setContext: (numCtx: number) => { session.sized.push(numCtx); },
}));

let RefusalNote: typeof import("./RefusalNote.tsx")["RefusalNote"];
let takeOffer: typeof import("./RefusalNote.tsx")["takeOffer"];
let store: typeof import("../lib/store/store.ts");
beforeAll(async () => {
  vi.stubGlobal("window", {});
  ({ RefusalNote, takeOffer } = await import("./RefusalNote.tsx"));
  store = await import("../lib/store/store.ts");
  vi.unstubAllGlobals();
});
beforeEach(() => {
  for (const list of [session.chosen, session.sentNow, session.sent, session.picked, session.sized]) list.length = 0;
  session.answer.fn = () => Promise.resolve(true);
});

const GIB = 1024 ** 3;
const report = (verdict: "fits" | "spills") => ({ verdict, numCtx: 8192, needVramBytes: 9 * GIB, freeVramBytes: 8 * GIB, spillRamBytes: verdict === "spills" ? GIB : 0, source: "estimate" as const });
const short = { needBytes: 0, gpuBytes: 0, ramBytes: 0, shortBytes: 0 };
const note = (offer: FitOffer) => renderToStaticMarkup(createElement(RefusalNote, { o: { notice: "refused", model: "qwen3.5:9b", numCtx: 32768, offer } }));
const SLOWER = new RegExp(String.raw`<span[^>]*data-testid="chat\.composer\.offer-slower"[^>]*>`, "g");
const marks = (html: string) => [...html.matchAll(SLOWER)].map((m) => m[0]);

it.each([
  ["a GPU that spills", false, "Slower"],
  ["no supported GPU", true, "System memory"],
])("an offer that runs partly in system memory, on %s, is marked with the server's word for it", (_, cpu, word) => {
  const html = note({ short, context: { numCtx: 8192, verdict: "spills", words: fitWords(report("spills"), "now", cpu) } });
  const [mark, ...more] = marks(html);
  expect(more).toEqual([]);
  expect(mark).toContain(`data-tip="${word}"`);
  expect(mark).toContain(`aria-label="${word}"`);
});

it("an offer the server judged to run on the GPU carries no mark, whatever its verdict field says", () => {
  const html = note({ short, model: { model: "qwen3.5:4b", numCtx: 8192, verdict: "spills", words: fitWords(report("fits"), "now", false) } });
  expect(marks(html)).toEqual([]);
});

it("an offer sent with no words is not judged by the note", () => {
  const html = note({ short, context: { numCtx: 8192, verdict: "spills" } });
  expect(marks(html)).toEqual([]);
});

const textOf = (html: string) => html.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, "");
const BUTTON = /<button\b[^>]*>/g;

it("when nothing runs, the note says in one line what is short, the GPU's and system memory apart, with the memory details behind one control", () => {
  const html = note({ short: { needBytes: 12 * GIB, gpuBytes: 8 * GIB, ramBytes: 2 * GIB, shortBytes: 2 * GIB } });
  const line = html.match(/<span[^>]*data-testid="chat\.composer\.offer-short"[^>]*>([\s\S]*?)<\/span>/)?.[1] ?? "";
  expect(textOf(line).trim()).toBe(`needs ${gb(12 * GIB)} · GPU ${gb(8 * GIB)} + RAM ${gb(2 * GIB)} · ${gb(2 * GIB)} short`);
  const buttons = html.match(BUTTON) ?? [];
  expect(buttons, "one control, and no offer to take").toHaveLength(1);
  expect(buttons[0]).toContain('data-testid="chat.composer.offer-details"');
  expect(buttons[0]).toContain('aria-label="Memory details"');
});

const BIG = "qwen3.5:9b";
const SMALL = "qwen3.5:4b";
const heldNote = (notice: string) => {
  store.setState({
    view: "thread", threadId: "chat", model: BIG, notice,
    noticeOffer: { notice: "Not enough memory", model: BIG, numCtx: 32768, offer: { short, model: { model: SMALL, numCtx: 8192, verdict: "fits" } } },
    replies: repliesOf([{ id: "held", threadId: "chat", text: "Plan the trip", waitFor: "reply", held: true, why: { code: "memory", message: "Not enough memory" } }]),
  });
};
const settle = async () => { for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0)); };

it("an offer taken after the note has moved on does nothing; taken while it stands, with the box empty, it makes the change and asks for this chat's held message to have it", () => {
  heldNote("Something else happened");
  const before = store.getState().noticeOffer;
  takeOffer("model");
  expect([session.picked, session.sized, session.chosen, session.sent, session.sentNow]).toEqual([[], [], [], [], []]);
  expect(store.getState().noticeOffer).toBe(before);
  expect(store.getState().notice).toBe("Something else happened");

  heldNote("Not enough memory");
  takeOffer("model");
  expect(session.picked).toEqual([SMALL]);
  expect(session.sized).toEqual([8192]);
  expect(session.chosen).toEqual([["held", SMALL, 8192]]);
  expect(session.sent, "the box is empty, so nothing new is sent").toEqual([]);
  expect(store.getState().noticeOffer).toBeNull();
});

it("a held message taken with an offer goes only once the server says it has the choice", async () => {
  const answers: ((chosen: boolean) => void)[] = [];
  session.answer.fn = () => new Promise<boolean>((resolve) => { answers.push(resolve); });
  heldNote("Not enough memory");
  takeOffer("model");
  await settle();
  expect(session.sentNow, "not before the server answers").toEqual([]);
  answers[0]?.(false);
  await settle();
  expect(session.sentNow, "not when the server says no").toEqual([]);
  heldNote("Not enough memory");
  takeOffer("model");
  answers[1]?.(true);
  await settle();
  expect(session.sentNow).toEqual(["held"]);
});
