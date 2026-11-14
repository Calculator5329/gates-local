// Render the real composer over the store, without a browser. Interaction,
// focus, geometry and double-click checks also live in composer-action.spec.ts.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LiveTurn, State } from "./store.ts";
import { clearDraft, replaceDraft } from "./drafts.ts";

const device = vi.hoisted(() => ({ touch: false }));
vi.mock("./store.ts", async (original) => {
  const store = await original<typeof import("./store.ts")>();
  return { ...store, useStore: <T,>(selector: (s: State) => T): T => selector(store.getState()) };
});
vi.mock("./session.ts", () => ({
  ...Object.fromEntries(["cancelQueuedEdit", "cancelStopAsk", "confirmStopAsk", "editQueued","openSettings", "pickModel", "pull", "removeQueued", "send", "sendQueuedNow", "setContext", "stop", "recheckRuntime"].map((name) => [name, vi.fn()])),
  firstPull: () => undefined,
  queueReason: () => null,
}));
vi.mock("./FitPanel.tsx", () => ({ openFit: vi.fn() }));
vi.mock("./Sidebar.tsx", () => ({ focusComposer: vi.fn() }));
vi.mock("./ui.tsx", async (original) => ({ ...await original<typeof import("./ui.tsx")>(), useMedia: () => device.touch, isTouch: () => device.touch }));

const { Composer, enterAnswer } = await import("./Composer.tsx");
const { getState, setState } = await import("./store.ts");
const initial = getState();
afterEach(() => { clearDraft("thread"); clearDraft(null); setState(initial); device.touch = false; });
function setFixture(patch: Partial<State> & { draft?: string }) {
  const { draft = "", ...state } = patch;
  setState(state);
  replaceDraft(state.threadId ?? null, { text: draft });
}

const ready: State = {
  ...initial,
  conn: { kind: "open" },
  runtime: { state: "ready", owner: "external", baseUrl: "http://127.0.0.1:5288", version: "test" },
  models: [{ name: "qwen3.5:9b", digest: "test", sizeBytes: 1, modifiedAt: "", capabilities: ["completion", "thinking"] }],
  model: "qwen3.5:9b",
  view: "thread",
  threadId: "thread",
};
const live: LiveTurn = { gen: 1, threadId: "thread", turnId: "turn", model: "qwen3.5:9b", startedAt: 0, thinking: "", text: "Reply", tools: [], pendingUser: null };
const turns = { thread: live };
const states: readonly [string, Partial<State> & { draft?: string }, string, string?][] = [
  ["idle", {}, "Send message"],
  ["typing", { draft: "hello" }, "Send message"],
  ["running", { turns }, "Stop", "Queue message"],
  ["running with a draft", { turns, draft: "next" }, "Stop", "Queue message"],
  ["editing a queued message", { turns, editingQueued: "queued", draft: "edited" }, "Update queued message"],
  ["editing an empty queued message", { turns, editingQueued: "queued" }, "Update queued message"],
  ["stopped", { turns: { thread: { ...live, end: { kind: "stopped", secs: 1 } } } }, "Send message"],
  ["failed", { turns: { thread: { ...live, end: { kind: "error", code: "internal", message: "Failed" } } } }, "Send message"],
  ["another chat running", { turns: { other: { ...live, threadId: "other" } } }, "Send message"],
  ["disconnected", { conn: { kind: "down", since: 0 } }, "Send message"],
  ["no model", { models: [], model: undefined }, "Send message"],
  ["installing", { runtime: { state: "installing", owner: "app", baseUrl: "http://127.0.0.1:5288" } }, "Send message"],
  ["memory refused", { draft: "Too big", fitTable: { reading: { boot: "b", seq: 1, measuredAt: 0 }, memory: { kind: "gpu", freeBytes: 0, usableBytes: 0 }, rows: [{ model: "qwen3.5:9b", numCtx: 16384, freeVramBytes: 0, needVramBytes: 2 ** 30, spillRamBytes: 0, shortfallBytes: 2 ** 30, verdict: "refuse", source: "estimate", stops: [] }] } }, "Send message"],
];

