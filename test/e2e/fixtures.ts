// Shared journey fixtures: every test starts on a fresh server data dir with
// a chosen fake scenario, and fails if the page logs a console error or an
// uncaught exception (a spec that expects some, like reconnect, lists them).
import { test as base, expect, type Locator, type Page } from "@playwright/test";
import { CONTROL_URL, appUrl } from "./env.ts";

export type Scenario = "models" | "no-models" | "slow-first-token" | "mid-stream-error" | "wrong-service" | "embed-smallest" | "embed-only" | "slow-drip" | "long-name";
/** Settings' runtimeMode: "system" uses the Ollama on its port, "app" the app's own copy. */
export type RuntimeMode = "system" | "app";
/** Threads written before the server starts: N messages in one thread, the design's sidebar ("design-code" adds a reply with a long code block, a table and a long URL), the README's demo threads, or 0 for none. */
export type Seed = number | "design" | "design-code" | "readme";

async function control(route: string, body: unknown = {}): Promise<unknown> {
  const r = await fetch(`${CONTROL_URL}${route}`, { method: "POST", body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${route}: ${r.status} ${await r.text()}`);
  return r.headers.get("content-type")?.includes("json") ? r.json() : undefined;
}

export const stack = {
  /** Fresh data dir and a rediscovered runtime, with the fake set to this scenario; seed writes threads first (test/e2e/seed.ts). */
  async reset(scenario: Scenario = "models", seed: Seed = 0, seedAt?: number, runtimeMode?: RuntimeMode, installed?: readonly string[], comfyUrl?: string): Promise<string | null> {
    const r = await control("/reset", {
      scenario,
      seed,
      ...(seedAt === undefined ? {} : { seedAt }),
      ...(runtimeMode === undefined ? {} : { runtimeMode }),
      ...(installed === undefined ? {} : { installed }),
      ...(comfyUrl === undefined ? {} : { comfyUrl }),
    });
    const id = typeof r === "object" && r !== null ? (r as { threadId?: unknown }).threadId : undefined;
    return typeof id === "string" ? id : null;
  },
  /** Stop the server, wait downMs, start it again on the same data. */
  restart: (downMs = 0) => control("/restart", { downMs }),
  /** Switch the fake's behaviour mid-test (options such as tokenDelayMs; without `installed` the scenario's own models return). */
  scenario: (scenario: Scenario, options: Record<string, number | readonly string[]> = {}) => control("/scenario", { scenario, ...options }),
};

interface Fixtures {
  /** The fake scenario the test starts in. */
  scenario: Scenario;
  /** Threads seeded before the server starts (see Seed). */
  seed: Seed;
  /** The fake's installed models for this test; undefined keeps the scenario's default set. */
  installed: readonly string[] | undefined;
  /** Pins the seeded threads' clock (epoch ms); undefined seeds relative to now. */
  seedAt: number | undefined;
  /** Saved settings in this runtime mode before the server starts; undefined is a first launch (the server picks). */
  runtimeMode: RuntimeMode | undefined;
  /** Saved ComfyUI address, so a test never reaches the default port; undefined leaves it unset. */
  comfyUrl: string | undefined;
  /** Console errors this test expects, as patterns; anything else fails it. */
  allowedErrors: RegExp[];
  /** Mark first run done before load, so the app opens on a new thread. */
  skipFirstRun: boolean;
  /** The seeded thread's id, or null. */
  seededThread: string | null;
  /** Open the app; resolves once the page has loaded. */
  open: (hash?: string) => Promise<void>;
}

export const test = base.extend<Fixtures>({
  scenario: ["models", { option: true }],
  seed: [0, { option: true }],
  seedAt: [undefined, { option: true }],
  runtimeMode: [undefined, { option: true }],
  comfyUrl: [undefined, { option: true }],
  installed: [undefined, { option: true }],
  allowedErrors: [[], { option: true }],
  skipFirstRun: [true, { option: true }],
  seededThread: async ({ scenario, seed, seedAt, runtimeMode, installed, comfyUrl }, use) => {
    await use(await stack.reset(scenario, seed, seedAt, runtimeMode, installed, comfyUrl));
  },
  open: async ({ page, allowedErrors, skipFirstRun, seededThread }, use) => {
    void seededThread; // the stack resets before the page opens
    const errors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error" && !allowedErrors.some((re) => re.test(m.text()))) errors.push(m.text());
    });
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    if (skipFirstRun) await page.addInitScript(() => localStorage.setItem("gates-local.first-run-done", "1"));
    await use(async (hash = "") => {
      await page.goto(appUrl(hash));
    });
    expect(errors, "console errors").toEqual([]);
  },
});

export { expect };

/** Type into the composer and send with Enter. */
export async function sendMessage(page: Page, text: string): Promise<void> {
  const ta = page.locator("#ta");
  await ta.fill(text);
  await ta.press("Enter");
}

/** Open Settings › Advanced; resolves to its GPU memory group. */
export async function openGpuMemory(page: Page): Promise<Locator> {
  await page.keyboard.press("Control+Comma");
  await page.locator(".snav").getByRole("button", { name: "Advanced", exact: true }).click();
  const gpu = page.locator(".set #gpuMemory");
  await expect(gpu).toBeVisible();
  return gpu;
}

/** The composer is unblocked: connected, and Ollama answers (a healthy runtime has no sidebar row). */
export async function waitReady(page: Page): Promise<void> {
  await expect(page.locator(".composer:not(.blocked)")).toBeVisible();
  await expect(page.locator("#ta")).toBeEnabled();
}
