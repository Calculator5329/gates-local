/// <reference lib="dom" />
// Animation-frame observations complement raster bursts: a short-lived empty
// verdict can fall between two screenshots. Evidence is opt-in and stays out
// of the checkout; the observations and assertions always run.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";

export interface Frame {
  at: number;
  text: string;
  boxes: Record<string, number[]>;
  checking: boolean;
  verdicts: string[];
  elements: string[];
}

interface ProbeWindow extends Window {
  flickerFrames?: Frame[];
  flickerStop?: () => void;
}

/** Delay real RPC answers without replacing their contents or the push stream. */
export async function delayedMemory(page: Page, ms: number, methods: readonly string[] = ["fit.table", "gpu.status"]): Promise<void> {
  await page.routeWebSocket(/127\.0\.0\.1:5286/, (ws) => {
    const server = ws.connectToServer();
    const delayed = new Set<unknown>();
    ws.onMessage((message) => {
      const req = JSON.parse(String(message)) as { id?: unknown; method?: unknown };
      if (typeof req.method === "string" && methods.includes(req.method)) delayed.add(req.id);
      server.send(message);
    });
    server.onMessage((message) => {
      const res = JSON.parse(String(message)) as { type?: unknown; id?: unknown };
      if (res.type === "response" && delayed.delete(res.id) && ms > 0) setTimeout(() => ws.send(message), ms);
      else ws.send(message);
    });
  });
}

/** Observe the old state, the interaction, and at least 1.5 seconds afterwards. */
export async function burst(page: Page, surface: string, selector: string, action: () => Promise<unknown>): Promise<Frame[]> {
  const root = process.env["GL_FLICKER_EVIDENCE_ROOT"];
  const dir = root === undefined ? undefined : path.join(root, surface);
  if (dir) mkdirSync(dir, { recursive: true });
  await page.evaluate((sel) => {
    const w = window as ProbeWindow;
    w.flickerFrames = [];
    let active = true;
    w.flickerStop = () => { active = false; };
    const start = performance.now();
    const sample = () => {
      const el = document.querySelector<HTMLElement>(sel);
      const boxes: Record<string, number[]> = {};
      if (el) {
        const nodes = [el, ...el.querySelectorAll<HTMLElement>("[data-flicker-box], .fp-v, .fp-row, .ctx-line, details, .srow, .pk-r, .pk-foot, .c-bottom, .turn, [role=menuitem]")];
        nodes.forEach((node, i) => {
          const r = node.getBoundingClientRect();
          const key = i === 0 ? "surface" : node.dataset["flickerBox"] || node.dataset["m"] || node.dataset["dm"] || node.id || `${node.className || node.tagName}:${i}`;
          if (r.width && r.height) boxes[key] = [r.x, r.y, r.width, r.height];
        });
      }
      const text = el?.innerText ?? "";
      // A fit value still loading: the skeleton before the first table, or an old "Checking…".
      const loading = /checking[^\n]*…/i.test(text) || el?.querySelector(".fit-skel, .pk-cost.skel") != null;
      w.flickerFrames?.push({ at: performance.now() - start, text, boxes, checking: loading, verdicts: [...(el?.querySelectorAll(".fp-v, .vl, .mp-fit, .pk-v") ?? [])].map((n) => n.textContent ?? ""), elements: [...(el?.querySelectorAll("button, input, details, [role=alert]") ?? [])].map((n) => `${n.tagName}:${n.getAttribute("aria-label") ?? n.textContent}`) });
      if (active) requestAnimationFrame(sample);
    };
    sample();
  }, selector);
  const capture = { active: true };
  const shots = (async () => {
    if (!dir) return;
    let i = 0;
    while (capture.active) {
      await page.screenshot({ path: path.join(dir, `${String(i++).padStart(3, "0")}.png`) });
    }
  })();
  try {
    await action();
    // This is the measurement interval, rather than a readiness sleep.
    await page.evaluate(() => new Promise<void>((resolve) => {
      const start = performance.now();
      const frame = () => performance.now() - start >= 1600 ? resolve() : requestAnimationFrame(frame);
      requestAnimationFrame(frame);
    }));
  } finally {
    capture.active = false;
    await shots;
    await page.evaluate(() => (window as ProbeWindow).flickerStop?.());
  }
  const frames = await page.evaluate(() => (window as ProbeWindow).flickerFrames ?? []);
  if (dir) writeFileSync(path.join(dir, "probe.json"), JSON.stringify(frames, null, 2));
  return frames;
}

