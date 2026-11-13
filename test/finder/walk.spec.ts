/// <reference lib="dom" />
// The bug finder's walk (scripts/bug-finder.ts runs it; never in `pnpm e2e`
// or the release check). For each screen in GL_FINDER_SCREENS (ids from
// screens.ts, or "all"), it slows the link, does each step, keeps every frame
// from the action until the page is quiet, and runs the detectors. A step with
// a finding keeps its frames and a screenshot burst. It reports; it never
// fails on what it finds. A step that cannot run is listed as broken.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createClient } from "@gates-local/contracts";
import type { Page } from "@playwright/test";
import { type Delay, TRACK, collectWhole, delayEverything, settled } from "../e2e/flicker-probe.ts";
import { fakeComfy } from "../e2e/fake-comfy.ts";
import { FAKE_URL } from "../e2e/env.ts";
import { expect, sendMessage, stack, test, waitReady } from "../e2e/fixtures.ts";
import { type CutEl, type FinderFrame, type Finding, detect } from "./detectors.ts";
import { type Shot, Screencast, atEnd, burst, cutOff, extras, now, shotFor, twoFrames, watchScript } from "./page.ts";
import { type Ctx, FINDER_TRACK, HOLD, SCREENS, type Screen, type Step } from "./screens.ts";
import { FINDER_OUT } from "./out.ts";

/** Long enough that every loading state shows on a fast machine (the audit's delay). */
const DELAY_MS = 600;
const WANTED = (process.env["GL_FINDER_SCREENS"] ?? "all").split(",").map((s) => s.trim()).filter(Boolean);
const chosen = WANTED.includes("all") ? SCREENS : SCREENS.filter((s) => WANTED.includes(s.id));
const unknown = WANTED.filter((id) => id !== "all" && !SCREENS.some((s) => s.id === id));
if (unknown.length > 0) throw new Error(`GL_FINDER_SCREENS: no screen named ${unknown.join(", ")}; screens: ${SCREENS.map((s) => s.id).join(", ")}`);
/** Keep every step's frames, not only a step with a finding (bug-finder --keep, for tuning). */
const KEEP = process.env["GL_FINDER_KEEP"] === "1";
/** Console lines a slowed link and a missing ComfyUI make on purpose. */
const EXPECTED = [/WebSocket connection to .* failed/];

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** What the sheet gets per step. */
export interface StepReport {
  readonly name: string;
  readonly frames: number;
  readonly ms: number;
  readonly findings: readonly (Finding & { readonly pics: readonly (string | null)[] })[];
  /** The kept burst, relative to the report folder. */
  readonly burst: readonly { readonly file: string; readonly ms: number }[];
  readonly broken?: string;
}
export interface ScreenReport { readonly id: string; readonly name: string; readonly seconds: number; readonly size: { readonly width: number; readonly height: number }; readonly steps: readonly StepReport[] }

test.describe.configure({ mode: "serial" });

