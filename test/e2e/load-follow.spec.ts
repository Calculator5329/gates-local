/// <reference lib="dom" />
// Journeys: New thread starts on the model used last. Plain case: Gemma loaded
// and used in one chat, a new chat shows Gemma at the same context with no load
// asked. Loading case: one chat picks Gemma while Qwen is loaded and Gemma
// starts a slow load; New thread starts on Gemma and shows it loading; picking
// Gemma there joins the same load, and both chats show it ready when it ends.
// The composer toolbar holds still while a picked model loads.
import type { Page } from "@playwright/test";
import { decodePayload, decodeRequest, decodeResult, decodeServerMessage } from "@gates-local/contracts";
import { FAKE_URL } from "./env.ts";
import { expect, sendMessage, stack, test, waitReady } from "./fixtures.ts";
import { holds } from "./waits.ts";

const GEMMA = "gemma4:12b";
/** The fake cannot hold a load open until released, so the load is long enough for two picks on a slow machine; a precondition says so if not. */
const LOAD_MS = 8000;

interface FakeLoad { readonly model: string; readonly startedAt: number; readonly endedAt?: number }

async function fakeLoads(model: string): Promise<FakeLoad[]> {
  const state = (await (await fetch(`${FAKE_URL}/__fake/state`)).json()) as { loads: FakeLoad[] };
  return state.loads.filter((l) => l.model === model);
}

async function pick(page: Page, query: string, tag: string): Promise<void> {
  await page.locator("#modelBtn").click();
  await page.locator("#pkSearch").fill(query);
  await page.locator(`#picker .pk-r[data-m="${tag}"]`).click();
  await expect(page.locator("#picker")).toBeHidden();
}

// Guards the owner's ask (R34): New thread starts on the last used model, already loaded.
test("New thread starts on the model and context last used, already loaded, with no load asked", async ({ page, open }) => {
  const loadsAsked: string[] = [];
  page.on("websocket", (ws) => ws.on("framesent", (frame) => {
    const r = decodeRequest(frame.payload);
    if (r.ok && r.value.method === "models.load") loadsAsked.push(`${r.value.params.model}@${r.value.params.numCtx}`);
  }));
  await open();
  await waitReady(page);
  const btn = page.locator("#modelBtn");
  await expect(btn).toContainText("Qwen 3.5 9B");
  // Chat 1: Gemma at 32k, not the app's pick, used for a reply.
  await btn.click();
  const picker = page.locator("#picker");
  await picker.locator("#pkSearch").fill("gemma");
  await picker.locator(`.pk-r[data-m="${GEMMA}"]`).hover();
  await picker.getByRole("radiogroup", { name: "Context" }).getByRole("radio", { name: "32k" }).click();
  await expect(picker).toBeHidden();
  await expect(btn).toContainText("Gemma 4 12B");
  await expect(btn).toContainText("32k");
  await sendMessage(page, "Used on Gemma");
  await expect(page.locator(".turn.a").last()).toHaveClass(/\bdone\b/);
  await expect(btn).not.toHaveAttribute("aria-busy", "true");
  const asked = loadsAsked.length;

  await page.getByTestId("sidebar.top.new-thread").click();
  await expect(page.locator("#ta")).toHaveValue("");
  await expect(btn).toContainText("Gemma 4 12B");
  await expect(btn).toContainText("32k");
  await expect(btn).not.toHaveAttribute("aria-busy", "true");
  expect(loadsAsked.slice(asked), "New thread asks for no load").toEqual([]);
  expect(await fakeLoads(GEMMA), "Ollama loaded Gemma once").toHaveLength(1);
});

