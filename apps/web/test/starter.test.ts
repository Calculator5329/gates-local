import { beforeEach, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ log: [] as string[], view: "settings", image: false }));
vi.mock("../src/session.ts", () => ({ newThread: () => { calls.log.push("new chat"); calls.view = "new"; }, send: async (text: string, opts: object) => { calls.log.push(`send ${text} image ${calls.image} ${JSON.stringify(opts)}`); } }));
vi.mock("../src/drafts.ts", () => ({ replaceDraft: (thread: string | null, d: { text: string }) => calls.log.push(`draft ${thread} ${d.text}`) }));
vi.mock("../src/Sidebar.tsx", () => ({ focusComposer: () => calls.log.push("focus") }));
vi.mock("../src/store.ts", () => ({ getState: () => ({ view: calls.view, image: calls.image }), setState: (p: { image?: boolean }) => { if (p.image !== undefined) calls.image = p.image; calls.log.push(`set ${JSON.stringify(p)}`); } }));
import { askWith, startWith } from "../src/starter.ts";

beforeEach(() => { calls.log = []; calls.image = false; });

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
