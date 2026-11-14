// Pictures, the journey the owner picked (direction D, the contact sheet): open Pictures from
// the sidebar's footer, the grid shows every finished picture, one opens in the inspector, and
// Again sends its prompt again in its own thread. Then the same screen at phone width, with the
// inspector as a bottom sheet. Screenshots at both widths, dark and light, the screen outlined.
import type { Locator, Page } from "@playwright/test";
import { createClient, type ImageChoice } from "@gates-local/contracts";
import { scenePng } from "../../apps/server/src/pictures/test-png.ts";
import { fakeComfy } from "./fake-comfy.ts";
import { expect, stack, test, waitReady } from "./fixtures.ts";

test.use({ allowedErrors: [/WebSocket connection to .* failed/] });
let comfy: Awaited<ReturnType<typeof fakeComfy>>;
// a (fake) GPU: on the CPU Image mode has no default and every job is refused
test.beforeEach(async () => { comfy = await fakeComfy(); comfy.gpu(); });
test.afterEach(async () => { await comfy.close(); });

type Client = ReturnType<typeof createClient>;

async function theme(page: Page, scheme: "dark" | "light"): Promise<void> {
  await page.emulateMedia({ colorScheme: scheme });
  await page.evaluate((s) => document.documentElement.setAttribute("data-theme", s), scheme);
}

/** The whole window, the Pictures screen and its footer button outlined in amber. */
async function shot(page: Page, file: string): Promise<void> {
  await page.mouse.move(2, 2);
  const style = await page.addStyleTag({ content: ".pics{outline:2px solid #f59e0b;outline-offset:-2px} .sb-foot .pics-btn{outline:2px solid #f59e0b;outline-offset:1px}" });
  await page.screenshot({ path: file, animations: "disabled" });
  await style.evaluate((el) => el.parentNode?.removeChild(el));
}

/** Every thumbnail drawn has loaded (the server makes each on first ask). */
async function thumbsLoaded(tiles: Locator): Promise<void> {
  await expect.poll(() => tiles.evaluateAll((els) => els.length > 0 && els.every((el) => {
    const img = el.querySelector("img");
    return img !== null && img.complete && img.naturalWidth > 0;
  })), { timeout: 15_000 }).toBe(true);
}

/** One finished picture in `threadId`: the fake serves a scene of the chosen size, and the job is waited out. */
async function picture(client: Client, threadId: string, prompt: string, choice: ImageChoice, hue: number): Promise<void> {
  comfy.picture(scenePng(choice.width, choice.height, hue));
  const { jobId } = await client.call("image.generate", { threadId, prompt, choice });
  comfy.finish();
  await expect.poll(async () => (await client.call("threads.get", { threadId })).messages.find((m) => m.id === jobId)?.imageJob?.state, { timeout: 30_000 }).toBe("done");
}

// Guards the owner's pick for Pictures (the contact sheet): grid, inspector, Again, phone sheet.
test("pictures: the grid, a picture in the inspector, Again in its thread, and the phone sheet", async ({ page, open }, info) => {
  info.annotations.push({ type: "budget", description: "Six fake image jobs run to done one after another (five to fill the grid, one from Again), and four full-window screenshots." });
  await stack.reset("models", 0, undefined, "system", undefined, comfy.url);
  await open(); await waitReady(page);
  const server = new URL(page.url()).searchParams.get("server");
  if (!server) throw new Error("No test server URL");
  const client = createClient(new WebSocket(server));
  let ships = "", wide: ImageChoice;
  try {
    await client.call("settings.update", { imageGen: true });
    const { current } = await client.call("image.presets", {});
    const sizes = current.preset.sizes;
    const of = (size: { width: number; height: number } | undefined): ImageChoice => ({ preset: current.preset.id, ...(size ?? sizes[0]!) });
    wide = of(sizes.find((z) => z.width > z.height));
    const tall = of(sizes.find((z) => z.height > z.width));
    const square = of(sizes.find((z) => z.width === z.height));
    ships = (await client.call("threads.create", { title: "Ships" })).id;
    const zebra = (await client.call("threads.create", { title: "Zebra" })).id;
    await picture(client, zebra, "a zebra dragon on blue ice", square, 200);
    await picture(client, zebra, "a zebra dragon on blue ice, closer", tall, 230);
    await picture(client, ships, "a space battle over a ringed planet", wide, 20);
    await picture(client, ships, "a quiet harbour at dusk", wide, 300);
    await picture(client, ships, "a lighthouse in a storm", tall, 260);
  } finally {
    client.close();
  }

  // open from the footer: the grid shows all five under Today, and the newest is picked
  await page.getByTestId("sidebar.foot.pictures").click();
  const pics = page.locator(".pics");
  await expect(pics.getByRole("heading", { name: /Pictures/ })).toContainText("5");
  const tiles = pics.getByTestId("pictures.grid.tile");
  await expect(tiles).toHaveCount(5);
  await expect(pics.locator(".pics-day").first()).toHaveText("Today");
  await expect(tiles.first()).toHaveAttribute("aria-pressed", "true");
  await thumbsLoaded(tiles);

  // a picture opens in the inspector: its prompt, its size, its thread
  await tiles.nth(2).click();
  await expect(tiles.nth(2)).toHaveAttribute("aria-pressed", "true");
  const insp = pics.locator(".pics-insp");
  await expect(insp.locator(".pics-prompt")).toHaveText("a space battle over a ringed planet");
  await expect(insp.locator(".pics-facts")).toContainText(`${wide.width} × ${wide.height}`);
  await expect(insp.getByRole("button", { name: "Ships" })).toBeVisible();
  await shot(page, info.outputPath("pictures-r2-desk-dark.png"));
  await theme(page, "light");
  await shot(page, info.outputPath("pictures-r2-desk-light.png"));
  await theme(page, "dark");

  // Again: its thread opens and a fourth card, for the same prompt, finishes there
  await insp.getByTestId("pictures.actions.again").click();
  await expect(page).toHaveURL(new RegExp(`#thread=${ships}$`));
  await expect(page.locator(".pics")).toHaveCount(0);
  const cards = page.locator("[data-image-job]");
  await expect(cards).toHaveCount(4);
  await expect(cards.last()).toHaveAttribute("data-image-job", "done", { timeout: 30_000 });

  // the phone: Pictures again (six now), the inspector a sheet on the bottom edge, nothing wider than the screen
  await page.setViewportSize({ width: 390, height: 844 });
  await page.keyboard.press("Control+Shift+P");
  await expect(pics.getByRole("heading", { name: /Pictures/ })).toContainText("6");
  const sheet = pics.locator(".pics-insp");
  await expect(sheet.getByTestId("pictures.actions.again")).toBeVisible();
  const box = await sheet.boundingBox();
  expect(box && Math.round(box.y + box.height)).toBe(844);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await thumbsLoaded(tiles);
  await shot(page, info.outputPath("pictures-r2-phone-dark.png"));
  await theme(page, "light");
  await shot(page, info.outputPath("pictures-r2-phone-light.png"));
});
