// Shared journey fixtures: every test starts on a fresh server data dir with
// a chosen fake scenario, and fails if the page logs a console error or an
// uncaught exception (a spec that expects some, like reconnect, lists them).
import { test as base, expect, type Locator, type Page, type Request } from "@playwright/test";
import { createClient } from "@gates-local/contracts";
import { CONTROL_URL, SERVER_PORT, TOKEN, appUrl } from "./env.ts";

export type Scenario = "models" | "no-models" | "slow-first-token" | "mid-stream-error" | "wrong-service" | "embed-smallest" | "embed-only" | "slow-drip" | "long-name" | "threads" | "image-turn" | "image-claims" | "image-text-call" | "image-batch" | "measure";
/** Settings' runtimeMode: "system" uses the Ollama on its port, "app" the app's own copy. */
export type RuntimeMode = "system" | "app";
/** Threads written before the server starts: N messages in one thread, the design's sidebar ("design-code" adds a reply with a long code block, a table and a long URL; "usage" adds a week of three models' usage), the README's demo threads, saved tool turns ("work-fold"), or 0 for none. */
export type Seed = number | "design" | "design-code" | "readme" | "usage" | "work-fold";
export type Sandbox = "ready" | "off";
/** The image engine the server installs in place of the pinned one (GATES_LOCAL_IMAGE_ENGINE): fake-comfy's engine(). */
export type FakeEngine = { readonly manifest: Record<string, unknown>; readonly layout: "uv-venv"; readonly address: string };

/** What Chromium fails an in-flight request with when the host's addresses change under it. */
const NETWORK_CHANGED = "net::ERR_NETWORK_CHANGED";

/** What a page load fetches to start the app. */
const LOAD_TYPES = new Set(["document", "script", "stylesheet", "font"]);

/**
 * Load `url`; the requests a network change cut short (the document's own among them), or null
 * when none was. A chunk the page asks for as it finishes loading can fail just after the load
 * event, so the load's own requests still in flight are waited for (5 s at most) before deciding.
 */
async function loadPage(page: Page, url: string): Promise<Set<string> | null> {
  const cut = new Set<string>();
  const inFlight = new Set<Request>();
  let loading = true, settled: (() => void) | undefined;
  const started = (r: Request) => { if (loading && LOAD_TYPES.has(r.resourceType())) inFlight.add(r); };
  const ended = (r: Request) => { if (inFlight.delete(r) && inFlight.size === 0) settled?.(); };
  const failed = (r: Request) => { if (r.failure()?.errorText === NETWORK_CHANGED) cut.add(r.url()); ended(r); };
  page.on("request", started);
  page.on("requestfinished", ended);
  page.on("requestfailed", failed);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await page.goto(url);
    loading = false;
    if (inFlight.size > 0) await new Promise<void>((done) => { settled = done; timer = setTimeout(done, 5_000); });
  } catch (e) {
    if (!(e instanceof Error && e.message.includes(NETWORK_CHANGED))) throw e;
    cut.add(url);
  } finally {
    clearTimeout(timer);
    page.off("request", started);
    page.off("requestfinished", ended);
    page.off("requestfailed", failed);
  }
  return cut.size > 0 ? cut : null;
}

