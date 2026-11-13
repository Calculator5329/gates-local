// How the image picker and its composer button look: the setup's name gets the room before it
// is cut, two Klein setups never look the same on the button, the button keeps its width on a
// thread switch, and the GB number sits once per size row with a mark, not a word.
import type { Page } from "@playwright/test";
import { createClient } from "@gates-local/contracts";
import { fakeComfy } from "./fake-comfy.ts";
import { expect, stack, test, waitReady } from "./fixtures.ts";

test.use({ video: "off" });
let comfy: Awaited<ReturnType<typeof fakeComfy>>;
// Klein's files on a GPU: on the CPU the default needs an encoder they lack
test.beforeEach(async () => { comfy = await fakeComfy(); comfy.gpu(); });
test.afterEach(async () => { await comfy.close(); });

const connect = (page: Page) => {
  const server = new URL(page.url()).searchParams.get("server");
  if (!server) throw new Error("No test server URL");
  return createClient(new WebSocket(server));
};

async function imageOn(page: Page) {
  await page.keyboard.press("Control+Comma");
  await page.getByTestId("settings.nav.open-images").click();
  await page.getByTestId("settings.images.enable").click();
  await expect(page.getByTestId("settings.images.enable")).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await waitReady(page);
  await page.getByTestId("chat.composer.image").click();
}

/** Every text box inside the button that its own width cuts. */
const cut = (page: Page) => page.locator("#modelBtn").evaluate((b) =>
  [...b.querySelectorAll("span, small")].filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.textContent ?? ""));

const width = async (page: Page) => Math.round((await page.locator("#modelBtn").boundingBox())?.width ?? 0);

test("the picker's look: the button names the setup whole, the size list says its number once, each row a mark", async ({ page, open }, info) => {
  comfy.withApp(); // every row ready: a row that needs files names their download size, which is not a fit number
  await stack.reset("models", 0, undefined, "system", undefined, comfy.url);
  await open(); await waitReady(page);
  await imageOn(page);
  // Klein picked: a setup that runs at three sizes (each style setup runs at one)
  const client = connect(page);
  try { await client.call("settings.update", { imageChoice: { preset: "flux2-klein-4b", width: 1024, height: 1024 } }); } finally { client.close(); }
  const button = page.locator("#modelBtn");
  await expect(button).toContainText("Klein 4B");
  await expect(button).toContainText("1024×1024");
  await button.click();
  const picker = page.locator("#imagePicker");
  await expect(picker.locator(".pk-ctx-row")).toHaveCount(3);
  await page.mouse.move(5, 5);
  // one crop for the before and after shots: the composer's right side and the picker above it
  const box = await page.locator(".composer").boundingBox();
  if (!box) throw new Error("no composer");
  await page.screenshot({ path: info.outputPath("image-look.png"), animations: "disabled",
    clip: { x: Math.max(0, box.x + box.width - 660), y: Math.max(0, box.y - 200), width: 676, height: box.height + 216 } });
  expect(await cut(page), "the button's name and size are whole: the composer row has the room").toEqual([]);
  for (const row of await picker.locator(".pk-r").all()) await expect(row, "the model rows carry no GB number").not.toContainText("GB");
  await expect(picker, "a mark, not the word").not.toContainText("Fits");
  // Klein's number is the same at every size: the head says it once, the rows keep only the mark
  expect((await picker.locator(".pk-context").innerText()).match(/GB/g), "the shared number is said once").toHaveLength(1);
  expect((await picker.locator(".pk-context-head").innerText()).match(/GB/g), "and it is in the head").toHaveLength(1);
});

test("two Klein setups never look the same on the button, wide or narrow", async ({ page, open }) => {
  await stack.reset("models", 0, undefined, "system", undefined, comfy.url);
  await open(); await waitReady(page);
  await imageOn(page);
  const client = connect(page);
  const button = page.locator("#modelBtn");
  try {
    const tip = () => button.evaluate((b) => b.getAttribute("data-tip") ?? b.getAttribute("data-tipt"));
    // Klein and the Characters style setup on the same files: each at its own size
    const look = async (preset: string) => {
      const klein = preset === "flux2-klein-4b";
      await client.call("settings.update", { imageChoice: klein ? { preset, width: 1024, height: 1024 } : { preset, width: 768, height: 1024 } });
      await expect.poll(tip).toContain(klein ? "FLUX.2 Klein 4B" : "characters");
      if (klein) await expect.poll(tip).not.toContain("characters");
      await page.mouse.move(5, 5);
      return button.screenshot({ animations: "disabled" });
    };
    for (const size of [{ width: 1280, height: 800 }, { width: 390, height: 800 }]) {
      await page.setViewportSize(size);
      expect((await look("flux2-klein-4b")).equals(await look("characters--klein-official4")), `${size.width} px wide`).toBe(false);
    }
  } finally { client.close(); }
});

