// The image picker on cards of each size, with every setup's files in ComfyUI: which setup each
// tier offers (its tag on the row, the tier rows first in General), Defaults' General row (the
// style bench's winner at the card's level) and what the composer button sends unset. The levels
// go by the card's memory, never by what is free now: a 16 GB card that another program holds
// 11 GB of keeps the 16 GB setups, and the footer says what is free. Under 4 GB there is no
// default: the button says "Image model", no row is checked and the picker says why. On the CPU
// the basic-PC General setup is the default and the picker says once how slow it is. The fake
// card is 16303 MiB unless stack.gpu names another size.
import type { Page } from "@playwright/test";
import { createClient } from "@gates-local/contracts";
import { fakeComfy } from "./fake-comfy.ts";
import { expect, stack, test, waitReady } from "./fixtures.ts";

test.use({ video: "off" });
let comfy: Awaited<ReturnType<typeof fakeComfy>>;
test.beforeEach(async () => { comfy = await fakeComfy(); comfy.withApp(); });
test.afterEach(async () => { await comfy.close(); });

const NO_GPU = "Image mode needs a GPU with 4 GB.";
const SLOW = "No GPU: a picture takes 2 to 4 minutes.";

/**
 * General's rows: Defaults' General row first ("General: <setup>", the tier's pick, named by the
 * style alone), then Other models' General rows in order, each with its tier tag ("" when none).
 */
const general = (page: Page) => page.locator("#imagePicker").evaluate((root) => {
  const style = [...root.querySelectorAll<HTMLElement>('[role=listbox][aria-label="Defaults"] .pk-r')].find((r) => r.querySelector(".pk-nm")?.textContent === "General");
  const rest = [...root.querySelectorAll<HTMLElement>('[role=group][aria-label="General"] [data-preset]')];
  return [...style === undefined ? [] : [`General: ${style.dataset["preset"]}`], ...rest.map((r) => `${r.dataset["preset"]} ${r.querySelector(".pk-variant")?.textContent ?? ""}`.trim())];
});

/** The picker with the parts this change touches outlined in amber: the button, General and the footer. */
async function shot(page: Page, path: string) {
  await page.mouse.move(5, 5);
  const marked = page.locator('#modelBtn, #imagePicker .pk-menu:not([inert]), #imagePicker .pk-bottom');
  await marked.evaluateAll((els) => { for (const el of els) { (el as HTMLElement).style.outline = "2px solid #f59e0b"; (el as HTMLElement).style.outlineOffset = "2px"; } });
  await page.screenshot({ path, animations: "disabled" });
  await marked.evaluateAll((els) => { for (const el of els) { (el as HTMLElement).style.outline = ""; (el as HTMLElement).style.outlineOffset = ""; } });
}

// Other models' General rows on an 8 GB card or bigger: the tier rows in tier order, then compact
const TIERS = ["flux2-klein-4b Fast", "z-image-int8 Balanced", "moss-image Best", "flux2-klein-4b-compact"];
// no tier and no style setup: General has no Defaults row
const NONE = ["flux2-klein-4b", "flux2-klein-4b-compact", "z-image-int8", "moss-image"];
/** A card's size as nvidia-smi reports it (an "8 GB" card says 8188 MiB), and another program's MiB on it. */
const LEVELS: readonly { name: string; gpu?: { other: number; card?: number }; rows: readonly string[]; button?: string; note?: string; shot?: string }[] = [
  { name: "a 16 GB card", gpu: { other: 0 }, rows: ["General: general--r2-2a-klein-compact8", ...TIERS], button: "General896×896", shot: "image-11-after-16gb.png" },
  { name: "a 16 GB card another program holds 11 GB of", gpu: { other: 11_264 }, rows: ["General: general--r2-2a-klein-compact8", ...TIERS], button: "General896×896" },
  { name: "an 8 GB card", gpu: { other: 0, card: 8188 }, rows: ["General: general--fit-8b-klein-compact8", ...TIERS], button: "General512×512", shot: "image-11-after-8gb.png" },
  { name: "a 6 GB card", gpu: { other: 0, card: 6144 }, rows: ["General: general--fit-8b-klein-compact8", "flux2-klein-4b-compact Fast", "z-image-int8 Balanced", "moss-image Best", "flux2-klein-4b"], button: "General512×512" },
  { name: "a 4 GB card", gpu: { other: 0, card: 4096 }, rows: ["General: general--fit-4a-klein-compact8", "flux2-klein-4b-compact Fast and balanced", "moss-image Best", "flux2-klein-4b", "z-image-int8"], button: "General512×512" },
  { name: "a 3 GB card", gpu: { other: 0, card: 3072 }, rows: NONE, note: NO_GPU },
  { name: "the CPU", rows: ["General: general--cpu-klein-fp4-768-2", ...NONE], button: "General768×768", note: SLOW, shot: "image-11-after-cpu.png" },
];

// Guards the owner's ask for image setups by card size: each tier's default, and no default without a GPU.
for (const level of LEVELS) {
  test(`the picker on ${level.name}: ${level.button === undefined ? "no default, and it says a GPU is needed" : `${level.button} by default, each tier's setup tagged`}${level.note === SLOW ? ", and it says how slow" : ""}`, async ({ page, open }, info) => {
    await stack.reset("models", 0, undefined, "system", undefined, comfy.url);
    if (level.gpu !== undefined) { comfy.gpu(); await stack.gpu(level.gpu.other, level.gpu.card); }
    await open(); await waitReady(page);
    const server = new URL(page.url()).searchParams.get("server");
    if (!server) throw new Error("No test server URL");
    const client = createClient(new WebSocket(server));
    try { await client.call("settings.update", { imageGen: true }); } finally { client.close(); }
    await page.getByTestId("chat.composer.image").click();
    const button = page.locator("#modelBtn");
    if (level.button === undefined) await expect(button).toContainText("Image model");
    else await expect(button).toContainText(level.button);
    await button.click();
    const picker = page.locator("#imagePicker");
    await expect(picker.locator(".pk-r").first()).toBeVisible();
    expect(await general(page)).toEqual(level.rows);
    if (level.shot !== undefined) await shot(page, info.outputPath(level.shot));
    const footer = picker.locator(".pk-bottom");
    if (level.button === undefined) await expect(picker.locator('[aria-selected="true"], [aria-checked="true"]'), "nothing picked").toHaveCount(0);
    if (level.note !== undefined) {
      await expect(footer.getByRole("status")).toHaveText(level.note);
      await expect(footer).not.toContainText("Runs in system memory");
    } else {
      await expect(footer.getByRole("status")).toHaveCount(0);
      await expect(footer).not.toContainText(NO_GPU);
      // what is free now is said as information, and on the busy card it is under a gigabyte
      await expect(footer).toContainText((level.gpu?.other ?? 0) > 0 ? /\b0\.\d\sGB free/ : /\d+\.\d\sGB free/);
    }
  });
}