// ---------------------------------------------------------------- whole on the first frame
//
// The product rule (docs/design.md): a surface shows its full shape on its
// first frame. Nothing arrives later, nothing moves, no words flash and get
// replaced, unless the person did something. A placeholder marks itself
// `data-skel`; a fixed-size slot for a wait that is long by nature (a fit
// check, a download) marks itself `data-wait` and may change its words, not
// its box.

/** The link is slow: every answer, push and code chunk arrives `ms` late, in order. */
export interface Delay {
  /** Requests sent and not yet answered to the page. */
  pending(): number;
  /** Milliseconds since the last request or answer went by. */
  quietFor(): number;
}

export async function delayEverything(page: Page, ms: number, socket: RegExp = /127\.0\.0\.1:5286/): Promise<Delay> {
  let pending = 0;
  let last = Date.now();
  const touch = () => { last = Date.now(); };
  await page.routeWebSocket(socket, (ws) => {
    const server = ws.connectToServer();
    const open = new Set<unknown>();
    ws.onMessage((message) => {
      try {
        const req = JSON.parse(String(message)) as { id?: unknown; method?: unknown };
        if (typeof req.method === "string" && req.id !== undefined) { open.add(req.id); pending++; touch(); }
      } catch { /* not a request */ }
      server.send(message);
    });
    // Equal timeouts fire in order, so pushes never overtake an answer sent before them.
    server.onMessage((message) => {
      let id: unknown;
      try { const res = JSON.parse(String(message)) as { type?: unknown; id?: unknown }; if (res.type === "response") id = res.id; } catch { /* a push */ }
      setTimeout(() => {
        ws.send(message);
        if (id !== undefined && open.delete(id)) pending--;
        touch();
      }, ms);
    });
  });
  // Lazy code chunks: a section whose code is not in hand shows that here too.
  await page.route(/\/assets\/.+\.(js|css)(\?.*)?$/, async (route) => {
    pending++; touch();
    await new Promise((resolve) => setTimeout(resolve, ms));
    try { await route.continue(); } finally { pending--; touch(); }
  });
  return { pending: () => pending, quietFor: () => Date.now() - last };
}

/** Wait until the page has nothing in flight (or `max` ms), so a measurement starts from rest. */
export async function settled(delay: Delay, max = 10_000): Promise<void> {
  const end = Date.now() + max;
  while (Date.now() < end && (delay.pending() > 0 || delay.quietFor() < 400)) await new Promise((resolve) => setTimeout(resolve, 50));
}

export interface WholeOptions {
  /** The surface: everything inside it is watched. */
  readonly root: string;
  /** Its first frame: this selector shows (with these words, when given). Default: the root shows. */
  readonly arrive?: { readonly selector: string; readonly text?: string };
  /** Cards, rows and panels whose box is followed. */
  readonly track?: string;
}

interface WholeEl { readonly key: string; readonly box: readonly number[] }
export interface WholeFrame {
  readonly at: number;
  readonly present: boolean;
  readonly arrived: boolean;
  /** Visible words; a placeholder reads ▢ and a wait slot ◇ whatever it says. */
  readonly text: string;
  readonly els: readonly WholeEl[];
  /** Placeholders outside an aria-busy container, or not hidden from assistive tech. */
  readonly loose: number;
}

