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
const DEFAULTS = ["General", "People", "Characters", "Pixel art", "Game sprites", "Backgrounds", "Icons", "Text and logos", "Painterly and concept art"];

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
    await page.getByTestId("chat.options-menu.image").click();
    await page.keyboard.press("Escape");
  } else await page.getByTestId("chat.composer.image").click();
  await page.locator("#modelBtn").click();
  const picker = page.locator("#imagePicker");
  // the menu open is Defaults, or Other models when the picked setup is there
  await expect(picker.locator(".pk-r:visible").first()).toBeVisible();
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

// Guards the owner's report (a): the picker's rail named nothing.
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
  await expect(rail.getByTestId("image.picker.defaults")).toHaveAttribute("aria-pressed", "true");
  await rail.getByTestId("image.picker.other").click();
  await expect(rail.getByTestId("image.picker.other")).toHaveAttribute("aria-pressed", "true");
  expect(await height(picker), "Other models: the same height").toBe(first);
  // each Other row highlighted in turn shows its sizes: still the same height
  for (const row of await picker.locator(".pk-menu:not([inert]) .pk-r").all()) {
    await row.hover();
    expect(await height(picker)).toBe(first);
  }
  await rail.getByTestId("image.picker.defaults").click();
  expect(await height(picker), "back on Defaults: the same height").toBe(first);
  for (const row of await picker.locator(".pk-menu:not([inert]) .pk-r").all()) {
    await row.hover();
    expect(await height(picker)).toBe(first);
  }
  await page.mouse.move(5, 5);
  await shot(page, info, "menus-defaults.png", picker.locator(".pk-menu:not([inert])"));
  await rail.getByTestId("image.picker.other").click();
  await shot(page, info, "menus-other.png", picker.locator(".pk-menu:not([inert])"));
});

// Guards the owner's report (b): a Defaults row said its group and model again. And the bug finder's
// (image row 15): its tooltip repeated the setup the size pane names, so it has none.
test("(b) a Defaults row is the style's name alone, its setup in the size pane only; the rest is in Other models", async ({ page, open }, info) => {
  comfy.withApp();
  const picker = await openPicker(page, open);
  await shot(page, info, "finding-b.png", picker.locator(".pk-list-scroll"));
  expect(await shownNames(picker)).toEqual(DEFAULTS);
  const defaults = picker.getByTestId("image.picker.defaults-list");
  await expect(defaults.locator(".pk-group, .maker-mark, .mark, .pk-variant"), "no group header, mark or tier tag").toHaveCount(0);
  // this 16 GB card's General is the style bench's 16 GB winner, and it is the button's
  const general = defaults.locator(".pk-r").first();
  await expect(general).toHaveAttribute("data-preset", "general--r2-2a-klein-compact8");
  await expect(general).toHaveAttribute("aria-selected", "true");
  await general.hover();
  // the sizes head names the model only (decision 16): the row already says the style
  await expect(picker.getByTestId("image.picker.model")).toHaveText("FLUX.2 Klein 4B");
  // the pointer stays on General past the tooltip delay: the shot shows whether one comes up
  await page.waitForTimeout(900);
  await page.screenshot({ path: info.outputPath("finding-15.png"), animations: "disabled" });
  await expect(defaults.locator("[data-tip]"), "no Defaults row has a tooltip").toHaveCount(0);
  await expect(page.locator("#tip")).not.toBeVisible();
  const pixel = defaults.locator('.pk-r[data-preset="pixel-art--r2-1a-klein-compact8"]');
  await pixel.hover();
  await expect(picker.getByTestId("image.picker.model")).toHaveText("FLUX.2 Klein 4B");

  // Other models: the General tier setups, marked and tagged as before; no style repeats
  await picker.getByTestId("image.picker.other").click();
  const other = picker.getByTestId("image.picker.other-list");
  expect(await other.locator("[role=group]").evaluateAll((gs) => gs.map((g) => [g.getAttribute("aria-label"), ...[...g.querySelectorAll("[data-preset]")].map((r) => r.getAttribute("data-preset"))]))).toEqual([
    ["General", "flux2-klein-4b", "z-image-int8", "moss-image"],
  ]);
  await expect(other.locator(".pk-r .maker-mark")).toHaveCount(3);
  // a pick from Other models runs that setup, and the picker opens on its menu next time
  await other.locator('.pk-r[data-preset="moss-image"] .pk-select').click();
  await expect(picker).toBeHidden();
  await expect(page.locator("#modelBtn")).toContainText("MOSS");
  await page.locator("#modelBtn").click();
  await expect(picker.getByTestId("image.picker.other")).toHaveAttribute("aria-pressed", "true");
  await expect(other.locator('.pk-r[data-preset="moss-image"]')).toHaveAttribute("aria-selected", "true");
});

