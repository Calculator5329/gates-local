/// <reference lib="dom" />
// The finder's page side. The probe's own sampler (wholeSampler in
// test/e2e/flicker-probe.ts) records every animation frame; the finder's hook
// rides on each of its frames, so what it samples (words said twice) lines up
// with the probe's frame by index. Cut-off text is read once, when the step is
// quiet. The screencast keeps what was painted, with the browser's clock.
// The page runs finderHook's and finderCut's source alone, so their helpers live inside them.
/* oxlint-disable unicorn/consistent-function-scoping */
import type { CDPSession, Page } from "@playwright/test";
import { TRACK, type WholeOptions, wholeSampler } from "../e2e/flicker-probe.ts";
import type { CutEl, Twin } from "./detectors.ts";

/** Words that are the conversation, not the app: never "said twice". */
export const IGNORE = [".md", ".think-body", "pre", "code", ".turn.u", "#tip", ".us-rows", "[data-finder-ignore]"].join(", ");

interface HookOptions { readonly root: string; readonly ignore: string }
interface Extra { readonly t: number; readonly twice: readonly Twin[] }
interface FinderWindow { finderStart?: number; finderExtras?: Extra[]; wholeWatch?: { frames: { text: string }[] } }

/** Runs in the page right after wholeSampler: one extra sample per probe frame. Its helpers live inside it. */
function finderHook(o: HookOptions): void {
  const w = window as unknown as FinderWindow;
  const watch = w.wholeWatch;
  if (!watch) return;
  const extras: Extra[] = [];
  w.finderStart = performance.now();
  w.finderExtras = extras;
  const vis = (el: Element) => {
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1 && el.checkVisibility({ opacityProperty: true, visibilityProperty: true });
  };
  const norm = (s: string) => s.replace(/<[^>]*>/g, " ").replace(/&[a-z#0-9]+;/gi, " ").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
  const name = (el: Element) => {
    const cls = typeof el.className === "string" ? el.className.split(/\s+/).find(Boolean) : undefined;
    const said = el.getAttribute("aria-label") || ((el as HTMLElement).innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
    return `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ""}${said ? ` "${said}"` : ""}`;
  };
  const box = (el: Element) => { const r = el.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map((v) => Math.round(v)); };
  const ownText = (el: Element) => [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && (n.nodeValue ?? "").trim() !== "");
  /** In the window and on top at its middle (or its tooltip's owner is). */
  const seen = (el: Element) => {
    const r = el.getBoundingClientRect();
    const x = Math.min(Math.max(r.left + r.width / 2, 0), window.innerWidth - 1), y = Math.min(Math.max(r.top + r.height / 2, 0), window.innerHeight - 1);
    if (r.right <= 0 || r.bottom <= 0 || r.left >= window.innerWidth || r.top >= window.innerHeight) return false;
    const top = document.elementFromPoint(x, y);
    return top !== null && (el.contains(top) || top.contains(el));
  };
  let lastText: string | null = null;
  let lastTwice: Twin[] = [];
  const sample = (text: string): Twin[] => {
    // the same words on screen as the frame before: the same answer
    if (text === lastText) return lastTwice;
    lastText = text;
    const root = document.querySelector(o.root);
    if (!root) return (lastTwice = []);
    const units = new Map<string, { el: Element; tip: boolean }[]>();
    const add = (phrase: string, el: Element, tip: boolean) => {
      // two words or more; numbers, times and sizes repeat by nature
      if (phrase.split(" ").length < 2 || /^[\d\s.:,%x×/+-]*(am|pm|ms|s|min|mb|gb|kb|k)?$/.test(phrase)) return;
      const list = units.get(phrase) ?? [];
      list.push({ el, tip });
      units.set(phrase, list);
    };
    for (const el of root.querySelectorAll("*")) {
      if (el.closest(o.ignore)) continue;
      const tip = el.getAttribute("data-tipt") ?? el.getAttribute("data-tip");
      const field = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el : null;
      const textual = ownText(el);
      if (!textual && !tip && !field) continue;
      if (!vis(el)) continue;
      const words = norm((el as HTMLElement).innerText ?? "");
      if (textual) add(words, el, false);
      // an icon's own tooltip is how it says its name once; a tooltip on words says them again,
      // unless those words can be cut with an ellipsis: then the tooltip is how the whole name is read
      if (tip && words !== "") {
        const phrase = norm(tip);
        const fullName = [el, ...el.querySelectorAll("*")].some((e) => getComputedStyle(e).textOverflow === "ellipsis" && norm((e as HTMLElement).innerText ?? "") === phrase);
        if (!fullName) add(phrase, el, true);
      }
      if (field && field.placeholder && field.value === "") add(norm(field.placeholder), el, false);
    }
    const out: Twin[] = [];
    for (const [phrase, list] of units) {
      // a label inside another label with the same words is one thing
      const kept = list.filter((u) => u.tip || !list.some((v) => !v.tip && v.el !== u.el && v.el.contains(u.el)));
      if (kept.length < 2) continue;
      // one column of a list (same kind of element, same left edge, one per row) is a table's cells, each row's own
      const kind = (u: { el: Element }) => name(u.el).split(" ")[0];
      const left = box(kept[0]!.el)[0]!;
      if (kept.every((u) => u.tip === kept[0]!.tip && kind(u) === kind(kept[0]!) && Math.abs(box(u.el)[0]! - left) <= 1)) continue;
      // words under a drawer or a menu are not seen; it takes two seen to say a thing twice
      if (kept.filter((u) => seen(u.el)).length < 2) continue;
      out.push({ phrase, els: kept.slice(0, 4).map((u) => ({ key: name(u.el), box: box(u.el), tip: u.tip })) });
    }
    return (lastTwice = out);
  };
  const push = watch.frames.push;
  watch.frames.push = function (this: { text: string }[], ...items: { text: string }[]) {
    for (const f of items) extras.push({ t: performance.timeOrigin + performance.now(), twice: sample(f.text) });
    return push.apply(this, items);
  };
}

/** Runs in the page once the step is quiet: words wider than their box, and boxes past the window's edge. */
function finderCut(o: HookOptions): CutEl[] {
  const root = document.querySelector(o.root);
  if (!root) return [];
  const out: CutEl[] = [];
  const vw = window.innerWidth, vh = window.innerHeight;
  const vis = (el: Element) => {
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1 && el.checkVisibility({ opacityProperty: true, visibilityProperty: true });
  };
  const ownText = (el: Element) => [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && (n.nodeValue ?? "").trim() !== "");
  const name = (el: Element) => {
    const cls = typeof el.className === "string" ? el.className.split(/\s+/).find(Boolean) : undefined;
    const said = el.getAttribute("aria-label") || ((el as HTMLElement).innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
    return `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ""}${said ? ` "${said}"` : ""}`;
  };
  const box = (el: Element) => { const r = el.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map((v) => Math.round(v)); };
  // inside something that scrolls, being past the edge is being further down the list
  const scrolls = (el: Element) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (/(auto|scroll)/.test(cs.overflowX + cs.overflowY) && (p.scrollHeight > p.clientHeight + 1 || p.scrollWidth > p.clientWidth + 1)) return true;
    }
    return false;
  };
  for (const el of root.querySelectorAll("*")) {
    if (el.closest(o.ignore)) continue;
    const textual = ownText(el);
    if (!textual && !el.matches("button, input, select, textarea, img, [role=button], h1, h2, h3, label")) continue;
    if (!vis(el)) continue;
    const cs = getComputedStyle(el);
    const he = el as HTMLElement;
    if (textual && he.clientWidth > 0 && he.scrollWidth > he.clientWidth + 2 && !/(auto|scroll)/.test(cs.overflowX)) {
      // a name cut with an ellipsis is said in full by its tooltip
      const tipped = el.closest("[data-tip], [data-tipt], [title]") !== null;
      // words that spill past a box that does not clip are only cut where they run into a neighbour
      const r = el.getBoundingClientRect();
      const spill = { left: r.right, right: r.right + he.scrollWidth - he.clientWidth, top: r.top, bottom: r.bottom };
      const near = [...(el.parentElement?.children ?? []), ...(el.parentElement?.parentElement?.children ?? [])].filter((n) => n !== el && !n.contains(el) && vis(n));
      const runsInto = near.some((n) => { const b = n.getBoundingClientRect(); return b.left < spill.right && b.right > spill.left && b.top < spill.bottom && b.bottom > spill.top; });
      let clips = cs.overflowX !== "visible";
      for (let p = el.parentElement; !clips && p && p !== document.body; p = p.parentElement) {
        if (getComputedStyle(p).overflowX !== "visible") { clips = p.getBoundingClientRect().right < spill.right - 1; break; }
      }
      if (!(cs.textOverflow === "ellipsis" && tipped) && (clips || runsInto)) out.push({ key: name(el), box: box(el), how: "text", px: he.scrollWidth - he.clientWidth });
      continue;
    }
    const r = el.getBoundingClientRect();
    const inView = r.right > 0 && r.bottom > 0 && r.left < vw && r.top < vh;
    const past = Math.max(-r.left, -r.top, r.right - vw, r.bottom - vh);
    if (inView && past > 1 && !scrolls(el)) out.push({ key: name(el), box: box(el), how: "edge", px: past });
  }
  return out.slice(0, 24);
}

/** The probe's sampler and the finder's hook, as one script for the page (or an init script for a load). */
export function watchScript(root: string, opens: WholeOptions["arrive"], track: readonly string[]): string {
  const whole = { root, ...(opens ? { arrive: opens } : {}), track: [TRACK, ...track].join(", ") };
  const hook: HookOptions = { root, ignore: IGNORE };
  return `(${wholeSampler.toString()})(${JSON.stringify(whole)});(${finderHook.toString()})(${JSON.stringify(hook)});`;
}

/** Wait two painted frames, so the probe has a frame from before the action. */
export const twoFrames = (page: Page) => page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));