export const TRACK = [
  ".set-h", ".mp-head", ".mp-tabs", ".grp", ".srow", ".mp-row", ".mp-card", ".mp-defrow", ".mp-foot", ".mp-quiet", ".mp-empty",
  ".dlrow", ".fp-set", ".inst-top", ".inst-actions", ".cfm", ".na", ".src-none", "details",
  ".sb-row", ".sb-h", ".composer", ".banner", ".turn", ".pk-r", ".pk-foot", ".pk-context", ".fr-card", ".first",
  "[role=alert]", "[data-watch]",
].join(", ");

/** Runs in the page from before the action (or before the app's first script) until stopped. Exported for the bug finder (test/finder), which samples beside it. */
export function wholeSampler(o: WholeOptions & { track: string }): void {
  const w = window as unknown as { wholeWatch?: { frames: unknown[]; on: boolean } };
  const state = { frames: [] as unknown[], on: true };
  w.wholeWatch = state;
  const start = performance.now();
  const kinds = o.track.split(",").map((s) => s.trim());
  // The page runs this function's source alone, so its helpers live inside it.
  const seen = (el: Element) => (el as HTMLElement).checkVisibility?.({ visibilityProperty: kinds.length > 0 }) ?? true;
  const short = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, o.track.length > 0 ? 48 : 0);
  const words = (el: Element) => short(el.querySelector(".grp-t, h1, h2, .mp-nmn, b, .sb-t, .nm")?.textContent);
  const labelOf = (el: HTMLElement) => {
    for (const a of ["data-watch", "data-m", "data-dm", "data-em", "data-cat", "data-import", "data-db", "data-pull", "data-ctx", "id"]) {
      const v = el.getAttribute(a);
      if (v) return v;
    }
    return short(el.getAttribute("aria-label")) || words(el);
  };
  const textOf = (root: Element) => {
    const out: string[] = [];
    const walk = (node: Node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        if (node.parentElement && seen(node.parentElement)) out.push(node.nodeValue ?? "");
        return;
      }
      if (!(node instanceof Element)) return;
      if (node.hasAttribute("data-skel")) { if (seen(node)) out.push(" ▢ "); return; }
      if (node.hasAttribute("data-wait")) { if (seen(node)) out.push(" ◇ "); return; }
      if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) {
        if (seen(node)) out.push(` ⟨${node.value || node.placeholder}⟩ `);
        return;
      }
      for (const child of node.childNodes) walk(child);
      if (node instanceof HTMLElement && getComputedStyle(node).display !== "inline") out.push(" ");
    };
    walk(root);
    return out.join("").replace(/\s+/g, " ").trim();
  };
  const tick = () => {
    const root = document.querySelector(o.root);
    const arrived = root !== null && (o.arrive === undefined ? true : [...document.querySelectorAll(o.arrive.selector)].some((el) => o.arrive?.text === undefined || short(el.textContent) === o.arrive.text));
    const els: { key: string; box: number[] }[] = [];
    let loose = 0;
    if (root) {
      const count = new Map<string, number>();
      for (const el of root.querySelectorAll<HTMLElement>(`${o.track}, [data-skel], [data-wait]`)) {
        if (el.parentElement?.closest("[data-skel]")) continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0 || !seen(el)) continue;
        const skel = el.hasAttribute("data-skel");
        if (skel && (el.closest("[aria-busy=true]") === null || el.closest("[aria-hidden=true]") === null)) loose++;
        const kind = skel ? "skel" : el.hasAttribute("data-wait") ? "wait" : kinds.find((k) => el.matches(k)) ?? "?";
        const grp = el.parentElement?.closest(".grp");
        const base = `${kind} ${grp ? `${words(grp)} / ` : ""}${labelOf(el)}`;
        const n = (count.get(base) ?? 0) + 1;
        count.set(base, n);
        els.push({ key: n === 1 ? base : `${base} #${n}`, box: [r.x, r.y, r.width, r.height].map((v) => Math.round(v * 2) / 2) });
      }
    }
    state.frames.push({ at: performance.now() - start, present: root !== null, arrived, text: root ? textOf(root) : "", els, loose });
    if (state.on) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/** Watch from before `action` until the page is quiet again (at least `min` ms, at most `max`). */
