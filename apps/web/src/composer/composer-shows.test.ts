import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import type { CatalogEntry, ImageChoice, Message, ModelInfo } from "@gates-local/contracts";
import { methodSamples } from "@gates-local/contracts/testing";
import type { LiveTurn, State } from "../lib/store/store.ts";

const device = vi.hoisted(() => ({ touch: false }));
vi.mock("../lib/store/store.ts", async (original) => {
  const actual = await original<typeof import("../lib/store/store.ts")>();
  return { ...actual, useStore: <T>(selector: (s: State) => T) => selector(actual.getState()) };
});
vi.mock("../lib/ui/ui.tsx", async (original) => ({ ...await original<typeof import("../lib/ui/ui.tsx")>(), useMedia: () => device.touch, isTouch: () => device.touch }));
import { getState, setState } from "../lib/store/store.ts";
import { clearDraft, replaceDraft } from "../lib/store/drafts.ts";
import { PHONE } from "../lib/ui/ui.tsx";
import { repliesOf } from "../../test/queue.ts";

const TAG = "qwen3.5:9b";
const NAME = "Qwen 3.5 9B";
const entry: CatalogEntry = { name: TAG, label: NAME, purpose: "Everyday answers", downloadBytes: 6_600_000_000, installed: true, recommended: true, rank: 0 };
const model = (name: string, capabilities: ModelInfo["capabilities"]): ModelInfo => ({ name, digest: "test", sizeBytes: 1, modifiedAt: "", capabilities });
const thinks = model(TAG, ["completion", "thinking"]);
const plain = model(TAG, ["completion"]);
const initial = getState();
const READY: Partial<State> = {
  conn: { kind: "open" }, hydrationSettled: true, runtime: { state: "ready", owner: "external", baseUrl: "http://127.0.0.1:1", version: "test" },
  models: [thinks], model: TAG, numCtx: 16384, catalog: [entry], view: "thread", threadId: "thread", pop: null, notice: null,
};
const INSTALLING: State["runtime"] = { state: "installing", owner: "app", baseUrl: "http://127.0.0.1:1", version: "test" };
const live: LiveTurn = { threadId: "thread", turnId: "turn", model: TAG, startedAt: 0, thinking: "", text: "Reply", tools: [] };
const IMAGE_ON: Partial<State> = { image: true, settings: { ...methodSamples["settings.get"].result, imageGen: true }, imageStatus: methodSamples["image.status"].result, imagePresets: methodSamples["image.presets"].result };
const PICTURE: ImageChoice = { preset: "flux2-klein-4b", width: 1024, height: 1024 };
const tooBig: State["fitTable"] = {
  reading: { boot: "b", seq: 1, measuredAt: 0 }, memory: { kind: "gpu", freeBytes: 0, usableBytes: 0 },
  rows: [{ model: TAG, numCtx: 16384, freeVramBytes: 0, needVramBytes: 2 ** 30, spillRamBytes: 0, shortfallBytes: 2 ** 30, verdict: "refuse", source: "estimate", stops: [] }],
};

let Composer: typeof import("./Composer.tsx")["Composer"];
let OptsMenu: typeof import("./Composer.tsx")["OptsMenu"];
let picker: typeof import("../picker/picker-models.ts");
beforeAll(async () => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  ({ Composer, OptsMenu } = await import("./Composer.tsx"));
  picker = await import("../picker/picker-models.ts");
});
afterEach(() => { clearDraft("thread"); clearDraft(null); setState(initial); device.touch = false; });
afterAll(() => vi.unstubAllGlobals());