/** When the action starts, on the probe's frame clock. */
export const now = (page: Page) => page.evaluate(() => performance.now() - ((window as unknown as FinderWindow).finderStart ?? 0));

export const extras = (page: Page) => page.evaluate(() => (window as unknown as FinderWindow).finderExtras ?? []);

export const cutOff = (page: Page, root: string) => page.evaluate(finderCut, { root, ignore: IGNORE });

export interface Shot { readonly t: number; readonly data: Buffer }

/** Every frame the browser paints (CDP screencast), with its wall-clock time in ms. */
export class Screencast {
  private frames: Shot[] = [];
  private on = false;
  private readonly cdp: CDPSession;
  constructor(cdp: CDPSession) {
    this.cdp = cdp;
    cdp.on("Page.screencastFrame", (e) => {
      if (this.on) this.frames.push({ t: (e.metadata.timestamp ?? Date.now() / 1000) * 1000, data: Buffer.from(e.data, "base64") });
      void cdp.send("Page.screencastFrameAck", { sessionId: e.sessionId }).catch(() => undefined);
    });
  }

  static async open(page: Page): Promise<Screencast> {
    return new Screencast(await page.context().newCDPSession(page));
  }

  async start(size: { width: number; height: number }): Promise<void> {
    this.frames = [];
    this.on = true;
    await this.cdp.send("Page.startScreencast", { format: "jpeg", quality: 70, maxWidth: size.width, maxHeight: size.height, everyNthFrame: 1 });
  }