// Guards the owner's ask (R34): a model still loading follows New thread, with one load.
test("a model still loading follows New thread, and a second pick joins its one load", async ({ page, open }) => {
  test.info().annotations.push({ type: "budget", description: "One eight-second cold load is the subject of the journey, after one ordinary reply." });
  const pushes: string[] = [];
  /** models.load requests for Gemma, and how many the server has answered. */
  const asked = new Set<string>();
  let answered = 0;
  page.on("websocket", (ws) => {
    ws.on("framesent", (frame) => {
      const r = decodeRequest(frame.payload);
      if (r.ok && r.value.method === "models.load" && r.value.params.model === GEMMA) asked.add(r.value.id);
    });
    ws.on("framereceived", (frame) => {
      const m = decodeServerMessage(frame.payload);
      if (!m.ok) return;
      if (m.value.type !== "push") {
        if (asked.has(m.value.id)) answered++;
        return;
      }
      if (m.value.channel !== "models.load") return;
      const l = decodeResult("models.load", m.value.payload);
      if (l.ok) pushes.push(`${l.value.model}:${l.value.state}`);
    });
  });
  await open();
  await waitReady(page);
  const btn = page.locator("#modelBtn");
  await expect(btn).toContainText("Qwen");
  await sendMessage(page, "First chat");
  await expect(page.locator(".turn.a").last()).toHaveClass(/\bdone\b/);
  const first = await page.locator(".sb-row.on .t").textContent();

  await stack.scenario("models", { loadDelayMs: LOAD_MS });
  await pick(page, "gemma", GEMMA);
  await expect(btn).toContainText("Gemma");
  await expect(btn).toHaveAttribute("aria-busy", "true");

  // S1: the new chat starts on the model chosen last, still loading.
  await page.getByTestId("sidebar.top.new-thread").click();
  await expect(page.locator("#ta")).toHaveValue("");
  await expect.soft(btn, "S1: the new chat shows the model still loading").toContainText("Gemma");
  await expect.soft(btn, "S1: and shows it loading").toHaveAttribute("aria-busy", "true");

  // S2: picking it again in the new chat joins the load, and it finishes here.
  await pick(page, "gemma", GEMMA);
  await expect(btn).toContainText("Gemma");
  await expect.poll(() => asked.size, { message: "the second pick asked for the load" }).toBe(2);
  const during = await fakeLoads(GEMMA);
  expect(during.length === 1 && during[0]?.endedAt === undefined, `precondition: the second pick lands while Ollama is still loading (raise LOAD_MS); fake loads ${JSON.stringify(during)}`).toBe(true);
  await expect(btn, `S2: the load shows finished in the new chat; pushes ${JSON.stringify(pushes)}`).not.toHaveAttribute("aria-busy", "true", { timeout: LOAD_MS + 8000 });
  // Both chats asked; wait for both answers before counting what the server said.
  await expect.poll(() => answered === asked.size, { timeout: LOAD_MS + 8000 }).toBe(true);
  await expect(btn).not.toHaveAttribute("aria-busy", "true");
  expect(pushes.filter((p) => p === `${GEMMA}:loading`), `one load, one loading; pushes ${JSON.stringify(pushes)}`).toHaveLength(1);
  expect(await fakeLoads(GEMMA), "Ollama loaded Gemma once").toHaveLength(1);

  // The first chat reads the same fact.
  await page.locator(".sb-row", { hasText: first ?? "" }).locator(".sb-thread").click();
  await expect(btn).toContainText("Gemma");
  await expect(btn).not.toHaveAttribute("aria-busy", "true");
});

// Guards the owner's pick (chat row 39, A): opening the app takes nothing from the card; the first key starts the load.
test("opening the app loads nothing, and the first key typed starts the thread's model loading", async ({ page, open }) => {
  const loadsAsked: string[] = [];
  page.on("websocket", (ws) => ws.on("framesent", (frame) => {
    const r = decodeRequest(frame.payload);
    if (r.ok && r.value.method === "models.load") loadsAsked.push(r.value.params.model);
  }));
  await open();
  await waitReady(page);
  await expect(page.locator("#modelBtn")).toContainText("Qwen 3.5 9B");
  await holds(page, 500, async () => [...loadsAsked], [], { message: "opening the app asks for no load" });
  await page.locator("#ta").pressSequentially("Wh");
  await expect.poll(() => loadsAsked, { timeout: 5000 }).toEqual(["qwen3.5:9b"]);
  await page.locator("#ta").pressSequentially("y is the sky blue");
  await holds(page, 300, async () => [...loadsAsked], ["qwen3.5:9b"], { message: "more keys ask nothing more" });
});

interface Frame {
  /** The control's name, its visible state, and where it sits. */
  readonly k: string;
  readonly s: string;
  readonly l: number;
  readonly w: number;
}