function show(patch: Partial<State> & { draft?: string; images?: string[] } = {}): void {
  const { draft = "", images = [], ...state } = patch;
  setState({ ...initial, ...READY, ...state });
  replaceDraft(getState().threadId, { text: draft, images });
}
const composer = () => renderToStaticMarkup(createElement(Composer));
const opts = () => renderToStaticMarkup(createElement(OptsMenu));
const words = (markup: string) => markup.replace(/<[^>]+>/g, "");
/** A queue row's words as a wide window shows them, without the phone's short form. */
const wide = (row: string) => words(row.replace(/<span class="qt-ws">[^<]*<\/span>/, ""));
const unescaped = (s: string) => s.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&#x27;", "'").replaceAll("&amp;", "&");
const opening = (markup: string, testId: string) => markup.match(new RegExp(`<button\\b[^>]*data-testid="${testId.replaceAll(".", "\\.")}"[^>]*>`))?.[0] ?? "";
const whole = (markup: string, testId: string) => markup.match(new RegExp(`<button\\b[^>]*data-testid="${testId.replaceAll(".", "\\.")}"[^>]*>[\\s\\S]*?</button>`))?.[0] ?? "";
const tipOf = (tag: string) => unescaped(tag.match(/data-tip="([^"]*)"/)?.[1] ?? "");
const modelButton = () => composer().match(/<button\b[^>]*id="modelBtn"[\s\S]*?<\/button>/)?.[0] ?? "";
const modelTip = () => tipOf(modelButton().match(/^<button\b[^>]*>/)?.[0] ?? "");
const modelTipt = () => unescaped(modelButton().match(/^<button\b[^>]*>/)?.[0].match(/data-tipt="([^"]*)"/)?.[1] ?? "");
const send = () => opening(composer(), "chat.composer.send");
const placeholder = () => composer().match(/<textarea[^>]*placeholder="([^"]*)"/)?.[1];
const rows = () => composer().match(/<li class="qt-r"[\s\S]*?<\/li>/g) ?? [];
const statusTag = (row: string) => row.match(/<span class="qt-s"[^>]*>/)?.[0] ?? "";
const numbers = (row: string) => row.match(/<span class="qt-n"[^>]*>((?:<span class="qt-p">[^<]*<\/span>)?[^<]*)<\/span>/)?.[1];
const said = (s: string, part: string) => s.split(part).length - 1;
const message = (id: string, role: Message["role"], stats?: Message["stats"]): Message => ({ id, threadId: "thread", role, content: id, createdAt: 1, ...(stats === undefined ? {} : { stats }) });

it("the context meter and the phone's options line count the last reply's prompt and its answer together", () => {
  show({ messages: { thread: [
    message("q1", "user"), message("a1", "assistant", { promptTokens: 1000, completionTokens: 500 }),
    message("q2", "user"), message("a2", "assistant", { promptTokens: 9000, completionTokens: 1000 }), message("q3", "user"),
  ] } });
  expect(words(composer().match(/<button\b[^>]*data-testid="chat\.composer\.context-meter"[\s\S]*?<\/button>/)?.[0] ?? "")).toBe("Context 61% used");
  const menu = words(opts());
  expect(menu).toContain("Context 61% used");
  expect(menu).toContain("10.0k of 16k tokens");
});

it("the phone's options menu says in plain words why Thinking is off, since its row has no tooltip", () => {
  show({ models: [], model: undefined, pulls: { [TAG]: { name: TAG, state: "downloading", completedBytes: 1, totalBytes: 10 } } });
  const downloading = whole(opts(), "chat.options-menu.thinking");
  expect(words(downloading)).toContain("Available when the model finishes downloading");
  expect(downloading).not.toContain("data-tip");
  show({ models: [plain] });
  const cannot = whole(opts(), "chat.options-menu.thinking");
  expect(words(cannot)).toContain(`${NAME} does not reason before answering`);
  expect(cannot).not.toContain("data-tip");
});

