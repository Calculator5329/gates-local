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
export async function delayedMemory(page: Page, ms: number, methods: readonly string[] = ["fit.check", "gpu.status"]): Promise<void> {
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
      w.flickerFrames?.push({ at: performance.now() - start, text, boxes, checking: /Checking[^\n]*…/.test(text), verdicts: [...(el?.querySelectorAll(".fp-v, .vl, .mp-fit, .pk-v") ?? [])].map((n) => n.textContent ?? ""), elements: [...(el?.querySelectorAll("button, input, details, [role=alert]") ?? [])].map((n) => `${n.tagName}:${n.getAttribute("aria-label") ?? n.textContent}`) });
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