/** Records every footer control on every animation frame until glToolbarStop is set. */
async function sampleToolbar(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { glToolbar: Frame[][]; glToolbarStop?: boolean };
    w.glToolbar = [];
    const tick = () => {
      if (w.glToolbarStop) return;
      const cf = document.querySelector(".composer .cf");
      if (cf) {
        w.glToolbar.push(
          [...cf.querySelectorAll(".cf-l > *, .cf-r > *")].map((el) => {
            const r = el.getBoundingClientRect();
            const b = el as HTMLButtonElement;
            // the model tile turning into a spinner and back is the load itself, a real change in a fixed-size tile;
            // so is the context slot showing the load's seconds and back (chat row 16), and its box is still checked
            const text = [...el.childNodes].map((n) => (n instanceof Element && (n.classList.contains("mmark") || n.classList.contains("picker-trigger-ctx")) ? "" : n.textContent)).join("");
            const s = `${text}|pressed=${el.getAttribute("aria-pressed")}|aria-disabled=${el.getAttribute("aria-disabled")}|disabled=${b.disabled}|unavail=${el.classList.contains("unavail")}`;
            return { k: el.getAttribute("aria-label") ?? el.id, s, l: Math.round(r.left * 2) / 2, w: Math.round(r.width * 2) / 2 };
          }),
        );
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/** Consecutive distinct values, in order. */
function runs(values: readonly string[]): string[] {
  return values.filter((v, i) => i === 0 || v !== values[i - 1]);
}

// Guards the owner's report: the toolbar flickered while a model loaded.
test("the composer toolbar holds still while a picked model loads slowly", async ({ page, open }) => {
  test.info().annotations.push({ type: "budget", description: "Two cold three-second model loads establish the starting allocation and exercise loading, followed by the post-load GPU reading and its rendered fit answer." });
  // gemma4:12b takes 3 s to load and fills the GPU a step at a time, as a real load does
  await stack.scenario("models", { loadDelayMs: 3000 });
  let loaded = false, reading = 0, tables = 0;
  const pending = new Set<string>();
  page.on("websocket", ws => {
    ws.on("framesent", frame => {
      const request = decodeRequest(frame.payload);
      if (request.ok) pending.add(request.value.id);
    });
    ws.on("framereceived", frame => {
      const decoded = decodeServerMessage(frame.payload);
      if (!decoded.ok) return;
      const message = decoded.value;
      if (message.type === "push") {
        const load = message.channel === "models.load" ? decodeResult("models.load", message.payload) : undefined;
        if (load?.ok && load.value.model === "gemma4:12b" && load.value.state === "ready") loaded = true;
        if (message.channel === "gpu.changed" && loaded && decodePayload(message.channel, message.payload).ok) reading++;
        if (message.channel === "fit.changed" && loaded && decodePayload(message.channel, message.payload).ok) tables++;
      } else pending.delete(message.id);
    });
  });
  await open();
  await waitReady(page);
  await expect(page.locator("#modelBtn")).toContainText("Qwen");
  // A recommended model is selected, but is not preloaded until it is picked.
  await page.locator("#modelBtn").click();
  await page.locator('#picker .pk-r[data-m="qwen3.5:9b"]').click();
  await expect(page.locator("#picker")).toBeHidden();
  await page.locator("#ta").fill("Hello");
  await expect.poll(async () => ((await (await fetch(`${FAKE_URL}/__fake/state`)).json()) as { loaded: { name: string }[] }).loaded.map(model => model.name)).toContain("qwen3.5:9b");


  await page.locator("#modelBtn").click();
  await page.locator("#pkSearch").fill("gemma");
  await sampleToolbar(page);
  await page.locator(`#picker .pk-r[data-m="gemma4:12b"]`).click();
  await expect(page.locator("#picker")).toBeHidden();
  await expect
    .poll(async () => ((await (await fetch(`${FAKE_URL}/__fake/state`)).json()) as { loaded: { name: string }[] }).loaded.map((l) => l.name), { timeout: 10_000 })
    .toContain("gemma4:12b");
  // Loading frames cannot satisfy this: require a fit table pushed after the
  // load, no request outstanding, and the resulting render.
  await expect.poll(async () => {
    if (tables === 0 || pending.size > 0) return false;
    const seen = tables;
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    return tables === seen && pending.size === 0;
  }, { timeout: 10_000 }).toBe(true);
  console.log(`TOOLBAR_SETTLED ${JSON.stringify({ postLoadGpuReadings: reading, postLoadTables: tables, pending: pending.size })}`);
  await expect.poll(() => page.evaluate(() => (window as unknown as { glToolbar: Frame[][] }).glToolbar.filter(frame => frame.find(control => control.k === "modelBtn")?.s.includes("Gemma")).length)).toBeGreaterThan(60);
  const frames = await page.evaluate(() => {
    const w = window as unknown as { glToolbar: Frame[][]; glToolbarStop?: boolean };
    w.glToolbarStop = true;
    return w.glToolbar;
  });

  const from = frames.findIndex((f) => f.find((c) => c.k === "modelBtn")?.s.includes("Gemma"));
  expect(from, "the trigger shows the picked model").toBeGreaterThanOrEqual(0);
  const after = frames.slice(from);
  expect(after.length, "frames sampled").toBeGreaterThan(60);
  const keys = after[0]?.map((c) => c.k) ?? [];
  // no control comes and goes
  expect(runs(after.map((f) => f.map((c) => c.k).join(", "))), "controls present").toEqual([keys.join(", ")]);
  for (const key of keys) {
    const mine = after.map((f) => f.find((c) => c.k === key));
    // each control changes only on a real change: no value comes back after another
    const states = runs(mine.map((c) => c?.s ?? "-"));
    expect.soft(states.length === new Set(states).size, `${key} went back to an earlier value: ${states.join("  →  ")}`).toBe(true);
    // and nothing moves or changes width once the picked name is up
    const boxes = runs(mine.map((c) => (c ? `left ${c.l} width ${c.w}` : "-")));
    expect.soft(boxes, `${key} moved`).toEqual([boxes[0]]);
  }
});
