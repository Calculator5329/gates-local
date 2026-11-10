import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText, useCopy } from "./copy.ts";

const feedback = vi.hoisted(() => ({ value: null as boolean | null }));
vi.mock("react", () => ({
  useState: () => [feedback.value, (value: boolean | null) => { feedback.value = value; }],
  useRef: (current: unknown) => ({ current }),
  useEffect: () => {},
}));

afterEach(() => vi.unstubAllGlobals());

/** A DOM contract fake; browser specs separately check the actual OS clipboard. */
function fallback(mode: "missing" | "rejected", result: boolean | "throw", where: "reply" | "field" = "reply") {
  class Focusable {
    focus = vi.fn();
  }
  class Field extends Focusable {
    selectionStart = 4;
    selectionEnd = 12;
    selectionDirection = "backward";
    setSelectionRange = vi.fn();
  }
  class Textarea extends Field {
    value = "";
    readOnly = false;
    style = { cssText: "" };
    select = vi.fn();
    remove = vi.fn();
  }
  const active = new Field();
  const ta = new Textarea();
  // A focused field reports the document selection as a caret in its parent;
  // a selected reply reports a range in nodes that don't contain the field.
  const anchor = { contains: (node: unknown) => where === "field" && node === active };
  const focus = {};
  const selection = { anchorNode: anchor, anchorOffset: 12, focusNode: focus, focusOffset: 4, removeAllRanges: vi.fn(), setBaseAndExtent: vi.fn() };
  let written: string | null = null;
  const execCommand = vi.fn(() => {
    if (result === "throw") throw new Error("Copy refused");
    if (result) written = ta.value;
    return result;
  });
  const doc = { activeElement: active, getSelection: () => selection, createElement: vi.fn(() => ta), body: { append: vi.fn() }, execCommand };
  vi.stubGlobal("HTMLElement", Focusable);
  vi.stubGlobal("HTMLInputElement", Field);
  vi.stubGlobal("HTMLTextAreaElement", Textarea);
  vi.stubGlobal("document", doc);
  vi.stubGlobal("navigator", { clipboard: mode === "missing" ? undefined : { writeText: () => Promise.reject(new Error("Permission denied")) } });
  return { active, ta, selection, anchor, focus, doc, written: () => written };
}

describe("copyText", () => {
  it("a focused composer does not erase a separate reply selection after fallback copying", async () => {
    const f = fallback("missing", true);
    // Chromium's field selection restoration replaces the document selection,
    // even when the reader has since selected text in a reply.
    const selected = { text: "re is the " };
    f.active.setSelectionRange.mockImplementation(() => { selected.text = ""; });
    f.selection.setBaseAndExtent.mockImplementation(() => { selected.text = "re is the "; });
    expect(await copyText("code")).toBe(true);
    expect(selected.text).toBe("re is the ");
  });

  it("a focused draft keeps its own backward selection after fallback copying", async () => {
    const f = fallback("missing", true, "field");
    // Restoring the caret-only document selection collapses the field's range.
    const range = { start: 4, end: 12, direction: "backward" };
    f.active.setSelectionRange.mockImplementation((start: number, end: number, direction: string) => { Object.assign(range, { start, end, direction }); });
    f.selection.setBaseAndExtent.mockImplementation(() => { Object.assign(range, { start: 0, end: 0, direction: "forward" }); });
    expect(await copyText("reply")).toBe(true);
    expect(range).toEqual({ start: 4, end: 12, direction: "backward" });
  });

  it("waits for the native write to finish and leaves the DOM alone on success", async () => {
    const pending: { resolve?: () => void } = {};
    const writeText = vi.fn(() => new Promise<void>((resolve) => { pending.resolve = resolve; }));
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    vi.stubGlobal("document", undefined);
    let settled = false;
    const done = copyText("  exact\n\t🦀  ").then((ok) => { settled = true; return ok; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(writeText).toHaveBeenCalledWith("  exact\n\t🦀  ");
    pending.resolve?.();
    expect(await done).toBe(true);
  });

  for (const mode of ["missing", "rejected"] as const) {
    for (const result of [true, false, "throw"] as const) {
      it(`${mode} API, fallback ${String(result)}: exact plain text and restoration even on failure`, async () => {
        const f = fallback(mode, result, "field");
        const text = "  **plain markdown** café 🦀\n\tlast line  \n";
        expect(await copyText(text)).toBe(result === true);
        expect(f.written()).toBe(result === true ? text : null);
        expect(f.ta.value).toBe(text);
        expect(f.ta.readOnly).toBe(true);
        expect(f.doc.execCommand).toHaveBeenCalledWith("copy");
        expect(f.doc.body.append).toHaveBeenCalledWith(f.ta);
        expect(f.ta.select).toHaveBeenCalledOnce();
        expect(f.ta.remove).toHaveBeenCalledOnce();
        expect(f.active.focus).toHaveBeenCalledWith({ preventScroll: true });
        expect(f.active.setSelectionRange).toHaveBeenCalledWith(4, 12, "backward");
        expect(f.selection.setBaseAndExtent).not.toHaveBeenCalled();
      });

      it(`${mode} API, fallback ${String(result)}: a reply selection is restored even on failure`, async () => {
        const f = fallback(mode, result);
        await copyText("text");
        expect(f.active.focus).toHaveBeenCalledWith({ preventScroll: true });
        expect(f.selection.removeAllRanges).toHaveBeenCalledOnce();
        expect(f.selection.setBaseAndExtent).toHaveBeenCalledWith(f.anchor, 12, f.focus, 4);
        expect(f.active.setSelectionRange).not.toHaveBeenCalled();
      });
    }
  }
});

it.each([true, false])("only the latest overlapping copy controls feedback (latest=%s)", async (latest) => {
  fallback("rejected", false);
  const attempts: Array<{ resolve(): void; reject(error: Error): void }> = [];
  vi.stubGlobal("navigator", { clipboard: { writeText: () => new Promise<void>((resolve, reject) => { attempts.push({ resolve, reject }); }) } });
  const [, copy] = useCopy("exact text");
  copy();
  copy();
  const finish = async (index: number, success: boolean) => {
    const attempt = attempts[index]!;
    if (success) attempt.resolve();
    else attempt.reject(new Error("Permission denied"));
    for (let job = 0; job < 8; job++) await Promise.resolve();
  };
  await finish(1, latest);
  expect(feedback.value).toBe(latest);
  await finish(0, !latest);
  expect(feedback.value).toBe(latest);
});