export async function watchWhole(page: Page, opts: WholeOptions, action: () => Promise<unknown>, delay?: Delay, min = 1500, max = 6000): Promise<WholeFrame[]> {
  await page.evaluate(wholeSampler, { ...opts, track: opts.track ?? TRACK });
  await action();
  return collectWhole(page, delay, min, max);
}

/** Start watching before the app's first script runs, for app start and first run. */
export async function watchFromLoad(page: Page, opts: WholeOptions): Promise<void> {
  await page.addInitScript(wholeSampler, { ...opts, track: opts.track ?? TRACK });
}

export async function collectWhole(page: Page, delay?: Delay, min = 1500, max = 6000): Promise<WholeFrame[]> {
  const start = Date.now();
  // The measurement interval: past every delayed answer, rather than a readiness sleep.
  const busy = () => delay !== undefined && (delay.pending() > 0 || delay.quietFor() < 500);
  for (let spent = 0; spent < max && (spent < min || busy()); spent = Date.now() - start) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return page.evaluate(() => {
    const w = window as unknown as { wholeWatch?: { frames: WholeFrame[]; on: boolean } };
    if (w.wholeWatch) w.wholeWatch.on = false;
    return w.wholeWatch?.frames ?? [];
  });
}

export interface WholeFinding { readonly step: string; readonly kind: string; readonly what: string; readonly detail: string }