async function control(route: string, body: unknown = {}): Promise<unknown> {
  const r = await fetch(`${CONTROL_URL}${route}`, { method: "POST", body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${route}: ${r.status} ${await r.text()}`);
  return r.headers.get("content-type")?.includes("json") ? r.json() : undefined;
}

export const stack = {
  /** Fresh data dir and a rediscovered runtime, with the fake set to this scenario; seed writes threads first (test/e2e/seed.ts). */
  async reset(scenario: Scenario = "models", seed: Seed = 0, seedAt?: number, runtimeMode?: RuntimeMode, installed?: readonly string[], comfyUrl?: string, controlledRuntimePorts = false, sandbox: Sandbox = "ready", engine?: FakeEngine): Promise<string | null> {
    const r = await control("/reset", {
      ...(sandbox === "off" ? { sandbox } : {}),
      ...(engine === undefined ? {} : { engine }),
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
  /** Stop the server (crash: SIGKILL, no goodbye pushes), wait downMs, then require an answer from its replacement. */
  async restart(downMs = 0, crash = false) {
    const result = await control("/restart", { downMs, crash });
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
  /** Put another program's MiB on the fake GPU, and give the card `totalMib` (16303 until a reset): a new GPU reading, with the runtime and its loaded models untouched. */
  gpu: (otherMib: number, totalMib?: number) => control("/gpu", { otherMib, ...totalMib === undefined ? {} : { totalMib } }),
  /** A computer with `memGib` of system memory (32 GB until a reset), and with no NVIDIA GPU at all when `gpu` is "none", else the 16 GB card. */
  computer: (memGib: number, gpu: "none" | "card" = "card") => control("/gpu", { otherMib: 0, memGib, ...gpu === "none" ? { none: true } : {} }),
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
  /** The stand-in machine's shell sandbox (test/fake-ollama/systemd-run.ts): "off" makes its probe fail. */
  sandbox: Sandbox;
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
  sandbox: ["ready", { option: true }],
  allowedErrors: [[], { option: true }],
  skipFirstRun: [true, { option: true }],
  seededThread: async ({ scenario, seed, seedAt, runtimeMode, installed, comfyUrl, controlledRuntimePorts, sandbox }, use) => {
    await use(await test.step("reset backend", () => stack.reset(scenario, seed, seedAt, runtimeMode, installed, comfyUrl, controlledRuntimePorts, sandbox)));
  },
  runtimePorts: async ({ seededThread }, use) => {
    void seededThread;
    await use(await stack.runtimePorts());
  },
  open: async ({ page, allowedErrors, skipFirstRun, seededThread }, use) => {
    void seededThread; // the stack resets before the page opens
    const logged: { text: string; url: string }[] = [];
    // resources of a page load that the host's network change cut short and that was loaded again:
    // one console line each is that cut's, any further one is an error
    const reloaded = new Map<string, number>();
    page.on("console", (m) => {
      if (m.type() === "error" && !allowedErrors.some((re) => re.test(m.text()))) logged.push({ text: m.text(), url: m.location().url });
    });
    page.on("pageerror", (e) => logged.push({ text: `pageerror: ${e.message}`, url: "" }));
    // An init script runs in every frame; a sandboxed one (Measure's pages) has no storage to write.
    if (skipFirstRun) await page.addInitScript(() => { if (window.top === window) localStorage.setItem("gates-local.first-run-done", "1"); });
    await use(async (hash = "") => {
      await test.step("page load", async () => {
        const target = appUrl(hash);
        const cut = await loadPage(page, target);
        if (cut === null) return;
        // Not the app: the host's network changed during the load (a Wi-Fi link reconnecting reaches
        // the browser as an address change), and Chromium failed the requests then in flight.
        // Load once more; that cause and no other is retried, and only its own lines are dropped.
        test.info().annotations.push({ type: "page load retried", description: `${NETWORK_CHANGED} during the load: ${[...cut].join(", ")}` });
        for (const url of cut) reloaded.set(url, 1);
        // the document itself was cut: load it again; else reload, since a goto to the same URL
        // with a hash only scrolls
        if (cut.has(target)) await page.goto(target);
        else await page.reload();
      });
    });
    const errors = logged.filter((e) => {
      const owed = reloaded.get(e.url) ?? 0;
      if (e.text !== `Failed to load resource: ${NETWORK_CHANGED}` || owed === 0) return true;
      reloaded.set(e.url, owed - 1);
      return false;
    }).map((e) => e.text);
    await test.step("teardown", async () => { expect(errors, "console errors").toEqual([]); });
  },
});

export { expect };

/** A Settings section's id from the name a spec knows it by ("Image generation" -> "images"). */
export const sectionId = (name: string): string => (name === "Image generation" ? "images" : name.toLowerCase());
/** The desktop Settings nav button for a section. */
export const navButton = (page: Page, name: string): Locator => page.getByTestId(`settings.nav.open-${sectionId(name)}`);
/** The phone Settings list row for a section. */
export const listButton = (page: Page, name: string): Locator => page.getByTestId(`settings.sections.open-${sectionId(name)}`);

/** Type into the composer and send with Enter. */
export async function sendMessage(page: Page, text: string): Promise<void> {
  const ta = page.locator("#ta");
  await ta.fill(text);
  await ta.press("Enter");
}

/** Open Settings › Advanced; resolves to its GPU memory group. */
export async function openGpuMemory(page: Page): Promise<Locator> {
  await page.keyboard.press("Control+Comma");
  await page.getByTestId("settings.nav.open-advanced").click();
  const gpu = page.locator(".set #gpuMemory");
  await expect(gpu).toBeVisible();
  return gpu;
}

/**
 * The app has its data and the composer is unblocked. Since the first frame
 * shows the whole app, an unblocked composer alone is true at boot, before
 * any read; #app[data-ready] is set once this connection's first reads have
 * settled, loaded or not (session.ts hydrate). It does not cover the open
 * thread's threads.get, and a failed read sets it too.
 */
export async function waitReady(page: Page): Promise<void> {
  await test.step("page ready", async () => {
  await expect(page.locator("#app[data-ready]")).toBeAttached();
  await composerOpen(page);
  });
}

/**
 * Models: on a desktop width the footer bot's own pop-up (settings row 6); on a phone,
 * a section of Settings, reached from its list.
 */
export async function openModels(page: Page): Promise<void> {
  if ((page.viewportSize()?.width ?? 1440) <= 640) {
    await page.keyboard.press("Control+Comma");
    await page.getByTestId("settings.shell.back").click();
    await page.getByTestId("settings.sections.open-models").click();
    return;
  }
  // the footer is under the Settings pop-up's dim: close it first
  if (await page.getByRole("dialog", { name: "Settings" }).count() > 0) {
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Settings" })).toHaveCount(0);
  }
  await page.getByTestId("sidebar.foot.models").click();
  await expect(page.getByRole("dialog", { name: "Models" }).locator(".mp")).toBeVisible();
}

/**
 * Only the composer unblocked, true from the first frame. For a spec that
 * holds the first reads on purpose and acts before they land; anything else
 * uses waitReady.
 */
export async function waitComposer(page: Page): Promise<void> {
  await test.step("composer ready", () => composerOpen(page));
}

async function composerOpen(page: Page): Promise<void> {
  await expect(page.locator(".composer:not(.blocked)")).toBeVisible();
  await expect(page.locator("#ta")).toBeEnabled();
}
