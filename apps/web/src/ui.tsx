// Shared pieces: the tooltip layer, popover placement and the verdict label.
// Tooltips follow the design: any element with data-tip (HTML built by the
// client, data always escaped with esc) or data-tipt (plain text, shown only
// when the row's .t is truncated).
import { type KeyboardEvent as ReactKeyboardEvent, useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import type { Verdict } from "./format.ts";
import { Icon } from "./icons.tsx";
import { type State, getState, setState } from "./store.ts";

type PopId = NonNullable<State["pop"]>["id"];
type FixedPopId = Exclude<PopId, "thread">;
/** The control each popover opens from; Escape and outside clicks return focus there. */
const POP_ANCHOR: Record<FixedPopId, string> = { picker: "modelBtn", images: "modelBtn", plus: "plusBtn", opts: "optBtn" };
/** The popover each element is drawn as. */
export const POP_EL: Record<PopId, string> = { picker: "picker", images: "imagePicker", plus: "plusMenu", thread: "threadMenu", opts: "optsMenu" };

/** A phone-width window (styles.css: 640 px and below), where popovers are bottom sheets. */
export const PHONE = "(max-width: 640px)";
export const isPhone = () => matchMedia(PHONE).matches;

/** Modal wrapping skips hidden, disabled and inert descendants, including a visible inactive rail. */
export function tabStops(root: HTMLElement | null): HTMLElement[] {
  return [...(root?.querySelectorAll<HTMLElement>("button:not(:disabled),a[href],input:not(:disabled),textarea,select,[tabindex]") ?? [])]
    .filter(el => el.tabIndex >= 0 && el.getClientRects().length > 0 && el.closest("[inert]") === null);
}
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

/** A popover's control; each thread menu has its own row button. */
export function anchorOf(id: PopId): HTMLElement | null {
  if (id !== "thread") return document.getElementById(POP_ANCHOR[id]);
  const p = getState().pop;
  return p?.id === "thread" ? document.querySelector<HTMLElement>(`.sb-row[data-thread="${CSS.escape(p.thread)}"] .sb-menu`) : null;
}

/** Open a popover, or close it when it is already open from the same control. */
export function togglePop(id: FixedPopId, kb = false): void {
  // Reopening the size control must not discard a choice awaiting its fit.
  if (id === "picker" && getState().pop?.id === id && document.getElementById("picker")?.getAttribute("aria-busy") === "true") return;
  closeTip();
  setState((s) => ({ pop: s.pop?.id === id ? null : { id, kb } }));
}

/** "if-inside" is a resize: a popover that held focus gives it back the way a phone's sheet does, and one that did not leaves focus alone. */
export function closePop(refocus: boolean | "if-inside" = false): void {
  const p = getState().pop;
  if (p === null) return;
  const el = document.getElementById(POP_EL[p.id]);
  const anchor = anchorOf(p.id);
  const sheet = isPhone() || (refocus === "if-inside" && el?.contains(document.activeElement) === true) ? el : null;
  setState({ pop: null });
  // A context-menu key returns to the thread control; a button-opened menu returns to that button.
  const target = () =>
    (p.id === "thread" && p.at !== undefined ? document.querySelector<HTMLElement>(`.sb-row[data-thread="${CSS.escape(p.thread)}"] .sb-thread`) : null) ??
    (anchor?.isConnected ? anchor : null) ??
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
  if (refocus === true) target()?.focus();
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
    <div className="sh-h">
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

const TIP_DELAY_MS = 400;
const TIP_WARM_MS = 300;

let hideTip: (within?: string) => void = () => undefined;
/** Hide an open or pending tooltip, optionally only within the changed control. */
export function closeTip(within?: string): void {
  hideTip(within);
}

/** The one tooltip element and its document listeners. Mount once. */
export function Tip() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let tipFor: Element | null = null;
    let waitingFor: Element | null = null;
    let timer: number | undefined;
    let closedAt = -Infinity;
    let source: string | null = null, at: DOMRect | undefined;
    const remember = (target: Element) => {
      source = target.getAttribute("data-tip") || target.getAttribute("data-tipt");
      at = target.getBoundingClientRect();
    };
    const cancelWait = () => {
      window.clearTimeout(timer);
      timer = undefined;
      waitingFor = null;
    };
    const hide = () => {
      cancelWait();
      if (tipFor !== null) closedAt = performance.now();
      el.classList.remove("open");
      tipFor = null;
    };
    hideTip = within => {
      if (!within || tipFor?.closest(within) || waitingFor?.closest(within)) hide();
    };
    const over = (e: Event) => {
      // with no hover (touch), a tap on a control is its action; tap() below opens tooltips instead
      if (isTouch()) return;
      const target = e.target instanceof Element ? e.target : null;
      const t = target?.closest("[data-tip],[data-tipt]") ?? null;
      if (!t) {
        hide();
        return;
      }
      if (t === tipFor || t === waitingFor) return;
      const warm = tipFor !== null || performance.now() - closedAt <= TIP_WARM_MS;
      hide();
      if (warm) show(t);
      else {
        waitingFor = t;
        remember(t);
        timer = window.setTimeout(() => show(t), TIP_DELAY_MS);
      }
    };
    const out = (e: MouseEvent) => {
      const next = e.relatedTarget instanceof Element ? e.relatedTarget.closest("[data-tip],[data-tipt]") : null;
      if (next !== null && (next === tipFor || next === waitingFor)) return;
      hide();
    };
    // stay: the same anchor's new words; the left edge holds unless the tip would leave the screen
    const show = (t: Element, stay = false) => {
      const was = stay ? parseFloat(el.style.left) : NaN;
      cancelWait();
      const pop = getState().pop;
      if (!t.isConnected || (pop !== null && t.closest(`#${POP_EL[pop.id]}`) === null)) return hide();
      if (t.getAttribute("aria-expanded") === "true" && t.closest(".cf, .hdr")) return hide();
      let html = t.getAttribute("data-tip");
      if (!html) {
        const tt = t.querySelector(".t");
        if (!tt || tt.scrollWidth <= tt.clientWidth) return hide();
        html = esc(t.getAttribute("data-tipt") ?? "");
      }
      tipFor = t;
      remember(t);
      el.innerHTML = html;
      el.classList.add("open");
      // a tag inside a picker row places its tip by the row (F72); the picker's foot keeps the default
      const r = (t.closest("#picker .pk-r, #picker .pk-dr") ?? t).getBoundingClientRect();
      // Measure at the left edge: left where the last tip was (near the window's
      // right edge) it shrinks to fit, then widens once moved and covers its row.
      el.style.left = "0px";
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      let top = r.top - h - 6;
      let left = r.left + r.width / 2 - w / 2;
      const picker = t.closest(".pk-foot") ? null : t.closest("#picker");
      if (picker || (t.closest(".sb") && t.classList.contains("sb-row"))) {
        // Outside the picker (F72): its context column also contains names and costs.
        const side = picker?.getBoundingClientRect() ?? r;
        top = r.top + r.height / 2 - h / 2;
        left = side.right + 8;
        if (left + w > window.innerWidth - 6) left = side.left - w - 8;
        if (picker && left < 6) {
          // No room on either side (a narrow window): outside the picker, above it or else below.
          const p = picker.getBoundingClientRect();
          left = p.left;
          top = p.top - h - 6 >= 6 ? p.top - h - 6 : p.bottom + 6;
        }
      }
      if (top < 6) top = r.bottom + 6;
      el.style.top = `${top}px`;
      el.style.left = `${was >= 6 && was + w <= window.innerWidth - 6 ? was : clamp(left, 6, window.innerWidth - w - 6)}px`;
    };
    const focusIn = (e: FocusEvent) => {
      const target = e.target instanceof Element ? e.target : null;
      if (isTouch() || !target?.matches(":focus-visible") || target.matches("input,textarea")) return;
      const t = target.closest("[data-tip]");
      if (t) show(t);
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
    // React may move, replace or rewrite an anchor without a pointer event.
    // Unrelated mutations leave the same explanation at the same anchor open.
    const changes = new MutationObserver(records => {
      const target = tipFor ?? waitingFor;
      if (!target) return;
      const now = target.getAttribute("data-tip") || target.getAttribute("data-tipt");
      if (!target.isConnected || !now) return hide();
      // new words at the same anchor (a download's percentage): the open tip follows in place; a pending one shows the newest
      if (source !== now) {
        // an anchor with no box (hidden, collapsed) has nowhere to point
        const box = target.getBoundingClientRect();
        if (box.width === 0 || box.height === 0) return hide();
        return target === tipFor ? show(target, true) : remember(target);
      }
      if (!records.some(record => record.target.contains(target) || target.contains(record.target))) return;
      const box = target.getBoundingClientRect();
      if (!at || box.x !== at.x || box.y !== at.y || box.width !== at.width || box.height !== at.height) hide();
    });
    changes.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-tip", "data-tipt"] });
    document.addEventListener("mouseover", over);
    document.addEventListener("mouseout", out);
    document.addEventListener("focusin", focusIn);
    document.addEventListener("focusout", hide);
    document.addEventListener("mousedown", hide);
    document.addEventListener("click", tap);
    document.addEventListener("scroll", scrolled, true);
    return () => {
      changes.disconnect();
      hide();
      hideTip = () => undefined;
      document.removeEventListener("mouseover", over);
      document.removeEventListener("mouseout", out);
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
