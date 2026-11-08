// Shared pieces: the tooltip layer, popover placement and the verdict label.
// Tooltips follow the design: any element with data-tip (HTML built by the
// client, data always escaped with esc) or data-tipt (plain text, shown only
// when the row's .t is truncated).
import { type KeyboardEvent as ReactKeyboardEvent, useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import type { Verdict } from "./format.ts";
import { Icon } from "./icons.tsx";
import { type State, getState, setState } from "./store.ts";

type PopId = NonNullable<State["pop"]>["id"];
/** The control each popover opens from; Escape and outside clicks return focus there. */
export const POP_ANCHOR: Record<PopId, string> = { picker: "modelBtn", plus: "plusBtn", more: "moreBtn", opts: "optBtn" };
/** The popover each element is drawn as. */
export const POP_EL: Record<PopId, string> = { picker: "picker", plus: "plusMenu", more: "moreMenu", opts: "optsMenu" };

/** A phone-width window (styles.css: 640 px and below), where popovers are bottom sheets. */
export const PHONE = "(max-width: 640px)";
export const isPhone = () => matchMedia(PHONE).matches;
/** A device with no hover (a phone or tablet): tooltips open by tap, and focus never pops the keyboard on its own. */
export const isTouch = () => matchMedia("(hover: none)").matches;

/** A media query as render state, for markup that differs by width and not only by style. */
export function useMedia(query: string): boolean {
  const subscribe = useCallback(
    (changed: () => void) => {
      const m = matchMedia(query);
      m.addEventListener("change", changed);
      return () => m.removeEventListener("change", changed);
    },
    [query],
  );
  return useSyncExternalStore(subscribe, () => matchMedia(query).matches, () => false);
}

/** The control a popover opened from: its desktop anchor, or another opener (data-anchor) when that one is hidden. */
export function anchorOf(id: PopId): HTMLElement | null {
  const main = document.getElementById(POP_ANCHOR[id]);
  if (main && main.getClientRects().length > 0) return main;
  for (const el of document.querySelectorAll<HTMLElement>(`[data-anchor="${id}"]`)) if (el.getClientRects().length > 0) return el;
  return main;
}

/** Open a popover, or close it when it is already open from the same control. */
export function togglePop(id: PopId, kb = false): void {
  closeTip();
  setState((s) => ({ pop: s.pop?.id === id ? null : { id, kb } }));
}

export function closePop(refocus = false): void {
  const p = getState().pop;
  if (p === null) return;
  const sheet = isPhone() ? document.getElementById(POP_EL[p.id]) : null;
  setState({ pop: null });
  // a thread menu from the sidebar gives focus back to its row
  const target = () =>
    (p.thread !== undefined ? document.querySelector<HTMLElement>(`.sb-row[data-thread="${CSS.escape(p.thread)}"]`) : null) ??
    anchorOf(p.id) ??
    document.querySelector<HTMLElement>(".set-bar .bk") ??
    document.getElementById("menuBtn");
  if (sheet !== null) {
    // the app stays inert until this close has rendered, and focus must not stay in a hidden sheet
    requestAnimationFrame(() => {
      const a = document.activeElement;
      if (a === null || a === document.body || sheet.contains(a)) target()?.focus();
    });
    return;
  }
  if (refocus) target()?.focus();
}

/** Up, Down, Home and End move between a menu's items. */
export function menuKeys(e: ReactKeyboardEvent<HTMLDivElement>): void {
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  const at = items.indexOf(document.activeElement as HTMLElement);
  const to = e.key === "ArrowDown" ? at + 1 : e.key === "ArrowUp" ? at - 1 : e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : null;
  if (to === null || items.length === 0) return;
  e.preventDefault();
  items[(to + items.length) % items.length]?.focus();
}

/** Escape text for a data-tip string. Every server or model value passes through it. */
export function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
}

export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** The verdict label: a dot and the words in the verdict color (F35). */
export function VLabel({ v, cls = "vl", hidden }: { v: Verdict; cls?: string; hidden?: boolean }) {
  return (
    <span className={`${cls} ${v.k}`} aria-hidden={hidden ? true : undefined}>
      <span className={`vd ${v.k}`} />
      {v.word}
    </span>
  );
}

/** A bottom sheet's title row with its close button. Drawn only on a phone (styles.css .sh-h). */
export function SheetHead({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="fpn-h sh-h">
      <span className="fp-h fp-t">
        {title}
        {sub === undefined ? null : <span className="fp-gpu">{sub}</span>}
      </span>
      <button type="button" className="ibtn" aria-label="Close" onClick={() => closePop(true)}>
        <Icon id="x" />
      </button>
    </div>
  );
}

/** What counts as a control for tap-to-explain: its tap is its own action. */
const CONTROL = "button, a, input, textarea, [role=button], [role=switch], [role=menuitem]";

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
      // with no hover (touch), a tap on a control is its action; tap() below opens tooltips instead
      if (isTouch()) return;
      const target = e.target instanceof Element ? e.target : null;
      const t = target?.closest("[data-tip],[data-tipt]") ?? null;
      if (!t) {
        if (tipFor) hide();
        return;
      }
      if (t === tipFor) return;
      show(t);
    };
    const show = (t: Element) => {
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
      // a tag inside a picker row places its tip by the row (F72); the picker's foot keeps the default
      const r = (t.closest("#picker .pk-r, #picker .pk-dr") ?? t).getBoundingClientRect();
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      let top = r.top - h - 6;
      let left = r.left + r.width / 2 - w / 2;
      const picker = t.closest(".pk-foot") ? null : t.closest("#picker");
      if (picker || (t.closest(".sb") && t.classList.contains("sb-row"))) {
        // Beside its own row (F72), so it never covers another row's name or a group heading.
        top = r.top + r.height / 2 - h / 2;
        left = r.right + 8;
        if (left + w > window.innerWidth - 6) left = r.left - w - 8;
        if (picker && left < 6) {
          // No room on either side (a narrow window): outside the picker, above it or else below.
          const p = picker.getBoundingClientRect();
          left = p.left;
          top = p.top - h - 6 >= 6 ? p.top - h - 6 : p.bottom + 6;
        }
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
    // touch: a tap on text that only explains (a legend row, a dotted term, a row that can't be
    // picked) opens its tooltip; a tap on a control does what the control does
    const tap = (e: MouseEvent) => {
      if (!isTouch()) return;
      const target = e.target instanceof Element ? e.target : null;
      const t = target?.closest("[data-tip]") ?? null;
      if (!t || t.matches(CONTROL) || target?.closest(CONTROL)?.contains(t) === false) return;
      show(t);
    };
    const scrolled = () => {
      if (isTouch()) hide();
    };
    document.addEventListener("mouseover", over);
    document.addEventListener("focusin", focusIn);
    document.addEventListener("focusout", hide);
    document.addEventListener("mousedown", hide);
    document.addEventListener("click", tap);
    document.addEventListener("scroll", scrolled, true);
    return () => {
      document.removeEventListener("mouseover", over);
      document.removeEventListener("focusin", focusIn);
      document.removeEventListener("focusout", hide);
      document.removeEventListener("mousedown", hide);
      document.removeEventListener("click", tap);
      document.removeEventListener("scroll", scrolled, true);
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