// Guards the owner's scorecard (Q4): the tip said the name and the near-same Ollama tag over three lines.
it("the model button's tip is only the full name, and only for a button that cuts it; never the Ollama tag", () => {
  show();
  const tag = modelButton().match(/^<button\b[^>]*>/)?.[0] ?? "";
  expect(tag, "nothing to say beside the name").not.toMatch(/data-tip="/);
  expect(modelTipt()).toBe(NAME);
  expect(modelButton()).not.toContain(TAG);
  show({ models: [model("mymodel", ["completion"])], model: "mymodel", catalog: [] });
  expect(modelTipt()).toBe("mymodel");
  expect(said(modelButton().replace(/^<button\b[^>]*>/, ""), "mymodel"), "a tag-only name has no short form to add").toBe(1);
});

// Guards the owner's scorecard (Q17): at 360 px the button cut "Qwen 3.5 9B" to "Qwen …" and lost the size.
it("the model button carries a compact name that keeps the size, for a button too narrow for the full one", () => {
  show();
  expect(modelButton()).toContain(`<span class="picker-trigger-name"><span class="ptn-f">${NAME}</span><span class="ptn-s" aria-hidden="true">Qwen 9B</span></span>`);
  const { compactName } = picker;
  expect(compactName("Gemma 4 12B")).toBe("Gemma 12B");
  expect(compactName("Qwen 3.8 27B · q8_0")).toBe("Qwen 27B");
  expect(compactName("gpt-oss 20B"), "already compact").toBeUndefined();
  expect(compactName("mymodel"), "no size to keep").toBeUndefined();
});

it("while the chosen model loads, a draft that would not fit is still refused for memory", () => {
  show({ draft: "hello", fitTable: tooBig, loads: { [TAG]: { model: TAG, numCtx: 16384, state: "loading" } } });
  const button = send();
  expect(button).toContain('aria-disabled="true"');
  expect(tipOf(button)).toBe("Not enough memory at 16k");
});

it("during setup the Thinking pill gives no reason of its own and the box greys it; once ready it says why it is off", () => {
  show({ runtime: INSTALLING, models: [plain] });
  const setup = composer();
  expect(setup).toMatch(/<form\b[^>]*class="composer blocked"/);
  const pill = opening(setup, "chat.composer.thinking");
  expect(pill).toMatch(/class="pill gate thinking"/);
  expect(tipOf(pill)).toBe("Thinking");
  expect(pill).not.toContain("aria-disabled");
  show({ models: [plain] });
  const ready = opening(composer(), "chat.composer.thinking");
  expect(tipOf(ready)).toBe("Thinking: not on this model");
  expect(ready).toContain('aria-disabled="true"');
});

it("while the engine installs, the model button keeps its name alone and its tip says the model downloads next", () => {
  show({ runtime: INSTALLING, models: [] });
  expect(modelTip()).toBe("Downloads next");
  expect(modelTipt()).toBe(NAME);
  expect(modelButton()).toContain(`<span class="ptn-f">${NAME}</span>`);
});

it("the box shows everyday words before anything is read, and with Image on asks for a picture unless the server is gone", () => {
  show({ conn: { kind: "connecting" }, runtime: undefined, models: undefined, model: undefined, hydrationSettled: false, bootWaited: false, view: "new", threadId: null });
  expect(placeholder()).toBe("Ask anything…");
  show(IMAGE_ON);
  expect(placeholder()).toBe("Describe a picture…");
  show({ ...IMAGE_ON, runtime: { state: "stopped", owner: "external", baseUrl: "http://127.0.0.1:1" } });
  expect(placeholder(), "a stopped chat engine does not matter to a picture").toBe("Describe a picture…");
  show({ ...IMAGE_ON, conn: { kind: "down", since: 0 } });
  expect(placeholder()).toBe("Chat starts when Gates Local reconnects…");
});

it("a draft too big for memory is not refused while this chat's reply runs or while a queued message is edited", () => {
  show({ draft: "hello", fitTable: tooBig });
  expect(send(), "with nothing running it is refused").toContain('aria-disabled="true"');
  device.touch = true;
  show({ draft: "hello", fitTable: tooBig, turns: { thread: live } });
  const queue = send();
  expect(queue).toContain('aria-label="Queue message"');
  expect(queue).not.toContain("aria-disabled");
  expect(tipOf(queue)).toBe("Queue");
  device.touch = false;
  show({ draft: "edited", fitTable: tooBig, editingQueued: "q1" });
  const update = send();
  expect(update).toContain('aria-label="Update queued message"');
  expect(update).not.toContain("aria-disabled");
  expect(tipOf(update)).toBe("Update · Enter");
});

it("with Image on, Send ignores the chat model's state and is off only for what stops a picture", () => {
  const stopped: State["runtime"] = { state: "stopped", owner: "external", baseUrl: "http://127.0.0.1:1" };
  show({ ...IMAGE_ON, runtime: stopped, models: [], model: undefined, draft: "a gate at dusk" });
  const free = send();
  expect(free).not.toContain("aria-disabled");
  expect(tipOf(free)).toBe("Make image · Enter");
  show({ ...IMAGE_ON, fitTable: tooBig, draft: "a gate at dusk" });
  expect(send(), "a chat model too big for memory does not count").not.toContain("aria-disabled");
  const off: [Partial<State> & { images?: string[] }, string][] = [
    [{ images: ["data:image/png;base64,AA"] }, "Image takes words only"],
    [{ imageStatus: { state: "missing", owner: "app" } }, "Images are not set up"],
    [{ imagePresets: undefined }, "Reading the image models…"],
  ];
  for (const [patch, why] of off) {
    show({ ...IMAGE_ON, draft: "a gate at dusk", ...patch });
    const button = send();
    expect(button, why).toContain('aria-disabled="true"');
    expect(tipOf(button)).toBe(why);
  }
});

it("with Image on, the model button shows the family mark beside the short name, and the tip the full name", () => {
  show(IMAGE_ON);
  const button = modelButton();
  expect(button).toMatch(/<span class="maker-mark"[^>]*>FX<\/span><span class="t">Klein 4B<\/span>/);
  expect(modelTip()).toBe("FLUX.2 Klein 4B");
});

it("at phone width the pills and the meter leave the composer row, and the Chat options sheet holds them", () => {
  const css = readFileSync(new URL("../app/styles.css", import.meta.url), "utf8");
  const width = PHONE.match(/\d+/)?.[0];
  const start = css.indexOf(`@media (max-width:${width}px){`);
  expect(start).toBeGreaterThan(-1);
  const phone = css.slice(start).split(/\n\}\n/)[0] ?? "";
  const hidden = [...phone.matchAll(/([^{}\n]+)\{display:none\}/g)].flatMap((m) => (m[1] ?? "").split(",").map((s) => s.trim()));
  expect(hidden).toEqual(expect.arrayContaining([".cf .pill", ".cf .meter"]));
  const shown = [...phone.matchAll(/([^{}\n]+)\{display:flex\}/g)].flatMap((m) => (m[1] ?? "").split(",").map((s) => s.trim()));
  expect(shown).toContain("#optBtn");
  show({ ...IMAGE_ON, messages: { thread: [message("a1", "assistant", { promptTokens: 9000, completionTokens: 1000 })] } });
  const menu = opts();
  expect(menu).toContain('data-testid="chat.options-menu.thinking"');
  expect(menu).toContain('data-testid="chat.options-menu.image"');
  expect(words(menu)).toContain("Context 61% used");
});