describe("the composer's primary action", () => {
  for (const [touch, draft] of [[false, "Keep this draft"], [true, "Keep this draft"], [true, ""]] as const) {
    it(`keeps a separate Stop available without replacing the ${touch ? `touch queue action, ${draft ? "with" : "without"} a draft` : "queued edit action"}`, () => {
      device.touch = touch;
      setFixture({ ...ready, turns, draft, editingQueued: touch ? null : "queued" });
      const html = renderToStaticMarkup(createElement(Composer));
      const stops = html.match(/<button\b[^>]*aria-label="Stop"[^>]*>/g) ?? [];
      expect(stops).toHaveLength(1);
      expect(stops[0], "an icon square in the button row, like Dictate").toMatch(/class="ctl sq\b/);
      // on touch the arrow holds its slot from the reply's start, off while the draft is empty
      if (touch) expect(html.match(/<button\b[^>]*class="send"[^>]*>/)?.[0]).toMatch(draft ? /aria-label="Queue message"(?![^>]*aria-disabled)/ : /aria-label="Queue message"[^>]*aria-disabled="true"/);
      expect(html, "no running line above the composer").not.toMatch(/Reply running|data-running-status/);
    });
  }
  for (const touch of [false, true]) {
    for (const [name, patch, keyboardLabel, touchLabel = keyboardLabel] of states) {
      it(`has exactly one button.send when ${name}, ${touch ? "touch" : "keyboard"}`, () => {
        device.touch = touch;
        setFixture({ ...ready, ...patch });
        const html = renderToStaticMarkup(createElement(Composer));
        const actions = html.match(/<button\b[^>]*class="send(?: [^"]*)?"[^>]*>/g) ?? [];
        expect(actions, "one primary slot in every state").toHaveLength(1);
        expect(actions[0]).toContain(`aria-label="${touch ? touchLabel : keyboardLabel}"`);
        expect(actions[0], "inactivity must not remove native keyboard focus").not.toMatch(/\sdisabled="/);
        // the tip names the button, and its key on a keyboard
        if (keyboardLabel === "Stop" && !touch) expect(actions[0]).toContain('data-tip="Stop"');
        if (touch) expect(actions[0]).not.toContain("Enter");
        if (name === "typing" && !touch) expect(actions[0]).toContain('data-tip="Send · Enter"');
        if (name === "memory refused") {
          expect(actions[0]).toContain('aria-disabled="true"');
          expect(actions[0]).toContain('data-tip="Not enough memory at 16k"');
        }
      });
    }
  }
});

/** A table where the model does not fit at 16k unless the chats named in `stops` stop their replies. */
const tooBigUnless = (stops: string[]): State["fitTable"] => ({
  reading: { boot: "b", seq: 1, measuredAt: 0 }, memory: { kind: "gpu", freeBytes: 0, usableBytes: 0 },
  rows: [{ model: "qwen3.5:9b", numCtx: 16384, freeVramBytes: 0, needVramBytes: 2 ** 30, spillRamBytes: 0, shortfallBytes: 2 ** 30, verdict: "refuse", source: "estimate", stops }],
});
const sendButton = () => renderToStaticMarkup(createElement(Composer)).match(/<button\b[^>]*class="send(?: [^"]*)?"[^>]*>/)?.[0] ?? "";

