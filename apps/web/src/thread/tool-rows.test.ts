import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message, ToolStep } from "@gates-local/contracts";
import { type LiveTurn, setState, type State } from "../lib/store/store.ts";

vi.mock("../lib/store/store.ts", async (original) => {
  const actual = await original<typeof import("../lib/store/store.ts")>();
  return { ...actual, useStore: <T,>(selector: (s: State) => T) => selector(actual.getState()) };
});
vi.mock("../lib/session/index.ts", () => ({ cancelImage: vi.fn(), retryImage: vi.fn(), reloadThread: vi.fn(), retry: vi.fn(), fileUrl: () => "/f", loadEarlier: vi.fn(async () => false), earlierOf: () => 0, onEarlier: () => () => undefined }));
beforeEach(() => { vi.stubGlobal("matchMedia", () => ({ matches: true })); vi.stubGlobal("window", {}); vi.useFakeTimers(); });
afterEach(() => { setState({ turns: {}, messages: {}, threadId: null }); vi.unstubAllGlobals(); vi.useRealTimers(); });

const T = "t";
const user: Message = { id: "u", threadId: T, role: "user", createdAt: 1, content: "Check my notes" };
const sent = (tools: ToolStep[], end?: LiveTurn["end"]): LiveTurn =>
  ({ threadId: T, turnId: "turn", model: "m", startedAt: 0, thinking: "", text: "", tools, ...(end === undefined ? {} : { end }) });
const reply = (tools: ToolStep[], patch: Partial<Message> = {}): Message =>
  ({ id: "a", threadId: T, role: "assistant", createdAt: 2, content: "Done.", tools, ...patch });
const call = (name: string, input: Record<string, unknown>) => JSON.stringify({ name, input });
const step = (name: string, state: ToolStep["state"], summary: string, patch: Partial<ToolStep> = {}): ToolStep =>
  ({ callId: `${name}-${summary}`, name, state, summary, ...patch });

async function render(state: Partial<State>): Promise<string> {
  vi.setSystemTime(5000);
  const { Timeline } = await import("./Thread.tsx");
  setState({ threadId: T, turns: {}, ...state });
  return renderToStaticMarkup(createElement(Timeline, { threadId: T }));
}
const saved = (msg: Message) => render({ messages: { [T]: [user, msg] } });
const live = (turn: LiveTurn) => render({ messages: { [T]: [user] }, turns: { [T]: turn } });

const rowsOf = (html: string) => html.split('<div class="wr" ').slice(1);
const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const text = (s: string) => decode(s.replace(/<[^>]+>/g, ""));
const cmdOf = (row: string) => {
  const m = /<p class="cmd">([\s\S]*?)<\/p>/.exec(row);
  return m === null ? undefined : text(m[1] ?? "");
};
const headOf = (row: string) => text(/<span class="wr-h"[^>]*>([\s\S]*?)<\/span>/.exec(row)?.[1] ?? "");
const metaOf = (row: string) => /<span class="wr-m">([\s\S]*?)<\/span><span class="wr-x">/.exec(row)?.[1] ?? "";
const markOf = (row: string) => /<span class="wr-st" data-st="(\w+)">([\s\S]*?)<\/span><span class="wr-h"[^>]*>/.exec(row);
async function oneRow(msg: Message): Promise<string> {
  const rows = rowsOf(await saved(msg));
  expect(rows).toHaveLength(1);
  return rows[0] ?? "";
}

