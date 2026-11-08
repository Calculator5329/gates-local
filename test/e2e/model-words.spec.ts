// Pins for the model-pick lane's words and geometry: picker row tooltips sit
// beside their own row (F72), the fit panel names its two memory quantities
// apart (G7-01) and puts its context lines apart (F76), a refused verdict's
// dot is red in the first-run card (item 4), and tok/s counts decode time only.
import type { Page } from "@playwright/test";
import { expect, openGpuMemory, sendMessage, test, waitReady } from "./fixtures.ts";

type Box = { top: number; bottom: number; left: number; right: number };
const meets = (a: Box, b: Box) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

/** Hover every picker row; for each, the tip's box and the boxes it must leave clear. */
async function rowTips(page: Page): Promise<{ tag: string; tip: Box; row: Box; others: Box[] }[]> {
  const rows = page.locator("#picker .pk-r[data-tip]");
  const n = await rows.count();
  expect(n).toBeGreaterThan(1);
  const out = [];
  for (let i = 0; i < n; i++) {
    const row = rows.nth(i);
    await row.locator(".pk-n").hover();
    await expect(page.locator("#tip.open")).toBeVisible();
    out.push(
      await row.evaluate((el) => {
        // DOMRect's own fields are getters, so copy them into plain objects for the trip back.
        const [tip, own, ...others] = [document.getElementById("tip") ?? el, el, ...[...document.querySelectorAll("#picker .pk-n, #picker .pk-g")].filter((x) => !el.contains(x))].map((e) => {
          const r = e.getBoundingClientRect();
          return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
        });
        const none = { top: 0, bottom: 0, left: 0, right: 0 };
        return { tag: el.getAttribute("data-m") ?? "", tip: tip ?? none, row: own ?? none, others };
      }),
    );
  }
  return out;
}

for (const width of [1440, 760]) {
  test(`a picker row's tooltip leaves every other row name and heading clear at ${width} px (F72)`, async ({ page, open }) => {
    await page.setViewportSize({ width, height: 900 });
    await open();
    await waitReady(page);
    await page.locator("#modelBtn").click();
    await expect(page.locator("#picker")).toBeVisible();
    for (const t of await rowTips(page)) {
      for (const o of t.others) expect(meets(t.tip, o), `${t.tag}: tip ${JSON.stringify(t.tip)} covers ${JSON.stringify(o)}`).toBe(false);
    }
  });
}

test("the fit panel names what this model can use apart from what is free, on separate context lines", async ({ page, open }) => {
  await open();
  await waitReady(page);
  const panel = await openGpuMemory(page);
  await expect(panel.locator(".fp-n").first()).toHaveText(/^Estimated [\d.]+\sGB of [\d.]+\sGB available to this model · /);
  await expect(panel.locator(".legend")).toContainText("Free after loading");
  await expect(panel.locator(".legend")).not.toContainText("Unused");

  // F76: the definition once; the other size's result is apart from it, in that size's tooltip (S1)
  const def = panel.locator(".ctx-line .ctx-def");
  await expect(def).toHaveText("How much conversation the model can keep in view.");
  await expect(panel.locator('[data-ctx="32768"]')).toHaveAttribute("data-tip", /at 32k/);
  await expect(panel.getByText("keep in view")).toHaveCount(1);
  await page.keyboard.press("Escape");

  // once a reply has loaded the model, the leftover segment is what is free right now
  await sendMessage(page, "Load it");
  // the reply first: the send opens its new thread, which would leave Settings if it were already open
  await expect(page.locator(".turn.a").last().locator(".md")).toContainText("You asked: Load it");
  await expect(page.locator(".writing")).toHaveCount(0, { timeout: 10_000 });
  await openGpuMemory(page);
  await expect(panel.locator(".legend")).toContainText("Currently free");
});

test("a refused verdict's dot is red in the first-run card, as everywhere else", async ({ page, open }) => {
  await open();
  await waitReady(page);
  const colours = await page.evaluate(() => {
    const host = document.createElement("div");
    host.innerHTML = '<div class="fr-m"><span class="v"><span class="vl no"><span class="vd no" id="t-fr"></span>x</span></span></div><span class="vl no"><span class="vd no" id="t-vl"></span>x</span>';
    document.body.append(host);
    const [card, elsewhere] = ["t-fr", "t-vl"].map((id) => getComputedStyle(document.getElementById(id) as Element).backgroundColor);
    const out = { card, elsewhere };
    host.remove();
    return out;
  });
  expect(colours.card).toBe(colours.elsewhere);
});

test.describe("decode speed", () => {
  test.use({ scenario: "slow-first-token" });

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
