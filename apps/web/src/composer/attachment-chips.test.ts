// The chips under the message box, mounted for real on the fake DOM: refused files with their reason
// and a way out, and attached images as the box and a saved turn show them.
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { FakeDocument, FakeElement, FakeIFrame, type FakeNode } from "../../test/fake-dom.ts";

const calls = vi.hoisted(() => ({ settings: [] as string[] }));
vi.mock("../lib/session/index.ts", async (original) => ({
  ...await original<typeof import("../lib/session/index.ts")>(),
  openSettings: (section: string) => { calls.settings.push(section); },
}));

const doc = new FakeDocument();
const win = { document: doc, HTMLIFrameElement: FakeIFrame, addEventListener() {}, removeEventListener() {} };
let root: Root;
let store: typeof import("../lib/store/store.ts");
let drafts: typeof import("../lib/store/drafts.ts");
let refused: typeof import("./refused-files.ts");
let chips: typeof import("./attachment-images.tsx");

beforeAll(async () => {
  doc.defaultView = win;
  Object.assign(doc, { addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", doc);
  vi.stubGlobal("HTMLElement", FakeElement);
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (X11; Linux x86_64)" });
  const { createRoot } = await import("react-dom/client");
  store = await import("../lib/store/store.ts");
  drafts = await import("../lib/store/drafts.ts");
  refused = await import("./refused-files.ts");
  chips = await import("./attachment-images.tsx");
  root = createRoot(doc.body.appendChild(doc.createElement("div")) as unknown as Element);
});
afterAll(() => { act(() => root.unmount()); vi.unstubAllGlobals(); });
beforeEach(() => { calls.settings.length = 0; });
afterEach(() => { act(() => root.render(null)); });

let chat = 0;
const nextChat = () => `chat-${++chat}`;
function all(pred: (el: FakeElement) => boolean, from: FakeNode = doc.body): FakeElement[] {
  const out: FakeElement[] = [];
  const walk = (n: FakeNode) => { for (const c of n.childNodes) if (c instanceof FakeElement) { if (pred(c)) out.push(c); walk(c); } };
  walk(from);
  return out;
}
const props = (el: FakeElement | null | undefined): Record<string, unknown> => {
  if (el === null || el === undefined) throw new Error("no such element");
  const key = Object.keys(el).find((k) => k.startsWith("__reactProps$"));
  return (key === undefined ? {} : (el as unknown as Record<string, Record<string, unknown>>)[key]) ?? {};
};
const click = (el: FakeElement | null | undefined) => act(() => { (props(el)["onClick"] as () => void)(); });
const chipEls = () => all((el) => el.classList.includes("attachment"));
const byTestId = (id: string, from: FakeNode) => all((el) => el.getAttribute("data-testid") === id, from);
const sizeLine = (chip: FakeElement) => all((el) => el.tagName === "SMALL", chip)[0]?.textContent;
type Refused = Omit<import("./refused-files.ts").RefusedFile, "id">;
const file = (over: Partial<Refused> = {}): Refused => ({ name: "notes.bin", size: 2048, reason: "Too big to send", library: false, ...over });

function showRefused(threadId: string) {
  act(() => store.setState({ view: "thread", threadId }));
  act(() => root.render(createElement(chips.RefusedFiles)));
}

it("a refused file's chip shows its name, its size and not sent, keeps the reason in its tip, and its Remove takes it away", async () => {
  const id = nextChat();
  refused.refuseFiles(id, [file()]);
  showRefused(id);
  const [chip, ...more] = chipEls();
  expect(more).toEqual([]);
  expect(chip!.getAttribute("data-tip")).toBe("Too big to send");
  expect(all((el) => el.tagName === "B", chip)[0]?.textContent).toBe("notes.bin");
  expect(sizeLine(chip!)).toBe("2 KB · not sent");
  const remove = byTestId("chat.attachment.refused-remove", chip!)[0];
  expect(remove?.getAttribute("aria-label")).toBe("Remove notes.bin");
  await click(remove);
  expect(chipEls()).toEqual([]);
  expect(refused.getRefused(id)).toEqual([]);
});

it("the reason reaches the keyboard and screen readers as the description of both the chip's buttons, through a hidden line", () => {
  const id = nextChat();
  refused.refuseFiles(id, [file({ library: true })]);
  showRefused(id);
  const chip = chipEls()[0]!;
  const buttons = all((el) => el.tagName === "BUTTON", chip);
  expect(buttons).toHaveLength(2);
  const described = buttons.map((b) => b.getAttribute("aria-describedby"));
  expect(described[0]).not.toBeNull();
  expect(described[1]).toBe(described[0]);
  const line = all((el) => el.id === described[0], chip)[0];
  expect(line?.classList).toEqual(["vh"]);
  expect(line?.textContent).toBe("Too big to send");
});

it("only a file the Library can hold offers the way into Settings › Library, and that button opens it", async () => {
  const id = nextChat();
  refused.refuseFiles(id, [file({ name: "book.epub", library: true }), file({ name: "tool.exe", library: false })]);
  showRefused(id);
  const [book, tool] = chipEls();
  expect(byTestId("chat.attachment.refused-library", tool!)).toEqual([]);
  const library = byTestId("chat.attachment.refused-library", book!);
  expect(library).toHaveLength(1);
  await click(library[0]);
  expect(calls.settings).toEqual(["library"]);
});

it("a dropped folder's chip says Folder where a file's says its size", () => {
  const id = nextChat();
  refused.refuseFiles(id, [file({ name: "photos", size: 0, folder: true }), file({ name: "clip.mov", size: 3 * 1024 ** 2 })]);
  showRefused(id);
  expect(chipEls().map(sizeLine)).toEqual(["Folder · not sent", "3.0 MB · not sent"]);
});

it("refused chips belong to the draft they were refused in and live only in memory: another chat shows none, and a reload brings none back", async () => {
  const here = nextChat();
  const there = nextChat();
  drafts.replaceDraft(here, { text: "about the attachment" });
  refused.refuseFiles(here, [file({ name: "secret.bin" })]);
  showRefused(here);
  expect(chipEls()).toHaveLength(1);
  showRefused(there);
  expect(chipEls(), "another chat's draft").toEqual([]);
  showRefused(here);
  expect(chipEls(), "back in the first chat").toHaveLength(1);
  expect(JSON.stringify(drafts.savedDrafts())).not.toContain("secret.bin");
  vi.resetModules();
  const reloaded = await import("./refused-files.ts");
  expect(reloaded.getRefused(here)).toEqual([]);
});

it("an image in the box shows from its data URL, and a saved one from the server with this window's file token", () => {
  act(() => store.setState({ serverOrigin: "http://gates.test", fileToken: "tok en" }));
  act(() => root.render(createElement(chips.AttachmentImages, { images: ["data:image/png;base64,AAAA", "threads/t1/pic one.png"] })));
  expect(all((el) => el.tagName === "IMG").map((img) => img.getAttribute("src"))).toEqual([
    "data:image/png;base64,AAAA",
    "http://gates.test/files/threads/t1/pic%20one.png?token=tok%20en",
  ]);
});
