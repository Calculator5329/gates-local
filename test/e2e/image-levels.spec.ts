// The image picker on cards of each size, with every setup's files in ComfyUI: which setup each
// tier offers (its tag on the row, the tier rows first in General) and what the composer button
// sends unset. The tiers go by the card's memory, never by what is free now: a 16 GB card that
// another program holds 11 GB of keeps the 16 GB tiers, and the footer says what is free. Under
// 4 GB, and on the CPU, there is no default: the button says "Image model", no row is checked and
// the picker says why. The fake card is 16303 MiB unless stack.gpu names another size.
import type { Page } from "@playwright/test";
import { createClient } from "@gates-local/contracts";
import { fakeComfy } from "./fake-comfy.ts";
import { expect, stack, test, waitReady } from "./fixtures.ts";

test.use({ video: "off" });
let comfy: Awaited<ReturnType<typeof fakeComfy>>;
test.beforeEach(async () => { comfy = await fakeComfy(); comfy.withApp(); });
test.afterEach(async () => { await comfy.close(); });

const NO_GPU = "Image mode needs a GPU with 4 GB.";

/** General's rows in order, each with its tier tag ("" when it has none). */
const general = (page: Page) => page.locator('#imagePicker [role=group][aria-label="General"] [data-preset]').evaluateAll((rows) =>
  rows.map((r) => `${r.getAttribute("data-preset")} ${r.querySelector(".pk-variant")?.textContent ?? ""}`.trim()));

/** The picker with the parts this change touches outlined in amber: the button, General and the footer. */
async function shot(page: Page, path: string) {
  await page.mouse.move(5, 5);
  const marked = page.locator('#modelBtn, #imagePicker [role=group][aria-label="General"], #imagePicker .pk-bottom');
  await marked.evaluateAll((els) => { for (const el of els) { (el as HTMLElement).style.outline = "2px solid #f59e0b"; (el as HTMLElement).style.outlineOffset = "2px"; } });
  await page.screenshot({ path, animations: "disabled" });
  await marked.evaluateAll((els) => { for (const el of els) { (el as HTMLElement).style.outline = ""; (el as HTMLElement).style.outlineOffset = ""; } });
}

const TOP = ["flux2-klein-4b Fast", "z-image-int8 Balanced", "moss-image Best", "flux2-klein-4b-compact"];
const NONE = ["flux2-klein-4b", "flux2-klein-4b-compact", "z-image-int8", "moss-image"];
/** A card's size as nvidia-smi reports it (an "8 GB" card says 8188 MiB), and another program's MiB on it. */
const LEVELS: readonly { name: string; gpu?: { other: number; card?: number }; rows: readonly string[]; button?: string; shot?: string }[] = [
  { name: "a 16 GB card", gpu: { other: 0 }, rows: TOP, button: "Klein 4B", shot: "image-5-after-16gb.png" },
  { name: "a 16 GB card another program holds 11 GB of", gpu: { other: 11_264 }, rows: TOP, button: "Klein 4B", shot: "image-5-after-16gb-busy.png" },
  { name: "an 8 GB card", gpu: { other: 0, card: 8188 }, rows: TOP, button: "Klein 4B" },
  { name: "a 6 GB card", gpu: { other: 0, card: 6144 }, rows: ["flux2-klein-4b-compact Fast", "z-image-int8 Balanced", "moss-image Best", "flux2-klein-4b"], button: "Compact" },
  { name: "a 4 GB card", gpu: { other: 0, card: 4096 }, rows: ["flux2-klein-4b-compact Fast and balanced", "moss-image Best", "flux2-klein-4b", "z-image-int8"], button: "Compact" },
  { name: "a 3 GB card", gpu: { other: 0, card: 3072 }, rows: NONE },
  { name: "the CPU", rows: NONE, shot: "image-5-after-cpu.png" },
];

for (const level of LEVELS) {
  test(`the picker on ${level.name}: ${level.button === undefined ? "no default, and it says a GPU is needed" : `${level.button} by default, each tier's setup tagged`}`, async ({ page, open }, info) => {
    await stack.reset("models", 0, undefined, "system", undefined, comfy.url);
    if (level.gpu !== undefined) { comfy.gpu(); await stack.gpu(level.gpu.other, level.gpu.card); }
    await open(); await waitReady(page);
    const server = new URL(page.url()).searchParams.get("server");
    if (!server) throw new Error("No test server URL");
    const client = createClient(new WebSocket(server));
    try { await client.call("settings.update", { imageGen: true }); } finally { client.close(); }
    await page.getByRole("button", { name: "Image", exact: true }).click();
    const button = page.locator("#modelBtn");
    if (level.button === undefined) await expect(button).toContainText("Image model");
    else await expect(button).toContainText(`${level.button}1024×1024`);
    await button.click();
    const picker = page.locator("#imagePicker");
    await expect(picker.locator(".pk-r").first()).toBeVisible();
    expect(await general(page)).toEqual(level.rows);
    if (level.shot !== undefined) await shot(page, info.outputPath(level.shot));
    const footer = picker.locator(".pk-bottom");
    if (level.button === undefined) {
      await expect(picker.locator('[aria-selected="true"], [aria-checked="true"]'), "nothing picked").toHaveCount(0);
      await expect(footer.getByRole("status")).toHaveText(NO_GPU);
      await expect(footer).not.toContainText("Runs in system memory");
    } else {
      await expect(footer.getByRole("status")).toHaveCount(0);
      await expect(footer).not.toContainText(NO_GPU);
      // what is free now is said as information, and on the busy card it is under a gigabyte
      await expect(footer).toContainText((level.gpu?.other ?? 0) > 0 ? /\b0\.\d\sGB free/ : /\d+\.\d\sGB free/);
    }
  });
}