/** Every control in the composer's button row, left and right edge, and the composer box's (as ux-trim-fixes measures it). */
const rowEdges = (page: Page) => page.locator(".composer .cf").evaluate((cf) => {
  const box = cf.getBoundingClientRect();
  const ctl = [...cf.querySelectorAll<HTMLElement>(".cf-l > *, .cf-r > *")].filter((e) => e.getClientRects().length > 0);
  // edges to a tenth of a pixel, measured in the page
  return {
    box: { l: Math.round(box.left * 10) / 10, r: Math.round(box.right * 10) / 10 },
    ctl: ctl.map((e) => { const r = e.getBoundingClientRect(); return { k: e.getAttribute("aria-label") ?? (e.id || e.className), l: Math.round(r.left * 10) / 10, r: Math.round(r.right * 10) / 10 }; }),
  };
});

for (const viewport of [360, 1280]) {
  const touch = viewport < 640;
  test.describe(`the composer row with Image on at ${viewport} px${touch ? ", touch" : ""}`, () => {
    test.use(touch ? { viewport: { width: viewport, height: 800 }, isMobile: true, hasTouch: true } : { viewport: { width: viewport, height: 800 } });
    test("stays inside the composer, keeps the button's minimum, and holds still on the first character", async ({ page, open }) => {
      await stack.reset("models", 0, undefined, "system", undefined, comfy.url);
      await open(); await waitReady(page);
      const client = connect(page);
      try { await client.call("settings.update", { imageGen: true }); } finally { client.close(); }
      if (touch) {
        await page.locator("#optBtn").click();
        await page.getByTestId("chat.options-menu.image").click();
        await page.keyboard.press("Escape");
      } else {
        await page.getByTestId("chat.composer.image").click();
      }
      const button = page.locator("#modelBtn");
      await expect(button).toContainText("1024×1024");
      expect(await width(page), "the image button keeps the row's minimum").toBeGreaterThanOrEqual(80);
      const before = await rowEdges(page);
      await page.locator("#ta").pressSequentially("a");
      await expect(page.locator("#ta")).toHaveValue("a");
      const after = await rowEdges(page);
      for (const [state, e] of [["before typing", before], ["after the first character", after]] as const) {
        for (const c of e.ctl) {
          expect(c.l, `${c.k} inside the composer, ${state}`).toBeGreaterThanOrEqual(e.box.l - 0.5);
          expect(c.r, `${c.k} inside the composer, ${state}`).toBeLessThanOrEqual(e.box.r + 0.5);
        }
      }
      expect(after.ctl, "the first character moves no control in the row").toEqual(before.ctl);
    });
  });
}

test("the button keeps its width on a thread switch with Image on", async ({ page, open }) => {
  await stack.reset("models", 0, undefined, "system", undefined, comfy.url);
  await open(); await waitReady(page);
  const client = connect(page);
  const threads: string[] = [];
  try {
    // two threads on installed chat models that fit, whose names differ in length
    for (const [title, model] of [["Short", "qwen3.5:9b"], ["Long", "gemma4:12b"]] as const) {
      const id = (await client.call("threads.create", { title })).id;
      await client.call("chat.send", { threadId: id, content: "hello", model, numCtx: 4096 });
      await expect.poll(async () => (await client.call("threads.get", { threadId: id })).messages.length, { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
      threads.push(id);
    }
  } finally { client.close(); }
  const image = page.getByTestId("chat.composer.image");
  await page.locator(`[data-thread="${threads[0]}"]`).click();
  await waitReady(page);
  await imageOn(page);
  await expect(page.locator("#modelBtn")).toContainText("1024×1024");
  const first = await width(page);
  for (const id of [threads[1], threads[0], threads[1]]) {
    await page.locator(`[data-thread="${id}"]`).click();
    await expect(page.locator("#modelBtn")).toContainText("1024×1024");
    expect(await width(page), `the button in thread ${id}`).toBe(first);
  }
  // Image off in the other thread, on again there: the image button is the same width as in the first
  await image.click();
  await expect(page.locator("#modelBtn")).not.toContainText("1024×1024");
  await image.click();
  await expect(page.locator("#modelBtn")).toContainText("1024×1024");
  expect(await width(page), "Image turned on again in the other thread").toBe(first);
});
