import { beforeEach, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ log: [] as string[], view: "settings", image: false, forced: [] as unknown[] }));
vi.mock("../lib/session/index.ts", () => ({ newThread: () => { calls.log.push("new chat"); calls.view = "new"; }, send: async (text: string, opts: object) => { calls.log.push(`send ${text} image ${calls.image} ${JSON.stringify(opts)}`); } }));
vi.mock("../lib/store/drafts.ts", () => ({ replaceDraft: (thread: string | null, d: { text: string }) => calls.log.push(`draft ${thread} ${d.text}`) }));
vi.mock("./focus.ts", () => ({ focusComposer: (force?: boolean) => { calls.forced.push(force); calls.log.push("focus"); } }));
vi.mock("../lib/store/store.ts", () => ({ getState: () => ({ view: calls.view, image: calls.image }), setState: (p: { image?: boolean }) => { if (p.image !== undefined) calls.image = p.image; calls.log.push(`set ${JSON.stringify(p)}`); } }));
import { askWith, startWith } from "./starter.ts";

beforeEach(() => { calls.log = []; calls.image = false; calls.forced = []; });

// starter-ask.test.ts runs the same press against the real draft store and session.
it("a Library question opens a new chat and sends itself to the chat model, past the message box", () => {
  calls.view = "settings"; calls.image = true;
  askWith("Which artist has the most albums?");
  expect(calls.log).toEqual(["new chat", 'set {"image":false}', "focus", 'send Which artist has the most albums? image false {"keepDraft":true}']);
});

it("from Settings, a starter opens a new chat with its words in the message box", () => {
  calls.view = "settings";
  startWith("Which artist has the most albums?");
  expect(calls.log).toEqual(["new chat", "draft null Which artist has the most albums?", "focus"]);
});

it("on the new chat already, it fills the box without starting another (F43's cards)", () => {
  calls.view = "new";
  startWith("Describe this picture", true);
  expect(calls.log).toEqual(["draft null Describe this picture", 'set {"image":true}', "focus"]);
});

it("a starter fills the message box first and then puts the cursor there, even on a touch screen where focus is otherwise held back", () => {
  for (const view of ["settings", "new"]) {
    calls.view = view; calls.log = []; calls.forced = [];
    startWith("Plan a trip");
    expect(calls.log, view).toEqual([...view === "new" ? [] : ["new chat"], "draft null Plan a trip", "focus"]);
    expect(calls.forced, view).toEqual([true]);
  }
});