async function stylesheet(): Promise<string> {
  const { readFileSync } = await import("node:fs");
  return readFileSync(new URL("../app/styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
}
interface Rule { readonly sel: readonly string[]; readonly body: string }
function rulesOf(css: string): Rule[] {
  return css.split("}").flatMap((chunk) => {
    const open = chunk.lastIndexOf("{");
    if (open < 0) return [];
    const head = chunk.slice(0, open);
    return [{ sel: head.slice(head.lastIndexOf("{") + 1).split(",").map((s) => s.trim()), body: chunk.slice(open + 1) }];
  });
}
function blocksOf(css: string, at: RegExp): string {
  let out = "";
  for (const m of css.matchAll(at)) {
    const start = (m.index ?? 0) + m[0].length;
    let depth = 1;
    let i = start;
    for (; i < css.length && depth > 0; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") depth--;
    }
    out += css.slice(start, i - 1) + "}";
  }
  return out;
}
const names = (rule: Rule, cls: string) => rule.sel.some((s) => s === cls || s.endsWith(` ${cls}`));

describe("a call's line in its opened row", () => {
  it("a shell call shows its command after $, and any other call its query, path or prompt with no $", async () => {
    expect(cmdOf(await oneRow(reply([step("shell", "done", "Listing files", { detail: `${call("shell", { command: "ls -la notes" })}\nnotes.md` })])))).toBe("$ ls -la notes");
    expect(cmdOf(await oneRow(reply([step("sql", "done", "Counting rows", { detail: call("sql", { query: "select count(*) from books" }) })])))).toBe("select count(*) from books");
    expect(cmdOf(await oneRow(reply([step("read", "done", "Reading the notes", { detail: call("read", { path: "docs/notes.md" }) })])))).toBe("docs/notes.md");
    expect(cmdOf(await oneRow(reply([step("image", "done", "Image queued", { detail: call("image", { prompt: "a ship at dawn" }) })])))).toBe("a ship at dawn");
  });

  it("an image call's prompts show one per line, and an older step's single prompt still shows", async () => {
    expect(cmdOf(await oneRow(reply([step("image", "done", "Images queued", { detail: call("image", { prompts: ["a ship at dawn", "a ship at dusk"] }) })])))).toBe("a ship at dawn\na ship at dusk");
    expect(cmdOf(await oneRow(reply([step("image", "done", "Image queued", { detail: call("image", { prompt: "a lone lighthouse" }) })])))).toBe("a lone lighthouse");
  });

  it("a saved line that is not a call, such as an older step cut short, is shown just as it was saved", async () => {
    const cut = '{"name":"shell","input":{"command":"find / -name notes';
    expect(cmdOf(await oneRow(reply([step("shell", "done", "Finding notes", { detail: `${cut}\nmore` })])))).toBe(`$ ${cut}`);
    expect(cmdOf(await oneRow(reply([step("shell", "done", "Searching", { detail: "grep -r TODO src" })])))).toBe("$ grep -r TODO src");
  });
});

describe("a step cut short", () => {
  it("a step still running when Stop ends the turn is drawn cut short: the grey mark and stopped, never running", async () => {
    const rows = rowsOf(await live(sent([step("shell", "running", "Searching your library")], { kind: "stopped", secs: 3 })));
    expect(rows).toHaveLength(1);
    const row = rows[0] ?? "";
    expect(markOf(row)?.[1]).toBe("cut");
    expect(row).not.toContain("run-dot");
    expect(text(metaOf(row))).toBe("Shell · stopped");
  });

  it("a failed step's mark is red and a step Stop cut short keeps the grey mark of every other step", async () => {
    const rows = rowsOf(await saved(reply([step("shell", "error", "Searching", { stopped: true }), step("sql", "error", "Counting")], { interrupted: true })));
    expect(rows.map((r) => markOf(r)?.[1])).toEqual(["cut", "rej"]);
    const rules = rulesOf(await stylesheet());
    const mark = rules.filter((r) => r.sel.includes(".wr-st"));
    expect(mark.some((r) => r.body.includes("color:var(--muted-foreground)"))).toBe(true);
    expect(rules.filter((r) => r.sel.includes('.wr-st[data-st="rej"]')).map((r) => r.body)).toEqual(["color:var(--red)"]);
    expect(rules.filter((r) => r.sel.some((s) => s.includes('data-st="cut"')))).toEqual([]);
  });
});

describe("a step's label", () => {
  it("a call run with -readonly is labelled read-only beside the tool's name; one without the flag is not", async () => {
    const ro = await oneRow(reply([step("shell", "done", "Listing tables", { durationMs: 1200, detail: call("shell", { command: "sqlite3 -readonly lib.db .tables" }) })]));
    expect(text(metaOf(ro))).toBe("Shell · read-only · 1.2 s");
    const rw = await oneRow(reply([step("shell", "done", "Listing tables", { durationMs: 1200, detail: call("shell", { command: "sqlite3 -readonlyx lib.db .tables" }) })]));
    expect(text(metaOf(rw))).toBe("Shell · 1.2 s");
    expect(rw).not.toContain("read-only");
  });

  it("a summary that already starts with the tool's name is said once: no Read lead before its time or its running word", async () => {
    const done = await oneRow(reply([step("read", "done", "Read notes.md", { durationMs: 30 })]));
    expect(headOf(done)).toBe("Read notes.md");
    expect(text(metaOf(done))).toBe("30 ms");
    expect(done).not.toContain("wr-tool");
    const rows = rowsOf(await live(sent([step("read", "running", "Read notes.md")])));
    expect(text(metaOf(rows[0] ?? ""))).toBe("running");
  });

  it("a failed step's heading is the call it made, with the red mark, never the words that it could not finish", async () => {
    const row = await oneRow(reply([step("shell", "error", "Tool could not finish", { durationMs: 900, detail: `${call("shell", { command: "cat missing.txt" })}\ncat: missing.txt: No such file` })]));
    expect(markOf(row)?.[1]).toBe("rej");
    expect(headOf(row)).toBe("cat missing.txt");
    expect(row).not.toContain("Tool could not finish");
  });

  it("a failed step's opened body does not repeat the call its heading already says (Measure transcript, 2026-11-21)", async () => {
    const refused = "Path is outside your Library; use /library/<source id>";
    const row = await oneRow(reply([step("read", "error", "Tool could not finish", { detail: `${call("read", { path: "measure-notes/expenses.csv" })}\n${refused}` })]));
    expect(headOf(row)).toBe("measure-notes/expenses.csv");
    expect(cmdOf(row)).toBeUndefined();
    expect(text(row).split("measure-notes/expenses.csv")).toHaveLength(2);
    expect(text(row)).toContain(refused);
    // a row headed by its summary keeps its call line
    expect(cmdOf(await oneRow(reply([step("read", "done", "Read Notes", { detail: call("read", { path: "/library/measure-notes/expenses.csv" }) })])))).toBe("/library/measure-notes/expenses.csv");
  });
});

describe("a tool row's look", () => {
  it("a running call carries the one working dot in its mark, never a spinner", async () => {
    const rows = rowsOf(await live(sent([step("shell", "running", "Searching your library")])));
    expect(rows).toHaveLength(1);
    const mark = markOf(rows[0] ?? "");
    expect(mark?.[1]).toBe("run");
    expect(mark?.[2]).toBe('<span class="run-dot"></span>');
    expect(rows[0]).not.toMatch(/spin/);
  });

  it("on a phone the collapsed line keeps the time and the tool's name moves into the details", async () => {
    const row = await oneRow(reply([step("shell", "done", "Listing files", { durationMs: 1200, detail: call("shell", { command: "ls" }) })]));
    expect(metaOf(row)).toBe('<span class="wr-tool">Shell · </span>1.2 s');
    expect(row).toContain('<p class="wr-who">Shell</p>');
    const css = await stylesheet();
    const everywhere = rulesOf(css);
    expect(everywhere.some((r) => r.sel.includes(".wr-who") && r.body === "display:none")).toBe(true);
    const phone = rulesOf(blocksOf(css, /@media ?\(max-width:640px\)\{/g));
    expect(phone.some((r) => names(r, ".wr-tool") && /(^|;)display:none/.test(r.body))).toBe(true);
    expect(phone.some((r) => names(r, ".wr-who") && /(^|;)display:block/.test(r.body))).toBe(true);
    expect(phone.filter((r) => names(r, ".wr-m") && /display:none/.test(r.body))).toEqual([]);
  });

  it("an opened call's output is one box up to 360 px that scrolls inside, and at its ends the wheel goes on to the page", async () => {
    const rules = rulesOf(await stylesheet()).filter((r) => r.sel.some((s) => s.includes(".wr-body")));
    const box = rules.find((r) => r.sel.includes(".wr-body"));
    expect(box?.body).toMatch(/(^|;)max-height:360px(;|$)/);
    expect(box?.body).toMatch(/(^|;)overflow-y:auto(;|$)/);
    expect(rules.filter((r) => /overscroll-behavior/.test(r.body))).toEqual([]);
  });
});
