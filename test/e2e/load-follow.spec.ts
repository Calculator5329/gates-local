/// <reference lib="dom" />
// Journeys: New thread starts on the model used last. Plain case: Gemma loaded
// and used in one chat, a new chat shows Gemma at the same context with no load
// asked. Loading case: one chat picks Gemma while Qwen is loaded and Gemma
// starts a slow load; New thread starts on Gemma and shows it loading; picking
// Gemma there joins the same load, and both chats show it ready when it ends.
import type { Page } from "@playwright/test";
import { decodeRequest, decodeResult, decodeServerMessage } from "@gates-local/contracts";
import { FAKE_URL } from "./env.ts";
import { expect, sendMessage, stack, test, waitReady } from "./fixtures.ts";

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

  await page.getByRole("button", { name: "New thread" }).click();
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
  await page.getByRole("button", { name: "New thread" }).click();
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
  await page.waitForTimeout(500);
  expect(loadsAsked, "opening the app asks for no load").toEqual([]);
  await page.locator("#ta").pressSequentially("Wh");
  await expect.poll(() => loadsAsked, { timeout: 5000 }).toEqual(["qwen3.5:9b"]);
  await page.locator("#ta").pressSequentially("y is the sky blue");
  await page.waitForTimeout(300);
  expect(loadsAsked, "more keys ask nothing more").toEqual(["qwen3.5:9b"]);
});
