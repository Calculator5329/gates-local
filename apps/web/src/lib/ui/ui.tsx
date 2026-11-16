import { type KeyboardEvent as ReactKeyboardEvent, useCallback, useSyncExternalStore } from "react";
import type { Verdict } from "../words/format.ts";
import { Icon } from "./icons.tsx";
import { type State, getState, setState } from "../store/store.ts";
import { requestFocus } from "./kit/focus.ts";
import { debounce } from "./kit/async.ts";

type PopId = NonNullable<State["pop"]>["id"];
type FixedPopId = Exclude<PopId, "thread">;
const POP_ANCHOR: Record<FixedPopId, string> = { picker: "modelBtn", images: "modelBtn", plus: "plusBtn", opts: "optBtn", count: "countBtn", unset: "imageBtn" };
export const POP_EL: Record<PopId, string> = { picker: "picker", images: "imagePicker", plus: "plusMenu", thread: "threadMenu", opts: "optsMenu", count: "countMenu", unset: "imageUnset" };

export const PHONE = "(max-width: 640px)";
export const isPhone = () => matchMedia(PHONE).matches;

export function tabStops(root: HTMLElement | null): HTMLElement[] {
  return [...(root?.querySelectorAll<HTMLElement>("button:not(:disabled),a[href],input:not(:disabled),textarea,select,[tabindex]") ?? [])]
    .filter(el => el.tabIndex >= 0 && el.getClientRects().length > 0 && el.closest("[inert]") === null);
}
export const isTouch = () => matchMedia("(hover: none)").matches;

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

export function anchorOf(id: PopId): HTMLElement | null {
  if (id !== "thread") return document.getElementById(POP_ANCHOR[id]);
  const p = getState().pop;
  return p?.id === "thread" ? document.querySelector<HTMLElement>(`.sb-row[data-thread="${CSS.escape(p.thread)}"] .sb-menu`) : null;
}

export function togglePop(id: FixedPopId, kb = false): void {
  closeTip();
  setState((s) => ({ pop: s.pop?.id === id ? null : { id, kb } }));
}

export function closePop(refocus: boolean | "if-inside" = false): void {
  const p = getState().pop;
  if (p === null) return;
  const el = document.getElementById(POP_EL[p.id]);
  const anchor = anchorOf(p.id);
  const sheet = isPhone() || (refocus === "if-inside" && el?.contains(document.activeElement) === true) ? el : null;
  setState({ pop: null });
  const target = () =>
    (p.id === "thread" && p.at !== undefined ? document.querySelector<HTMLElement>(`.sb-row[data-thread="${CSS.escape(p.thread)}"] .sb-thread`) : null) ??
    (anchor?.isConnected ? anchor : null) ??
    document.querySelector<HTMLElement>(".set-bar .bk") ??
    document.getElementById("menuBtn");
  if (sheet !== null) {
    // why: the app stays inert until the close renders, so focus waits for that commit
    requestFocus(() => {
      const a = document.activeElement;
      return a === null || a === document.body || sheet.contains(a) ? target() : null;
    });
    return;
  }
  if (refocus === true) target()?.focus();
}

export function menuKeys(e: ReactKeyboardEvent<HTMLDivElement>): void {
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  const at = items.indexOf(document.activeElement as HTMLElement);
  const to = e.key === "ArrowDown" ? at + 1 : e.key === "ArrowUp" ? at - 1 : e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : null;
  if (to === null || items.length === 0) return;
  e.preventDefault();
  items[(to + items.length) % items.length]?.focus();
}

export function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
}

export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export const Skel = ({ w = "8em" }: { w?: string }) => <span className="skel" data-skel="" aria-hidden="true" style={{ width: w }} />;

export const FitSkel = ({ w = "40px" }: { w?: string }) => <span className="skel fit-skel" data-skel="" aria-hidden="true" style={{ width: w }} />;

const TURN_SKEL = [["38%"], ["94%", "88%", "62%"], ["26%"], ["90%", "71%"]] as const;

export const TurnSkel = () => (
  <div className="tl-skel" data-skel="" aria-hidden="true" data-thread-loading="" data-flicker-box="thread-loading">
    {TURN_SKEL.map((lines, i) => (
      <div key={i} className={i % 2 === 0 ? "tl-skel-u" : "tl-skel-a"}>
        {lines.map((w, j) => <span key={j} className="skel" style={{ width: w }} />)}
      </div>
    ))}
  </div>
);

export function VLabel({ v, cls = "vl", hidden }: { v: Verdict; cls?: string; hidden?: boolean }) {
  return (
    <span className={`${cls} ${v.k}`} aria-hidden={hidden ? true : undefined}>
      <span className={`vd ${v.k}`} />
      {v.word}
    </span>
  );
}

