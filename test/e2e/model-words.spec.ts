// Pins for the model-pick lane's words and geometry: picker rows open no
// tooltip and the picker holds still through a fit refresh (F72), the fit panel names its two memory quantities
// apart (G7-01) and keeps context fit on hover (S1), a refused verdict's
// dot is red in the first-run card (item 4), and tok/s counts decode time only.
import type { Page } from "@playwright/test";
import { decodeResult, type FitTable } from "@gates-local/contracts";
import { expect, openGpuMemory, sendMessage, test, waitReady } from "./fixtures.ts";

/** Prepare normally, then push a newer fit table while the picker is open. */
async function pickerReports(page: Page) {
  let table: FitTable | undefined;
  let refresh: (() => void) | undefined;
  const received = new Set<string>();
  await page.routeWebSocket(/127\.0\.0\.1:5286/, ws => {
    const server = ws.connectToServer();
    const methods = new Map<unknown, string>();
    ws.onMessage(message => {
      const req = JSON.parse(String(message)) as { id?: unknown; method?: string };
      if (req.method) methods.set(req.id, req.method);
      server.send(message);
    });
    server.onMessage(message => {
      const res = JSON.parse(String(message)) as { type?: string; id?: unknown; result?: unknown; channel?: string; payload?: unknown };
      const method = res.type === "response" ? methods.get(res.id) : undefined;
      methods.delete(res.id);
      const pushed = res.type === "push" && res.channel === "fit.changed" ? decodeResult("fit.table", res.payload) : undefined;
      const answered = method === "fit.table" ? decodeResult("fit.table", res.result) : undefined;
      const next = pushed ?? answered;
      if (next?.ok) table = next.value;
      if (method !== undefined) received.add(method);
      ws.send(message);
    });
    refresh = () => {
      if (!table) throw new Error("No fit table to refresh");
      const reading = { ...table.reading, seq: table.reading.seq + 1, measuredAt: table.reading.measuredAt + 1 };
      ws.send(JSON.stringify({ type: "push", channel: "fit.changed", payload: { ...table, reading } }));
    };
  });
  return {
    received,
    refresh: () => {
      if (!refresh) throw new Error("Picker connection has not opened");
      refresh();
    },
  };
}

/** The tooltip opens 400 ms after the pointer settles (ui.tsx); twice that leaves no doubt it would have. */
const PAST_TIP_DELAY_MS = 800;

/** Hover every picker row: a row's facts open no tooltip (the owner removed them); a cut name opens one with the full name, and only then. */
async function rowsOpenNoTip(page: Page): Promise<void> {
  const rows = page.locator("#picker .pk-r");
  const n = await rows.count();
  expect(n).toBeGreaterThan(1);
  for (let i = 0; i < n; i++) {
    const nm = rows.nth(i).locator(".pk-nm");
    await rows.nth(i).locator(".pk-n").hover();
    await page.waitForTimeout(PAST_TIP_DELAY_MS);
    const cut = await nm.evaluate((el) => el.scrollWidth > el.clientWidth);
    if (cut) await expect(page.locator("#tip.open"), `row ${i}, its name cut`).toHaveText((await nm.textContent()) ?? "");
    else await expect(page.locator("#tip.open"), `row ${i}`).toHaveCount(0);
  }
}

for (const width of [1440, 760]) {
  // Guards the owner's rulings (N04, F72): picker rows open no tooltip, and the picker holds still through a refresh.
  test(`picker rows open no tooltip, and the picker holds still through a fit refresh at ${width} px (F72)`, async ({ page, open }) => {
    await page.setViewportSize({ width, height: 900 });
    const reports = await pickerReports(page);
    await open();
    await waitReady(page);
    await expect.poll(() => reports.received.has("models.catalog") && reports.received.has("fit.table")).toBe(true);
    await page.locator("#modelBtn").click();
    const picker = page.locator("#picker");
    await expect(picker).toBeVisible();
    await expect(picker.locator(".fit-skel")).toHaveCount(0);
    await picker.evaluate(el => Promise.all(el.getAnimations().map(animation => animation.finished)));
    const before = await picker.boundingBox();
    await picker.locator('.pk-r[data-m="gemma4:12b"] .pk-n').hover();
    reports.refresh();
    await expect(picker).toBeVisible();
    await expect(picker.locator('.pk-r[aria-busy="true"]')).toHaveCount(0);
    await expect(picker.locator(".pk-bottom").getByRole("button", { name: "Download models", exact: true })).toBeVisible();
    await expect(picker.locator(".fit-skel")).toHaveCount(0);
    expect(await picker.boundingBox(), "a pushed table keeps the picker under the resting pointer").toEqual(before);
    await rowsOpenNoTip(page);
    await page.screenshot({ path: test.info().outputPath(`picker-stable-${width}.png`) });
  });
}

// Guards the owner's rule to show only what is true on the GPU memory panel (unsure: no line of his on available vs free).
test("GPU memory distinguishes available from free memory and leaves context fit on hover", async ({ page, open }) => {
  await open();
  await waitReady(page);
  const panel = await openGpuMemory(page);
  await expect(panel).toContainText("Memory at 16k context");
  await panel.locator("summary", { hasText: "Details" }).click();
  await expect(panel.locator(".fp-n").filter({ hasText: /^Estimated/ })).toContainText(/Estimated [\d.]+\sGB; [\d.]+\sGB available on GPU\./);
  await expect(panel.locator(".legend")).toContainText("Free after loading");
  await expect(panel.locator(".legend")).not.toContainText("Unused");

  // F76: the definition once; the other size's result is apart from it, in that size's tooltip (S1)
  const def = panel.locator(".srow", { hasText: "Default context" }).locator(".sl .d").first();
  await expect(def).toContainText("tokens of conversation the model keeps in view");
  await expect(panel.locator('[data-ctx="32768"]')).toHaveAttribute("data-tip", /at 32k/);
  await expect(panel.getByText("tokens of conversation the model keeps in view")).toHaveCount(1);
  await page.keyboard.press("Escape");

  // once a reply has loaded the model, the leftover segment is what is free right now
  await sendMessage(page, "Load it");
  // the reply first: the send opens its new thread, which would leave Settings if it were already open
  await expect(page.locator(".turn.a").last().locator(".md")).toContainText("You asked: Load it");
  await expect(page.locator(".writing")).toHaveCount(0, { timeout: 10_000 });
  await openGpuMemory(page);
  await expect(panel.locator(".legend")).toContainText("Currently free");
});

test.describe("decode speed", () => {
  test.use({ scenario: "slow-first-token" });

  // Guards the owner's ask for a model's tok/s as a number: it counts decode time only.
  test("tok/s counts decode time, not the 2.5 s wait for the first token", async ({ page, open }) => {
    await open();
    await waitReady(page);
    await sendMessage(page, "Count the tokens");
    await expect(page.locator(".writing")).toHaveCount(0, { timeout: 15_000 });
    // The fake decodes a token every 12 ms (about 80 tok/s); over the whole 3+ s turn it would be under 25.
    const meta = await page.locator(".turn.a").last().locator(".meta").textContent();
    const replyTps = Number(/(\d+) tok\/s/.exec(meta ?? "")?.[1]);
    expect(replyTps).toBeGreaterThanOrEqual(40);
    const panel = await openGpuMemory(page);
    const panelTps = Number(/(\d+) tok\/s/.exec((await panel.locator(".meas").textContent()) ?? "")?.[1]);
    expect(panelTps).toBe(replyTps);
  });
});