const near = (a: readonly number[], b: readonly number[], slack = 1) => a.every((v, i) => Math.abs(v - (b[i] ?? 0)) <= slack);
const inside = (a: readonly number[], b: readonly number[], slack = 1) =>
  (a[0] ?? 0) >= (b[0] ?? 0) - slack && (a[1] ?? 0) >= (b[1] ?? 0) - slack &&
  (a[0] ?? 0) + (a[2] ?? 0) <= (b[0] ?? 0) + (b[2] ?? 0) + slack && (a[1] ?? 0) + (a[3] ?? 0) <= (b[1] ?? 0) + (b[3] ?? 0) + slack;
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Where two texts differ, with a little of what is around it. */
function diff(a: string, b: string): string {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  let j = 0;
  while (j < a.length - i && j < b.length - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++;
  const cut = (s: string) => JSON.stringify(`${i > 30 ? "…" : ""}${s.slice(Math.max(0, i - 30), Math.min(s.length, s.length - j + 30))}${j > 30 ? "…" : ""}`.slice(0, 220));
  return `${cut(a)} -> ${cut(b)}`;
}

/** Everything that broke the rule between the surface's first frame and the end. */
export function wholeFindings(step: string, frames: readonly WholeFrame[]): WholeFinding[] {
  const out: WholeFinding[] = [];
  const add = (kind: string, what: string, detail: string) => out.push({ step, kind, what, detail });
  const from = frames.findIndex((f) => f.arrived);
  if (from < 0) return [{ step, kind: "never shown", what: "(surface)", detail: `not shown in ${frames.length} frames` }];
  const first = frames[from]!;
  const start = frames[0]!;
  // Something else on screen between the action and the surface: a passing screen.
  for (const text of new Set(frames.slice(1, from).filter((f) => f.present && f.text !== start.text).map((f) => f.text))) {
    add("passing screen", "(surface)", JSON.stringify(text.slice(0, 200)));
  }
  const shown = frames.slice(from);
  const ms = (i: number) => `${(shown[i]!.at - first.at).toFixed(0)} ms and ${i} frames`;
  const keys = [...new Set(shown.flatMap((f) => f.els.map((e) => e.key)))];
  for (const key of keys) {
    const at = shown.map((f, i) => ({ i, box: f.els.find((e) => e.key === key)?.box })).filter((e): e is { i: number; box: readonly number[] } => e.box !== undefined);
    const begin = at[0]!;
    const skel = key.startsWith("skel ");
    if (begin.i > 0 && !skel) {
      // A placeholder held this place: it may be replaced by what it stood for.
      const held = shown.slice(0, begin.i + 1).some((f) => f.els.some((e) => e.key.startsWith("skel ") && inside(begin.box, e.box)));
      if (!held) add("late", key, `arrived ${ms(begin.i)} after the first frame`);
    }
    const boxes = [...new Set(at.map((e) => e.box.join(",")))];
    if (at.some((e) => !near(e.box, begin.box))) add("moved", key, `x,y,w,h ${boxes.slice(0, 4).join(" -> ")}${boxes.length > 4 ? " …" : ""}`);
    const last = at.at(-1)!;
    if (!skel && last.i < shown.length - 1) add("gone", key, `last seen ${ms(last.i)} after the first frame`);
    else if (!skel && at.length < shown.length - begin.i) add("blinked", key, "missing on some frames in between");
  }
  let changes = 0;
  for (let i = 1; i < shown.length; i++) {
    const a = shown[i - 1]!.text, b = shown[i]!.text;
    if (a === b) continue;
    const pattern = new RegExp(`^${a.split("▢").map(escape).join("[\\s\\S]*?")}$`);
    if (pattern.test(b)) continue;
    if (changes++ < 4) add("changed words", "(surface)", `${ms(i)}: ${diff(a, b)}`);
  }
  if (changes > 4) add("changed words", "(surface)", `${changes - 4} more changes`);
  const end = shown.at(-1)!;
  const left = end.els.filter((e) => e.key.startsWith("skel "));
  if (left.length > 0) add("placeholder left", left.map((e) => e.key).join(", "), "still a placeholder at the end");
  if (shown.some((f) => f.loose > 0)) add("loose placeholder", "(surface)", "a placeholder outside an aria-busy container, or not aria-hidden");
  return out;
}

/** Count distinct missing/loading states, and the excursion of stable boxes. */
export function memoryMetrics(frames: Frame[]) {
  const wrong = frames.filter((f) => f.checking || f.verdicts.length === 0);
  const transients = new Set(wrong.map((f) => JSON.stringify([f.checking, f.verdicts, f.elements]))).size;
  const heights = frames.map((f) => Object.values(f.boxes)[0]?.[3]).filter((h): h is number => h !== undefined);
  return { frames: frames.length, transients, shiftPx: Math.max(0, ...heights) - Math.min(...heights), checkingFrames: wrong.length };
}

/** Endpoints are intentional. Intermediate text/controls and overshoot need review. */
export function transitionMetrics(frames: Frame[]) {
  const start = frames[0];
  const end = frames.at(-1);
  const visible = frames.filter((f) => Object.keys(f.boxes).length > 0);
  const firstBoxes = visible[0]?.boxes ?? {};
  const lastBoxes = visible.at(-1)?.boxes ?? {};
  const states = [...new Set(frames.map((f) => f.text))];
  const transientText = states.filter((text) => text !== start?.text && text !== end?.text);
  const known = new Set([...(start?.elements ?? []), ...(end?.elements ?? [])]);
  const transientElements = [...new Set(frames.flatMap((f) => f.elements).filter((s) => !known.has(s)))];
  let shiftPx = 0;
  let overshootPx = 0;
  for (const key of Object.keys(firstBoxes)) {
    const a = firstBoxes[key];
    const b = lastBoxes[key];
    if (!a || !b) continue;
    for (let axis = 0; axis < 4; axis++) {
      const vals = visible.map((f) => f.boxes[key]?.[axis]).filter((v): v is number => v !== undefined);
      const lo = Math.min(...vals);
      const hi = Math.max(...vals);
      shiftPx = Math.max(shiftPx, hi - lo);
      overshootPx = Math.max(overshootPx, Math.min(a[axis] ?? 0, b[axis] ?? 0) - lo, hi - Math.max(a[axis] ?? 0, b[axis] ?? 0));
    }
  }
  return { frames: frames.length, transients: transientText.length, transientText, transientElements, shiftPx, overshootPx, checkingFrames: frames.filter((f) => f.checking).length };
}
