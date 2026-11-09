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
function fallback(mode: "missing" | "rejected", result: boolean | "throw") {
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
  const anchor = {};
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
        const f = fallback(mode, result);
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
        expect(f.selection.removeAllRanges).toHaveBeenCalledOnce();
        expect(f.selection.setBaseAndExtent).toHaveBeenCalledWith(f.anchor, 12, f.focus, 4);
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