  async stop(): Promise<Shot[]> {
    this.on = false;
    await this.cdp.send("Page.stopScreencast").catch(() => undefined);
    return this.frames;
  }
}

/** The shots to keep for a step with a finding: every frame for the first 600 ms, then one per 100 ms, at most `cap`. */
export function burst(shots: readonly Shot[], from: number, cap = 60): Shot[] {
  const out: Shot[] = [];
  let next = from + 600;
  for (const s of shots) {
    if (out.length >= cap) break;
    if (s.t < from) continue;
    if (s.t <= from + 600) { out.push(s); continue; }
    if (s.t >= next) { out.push(s); next = s.t + 100; }
  }
  return out;
}

/** A frame's paint reaches the screencast a frame or two after its animation frame starts. */
export const PAINT_LAG_MS = 34;

/**
 * The painted frame that shows probe frame `i`. A frame where something just
 * changed (`changed`) is shown by the first paint a little after it, when the
 * change is on screen; any other frame by the first paint before the next frame,
 * or the last one before it when nothing was painted.
 */
export function shotFor(shots: readonly Shot[], frames: readonly { t: number }[], i: number, changed = false): Shot | undefined {
  const t = frames[i]?.t;
  if (t === undefined) return undefined;
  if (changed) return shots.find((s) => s.t >= t + PAINT_LAG_MS) ?? shots.at(-1);
  const until = frames[i + 1]?.t ?? Infinity;
  return shots.find((s) => s.t >= t - 4 && s.t < until) ?? shots.filter((s) => s.t <= t).at(-1) ?? shots[0];
}
