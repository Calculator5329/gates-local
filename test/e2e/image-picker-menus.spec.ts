// The image picker's two menus (Defaults and Other models) and the four things the owner's
// screenshot showed: (a) the rail named nothing, (b) a Defaults row said its group and its model
// again, (c) every size said the same number and a bar was green that did not fit in what is free,
// (d) a greyed row's reason was cut off. Each test saves its finding's shot before it checks, so a
// run on the old picker gives the before shots. The popup's height is measured on both menus and
// after each click: nothing moves. The fake card is 16303 MiB with 4182 MiB resident.
import type { Locator, Page, TestInfo } from "@playwright/test";
import { createClient } from "@gates-local/contracts";
import { fakeComfy } from "./fake-comfy.ts";
import { expect, sendMessage, stack, test, waitReady } from "./fixtures.ts";

test.use({ video: "off" });
let comfy: Awaited<ReturnType<typeof fakeComfy>>;
test.beforeEach(async () => { comfy = await fakeComfy(); comfy.gpu(); });
test.afterEach(async () => { await comfy.close(); });

/** Another program's MiB that leaves 3072 MiB (3.0 GB) free on the fake card. */
const THREE_GB_FREE = 16_303 - 4182 - 3072;
const DEFAULTS = ["General", "People", "Pixel art", "Game sprites", "Backgrounds"];

async function openPicker(page: Page, open: () => Promise<void>, otherMib = 0) {
  await stack.reset("models", 0, undefined, "system", undefined, comfy.url);
  await stack.gpu(otherMib);
  await open(); await waitReady(page);
  const server = new URL(page.url()).searchParams.get("server");
  if (!server) throw new Error("No test server URL");
  const client = createClient(new WebSocket(server));
  try { await client.call("settings.update", { imageGen: true }); } finally { client.close(); }
  // at phone width Image is in the composer's options, not a pill
  if ((page.viewportSize()?.width ?? 1440) <= 640) {
    await page.locator("#optBtn").click();
    await page.getByRole("menuitemcheckbox", { name: "Image" }).click();
    await page.keyboard.press("Escape");
  } else await page.getByRole("button", { name: "Image", exact: true }).click();
  await page.locator("#modelBtn").click();
  const picker = page.locator("#imagePicker");
  await expect(picker.locator(".pk-r").first()).toBeVisible();
  return picker;
}

/** The picker with one part outlined in amber: the finding's shot. */
async function shot(page: Page, info: TestInfo, name: string, part: Locator) {
  await page.mouse.move(5, 5);
  await part.evaluateAll((els) => { for (const el of els) { (el as HTMLElement).style.outline = "2px solid #f59e0b"; (el as HTMLElement).style.outlineOffset = "-2px"; } });
  await page.locator("#imagePicker").screenshot({ path: info.outputPath(name), animations: "disabled" });
  await part.evaluateAll((els) => { for (const el of els) { (el as HTMLElement).style.outline = ""; (el as HTMLElement).style.outlineOffset = ""; } });
}

const height = async (picker: Locator) => Math.round((await picker.boundingBox())?.height ?? 0);
/** The rows of the menu on screen, by the name each shows. */
const shownNames = (picker: Locator) => picker.locator(".pk-menu:not([inert]) .pk-nm").allTextContents();
/** The computed colour a CSS colour token paints as a background. */
const paint = (page: Page, token: string) => page.evaluate((t) => {
  const probe = document.createElement("i");
  probe.style.background = `var(${t})`;
  document.body.append(probe);
  const c = getComputedStyle(probe).backgroundColor;
  probe.remove();
  return c;
}, token);