it("a queued row waiting on a clock names it in a tip, and a row that shows a word has no tip", () => {
  show({ runtime: INSTALLING, replies: repliesOf([
    { id: "q1", threadId: "thread", text: "first", waitFor: "reply", held: true },
    { id: "q2", threadId: "thread", text: "second", waitFor: "setup" },
  ]) });
  const [held, clocked] = rows();
  expect(words(held ?? "")).toContain("On hold");
  expect(statusTag(held ?? "")).toBe('<span class="qt-s" role="status">');
  expect(tipOf(statusTag(clocked ?? ""))).toBe("Sends when setup finishes");
});

it("a row waiting on a download or on setup shows its percent and time left, no numbers once every byte is in, and none before a size is known", () => {
  const setupRow = repliesOf([{ id: "q1", threadId: "thread", text: "hello", waitFor: "setup" }]);
  show({ runtime: { ...INSTALLING, install: { receivedBytes: 42_000_000, totalBytes: 100_000_000, bytesPerSecond: 500_000 } }, replies: setupRow });
  expect(words(numbers(rows()[0] ?? "") ?? "")).toBe("42% · 2 min");
  show({ runtime: { ...INSTALLING, install: { receivedBytes: 100_000_000, totalBytes: 100_000_000 } }, replies: setupRow });
  expect(numbers(rows()[0] ?? "")).toBeUndefined();
  const downloadRow = repliesOf([{ id: "q1", threadId: "thread", text: "hello", waitFor: "download" }]);
  show({ models: [], pulls: { [TAG]: { name: TAG, state: "verifying", completedBytes: 10, totalBytes: 10 } }, replies: downloadRow });
  expect(numbers(rows()[0] ?? "")).toBeUndefined();
  show({ models: [], pulls: { [TAG]: { name: TAG, state: "downloading", completedBytes: 0 } }, replies: downloadRow });
  expect(numbers(rows()[0] ?? "")).toBeUndefined();
  expect(words(rows()[0] ?? "")).toContain("Downloading Qwen 3.5 9B");
});