for (const screen of chosen) {
  test.describe(screen.id, () => {
    test.use({
      seed: screen.seed ?? 0,
      skipFirstRun: !screen.firstRun,
      comfyUrl: "http://127.0.0.1:1",
      allowedErrors: [/./],
      ...(screen.viewport ? { viewport: screen.viewport } : {}),
      ...(screen.installed ? { installed: screen.installed } : {}),
    });
    test(screen.name, async ({ page, open }, info) => {
      test.setTimeout(240_000);
      const started = Date.now();
      const errors: string[] = [];
      page.on("console", (m) => { if (m.type() === "error" && !EXPECTED.some((re) => re.test(m.text()))) errors.push(m.text()); });
      page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
      const comfy = screen.comfy ? await fakeComfy() : undefined;
      try {
        if (comfy) { comfy.gpu(); await stack.reset("models", 0, undefined, "system", undefined, comfy.url); }
        if (screen.noGpu) await stack.computer(32, "none");
        if (screen.titlebar) await page.addInitScript(desktopOverlay);
        const delay = await delayEverything(page, DELAY_MS);
        const cast = await Screencast.open(page);
        const size = page.viewportSize() ?? { width: 1440, height: 900 };
        const ctx = context(page, delay, info.outputPath("notes.md"));
        // one stuck control is a broken step, not the whole walk's time
        page.setDefaultTimeout(20_000);
        if (screen.desktopUpdates) await page.addInitScript(desktopUpdates, DELAY_MS);
        const steps: StepReport[] = [];
        if (screen.load) {
          const load = screen.load;
          steps.push(await run(page, screen, { name: load.name, root: load.root, ...(load.opens ? { opens: load.opens } : {}), act: async () => undefined }, cast, errors, delay, async () => {
            await page.addInitScript({ content: watchScript(load.root, load.opens, FINDER_TRACK, HOLD) });
            await cast.start(size);
            const t = Date.now();
            await open();
            return { actAt: 0, t };
          }));
        } else {
          await open();
          await waitReady(page);
          await settled(delay);
        }
        try { await screen.setup?.(ctx); } catch (e) { steps.push(broken("setup", e)); }
        if (!steps.some((s) => s.broken)) {
          for (const step of screen.steps) {
            const report = await run(page, screen, step, cast, errors, delay, async () => {
              await step.before?.(ctx);
              await settled(delay, 4000);
              await cast.start(size);
              await page.evaluate(watchScript(step.root, step.opens, [...FINDER_TRACK, ...step.track ?? []], HOLD));
              await twoFrames(page);
              const actAt = await now(page);
              const t = Date.now();
              await step.act(ctx);
              return { actAt, t };
            });
            steps.push(report);
            if (report.broken) break;
          }
        }
        const out: ScreenReport = { id: screen.id, name: screen.name, seconds: Math.round((Date.now() - started) / 100) / 10, size, steps };
        mkdirSync(path.join(FINDER_OUT, "raw"), { recursive: true });
        writeFileSync(path.join(FINDER_OUT, "raw", `${screen.id}.json`), JSON.stringify(out, null, 2));
        const found = steps.flatMap((s) => s.findings);
        console.log(`FINDER ${screen.id}: ${steps.length} steps, ${found.length} findings, ${steps.filter((s) => s.broken).length} broken, ${out.seconds} s`);
        for (const f of found) console.log(`FINDER FINDING ${JSON.stringify({ step: f.step, kind: f.kind, element: f.element, px: f.px, ms: f.ms, detail: f.detail })}`);
      } finally {
        await comfy?.close();
      }
    });
  });
}

/**
 * In the page: the desktop app's update bridge, and update.status answered as
 * updates.spec.ts answers it (an idle copy this app can update). The socket is
 * already routed to slow the link, so the answer is made here, `ms` late like
 * every other. update.check finds an update, as updates.spec.ts row 9 does: the
 * walked copy is not a git clone, so the server's own answer would fold the card.
 */
function desktopUpdates(ms: number): void {
  Object.assign(window, { gatesLocal: {
    updateApprovalVersion: 2,
    getServerUrl: async () => new URLSearchParams(location.search).get("server"),
    onState: () => () => undefined,
    updateAndRestart: async () => ({ ok: true }),
  } });
  const found = { state: "available", checkedAt: Date.UTC(2026, 10, 13, 6, 57), channel: "main", current: "abc1234", target: "def5678", targetCommit: `def5678${"0".repeat(33)}`, total: 2, changes: ["Faster chat", "A new setting"] };
  let lastCheck: typeof found | null = null;
  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function (this: WebSocket, data: Parameters<WebSocket["send"]>[0]) {
    let req: { id?: unknown; method?: unknown } = {};
    try { req = JSON.parse(String(data)) as typeof req; } catch { /* not a request */ }
    if (req.method !== "update.status" && req.method !== "update.check") return send.call(this, data);
    if (req.method === "update.check") lastCheck = found;
    const result = req.method === "update.check" ? found : { version: { kind: "commit", commit: "abc1234" }, result: null, lastCheck, activity: [], canControl: true };
    setTimeout(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "response", id: req.id, ok: true, result }) })), ms);
  };
}

/** In the page: the desktop window's controls overlay, as sb-hairline.spec.ts stubs it, so the app takes the desktop titlebar layout. */
function desktopOverlay(): void {
  const overlay = new EventTarget();
  Object.assign(overlay, { visible: true });
  Object.defineProperty(navigator, "windowControlsOverlay", { value: overlay });
  document.addEventListener("DOMContentLoaded", () => document.documentElement.style.setProperty("--window-controls-width", "138px"));
}