test("(a) the rail is two named menus, Defaults and Other models, and the popup's height holds on both and on every click", async ({ page, open }, info) => {
  comfy.withApp();
  const picker = await openPicker(page, open);
  await shot(page, info, "finding-a.png", picker.locator(".pk-rail"));
  const rail = picker.locator(".pk-rail");
  await expect(rail.locator("button")).toHaveCount(2);
  await expect(rail.locator("button").nth(0)).toHaveAccessibleName("Defaults");
  await expect(rail.locator("button").nth(1)).toHaveAccessibleName("Other models");
  await expect(rail.locator(".maker-mark, .mark"), "no family codes on the rail").toHaveCount(0);
  await expect(rail).not.toContainText(/\S/);

  const first = await height(picker);
  expect(first).toBeGreaterThan(0);
  await expect(rail.getByRole("button", { name: "Defaults" })).toHaveAttribute("aria-pressed", "true");
  await rail.getByRole("button", { name: "Other models" }).click();
  await expect(rail.getByRole("button", { name: "Other models" })).toHaveAttribute("aria-pressed", "true");
  expect(await height(picker), "Other models: the same height").toBe(first);
  // each Other row highlighted in turn shows its sizes: still the same height
  for (const row of await picker.locator(".pk-menu:not([inert]) .pk-r").all()) {
    await row.hover();
    expect(await height(picker)).toBe(first);
  }
  await rail.getByRole("button", { name: "Defaults" }).click();
  expect(await height(picker), "back on Defaults: the same height").toBe(first);
  for (const row of await picker.locator(".pk-menu:not([inert]) .pk-r").all()) {
    await row.hover();
    expect(await height(picker)).toBe(first);
  }
  await page.mouse.move(5, 5);
  await shot(page, info, "menus-defaults.png", picker.locator(".pk-menu:not([inert])"));
  await rail.getByRole("button", { name: "Other models" }).click();
  await shot(page, info, "menus-other.png", picker.locator(".pk-menu:not([inert])"));
});

test("(b) a Defaults row is the style's name alone, its setup in the tip and the size pane; the rest is in Other models", async ({ page, open }, info) => {
  comfy.withApp();
  const picker = await openPicker(page, open);
  await shot(page, info, "finding-b.png", picker.locator(".pk-list-scroll"));
  expect(await shownNames(picker)).toEqual(DEFAULTS);
  const defaults = picker.getByRole("listbox", { name: "Defaults" });
  await expect(defaults.locator(".pk-group, .maker-mark, .mark, .pk-variant"), "no group header, mark or tier tag").toHaveCount(0);
  // this 16 GB card's General is the Fast tier's setup, FLUX.2 Klein 4B, and it is the button's
  const general = defaults.locator(".pk-r").first();
  await expect(general).toHaveAttribute("data-preset", "flux2-klein-4b");
  await expect(general).toHaveAttribute("aria-selected", "true");
  await expect(general.locator(".pk-select")).toHaveAttribute("data-tip", "FLUX.2 Klein 4B");
  await general.hover();
  await expect(page.locator("#tip")).toHaveText("FLUX.2 Klein 4B");
  await expect(picker.locator(".pk-context-head")).toContainText("FLUX.2 Klein 4B");
  const pixel = defaults.locator('.pk-r[data-preset="flux2-klein-4b-pixel"]');
  await pixel.hover();
  await expect(picker.locator(".pk-context-head")).toContainText("FLUX.2 Klein 4B pixel art");

  // Other models: the non-winning General setups, marked and tagged as before; no theme repeats
  await picker.getByRole("button", { name: "Other models" }).click();
  const other = picker.getByRole("listbox", { name: "Other models" });
  expect(await other.locator("[role=group]").evaluateAll((gs) => gs.map((g) => [g.getAttribute("aria-label"), ...[...g.querySelectorAll("[data-preset]")].map((r) => r.getAttribute("data-preset"))]))).toEqual([
    ["General", "z-image-int8", "moss-image", "flux2-klein-4b-compact"],
  ]);
  await expect(other.locator(".pk-r .maker-mark")).toHaveCount(3);
  // a pick from Other models runs that setup, and the picker opens on its menu next time
  await other.locator('.pk-r[data-preset="moss-image"] .pk-select').click();
  await expect(picker).toBeHidden();
  await expect(page.locator("#modelBtn")).toContainText("MOSS");
  await page.locator("#modelBtn").click();
  await expect(picker.getByRole("button", { name: "Other models" })).toHaveAttribute("aria-pressed", "true");
  await expect(other.locator('.pk-r[data-preset="moss-image"]')).toHaveAttribute("aria-selected", "true");
});