// Council climb-025 Q15: the first queued question showed a clock, "7%" and "10 s", and not what it waited for.
it("a row waiting on the first download says what is downloading beside its numbers, and what is checked once every byte is in", () => {
  const downloadRow = repliesOf([{ id: "q1", threadId: "thread", text: "hello", waitFor: "download" }]);
  show({ models: [], pulls: { [TAG]: { name: TAG, state: "downloading", completedBytes: 7, totalBytes: 100, bytesPerSecond: 9.3 } }, replies: downloadRow });
  expect(wide(rows()[0] ?? "")).toMatch(/Downloading Qwen 3\.5 9B·\s*7% · 10 s/);
  // a phone says the download as its icon and the model's short form, so the row is not cut to "Downloading Q…"
  expect(rows()[0]).toContain('<span class="qt-wf">Downloading Qwen 3.5 9B</span><span class="qt-ws">Qwen 9B</span>');
  expect(rows()[0]).toMatch(/<svg class="ic s14 qt-wf"[^>]*><use href="#i-clock"><\/use><\/svg><svg class="ic s14 qt-ws"[^>]*><use href="#i-download">/);
  const css = readFileSync(new URL("../app/styles.css", import.meta.url), "utf8");
  expect(css).toMatch(/\n\.qt-ws\{display:none\}/);
  const phone = css.slice(css.indexOf("@media (max-width:480px){\n  .cb-wrap{")).split(/\n\}\n/)[0] ?? "";
  expect(phone).toMatch(/\.qt-wf\{display:none\}/);
  expect(phone).toMatch(/\.qt-ws\{display:inline\}/);
  show({ models: [], pulls: { [TAG]: { name: TAG, state: "verifying", completedBytes: 100, totalBytes: 100 } }, replies: downloadRow });
  expect(wide(rows()[0] ?? "")).toContain("Checking Qwen 3.5 9B");
  expect(rows()[0]).not.toContain('class="qt-n"');
});

it("a row waiting on setup says what setup is doing beside its numbers", () => {
  const setupRow = repliesOf([{ id: "q1", threadId: "thread", text: "hello", waitFor: "setup" }]);
  show({ runtime: { ...INSTALLING, install: { receivedBytes: 42_000_000, totalBytes: 100_000_000, bytesPerSecond: 500_000 } }, replies: setupRow });
  expect(words(rows()[0] ?? "")).toMatch(/Downloading Ollama·\s*42% · 2 min/);
  show({ runtime: { ...INSTALLING, install: { receivedBytes: 100_000_000, totalBytes: 100_000_000 } }, replies: setupRow });
  expect(words(rows()[0] ?? "")).toContain("Unpacking Ollama");
});

it("a reader hears a waiting row's clock as words, never its numbers digit by digit", () => {
  show({ runtime: { ...INSTALLING, install: { receivedBytes: 42_000_000, totalBytes: 100_000_000 } }, replies: repliesOf([{ id: "q1", threadId: "thread", text: "hello", waitFor: "setup" }]) });
  const row = rows()[0] ?? "";
  expect(row).toContain('<span class="vh">Sends when setup finishes</span>');
  expect(row).toMatch(/<span class="qt-n" aria-hidden="true"><span class="qt-p">42%<\/span><\/span>/);
});

it("only a queued picture carries a kind icon; a queued chat message has none", () => {
  show({ replies: repliesOf([
    { id: "q1", threadId: "thread", text: "a chat", waitFor: "reply" },
    { id: "q2", threadId: "thread", text: "a picture", waitFor: "reply", draw: PICTURE },
  ]) });
  const [chat, picture] = rows();
  expect(chat).not.toContain('class="qt-k"');
  expect(picture).toContain('class="qt-k"');
});

it("a queued message that just waits still has its status line, empty, ready to announce a word", () => {
  show({ replies: repliesOf([{ id: "q1", threadId: "thread", text: "next", waitFor: "reply" }]) });
  expect(rows()[0]).toContain('<span class="qt-s" role="status"></span>');
});