it("a model that fits once another chat's reply stops can be sent to, and Send says that reply stops first; with nothing to free it is refused", () => {
  const other = { other: { ...live, threadId: "other" } };
  setFixture({ ...ready, draft: "hello", turns: other, fitTable: tooBigUnless(["other"]) });
  const freed = sendButton();
  expect(freed, "no memory refusal").not.toContain('aria-disabled="true"');
  expect(freed).not.toContain("not enough memory");
  expect(freed).toMatch(/Another chat(?:&#x27;|')s reply stops first/);
  setFixture({ ...ready, draft: "hello", turns: other, fitTable: tooBigUnless([]) });
  const refused = sendButton();
  expect(refused).toContain('aria-disabled="true"');
  expect(refused).toContain("Not enough memory at 16k");
});

const modelButton = () => renderToStaticMarkup(createElement(Composer)).match(/<button\b[^>]*id="modelBtn"[\s\S]*?<\/button>/)?.[0] ?? "";
const slot = (html: string) => html.match(/<small class="picker-trigger-ctx">([^<]*)<\/small>/)?.[1];
const mark = (html: string) => html.match(/<span class="maker-mark"[\s\S]*?<\/span>/)?.[0];
it("an unrecognized model has a plain name and context, with no placeholder symbol or icon slot", () => {
  const tag = "wizard-vicuna:7b";
  setFixture({ ...ready, model: tag, models: [{ ...ready.models![0]!, name: tag }] });
  const button = modelButton();
  expect(button).toContain('class="picker-trigger-name"');
  expect(slot(button)).toMatch(/^\d+k$/);
  expect(mark(button)).toBeUndefined();
  expect(button).not.toContain("?");
});
/** A button's contents, without its own tag: the tip on the tag may say more while the face stays the same. */
const body = (html: string) => html.replace(/^<button\b[^>]*>/, "");
const sendWhole = () => renderToStaticMarkup(createElement(Composer)).match(/<button\b[^>]*class="send(?: [^"]*)?"[\s\S]*?<\/button>/)?.[0] ?? "";
// Guards the owner's pick (2026-11-13: "doing too much" on a spinner, a bar and "3 s" on the model button, then option D,
// "On Send, not on the model": the model button never changes, and a ring fills around Send only while a message waits for the load).
it("a loading model leaves its button alone: a ring fills around Send, and only while a message waits for the load", () => {
  const tag = "qwen3.5:9b";
  const loadingModel: State = { ...ready, loads: { [tag]: { model: tag, numCtx: 16384, state: "loading" } }, loadSince: { [tag]: 0 }, loadTimes: { [tag]: 4200 } };
  setFixture(ready);
  const idle = modelButton();
  expect(slot(idle)).toMatch(/^\d+k$/);
  expect(sendWhole(), "no ring on an idle Send").not.toContain("ldring");

  // a load nobody is waiting on (a model just picked, a chat just opened): nothing moves anywhere
  setFixture(loadingModel);
  const loading = modelButton();
  expect(body(loading), "the model button's contents do not change").toBe(body(idle));
  expect(mark(loading), "the maker's mark stays").toBe(mark(idle));
  expect(sendWhole(), "nothing is waiting, so no ring").not.toContain("ldring");
  // the time is still there for whoever asks
  expect(loading).toMatch(/data-tip="[^"]*Loading into GPU memory, ~4 s"/);
  // a computer with no supported GPU has no GPU memory to load into
  setFixture({ ...loadingModel, gpu: { vendor: "none" } as State["gpu"] });
  expect(modelButton()).toMatch(/data-tip="[^"]*Loading into memory, ~4 s"/);

  // a message is waiting for the load: the ring is on the button being waited on, filling over the last load
  setFixture({ ...loadingModel, turns });
  expect(body(modelButton()), "still unchanged").toBe(body(idle));
  const waiting = sendWhole();
  expect(waiting).toMatch(/class="ldring"/);
  expect(waiting, "it fills over this machine's last load").toMatch(/animation-duration:4200ms/);
  // a first load has no time to aim at: the ring turns without an end
  setFixture({ ...loadingModel, turns, loadTimes: {} });
  expect(sendWhole()).toMatch(/class="ldring wait"/);
  expect(modelButton()).toMatch(/data-tip="[^"]*Loading into GPU memory"/);
  // a reply already running on a loaded model is not waiting for anything
  setFixture({ ...ready, turns });
  expect(sendWhole()).not.toContain("ldring");
});

it("F6: before the first read, Send claims nothing about Ollama or models and the model button still has a name", () => {
  setFixture({ ...initial, conn: { kind: "connecting" }, runtime: undefined, models: undefined, model: undefined, hydrationSettled: false, bootWaited: false, view: "new", threadId: null });
  const html = renderToStaticMarkup(createElement(Composer));
  const send = html.match(/<button\b[^>]*class="send(?: [^"]*)?"[^>]*>/)?.[0] ?? "";
  expect(send).not.toMatch(/Chat starts|Ollama|Download a model/);
  const model = html.match(/<button\b[^>]*id="modelBtn"[^>]*>/)?.[0] ?? "";
  expect(html, "the model button shows its placeholder").toMatch(/id="modelBtn"[^>]*>(?:(?!<\/button>)[\s\S])*data-skel/);
  expect(model).toMatch(/aria-label="Model"/);
});

