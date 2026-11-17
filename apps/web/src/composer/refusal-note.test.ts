// The note under a refused send prints the words the server judged each offer with: it holds no verdict of its own.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { fitWords, gb } from "@gates-local/contracts";
import type { FitOffer } from "@gates-local/contracts";
import { repliesOf } from "../../test/queue.ts";

const session = vi.hoisted(() => ({
  chosen: [] as [string, string, number][],
  sentNow: [] as string[],
  sent: [] as string[],
  picked: [] as string[],
  sized: [] as number[],
  freed: [] as unknown[],
  answer: { fn: null as unknown as () => Promise<boolean> },
  freeing: { fn: null as unknown as () => Promise<string | null> },
}));
vi.mock("../lib/session/index.ts", async (original) => ({
  ...await original<typeof import("../lib/session/index.ts")>(),
  chooseForQueued: (id: string, model: string, numCtx: number) => { session.chosen.push([id, model, numCtx]); return session.answer.fn(); },
  sendQueuedNow: (id: string) => { session.sentNow.push(id); },
  send: (text: string) => { session.sent.push(text); return Promise.resolve(); },
  pickModel: (model: string) => { session.picked.push(model); },
  setContext: (numCtx: number) => { session.sized.push(numCtx); },
  freeMemory: (free: unknown) => { session.freed.push(free); return session.freeing.fn(); },
}));

let RefusalNote: typeof import("./RefusalNote.tsx")["RefusalNote"];
let takeOffer: typeof import("./RefusalNote.tsx")["takeOffer"];
let takeFree: typeof import("./RefusalNote.tsx")["takeFree"];
let freeForQueued: typeof import("./RefusalNote.tsx")["freeForQueued"];
let store: typeof import("../lib/store/store.ts");
let drafts: typeof import("../lib/store/drafts.ts");
beforeAll(async () => {
  vi.stubGlobal("window", {});
  ({ RefusalNote, takeOffer, takeFree, freeForQueued } = await import("./RefusalNote.tsx"));
  store = await import("../lib/store/store.ts");
  drafts = await import("../lib/store/drafts.ts");
  vi.unstubAllGlobals();
});
beforeEach(() => {
  for (const list of [session.chosen, session.sentNow, session.sent, session.picked, session.sized, session.freed]) list.length = 0;
  session.answer.fn = () => Promise.resolve(true);
  session.freeing.fn = () => Promise.resolve(null);
});
afterEach(() => { for (const key of ["a", "b", "chat"]) drafts.clearDraft(key); });

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

// Council climb-025 Q16: "Gemma 4 12B · 16k ›" and "needs X · GPU Y + RAM Z · W short" said nothing in words.
it("when nothing runs, the note says in one plain sentence what is wrong, with the memory figures behind one control", () => {
  const html = note({ short: { needBytes: 12 * GIB, gpuBytes: 8 * GIB, ramBytes: 2 * GIB, shortBytes: 2 * GIB } });
  const line = html.match(/<span[^>]*data-testid="chat\.composer\.offer-what"[^>]*>([\s\S]*?)<\/span>/)?.[1] ?? "";
  expect(textOf(line).trim()).toBe("Not enough memory for Qwen 3.5 9B at 32k.");
  expect(textOf(html), "the figures are in the details, not the line").not.toMatch(/GB|short|RAM/);
  const buttons = html.match(BUTTON) ?? [];
  expect(buttons, "one control, and no offer to take").toHaveLength(1);
  expect(buttons[0]).toContain('data-testid="chat.composer.offer-details"');
  expect(buttons[0]).toContain('aria-label="Memory details"');
});

it("a refusal that counted no system memory says it is the GPU's memory, and leads the offers it makes", () => {
  const html = note({ short, model: { model: "qwen3.5:4b", numCtx: 8192, verdict: "fits" } });
  expect(textOf(html)).toMatch(/^Not enough GPU memory for Qwen 3\.5 9B at 32k\.\s*Qwen 3\.5 4B/);
});

// Council climb-025 Q12: "Qwen 3.5 4B · 16k Qwen 3.5 9B holds 7.0 GB" ran the context into the holder's name.
it("what another program holds is set apart from the model and context it is in the way of", () => {
  const html = note({ short, free: [{ kind: "model", name: "qwen3.5:4b", bytes: 7 * GIB }] });
  expect(textOf(html)).toMatch(new RegExp(`at 32k\\.\\s*—\\s*Qwen 3\\.5 4B holds ${gb(7 * GIB).replace(".", "\\.")}`));
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

const FREE = [{ kind: "model" as const, name: "other:7b", bytes: 7 * GIB }];
const freeNote = (threadId: string) => store.setState({
  view: "thread", threadId, model: BIG, notice: "Not enough memory",
  noticeOffer: { notice: "Not enough memory", model: BIG, numCtx: 32768, offer: { short, free: FREE } }, replies: new Map(),
});
/** Free it's memory.free answers when `finish` is called. */
const slowFree = () => {
  const finish: (() => void)[] = [];
  session.freeing.fn = () => new Promise<null>((resolve) => { finish.push(() => resolve(null)); });
  return () => finish.splice(0).forEach((f) => f());
};

it("Free it pressed in one chat sends that chat's words after the free, and nothing of the chat the person moved to meanwhile", async () => {
  const finish = slowFree();
  freeNote("a");
  drafts.replaceDraft("a", { text: "Plan A" });
  drafts.replaceDraft("b", { text: "Plan B" });
  const taking = takeFree(false);
  store.setState({ threadId: "b" });
  finish();
  await taking;
  expect(session.freed).toEqual([FREE]);
  expect(session.sent, "the other chat's words are not sent").toEqual([]);
  expect(session.picked, "the other chat's model is not changed").toEqual([]);
  expect(drafts.getDraft("b").text).toBe("Plan B");

  freeNote("a");
  const again = takeFree(false);
  finish();
  await again;
  expect(session.sent, "still in the chat with the same words: they go").toEqual(["Plan A"]);
});

it("Free it with words edited while the memory was freed sends nothing; the box keeps the new words", async () => {
  const finish = slowFree();
  freeNote("a");
  drafts.replaceDraft("a", { text: "Plan A" });
  const taking = takeFree(false);
  drafts.replaceDraft("a", { text: "Plan A, but longer" });
  finish();
  await taking;
  expect(session.sent).toEqual([]);
  expect(drafts.getDraft("a").text).toBe("Plan A, but longer");
});

it("a held message freed for retries by its own id, in whichever chat the person is by then", async () => {
  const finish = slowFree();
  heldNote("Not enough memory");
  store.setState({ noticeOffer: { notice: "Not enough memory", model: BIG, numCtx: 32768, offer: { short, free: FREE } } });
  drafts.replaceDraft("b", { text: "Plan B" });
  const taking = takeFree(false);
  store.setState({ threadId: "b" });
  finish();
  await taking;
  expect(session.sentNow).toEqual(["held"]);
  expect(session.sent).toEqual([]);
});

it("Free it on a queued row frees what that row's refusal named, then sends that row, and not when the free failed", async () => {
  await freeForQueued("q7", FREE, false);
  expect(session.freed).toEqual([FREE]);
  expect(session.sentNow).toEqual(["q7"]);
  session.freeing.fn = () => Promise.resolve("Could not free the memory");
  await freeForQueued("q7", FREE, false);
  expect(session.sentNow, "a failed free sends nothing").toEqual(["q7"]);
  expect(store.getState().notice).toBe("Could not free the memory");
});