function broken(name: string, e: unknown): StepReport {
  // the first line and the locator it waited on, without the terminal's colours
  // oxlint-disable-next-line no-control-regex
  const lines = (e instanceof Error ? e.message : String(e)).replace(/\u001b\[[0-9;]*m/g, "").split("\n");
  const why = [lines[0], lines.find((l) => l.startsWith("Locator:"))].filter(Boolean).join(" ");
  return { name, frames: 0, ms: 0, findings: [], burst: [], broken: why.slice(0, 300) };
}

/** The frames where a thing changed (a move's after, a flicker's gone and back, an arrival, words said twice) are shown once painted. */
const changedAt = (f: Finding, j: number) => f.kind === "twice" || (j > 0 && f.kind !== "cut" && f.kind !== "error" && !((f.kind === "moves" || f.kind === "resized") && j === 2));

/** One step: watch from before the action until quiet, detect, keep frames and shots only when something was found. */
async function run(page: Page, screen: Screen, step: Step, cast: Screencast, errors: string[], delay: Delay,
  start: () => Promise<{ actAt: number; t: number }>): Promise<StepReport> {
  const before = errors.length;
  try {
    const { actAt, t } = await start();
    const probe = await collectWhole(page, delay, 1500, step.max ?? 6000);
    const extra = await extras(page);
    const cut: CutEl[] = await cutOff(page, step.root);
    const ends = await atEnd(page);
    const shots = await cast.stop();
    const frames: FinderFrame[] = probe.map((f, i) => ({ ...f, t: extra[i]?.t ?? 0, twice: extra[i]?.twice ?? [], hold: extra[i]?.hold ?? [] }));
    const found = detect({ screen: screen.id, step: step.name, frames, actAt, opens: step.opens !== undefined || screen.load !== undefined, free: step.free ?? [], cut, ends, errors: errors.slice(before), kinds: [...TRACK.split(","), ...FINDER_TRACK, ...step.track ?? []].map((k) => k.trim()) });
    const ms = Math.round(Date.now() - t);
    if (frames.findIndex((f) => f.arrived) < 0) return { ...broken(step.name, new Error(`the surface never showed: ${step.opens?.selector ?? step.root}`)), frames: frames.length, ms };
    if (found.length === 0 && !KEEP) return { name: step.name, frames: frames.length, ms, findings: [], burst: [] };
    // a step with findings keeps everything: its frames, a burst, and the frames each finding shows in
    const dir = path.posix.join("shots", screen.id, slug(step.name));
    mkdirSync(path.join(FINDER_OUT, dir), { recursive: true });
    mkdirSync(path.join(FINDER_OUT, "frames", screen.id), { recursive: true });
    writeFileSync(path.join(FINDER_OUT, "frames", screen.id, `${slug(step.name)}.json`), JSON.stringify(frames));
    const t0 = frames[0]?.t ?? 0;
    const written = new Map<Shot, string>();
    const keep = (s: Shot) => {
      let file = written.get(s);
      if (!file) {
        file = path.posix.join(dir, `${String(Math.max(0, Math.round(s.t - t0))).padStart(5, "0")}.jpg`);
        writeFileSync(path.join(FINDER_OUT, file), s.data);
        written.set(s, file);
      }
      return file;
    };
    const kept = burst(shots, t0 + (actAt - (frames[0]?.at ?? 0))).map((s) => ({ file: keep(s), ms: Math.round(s.t - t0) }));
    const findings = found.map((f) => ({ ...f, pics: f.frames.map((i, j) => { const s = shotFor(shots, frames, i, changedAt(f, j)); return s ? keep(s) : null; }) }));
    return { name: step.name, frames: frames.length, ms, findings, burst: kept };
  } catch (e) {
    await cast.stop();
    return { ...broken(step.name, e), findings: errors.slice(before).map((d) => ({ screen: screen.id, step: step.name, kind: "error" as const, element: "console", frames: [], boxes: [], detail: d.slice(0, 300), pics: [] })) };
  }
}

function context(page: Page, delay: Delay, notes: string): Ctx {
  return {
    page,
    send: (text) => sendMessage(page, text),
    scenario: async (name, options = {}) => { await stack.scenario(name as Parameters<typeof stack.scenario>[0], options); },
    release: async () => { await fetch(`${FAKE_URL}/__fake/release`, { method: "POST", body: "{}" }); },
    toolsOn: async () => {
      const server = new URL(page.url()).searchParams.get("server");
      if (!server) throw new Error("No test server");
      mkdirSync(path.dirname(notes), { recursive: true });
      writeFileSync(notes, "# Notes\n\nNothing to see.\n");
      const client = createClient(new WebSocket(server));
      try {
        await client.call("sources.add", { kind: "file", path: notes });
        await client.call("settings.update", { tools: true });
      } finally { client.close(); }
    },
    imagesOn: async () => {
      await page.keyboard.press("Control+Comma");
      await page.locator(".snav").getByRole("button", { name: "Image generation", exact: true }).click();
      const on = page.getByRole("switch", { name: "Generate images" });
      await on.click();
      await expect(on).toHaveAttribute("aria-checked", "true");
      await page.keyboard.press("Escape");
      await waitReady(page);
      await settled(delay);
    },
    settle: (max) => settled(delay, max),
    shows: (selector, timeout = 15_000) => expect(page.locator(selector).first()).toBeVisible({ timeout }),
  };
}
