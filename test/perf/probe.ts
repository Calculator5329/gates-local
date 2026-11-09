/// <reference lib="dom" />
import type { Page } from "@playwright/test";

export interface Observation { elapsed: number; frames: number[]; longTasks: number[]; inputDelays: number[] }
interface Probe {
  arm(event: string, selector: string, text: string, mode: string): void;
  result: Promise<Observation>;
  drop(): void;
}
declare global { interface Window { perfJourney: Probe } }

/** Instrument the browser only. No production hook; no automation round-trip in elapsed time. */
export function browserProbe(setup: boolean) {
    if (setup) localStorage.removeItem("gates-local.first-run-done");
    else localStorage.setItem("gates-local.first-run-done", "1");
    const sockets: WebSocket[] = [];
    const NativeSocket = window.WebSocket;
    window.WebSocket = class extends NativeSocket {
      constructor(url: string | URL, protocols?: string | string[]) { super(url, protocols); sockets.push(this); }
    };
    let resolve: (v: Observation) => void;
    let begin = 0;
    let frames: number[] = [], tasks: number[] = [], inputs: number[] = [];
    let observer: PerformanceObserver | undefined;
    const probe: Probe = {
      result: Promise.resolve({ elapsed: 0, frames: [], longTasks: [], inputDelays: [] }),
      drop: () => { for (const socket of sockets) if (socket.readyState === NativeSocket.OPEN) socket.close(); },
      arm(event, selector, text, mode) {
        probe.result = new Promise(r => { resolve = r; });
        frames = []; tasks = []; inputs = []; begin = 0;
        observer = new PerformanceObserver(list => { for (const entry of list.getEntries()) if (entry.startTime >= begin) tasks.push(entry.duration); });
        observer.observe({ type: "longtask" });
        let collecting = false;
        const onKey = (input: KeyboardEvent) => { if (collecting) inputs.push(Math.max(0, performance.now() - input.timeStamp)); };
        document.addEventListener("keydown", onKey, true);
        const start = (input?: Event) => {
          collecting = true;
          begin = event === "navigation" ? 0 : input?.timeStamp ?? performance.now();
          if (input) inputs.push(Math.max(0, performance.now() - input.timeStamp));
          let previous = performance.now();
          const initialSocket = sockets.at(-1);
          const check = () => {
            const now = performance.now();
            frames.push(now - previous); previous = now;
            const el = document.querySelector<HTMLElement>(selector);
            const visible = el !== null && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
            const rect = el?.getBoundingClientRect();
            const inView = visible && rect !== undefined && rect.bottom > 0 && rect.top < innerHeight;
            const match = mode === "absent" ? !visible
              : mode === "value" ? visible && (el as HTMLTextAreaElement).value === text
              : mode === "usable-value" ? visible && (el as HTMLTextAreaElement).value === text && !(el as HTMLTextAreaElement).disabled && document.activeElement === el
              : mode === "compact-text" ? inView && (el?.textContent ?? "").replace(/\s/g, "").includes(text)
              : mode === "count" ? document.querySelectorAll(selector).length === Number(text)
              : mode === "less-than" ? document.querySelectorAll(selector).length < Number(text)
              : mode === "ready" ? visible && !(el as HTMLTextAreaElement).disabled && !document.querySelector(".composer.blocked")
              : mode === "reconnect" ? initialSocket !== undefined && sockets.at(-1) !== initialSocket && sockets.at(-1)?.readyState === NativeSocket.OPEN && visible && !(el as HTMLTextAreaElement).disabled && !document.querySelector(".composer.blocked")
              : inView && (el?.textContent ?? "").includes(text);
            if (!match) { requestAnimationFrame(check); return; }
            // Two rAFs bracket a paint opportunity after the state is in the DOM.
            requestAnimationFrame(() => requestAnimationFrame(() => {
              for (const entry of observer?.takeRecords() ?? []) if (entry.startTime >= begin) tasks.push(entry.duration);
              observer?.disconnect();
              collecting = false;
              document.removeEventListener("keydown", onKey, true);
              resolve({ elapsed: performance.now() - begin, frames, longTasks: tasks, inputDelays: inputs });
            }));
          };
          requestAnimationFrame(check);
        };
        if (event.startsWith("mutation:")) {
          const from = event.slice("mutation:".length);
          if (document.querySelector(from)) throw new Error(`Measurement begin marker already exists: ${from}`);
          const starter = new MutationObserver(() => {
            if (document.querySelector(from)) { starter.disconnect(); start(); }
          });
          starter.observe(document, { childList: true, subtree: true, attributes: true });
        } else if (event === "navigation" || event === "now") start();
        else document.addEventListener(event, start, { capture: true, once: true });
      },
    };
    window.perfJourney = probe;
    // Armed before the production entry runs, including a cold startup slowdown.
    probe.arm("navigation", setup ? ".fr h1" : "#ta", setup ? "Ready to chat" : "", setup ? "text" : "ready");
}

export async function install(page: Page, firstRun = false) {
  await page.addInitScript(browserProbe, firstRun);
}

export async function measure(page: Page, trigger: () => Promise<unknown>, event: string, selector: string, text = "", mode = "text"): Promise<Observation> {
  await page.evaluate(args => window.perfJourney.arm(args.event, args.selector, args.text, args.mode), { event, selector, text, mode });
  await trigger();
  return page.evaluate(() => window.perfJourney.result);
}