it("chat row 31: during setup the field keeps Ask anything…, and a queued message says when it goes once, as a clock with a tip", () => {
  const installing: State = { ...ready, runtime: { state: "installing", owner: "app", baseUrl: "http://127.0.0.1:5288", version: "test" } };
  setFixture(installing);
  expect(renderToStaticMarkup(createElement(Composer)), "the field is the ready field").toMatch(/placeholder="Ask anything…"/);
  setFixture({ ...installing, queued: [{ id: "q", threadId: "thread", text: "hello", at: 1, waitFor: "setup" }] });
  const html = renderToStaticMarkup(createElement(Composer));
  const row = html.match(/<ul class="qt"[\s\S]*?<\/ul>/)?.[0] ?? "";
  expect(row).toMatch(/data-tip="Sends when setup finishes"/);
  expect(row).toMatch(/<span class="vh">Sends when setup finishes<\/span>/);
  expect(row, "no word beside the clock").not.toMatch(/After setup/);
  expect(html.split("setup finishes").length - 1, "said once, in the row").toBe(2);
});

// Chat row 36, owner pick A (2026-11-13): the queue is a shelf inside the message box, three icons a row, more than three fold to a count.
const queuedAt = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `q${i + 1}`, threadId: "thread", text: `message ${i + 1}`, at: i, waitFor: "reply" as const }));
it("chat row 36: queued messages sit on a shelf inside the message box, above the field", () => {
  setFixture({ ...ready, queued: queuedAt(2) });
  const html = renderToStaticMarkup(createElement(Composer));
  const form = html.match(/<form\b[^>]*class="composer[^"]*"[^>]*>([\s\S]*)<\/form>/)?.[1] ?? "";
  expect(form, "the shelf is in the box").toMatch(/^<ul class="qt"/);
  expect(form.indexOf('class="qt"'), "above the field").toBeLessThan(form.indexOf("<textarea"));
  expect(html.match(/<li class="qt-r"/g)).toHaveLength(2);
});

it("chat row 36: three queued show as three rows; more fold to the next two and a count that opens the rest", () => {
  setFixture({ ...ready, queued: queuedAt(3) });
  let html = renderToStaticMarkup(createElement(Composer));
  expect(html.match(/<li class="qt-r"/g)).toHaveLength(3);
  expect(html).not.toMatch(/data-testid="chat\.queue\.more"/);
  setFixture({ ...ready, queued: queuedAt(5) });
  html = renderToStaticMarkup(createElement(Composer));
  expect(html.match(/<li class="qt-r"/g), "the next two to go").toHaveLength(2);
  expect(html).toMatch(/message 1[\s\S]*message 2/);
  expect(html).not.toMatch(/message 3/);
  const more = html.match(/<button\b[^>]*data-testid="chat\.queue\.more"[^>]*>[\s\S]*?<\/button>/)?.[0] ?? "";
  expect(more).toMatch(/aria-expanded="false"/);
  expect(more).toMatch(/aria-label="Show 3 more queued messages"/);
  expect(more.replace(/<[^>]+>/g, ""), "a count, no sentence").toBe("+3");
  // the one being edited shows even when it is folded
  setFixture({ ...ready, queued: queuedAt(5), editingQueued: "q4" });
  html = renderToStaticMarkup(createElement(Composer));
  expect(html).toMatch(/message 4/);
  expect(html.match(/<li class="qt-r"/g)).toHaveLength(3);
});

