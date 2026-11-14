/// <reference lib="dom" />
import type { Page } from "@playwright/test";

// A fresh thread can finish its reply before the first frame observes it.
export const REPLY_TEXT_SELECTOR = ".turn.a .md";

export interface Observation { elapsed: number; frames: number[]; longTasks: number[]; inputDelays: number[]; epochStart?: number; epochEnd?: number }
/**
 * A second end state for the same input. Its window opens with the first and
 * closes later, so one input gives two rows. "class-count" reads a live
 * collection by class name, which costs far less per frame than a selector
 * over a long thread's DOM.
 */
export interface LaterEnd { selector: string; text: string; mode: string }
interface Probe {
  arm(event: string, selector: string, text: string, mode: string, later?: LaterEnd): void;
  result: Promise<Observation>;
  /** The window that closes at the later end, or the result itself when there is none. */
  later: Promise<Observation>;
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
    let resolveLater: (v: Observation) => void;
    let begin = 0;
    let frames: number[] = [], tasks: number[] = [], inputs: number[] = [];
    let observer: PerformanceObserver | undefined;
    const probe: Probe = {
      result: Promise.resolve({ elapsed: 0, frames: [], longTasks: [], inputDelays: [] }),
      later: Promise.resolve({ elapsed: 0, frames: [], longTasks: [], inputDelays: [] }),
      drop: () => { for (const socket of sockets) if (socket.readyState === NativeSocket.OPEN) socket.close(); },
      arm(event, selector, text, mode, later) {
        probe.result = new Promise(r => { resolve = r; });
        probe.later = later ? new Promise(r => { resolveLater = r; }) : probe.result;
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
          const matches = (end: LaterEnd) => {
            if (end.mode === "class-count") return document.getElementsByClassName(end.selector).length === Number(end.text);
            const el = document.querySelector<HTMLElement>(end.selector);
            const visible = el !== null && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
            const rect = el?.getBoundingClientRect();
            const inView = visible && rect !== undefined && rect.bottom > 0 && rect.top < innerHeight;
            return end.mode === "absent" ? !visible
              : end.mode === "value" ? visible && (el as HTMLTextAreaElement).value === end.text
              : end.mode === "usable-value" ? visible && (el as HTMLTextAreaElement).value === end.text && !(el as HTMLTextAreaElement).disabled && document.activeElement === el
              : end.mode === "compact-text" ? inView && (el?.textContent ?? "").replace(/\s/g, "").includes(end.text)
              : end.mode === "count" ? document.querySelectorAll(end.selector).length === Number(end.text)
              : end.mode === "less-than" ? document.querySelectorAll(end.selector).length < Number(end.text)
              : end.mode === "ready" ? visible && !(el as HTMLTextAreaElement).disabled && !document.querySelector(".composer.blocked")
              : end.mode === "reconnect" ? initialSocket !== undefined && sockets.at(-1) !== initialSocket && sockets.at(-1)?.readyState === NativeSocket.OPEN && visible && !(el as HTMLTextAreaElement).disabled && !document.querySelector(".composer.blocked")
              : inView && (el?.textContent ?? "").includes(end.text);
          };
          // Two rAFs bracket a paint opportunity after the state is in the DOM.
          const close = (last: boolean, settle: (v: Observation) => void) => requestAnimationFrame(() => requestAnimationFrame(() => {
            for (const entry of observer?.takeRecords() ?? []) if (entry.startTime >= begin) tasks.push(entry.duration);
            if (last) {
              observer?.disconnect();
              collecting = false;
              document.removeEventListener("keydown", onKey, true);
            }
            const end = performance.now();
            settle({ elapsed: end - begin, frames: [...frames], longTasks: [...tasks], inputDelays: [...inputs], epochStart: performance.timeOrigin + begin, epochEnd: performance.timeOrigin + end });
          }));
          let firstClosed = false;
          const check = () => {
            const now = performance.now();
            frames.push(now - previous); previous = now;
            if (!firstClosed && matches({ selector, text, mode })) { firstClosed = true; close(!later, resolve); }
            if (firstClosed && (!later || matches(later))) { if (later) close(true, resolveLater); return; }
            requestAnimationFrame(check);
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

/** Resolves when the first window closes; read `window.perfJourney.later` for the second. */
export async function measure(page: Page, trigger: () => Promise<unknown>, event: string, selector: string, text = "", mode = "text", later?: LaterEnd): Promise<Observation> {
  await page.evaluate(args => window.perfJourney.arm(args.event, args.selector, args.text, args.mode, args.later), { event, selector, text, mode, later });
  await trigger();
  return page.evaluate(() => window.perfJourney.result);
}
