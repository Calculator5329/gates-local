/// <reference lib="dom" />
// Motion bursts for the side-by-side kit (`GL_E2E_COMPARE=1` in shots.spec.ts). From an
// action, every frame the browser paints (CDP screencast) for about 1.5 s, the boxes of the
// parts that may move on every animation frame (the bug finder's idea: what moved, by how
// much, when), the frames resampled every 33 ms, and a contact sheet: those frames in a grid
// with the ms under each, cropped to what moved. It imports nothing of the app, so another
// app's capture can run the same file.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { CDPSession, Page } from "@playwright/test";

export type Step = (page: Page) => Promise<void>;

export interface BurstOptions {
  /** The burst's frames, boxes and sheet go in `<dir>/<name>/` and `<dir>/<name>.png`. */
  readonly dir: string;
  readonly name: string;
  /** Selectors whose boxes are logged on every frame (at most 12 elements each). */
  readonly track: readonly string[];
  /** The span recorded from the first step, in ms. */
  readonly spanMs?: number;
  /** Kept after the last step ends, in ms, when the steps run past the span. */
  readonly tailMs?: number;
  /** The contact sheet's step between frames, in ms. */
  readonly everyMs?: number;
  /** Written into the burst's JSON and the sheet's heading: app, viewport, theme, commit. */
  readonly meta?: Readonly<Record<string, string | number>>;
}

type Box = readonly [number, number, number, number];
interface BoxFrame { readonly t: number; readonly boxes: Record<string, Box[]> }
interface Painted { readonly t: number; readonly data: Buffer }
interface BurstWindow { burstOn?: boolean; burstT0?: number; burstFrames?: BoxFrame[] }

export interface BurstResult {
  readonly frames: number;
  readonly painted: number;
  readonly sheet: string;
  readonly json: string;
  readonly crop: Box | null;
}

/** Runs in the page: logs the tracked boxes on every animation frame, in ms from its start. */
function boxSampler(track: readonly string[]): void {
  const w = window as unknown as BurstWindow;
  const frames: BoxFrame[] = [];
  const t0 = performance.timeOrigin + performance.now();
  w.burstFrames = frames;
  w.burstT0 = t0;
  w.burstOn = true;
  const tick = () => {
    if (w.burstOn !== true) return;
    const boxes: Record<string, Box[]> = {};
    for (const sel of track) {
      const list: Box[] = [];
      for (const el of [...document.querySelectorAll(sel)].slice(0, 12)) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) list.push([Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]);
      }
      if (list.length > 0) boxes[sel] = list;
    }
    frames.push({ t: Math.round(performance.timeOrigin + performance.now() - t0), boxes });
    requestAnimationFrame(tick);
  };
  tick();
}

/** Resolves once the page's sampler has run `until` ms from its start: the span is what is recorded. */
function spanCovered(until: number): Promise<void> {
  const w = window as unknown as BurstWindow;
  return new Promise<void>((done) => {
    const check = () => (performance.timeOrigin + performance.now() - (w.burstT0 ?? 0) >= until ? done() : requestAnimationFrame(check));
    check();
  });
}

function sampled(): { t0: number; frames: BoxFrame[] } {
  const w = window as unknown as BurstWindow;
  w.burstOn = false;
  return { t0: w.burstT0 ?? 0, frames: w.burstFrames ?? [] };
}

class Screencast {
  readonly frames: Painted[] = [];
  private readonly cdp: CDPSession;
  private constructor(cdp: CDPSession) {
    this.cdp = cdp;
    cdp.on("Page.screencastFrame", (e) => {
      this.frames.push({ t: (e.metadata.timestamp ?? Date.now() / 1000) * 1000, data: Buffer.from(e.data, "base64") });
      void cdp.send("Page.screencastFrameAck", { sessionId: e.sessionId }).catch(() => undefined);
    });
  }

  static async start(page: Page): Promise<Screencast> {
    const cast = new Screencast(await page.context().newCDPSession(page));
    const size = page.viewportSize() ?? { width: 1440, height: 900 };
    await cast.cdp.send("Page.startScreencast", { format: "jpeg", quality: 85, maxWidth: size.width, maxHeight: size.height, everyNthFrame: 1 });
    return cast;
  }

  async stop(): Promise<void> {
    await this.cdp.send("Page.stopScreencast").catch(() => undefined);
    await this.cdp.detach().catch(() => undefined);
  }
}

const same = (a: readonly Box[] | undefined, b: readonly Box[] | undefined) => JSON.stringify(a ?? []) === JSON.stringify(b ?? []);

/** The selectors whose boxes changed, came or went during the burst. */
function movers(frames: readonly BoxFrame[], track: readonly string[]): string[] {
  return track.filter((sel) => frames.some((f, i) => i > 0 && !same(f.boxes[sel], frames[i - 1]!.boxes[sel])));
}

/** The union of every box of what moved, padded and kept in the viewport; null when it is most of the screen or nothing moved. */
function cropOf(frames: readonly BoxFrame[], moved: readonly string[], view: { width: number; height: number }): Box | null {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const f of frames) {
    for (const sel of moved) {
      for (const [x, y, w, h] of f.boxes[sel] ?? []) {
        [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x + w), Math.max(y1, y + h)];
      }
    }
  }
  if (!Number.isFinite(x0)) return null;
  const pad = 16;
  const box: Box = [Math.max(0, x0 - pad), Math.max(0, y0 - pad), 0, 0];
  const w = Math.min(view.width, x1 + pad) - box[0], h = Math.min(view.height, y1 + pad) - box[1];
  if (w <= 0 || h <= 0 || w * h > 0.85 * view.width * view.height) return null;
  return [box[0], box[1], w, h];
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