it("after the two-second bound with nothing read, the composer says Connecting once and nothing about Ollama", () => {
  setFixture({ ...initial, conn: { kind: "open" }, runtime: undefined, models: undefined, model: undefined, hydrationSettled: false, bootWaited: true, view: "new", threadId: null });
  const html = renderToStaticMarkup(createElement(Composer));
  expect(html).toMatch(/placeholder="Connecting…"/);
  expect(html.split("Connecting…").length - 1, "said once").toBe(1);
  expect(html).not.toMatch(/Ollama/);
});

// Owner, 2026-11-14: "enter to send message is sometimes not working". Enter with words typed is never silent:
// it sends, opens the fit panel on a memory refusal, or shows Send's reason at Send.
const sendTag = (html: string) => html.match(/<button\b[^>]*class="send(?: [^"]*)?"[^>]*>/)?.[0] ?? "";
describe("Enter with words typed", () => {
  it.each([
    ["sends when Send is on", { sendDisabled: false, memRefused: false, text: true, showStop: false }, "send"],
    ["does nothing in an empty box", { sendDisabled: true, memRefused: false, text: false, showStop: false }, null],
    ["opens the fit panel on a memory refusal", { sendDisabled: true, memRefused: true, text: true, showStop: false }, "fit"],
    ["shows Send's reason at Send", { sendDisabled: true, memRefused: false, text: true, showStop: false }, "tip"],
    ["says the reason in the notice while Stop holds Send's place", { sendDisabled: true, memRefused: false, text: true, showStop: true }, "note"],
  ] as const)("%s", (_, state, answer) => {
    expect(enterAnswer(state)).toBe(answer);
  });
  it("while disconnected, Send's reason is the placeholder's words, not Send · Enter", () => {
    setFixture({ ...ready, conn: { kind: "down", since: 0 }, draft: "hello" });
    const tag = sendTag(renderToStaticMarkup(createElement(Composer)));
    expect(tag).toMatch(/aria-disabled="true"/);
    expect(tag).toMatch(/data-tip="Chat starts when Gates Local reconnects…"/);
  });
  it("with the box empty the placeholder says it, and Send keeps its name", () => {
    setFixture({ ...ready, conn: { kind: "down", since: 0 } });
    const html = renderToStaticMarkup(createElement(Composer));
    expect(html).toMatch(/placeholder="Chat starts when Gates Local reconnects…"/);
    expect(sendTag(html)).toMatch(/data-tip="Send · Enter"/);
  });
  it("before the model list is read, Send is off and says so", () => {
    setFixture({ ...ready, models: undefined, draft: "hello" });
    const tag = sendTag(renderToStaticMarkup(createElement(Composer)));
    expect(tag).toMatch(/aria-disabled="true"/);
    expect(tag).toMatch(/data-tip="Reading the models…"/);
  });
  it("a chosen model that is not installed is named in Send's tip", () => {
    setFixture({ ...ready, model: "gone:1b", draft: "hello" });
    const tag = sendTag(renderToStaticMarkup(createElement(Composer)));
    expect(tag).toMatch(/aria-disabled="true"/);
    expect(tag).toMatch(/data-tip="gone 1B isn&#x27;t installed"/);
  });
  it("while a send asks the server what it would stop, Send is busy and turns its ring", () => {
    setFixture({ ...ready, asking: true, draft: "hello" });
    const html = renderToStaticMarkup(createElement(Composer));
    expect(sendTag(html)).toMatch(/aria-busy="true"/);
    expect(html).toMatch(/class="ldring wait ask"/);
    setFixture({ ...ready, asking: undefined, draft: "hello" });
    const idle = renderToStaticMarkup(createElement(Composer));
    expect(sendTag(idle)).not.toMatch(/aria-busy/);
    expect(idle).not.toMatch(/ldring/);
  });
});