test("(c) with 3.0 GB free every size of an 8 GB setup is red and says Too big, the number is said once, and the server refuses it the same way", async ({ page, open }, info) => {
  comfy.withApp();
  const picker = await openPicker(page, open, THREE_GB_FREE);
  await expect(picker.locator(".pk-bottom")).toContainText(/3\.0\sGB free/);
  const sizes = picker.locator(".pk-context");
  await shot(page, info, "finding-c.png", picker.locator(".pk-context, .pk-bottom"));
  await expect(page.locator("#modelBtn"), "the card's tier still picks Klein; free memory is information").toContainText("Klein 4B");
  const rows = sizes.locator(".pk-ctx-row");
  await expect(rows).toHaveCount(3);
  for (const row of await rows.all()) {
    await expect(row.locator(".pk-cost")).toHaveClass(/\bno\b/);
    await expect(row).toHaveAttribute("data-tip", /^Too big: \d+\.\d\sGB short$/);
    await expect(row.locator(".pk-cost")).toHaveAttribute("aria-label", /^8\.0\sGB estimated; Too big/);
  }
  await expect(sizes.locator(".pk-cost.gpu, .pk-cost.held"), "no size is shown as fitting").toHaveCount(0);
  // no green on any bar: the filled part paints red
  const red = await paint(page, "--red"), green = await paint(page, "--green");
  for (const fill of await sizes.locator(".pk-cost-fill").all()) {
    const c = await fill.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(c).not.toBe(green);
    expect(c).toBe(red);
  }
  // the same 8.0 GB at every size is said once, in the head
  expect(((await sizes.innerText()).match(/8\.0\sGB/g) ?? []).length).toBe(1);
  await expect(picker.locator(".pk-context-head")).toContainText(/8\.0\sGB/);

  // the server's answer is the same function's: a send at this size is refused for memory
  await page.keyboard.press("Escape");
  await sendMessage(page, "a tree");
  await expect(page.locator("[data-image-job]")).toHaveAttribute("data-fit", "refuse", { timeout: 15_000 });
});

test("(c) with room free the same sizes are green and fit", async ({ page, open }) => {
  comfy.withApp();
  const picker = await openPicker(page, open);
  const sizes = picker.locator(".pk-context");
  await expect(sizes.locator(".pk-cost.gpu")).toHaveCount(3);
  const green = await paint(page, "--green");
  for (const fill of await sizes.locator(".pk-cost-fill").all()) expect(await fill.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(green);
  for (const row of await sizes.locator(".pk-ctx-row").all()) await expect(row).toHaveAttribute("data-tip", "Fits on the GPU");
});

test("(d) a greyed row's reason that does not fit shows whole in its tip", async ({ page, open }, info) => {
  comfy.bare();
  comfy.withFolders();
  const picker = await openPicker(page, open);
  const klein = picker.locator('.pk-r[data-preset="flux2-klein-4b"]');
  comfy.down(true);
  await klein.getByRole("button", { name: "Download FLUX.2 Klein 4B" }).click();
  const reason = "Start ComfyUI on this computer first: downloads go into its model folders.";
  await expect(klein.locator(".pk-why")).toHaveText(reason);
  await shot(page, info, "finding-d.png", klein);
  expect(await klein.locator(".pk-why-t").evaluate((el) => el.scrollWidth > el.clientWidth), "the reason is cut on the row").toBe(true);
  await klein.locator(".pk-why").hover();
  await expect(page.locator("#tip")).toHaveClass(/\bopen\b/);
  await expect(page.locator("#tip")).toHaveText(reason);
  await page.locator("#imagePicker").screenshot({ path: info.outputPath("finding-d-tip.png"), animations: "disabled" });
  // the whole picker as well: the tip is drawn outside it
  await page.screenshot({ path: info.outputPath("finding-d-page.png"), animations: "disabled" });
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 412, height: 915 } });
  test("the popup keeps its height across both menus and the size step", async ({ page, open }, info) => {
    comfy.withApp();
    const picker = await openPicker(page, open);
    await page.screenshot({ path: info.outputPath("phone-defaults.png"), animations: "disabled" });
    const first = await height(picker);
    expect(first).toBeGreaterThan(0);
    await picker.getByRole("button", { name: "Other models" }).click();
    expect(await height(picker)).toBe(first);
    await page.screenshot({ path: info.outputPath("phone-other.png"), animations: "disabled" });
    await picker.locator(".pk-menu:not([inert]) .pk-r .pk-select").first().click();
    await expect(picker.locator(".pk-back")).toBeVisible();
    expect(await height(picker), "the size step: the same height").toBe(first);
    await page.screenshot({ path: info.outputPath("phone-sizes.png"), animations: "disabled" });
    await picker.locator(".pk-back").click();
    await picker.getByRole("button", { name: "Defaults" }).click();
    expect(await height(picker)).toBe(first);
  });
});
