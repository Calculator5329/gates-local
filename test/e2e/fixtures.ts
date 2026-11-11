// Shared journey fixtures: every test starts on a fresh server data dir with
// a chosen fake scenario, and fails if the page logs a console error or an
// uncaught exception (a spec that expects some, like reconnect, lists them).
import { test as base, expect, type Locator, type Page } from "@playwright/test";
import { createClient } from "@gates-local/contracts";
import { CONTROL_URL, SERVER_PORT, TOKEN, appUrl } from "./env.ts";

export type Scenario = "models" | "no-models" | "slow-first-token" | "mid-stream-error" | "wrong-service" | "embed-smallest" | "embed-only" | "slow-drip" | "long-name" | "threads" | "image-turn" | "image-claims" | "image-text-call";
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
  async reset(scenario: Scenario = "models", seed: Seed = 0, seedAt?: number, runtimeMode?: RuntimeMode, installed?: readonly string[], comfyUrl?: string, controlledRuntimePorts = false): Promise<string | null> {
    const r = await control("/reset", {
      scenario,
      seed,
      ...(seedAt === undefined ? {} : { seedAt }),
      ...(runtimeMode === undefined ? {} : { runtimeMode }),
      ...(installed === undefined ? {} : { installed }),
      ...(comfyUrl === undefined ? {} : { comfyUrl }),
      ...(controlledRuntimePorts ? { controlledRuntimePorts: true } : {}),
    });
    const id = typeof r === "object" && r !== null ? (r as { threadId?: unknown }).threadId : undefined;
    return typeof id === "string" ? id : null;
  },
  /** Expected inputs owned by the fixture, not ports read from runtime status. */
  async runtimePorts() {
    const value = await control("/runtime-ports");
    const fields = typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
    const system = fields["system"], app = fields["app"];
    if (typeof system !== "number" || typeof app !== "number" || !Number.isInteger(system) || system < 20000 || app !== system + 1 || app > 65535) throw new Error("The stack did not return controlled runtime ports");
    return { system, app };
  },
  /** Stop the server, wait downMs, then require an answer from its replacement. */
  async restart(downMs = 0) {
    const result = await control("/restart", { downMs });
    // /restart joins the old child and starts a new one. Probe over a fresh
    // connection as well, so neither a disconnect nor a log line proves ready.
    const client = createClient(new WebSocket(`ws://127.0.0.1:${SERVER_PORT}/?token=${TOKEN}`));
    try {
      await client.negotiate();
      await client.call("runtime.status", {});
    } finally { client.close(); }
    return result;
  },
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
  /** Allocate a fake-backed discovery range independent of host services. */
  controlledRuntimePorts: boolean;
  /** The known occupied system port and first free app port after reset. */
  runtimePorts: Awaited<ReturnType<typeof stack.runtimePorts>>;
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
  controlledRuntimePorts: [false, { option: true }],
  comfyUrl: [undefined, { option: true }],
  installed: [undefined, { option: true }],
  allowedErrors: [[], { option: true }],
  skipFirstRun: [true, { option: true }],
  seededThread: async ({ scenario, seed, seedAt, runtimeMode, installed, comfyUrl, controlledRuntimePorts }, use) => {
    await use(await test.step("reset backend", () => stack.reset(scenario, seed, seedAt, runtimeMode, installed, comfyUrl, controlledRuntimePorts)));
  },
  runtimePorts: async ({ seededThread }, use) => {
    void seededThread;
    await use(await stack.runtimePorts());
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
      await test.step("page load", () => page.goto(appUrl(hash)));
    });
    await test.step("teardown", async () => { expect(errors, "console errors").toEqual([]); });
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
  await test.step("page ready", async () => {
  await expect(page.locator(".composer:not(.blocked)")).toBeVisible();
  await expect(page.locator("#ta")).toBeEnabled();
  });
}
