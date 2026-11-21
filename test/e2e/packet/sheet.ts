// frames.png: one sheet of about 12 screencast frames from a failed test, most
// of them in the last four seconds before the screen last changed, each stamped
// with its time before the failure and the step that was running. Drawn by the test browser itself, so
// no image tool has to be installed on the test machine.
import type { Browser } from "@playwright/test";
import type { Frame } from "./trace.ts";

/** A step of the test on the wall clock: what was running at a frame's moment. */
export type Span = { readonly start: number; readonly end: number; readonly title: string };

type Cell = { readonly frame: Frame; readonly from: number; readonly to: number };

const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const seconds = (ms: number) => `${ms <= -50 ? "−" : ms >= 50 ? "+" : ""}${(Math.abs(ms) / 1000).toFixed(1)} s`;
/** A blank 800x500 screencast frame measured 2.7 KB; any painted app screen is several times that. */
const BLANK_JPEG_BYTES = 4000;

/** The moments the sheet shows: 4 across the test, 8 in its last 4 s (all 12 spread out when it is short). */
export function moments(first: number, failedAt: number): number[] {
  const span = failedAt - first;
  if (span <= 5000) return Array.from({ length: 12 }, (_, i) => first + (span * i) / 11);
  const early = Array.from({ length: 4 }, (_, i) => first + ((span - 4000) * i) / 4);
  return [...early, ...[-4000, -3000, -2000, -1500, -1000, -600, -300, 0].map(offset => failedAt + offset)];
}

/** The chosen frames, a frame shown at two moments in a row folded into one cell. */
export function cells(frames: readonly Frame[], times: readonly number[]): Cell[] {
  const out: Cell[] = [];
  for (const time of times) {
    const frame = frames.findLast(f => f.at <= time) ?? frames[0];
    if (!frame) continue;
    const last = out.at(-1);
    if (last?.frame === frame) out[out.length - 1] = { ...last, to: time };
    else out.push({ frame, from: time, to: time });
  }
  return out;
}

function stepAt(steps: readonly Span[], time: number): string {
  return steps.filter(step => step.start <= time && time <= step.end).at(-1)?.title ?? "";
}

/** Writes the sheet to `out`; returns how many cells it holds (0 writes nothing). */
export async function writeSheet(browser: Browser, out: string, input: {
  readonly title: string; readonly error: string; readonly frames: readonly Frame[];
  readonly startAt: number; readonly failedAt: number; readonly steps: readonly Span[];
}): Promise<number> {
  // why: an empty page before the app paints is a JPEG of a few KB and tells the reader nothing
  const painted = input.frames.filter(frame => frame.jpeg().length > BLANK_JPEG_BYTES);
  const frames = painted.length > 0 ? painted : input.frames;
  const first = frames[0];
  if (!first) return 0;
  // why: a waiting assertion paints nothing, so the moments end at the last change before the failure
  const lastChange = frames.findLast(frame => frame.at <= input.failedAt)?.at ?? first.at;
  const chosen = cells(frames, [...moments(first.at, lastChange), input.failedAt]);
  const html = chosen.map((cell, i) => {
    const when = cell.from === cell.to ? seconds(cell.from - input.failedAt) : `${seconds(cell.from - input.failedAt)} to ${seconds(cell.to - input.failedAt)}, unchanged`;
    const step = stepAt(input.steps, cell.to);
    const img = `data:image/jpeg;base64,${cell.frame.jpeg().toString("base64")}`;
    return `<figure class="${i === chosen.length - 1 ? "last" : ""}"><img src="${img}"><figcaption><b>${escape(when)}</b> · ${escape(seconds(cell.to - input.startAt).replace("+", ""))} in${step ? ` · ${escape(step)}` : ""}</figcaption></figure>`;
  }).join("");
  const page = await browser.newPage({ viewport: { width: 1600, height: 800 }, deviceScaleFactor: 1 });
  try {
    await page.setContent(`<!doctype html><style>
      body { margin: 0; padding: 8px; width: 1584px; background: #fff; color: #111; font: 15px/1.35 ui-monospace, monospace; }
      header { padding: 4px 4px 10px; } header b { font-size: 17px; } header div { color: #a00; white-space: pre-wrap; }
      main { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
      figure { margin: 0; border: 3px solid #ddd; align-self: start; } figure.last { border-color: #d00; }
      img { display: block; width: 100%; } figcaption { padding: 4px 6px; background: #f3f3f3; overflow-wrap: anywhere; }
    </style><header><b>${escape(input.title)}</b><div>${escape(input.error)}</div></header><main>${html}</main>`);
    await page.screenshot({ path: out, fullPage: true });
  } finally {
    await page.close();
  }
  return chosen.length;
}