interface Tick { readonly ms: number; readonly file: string; readonly fresh: boolean; readonly step: number | null }

function sheetHtml(title: string, ticks: readonly Tick[], data: ReadonlyMap<string, string>, crop: Box | null, view: { width: number; height: number }): string {
  const [cx, cy, cw, ch] = crop ?? [0, 0, view.width, view.height];
  const cols = cw / ch > 1.2 ? 6 : 9;
  const cell = Math.floor(2400 / cols) - 8;
  const s = cell / cw;
  const cells = ticks.map((t) => `<figure class="${t.step === null ? "" : "step"}"><div class="f" style="width:${cell}px;height:${Math.round(ch * s)}px"><img src="${data.get(t.file) ?? ""}" style="width:${Math.round(view.width * s)}px;left:${-Math.round(cx * s)}px;top:${-Math.round(cy * s)}px"></div><figcaption class="${t.fresh ? "" : "old"}">${t.ms} ms${t.step === null ? "" : ` · step ${t.step + 1}`}</figcaption></figure>`).join("");
  return `<!doctype html><meta charset="utf-8"><style>
body{margin:0;background:#111;color:#ddd;font:14px/1.3 system-ui,sans-serif;padding:12px;width:2400px}
h1{font-size:16px;margin:0 0 10px;font-weight:600}
.g{display:grid;grid-template-columns:repeat(${cols},${cell}px);gap:8px}
figure{margin:0}.f{position:relative;overflow:hidden;background:#000;outline:1px solid #333}
.f img{position:absolute;display:block}
figcaption{font:12px ui-monospace,monospace;padding:2px 0;color:#ddd}figcaption.old{color:#666}
figure.step .f{outline:2px solid #8fd14f}
</style><h1>${esc(title)}</h1><div class="g">${cells}</div>`;
}

/**
 * Records `steps` as one burst: screencast and box sampler start, the steps run in turn
 * (each waits for its own condition), and recording goes on to `spanMs` from the first
 * step, or `tailMs` past the last one when the steps take longer. Writes the frames every
 * `everyMs`, a JSON of the boxes per frame and a contact sheet.
 */
export async function burst(page: Page, o: BurstOptions, steps: readonly Step[]): Promise<BurstResult> {
  const span = o.spanMs ?? 1500, tail = o.tailMs ?? 600, every = o.everyMs ?? 33;
  const view = page.viewportSize() ?? { width: 1440, height: 900 };
  const out = path.join(o.dir, o.name);
  mkdirSync(out, { recursive: true });
  const cast = await Screencast.start(page);
  // a still page paints once when the screencast starts: that frame is the burst's first
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  await page.evaluate(boxSampler, [...o.track]);
  const marks: { start: number; end: number }[] = [];
  const now = () => page.evaluate(() => performance.timeOrigin + performance.now() - ((window as unknown as BurstWindow).burstT0 ?? 0));
  for (const step of steps) {
    const start = await now();
    await step(page);
    marks.push({ start: Math.round(start), end: Math.round(await now()) });
  }
  const until = Math.max(span, (marks.at(-1)?.end ?? 0) + tail);
  await page.evaluate(spanCovered, until);
  const { t0, frames } = await page.evaluate(sampled);
  await cast.stop();
  const painted = cast.frames.map((f) => ({ t: Math.round(f.t - t0), data: f.data }));

  // one tick every `every` ms: the last frame painted by then
  const files = new Map<Painted, string>();
  const ticks: Tick[] = [];
  let last: Painted | undefined;
  for (let ms = 0; ms <= until; ms += every) {
    const frame = painted.filter((f) => f.t <= ms).at(-1) ?? painted[0];
    if (frame === undefined) break;
    let file = files.get(frame);
    if (file === undefined) {
      file = `${String(files.size).padStart(3, "0")}-at-${Math.max(0, frame.t)}ms.jpg`;
      files.set(frame, file);
      writeFileSync(path.join(out, file), frame.data);
    }
    const step = marks.findIndex((m) => m.start > ms - every && m.start <= ms);
    ticks.push({ ms, file, fresh: frame !== last, step: step === -1 ? null : step });
    last = frame;
  }
  const moved = movers(frames, o.track);
  const crop = cropOf(frames, moved, view);
  const json = path.join(o.dir, `${o.name}.json`);
  writeFileSync(json, `${JSON.stringify({ name: o.name, meta: o.meta ?? {}, viewport: view, everyMs: every, spanMs: until, steps: marks, track: o.track, moved, crop, painted: painted.map((f) => ({ t: f.t, file: files.get(f) ?? null })), ticks, boxes: frames }, null, 1)}\n`);

  const data = new Map([...files.entries()].map(([f, name]) => [name, `data:image/jpeg;base64,${f.data.toString("base64")}`]));
  const meta = Object.entries(o.meta ?? {}).map(([k, v]) => `${k} ${v}`).join(" · ");
  const title = `${o.name} · ${meta} · steps at ${marks.map((m) => `${m.start} ms`).join(", ")} · ${painted.length} frames painted in ${until} ms${crop ? ` · crop ${crop.join(",")}` : " · whole window"}`;
  const sheetPage = await page.context().newPage();
  const sheet = path.join(o.dir, `${o.name}.png`);
  try {
    await sheetPage.setViewportSize({ width: 2424, height: 600 });
    await sheetPage.setContent(sheetHtml(title, ticks, data, crop, view), { waitUntil: "load" });
    await sheetPage.screenshot({ path: sheet, fullPage: true });
  } finally {
    await sheetPage.close();
  }
  return { frames: frames.length, painted: painted.length, sheet, json, crop };
}