export function SheetHead({ title }: { title: string }) {
  return (
    <div className="sh-h">
      <span className="fp-h fp-t">{title}</span>
      <button type="button" className="ibtn" data-testid="ui.sheet.close" aria-label="Close" onClick={() => closePop(true)}>
        <Icon id="x" />
      </button>
    </div>
  );
}

const CONTROL = "button, a, input, textarea, [role=button], [role=switch], [role=menuitem]";

const TIP_DELAY_MS = 400;
const TIP_WARM_MS = 300;

let hideTip: (within?: string) => void = () => undefined;
export function closeTip(within?: string): void {
  hideTip(within);
}
let showTipAt: (anchor: Element) => void = () => undefined;
export function openTip(anchor: Element | null | undefined): void {
  if (anchor) showTipAt(anchor);
}

// why: one identity at module level, so the listeners attach when #tip is drawn and go with it
const holdTip = (el: HTMLDivElement | null): (() => void) | undefined => {
  if (!el) return;
  let tipFor: Element | null = null;
  let waitingFor: Element | null = null;
  let closedAt = -Infinity;
  let source: string | null = null, at: DOMRect | undefined;
  const remember = (target: Element) => {
    source = target.getAttribute("data-tip") || target.getAttribute("data-tipt");
    at = target.getBoundingClientRect();
  };
  // why: a tooltip opens after the pointer rests on its anchor for the hover delay
  const wait = debounce((t: Element) => show(t), TIP_DELAY_MS);
  const cancelWait = () => {
    wait.cancel();
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
      wait(t);
    }
  };
  const out = (e: MouseEvent) => {
    const next = e.relatedTarget instanceof Element ? e.relatedTarget.closest("[data-tip],[data-tipt]") : null;
    if (next !== null && (next === tipFor || next === waitingFor)) return;
    hide();
  };
  const show = (t: Element, stay = false) => {
    const was = stay ? parseFloat(el.style.left) : NaN;
    cancelWait();
    const pop = getState().pop;
    if (!t.isConnected || (pop !== null && t.closest(`#${POP_EL[pop.id]}`) === null)) return hide();
    if (t.getAttribute("aria-expanded") === "true" && t.closest(".cf, .hdr")) return hide();
    let html = t.getAttribute("data-tip");
    if (!html) {
      const tt = t.querySelector(".t, .pk-nm");
      if (!tt || tt.scrollWidth <= tt.clientWidth) return hide();
      html = esc(t.getAttribute("data-tipt") ?? "");
    }
    tipFor = t;
    remember(t);
    el.innerHTML = html;
    el.classList.add("open");
    const r = t.getBoundingClientRect();
    // external: a browser shrinks a fixed box near the window's right edge to fit
    el.style.left = "0px";
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let top = r.top - h - 6;
    let left = r.left + r.width / 2 - w / 2;
    const picker = t.closest(".pk-foot") ? null : t.closest("#picker");
    if (picker || (t.closest(".sb") && t.classList.contains("sb-row"))) {
      const side = picker?.getBoundingClientRect() ?? r;
      top = r.top + r.height / 2 - h / 2;
      left = side.right + 8;
      if (left + w > window.innerWidth - 6) left = side.left - w - 8;
      if (picker && left < 6) {
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
  const changes = new MutationObserver(records => {
    const target = tipFor ?? waitingFor;
    if (!target) return;
    if (records.some(record => record.attributeName === "data-tipkey" && record.target === target)) return hide();
    const now = target.getAttribute("data-tip") || target.getAttribute("data-tipt");
    if (!target.isConnected || !now) return hide();
    if (source !== now) {
      const box = target.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) return hide();
      return target === tipFor ? show(target, true) : remember(target);
    }
    if (!records.some(record => record.target.contains(target) || target.contains(record.target))) return;
    const box = target.getBoundingClientRect();
    if (!at || box.x !== at.x || box.y !== at.y || box.width !== at.width || box.height !== at.height) hide();
  });
  changes.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-tip", "data-tipt", "data-tipkey"] });
  showTipAt = t => show(t);
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
    showTipAt = () => undefined;
    document.removeEventListener("mouseover", over);
    document.removeEventListener("mouseout", out);
    document.removeEventListener("focusin", focusIn);
    document.removeEventListener("focusout", hide);
    document.removeEventListener("mousedown", hide);
    document.removeEventListener("click", tap);
    document.removeEventListener("scroll", scrolled, true);
  };
};

export function Tip() {
  return <div className="tip" id="tip" ref={holdTip} />;
}

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