// Guards the owner's report (c): every size said the same number and a bar was green that did not fit.
// Decision 15: sizes are judged by the card ("the measure for a model is not what is available now
// its based on the ram in the card"); only the job, after the chat model has left, checks what is free.
test("(c) with 3.0 GB free on the 16 GB card every size of an 8 GB setup fits the card, the number is said once, and the job still refuses for what another program holds", async ({ page, open }, info) => {
  // Klein's files alone: the General style setup needs the FP4 encoder, so the default is Klein, 8 GB at three sizes
  const picker = await openPicker(page, open, THREE_GB_FREE);
  await expect(picker.getByTestId("image.picker.card")).toHaveText(/^16\sGB GPU$/);
  await expect(picker.locator(".pk-bottom"), "the card, not what is free this second").not.toContainText(/GB free\b(?! on disk)/);
  const sizes = picker.locator(".pk-context");
  await shot(page, info, "finding-c.png", picker.locator(".pk-context, .pk-bottom"));
  await expect(page.locator("#modelBtn"), "the card's tier picks Klein").toContainText("Klein 4B");
  const rows = sizes.locator(".pk-ctx-row");
  await expect(rows).toHaveCount(3);
  for (const row of await rows.all()) {
    await expect(row.locator(".pk-cost")).toHaveClass(/\bgpu\b/);
    await expect(row).not.toHaveAttribute("data-tip");
    await expect(row.locator(".pk-cost")).toHaveAttribute("aria-label", /^8\.0\sGB estimated; fits the GPU$/);
  }
  const green = await paint(page, "--green");
  for (const fill of await sizes.locator(".pk-cost-fill").all()) expect(await fill.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(green);
  // the same 8.0 GB at every size is said once, in the head
  expect(((await sizes.innerText()).match(/8\.0\sGB/g) ?? []).length).toBe(1);
  await expect(picker.locator(".pk-context-head")).toContainText(/8\.0\sGB/);

  // the job's own check after the handoff: another program holds the memory, so a send is refused
  await page.keyboard.press("Escape");
  await sendMessage(page, "a tree");
  await expect(page.locator("[data-image-job]")).toHaveAttribute("data-fit", "refuse", { timeout: 15_000 });
});

// Guards the owner's report (c), the other side: sizes that fit are green.
test("(c) with room free the same sizes are green and fit", async ({ page, open }) => {
  const picker = await openPicker(page, open); // Klein's files alone, as above
  await expect(picker.locator(".pk-context-head")).toContainText("FLUX.2 Klein 4B");
  const sizes = picker.locator(".pk-context");
  await expect(sizes.locator(".pk-cost.gpu")).toHaveCount(3);
  const green = await paint(page, "--green");
  for (const fill of await sizes.locator(".pk-cost-fill").all()) expect(await fill.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(green);
  for (const row of await sizes.locator(".pk-ctx-row").all()) await expect(row).not.toHaveAttribute("data-tip");
  for (const cost of await sizes.locator(".pk-cost").all()) await expect(cost).toHaveAttribute("aria-label", /fits the GPU$/);
});

// Guards the owner's report (d): a greyed row's reason was cut off.
test("(d) a greyed row's reason that does not fit shows whole in its tip", async ({ page, open }, info) => {
  // no model folders reported and none picked: a download is refused, never guessed onto a drive
  comfy.bare();
  const picker = await openPicker(page, open);
  await picker.getByTestId("image.picker.other").click();
  const klein = picker.locator('.pk-r[data-preset="flux2-klein-4b"]');
  await klein.getByRole("button", { name: "Download FLUX.2 Klein 4B" }).click();
  const reason = "ComfyUI has not said where its models go. Pick a folder for the image files first.";
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
  // Guards the owner's rule that nothing moves: the picker keeps its height on a phone.
  test("the popup keeps its height across both menus and the size step", async ({ page, open }, info) => {
    comfy.withApp();
    const picker = await openPicker(page, open);
    await page.screenshot({ path: info.outputPath("phone-defaults.png"), animations: "disabled" });
    const first = await height(picker);
    expect(first).toBeGreaterThan(0);
    await picker.getByTestId("image.picker.other").click();
    expect(await height(picker)).toBe(first);
    await page.screenshot({ path: info.outputPath("phone-other.png"), animations: "disabled" });
    await picker.locator(".pk-menu:not([inert]) .pk-r .pk-select").first().click();
    await expect(picker.locator(".pk-back")).toBeVisible();
    expect(await height(picker), "the size step: the same height").toBe(first);
    await page.screenshot({ path: info.outputPath("phone-sizes.png"), animations: "disabled" });
    await picker.locator(".pk-back").click();
    await picker.getByTestId("image.picker.defaults").click();
    expect(await height(picker)).toBe(first);
  });
});
