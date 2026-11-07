// Shared pieces: the tooltip layer, popover placement and the verdict label.
// Tooltips follow the design: any element with data-tip (HTML built by the
// client, data always escaped with esc) or data-tipt (plain text, shown only
// when the row's .t is truncated).
import { useEffect, useRef } from "react";
import type { Verdict } from "./format.ts";
import { type State, getState, setState } from "./store.ts";

type PopId = NonNullable<State["pop"]>["id"];
/** The control each popover opens from; Escape and outside clicks return focus there. */
export const POP_ANCHOR: Record<PopId, string> = { picker: "modelBtn", plus: "plusBtn", more: "moreBtn" };

/** Open a popover, or close it when it is already open from the same control. */
export function togglePop(id: PopId, kb = false): void {
  closeTip();
  setState((s) => ({ pop: s.pop?.id === id ? null : { id, kb } }));
}

export function closePop(refocus = false): void {
  const p = getState().pop;
  if (p === null) return;
  setState({ pop: null });
  if (refocus) document.getElementById(POP_ANCHOR[p.id])?.focus();
}

/** Escape text for a data-tip string. Every server or model value passes through it. */
export function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
}

export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** The verdict label: a dot and the words in the verdict color (F35). */
export function VLabel({ v, cls = "vl" }: { v: Verdict; cls?: string }) {
  return (
    <span className={`${cls} ${v.k}`}>
      <span className={`vd ${v.k}`} />
      {v.word}
    </span>
  );
}

let hideTip: () => void = () => undefined;
/** Hide the open tooltip (after a click that changes what it described). */
export function closeTip(): void {
  hideTip();
}

/** The one tooltip element and its document listeners. Mount once. */
export function Tip() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let tipFor: Element | null = null;
    const hide = () => {
      el.classList.remove("open");
      tipFor = null;
    };
    hideTip = hide;
    const over = (e: Event) => {
      const target = e.target instanceof Element ? e.target : null;
      const t = target?.closest("[data-tip],[data-tipt]") ?? null;
      if (!t) {
        if (tipFor) hide();
        return;
      }
      if (t === tipFor) return;
      if (t.getAttribute("aria-expanded") === "true" && t.closest(".cf, .hdr")) return;
      let html = t.getAttribute("data-tip");
      if (!html) {
        const tt = t.querySelector(".t");
        if (!tt || tt.scrollWidth <= tt.clientWidth) return hide();
        html = esc(t.getAttribute("data-tipt") ?? "");
      }
      tipFor = t;
      el.innerHTML = html;
      el.classList.add("open");
      const r = t.getBoundingClientRect();
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      let top = r.top - h - 6;
      let left = r.left + r.width / 2 - w / 2;
      if (t.closest("#picker") || (t.closest(".sb") && t.classList.contains("sb-row"))) {
        top = r.top + r.height / 2 - h / 2;
        left = r.right + 8;
        if (left + w > window.innerWidth - 6) left = r.left - w - 8;
      }
      if (top < 6) top = r.bottom + 6;
      el.style.top = `${top}px`;
      el.style.left = `${clamp(left, 6, window.innerWidth - w - 6)}px`;
    };
    const focusIn = (e: FocusEvent) => {
      const target = e.target instanceof Element ? e.target : null;
      if (!target || target.matches("input,textarea")) return;
      const t = target.closest("[data-tip]");
      if (t) t.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    };
    document.addEventListener("mouseover", over);
    document.addEventListener("focusin", focusIn);
    document.addEventListener("focusout", hide);
    document.addEventListener("mousedown", hide);
    return () => {
      document.removeEventListener("mouseover", over);
      document.removeEventListener("focusin", focusIn);
      document.removeEventListener("focusout", hide);
      document.removeEventListener("mousedown", hide);
    };
  }, []);
  return <div className="tip" id="tip" ref={ref} />;
}

/**
 * Place a popover next to its anchor (the design's place()). Composer popovers
 * open above the composer; "below" opens under the anchor; "end" aligns right edges.
 */
export function place(pop: HTMLElement, anchor: HTMLElement, align: "start" | "end", dir?: "below"): void {
  const r = anchor.getBoundingClientRect();
  const ph = pop.offsetHeight;
  const pw = pop.offsetWidth;
  const comp = anchor.closest(".composer");
  const ref = comp ? comp.getBoundingClientRect() : r;
  let top = dir === "below" ? r.bottom + 6 : ref.top - ph - 8;
  if (top < 8) top = Math.min(window.innerHeight - ph - 8, ref.bottom + 8);
  const left = align === "end" ? r.right - pw : r.left;
  pop.style.top = `${top}px`;
  pop.style.left = `${clamp(left, 8, window.innerWidth - pw - 8)}px`;
}
