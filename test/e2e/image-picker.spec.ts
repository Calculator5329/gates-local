// Image on in the composer: the model button names the image model and size where the chat
// model was (the same right edge, the width its name needs), its picker lists only what ComfyUI has every file for, Send goes straight
// to the image model (no chat request), and the choice is the app's: the same in a new thread
// and after a reload. Settings › Tools › Make images is on once a setup can run; an off stays off.
import type { Page } from "@playwright/test";
import { createClient } from "@gates-local/contracts";
import { CONTROL_URL } from "./env.ts";
import { ZIMAGE_FILES } from "../../apps/server/test/comfy/info.ts";
import { fakeComfy } from "./fake-comfy.ts";
import { expect, sendMessage, stack, test, waitReady } from "./fixtures.ts";
import { state } from "./threads-support.ts";

test.use({ video: process.env["GL_E2E_RECORD"] ? "on" : "off" });
let comfy: Awaited<ReturnType<typeof fakeComfy>>;
// FLUX.2 Klein 4B's files on a GPU: on the CPU the default needs an encoder they lack
test.beforeEach(async () => { comfy = await fakeComfy(); comfy.gpu(); });
test.afterEach(async () => { await comfy.close(); });

/** Defaults on a 16 GB card: each style's setup (styles.ts), in the menu's order. */
const STYLES_16 = ["general--r2-2a-klein-compact8", "portraits--moss-official25", "characters--klein-official4", "pixel-art--r2-1a-klein-compact8", "sprites--r2-1a-moss-official25", "backgrounds--r2-1b-moss-official25", "icons--r2-2a-moss-official25", "text-logos--moss-official25", "painterly--r2-2a-moss-official25"];

async function shot(page: Page, name: string, info: { outputPath: (n: string) => string }, clip?: { x: number; y: number; width: number; height: number }) {
  await page.screenshot({ path: info.outputPath(name), animations: "disabled", ...(clip ? { clip } : {}) });
}

/** The composer with room around it, the crop every button shot uses. */
async function composerClip(page: Page) {
  const box = await page.locator(".composer").boundingBox();
  if (!box) throw new Error("no composer");
  return { x: Math.max(0, box.x - 16), y: Math.max(0, box.y - 16), width: box.width + 32, height: box.height + 32 };
}

async function imageGenOn(page: Page) {
  await page.keyboard.press("Control+Comma");
  await page.locator(".snav").getByRole("button", { name: "Image generation", exact: true }).click();
  await page.getByRole("switch", { name: "Generate images" }).click();
  await expect(page.getByRole("switch", { name: "Generate images" })).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await waitReady(page);
}

/** The Image pill and Send keep their boxes; the model button keeps its right edge and height and takes the width its name needs. */
const boxes = async (page: Page) => {
  const [button, ...rest] = await Promise.all(["#modelBtn", '.cf-l button[aria-label="Image"]', ".composer button.send"].map((s) => page.locator(s).first().boundingBox()));
  return [button && { right: button.x + button.width, y: button.y, height: button.height }, ...rest];
};

test("Image on: the button names the image model and size where the chat model was, and its picker lists what ComfyUI has", async ({ page, open }, info) => {
  comfy.withApp(); // every setup's files: each row is ready, so none carries a Download button or its tip
  await stack.reset("models", 0, undefined, "system", undefined, comfy.url);
  await open(); await waitReady(page);
  await imageGenOn(page);
  const button = page.locator("#modelBtn");
  const before = await boxes(page);
  await page.getByRole("button", { name: "Image", exact: true }).click();
  // unset: the General style setup of the card's level (16 GB here: the GPU reading is the stack's default)
  await expect(button).toContainText("General");
  await expect(button).toContainText("896×896");
  expect(await boxes(page), "the Image pill and Send keep their boxes, the button its right edge").toEqual(before);
  await page.mouse.move(5, 5);
  await shot(page, "image-after-button.png", info, await composerClip(page));

  await button.click();
  const picker = page.locator("#imagePicker");
  await expect(picker).toBeVisible();
  await expect(picker.locator(".pk-r")).toHaveCount(STYLES_16.length + 4);
  // Defaults: one setup per style, the bench's winner at this level; Other models: General's setups in tier order
  expect(await picker.locator(".pk-r").evaluateAll((rows) => rows.map((r) => r.getAttribute("data-preset")))).toEqual([...STYLES_16, "flux2-klein-4b", "z-image-int8", "moss-image", "flux2-klein-4b-compact"]);
  await expect(picker.locator(".pk-rail").getByRole("button"), "the rail is the two menus").toHaveText(["", ""]);
  await expect(picker.locator(".pk-rail").getByRole("button").nth(0)).toHaveAccessibleName("Defaults");
  await expect(picker.locator(".pk-rail").getByRole("button").nth(1)).toHaveAccessibleName("Other models");
  await expect(picker.locator("input"), "the image picker has no search box").toHaveCount(0);
  // no row has a tooltip: a Defaults row's setup is in the size pane (every row is ready: no Download)
  await expect(picker.locator(".pk-r [data-tip], .pk-r[data-tip]"), "no row tooltips").toHaveCount(0);
  // a style setup runs at the one size the bench ran it at
  await expect(picker.locator(".pk-ctx-row")).toHaveCount(1);
  await shot(page, "image-after-picker.png", info);

  // a row picks that model at the size nearest the current one, as the chat picker picks a model
  await picker.locator('.pk-r[data-preset="pixel-art--r2-1a-klein-compact8"] .pk-select').click();
  await expect(picker).toBeHidden();
  await expect(button).toContainText("Retro pixel");
  await expect(button).toContainText("640×640");
  // a size row picks that size: Klein, from Other models, runs at three
  await button.click();
  await picker.getByRole("button", { name: "Other models" }).click();
  await picker.locator('.pk-r[data-preset="flux2-klein-4b"] .pk-select').click();
  await expect(picker).toBeHidden();
  await expect(button).toContainText("Klein 4B");
  await button.click();
  await expect(picker.locator(".pk-ctx-row")).toHaveCount(3);
  await picker.locator('.pk-ctx-row[data-size="1024x768"]').click();
  await expect(picker).toBeHidden();
  await expect(button).toContainText("Klein 4B");
  await expect(button).toContainText("1024×768");
  expect(await boxes(page)).toEqual(before);

  // Image off: the chat model again, at the same right edge
  await page.getByRole("button", { name: "Image", exact: true }).click();
  await expect(button).not.toContainText("Klein 4B");
  expect(await boxes(page)).toEqual(before);
});

test("the picker lists only presets whose files ComfyUI reports", async ({ page, open }) => {
  await comfy.close();
  comfy = await fakeComfy();
  comfy.only(ZIMAGE_FILES); // Z-Image's files only, no FLUX
  comfy.gpu();
  await stack.reset("models", 0, undefined, "system", undefined, comfy.url);
  await open(); await waitReady(page);
  await imageGenOn(page);
  await page.getByRole("button", { name: "Image", exact: true }).click();
  // the default falls past Klein to the first setup ComfyUI has every file for, without naming Klein
  await expect(page.locator("#modelBtn")).toContainText("Z-Image1024×1024");
  await expect(page.locator("#modelBtn")).not.toContainText("Klein");
  await page.locator("#modelBtn").click();
  const picker = page.locator("#imagePicker");
  // the rest are listed greyed out, each with its reason: a pick only for what ComfyUI has
  await expect(picker.locator(".pk-r:not(.off)")).toHaveCount(1);
  expect(await picker.locator(".pk-r:not(.off)").evaluateAll((rows) => rows.map((r) => r.getAttribute("data-preset")))).toEqual(["z-image-int8"]);
  await expect(picker.locator('.pk-r.off[data-preset="flux2-klein-4b"] .pk-select')).toHaveAttribute("aria-disabled", "true");
  // its Download button stays a button: the row itself is not marked disabled, only its pick
  await expect(picker.locator('.pk-r.off[aria-disabled]')).toHaveCount(0);
  // the pick is in Other models, so it opens there; Klein is greyed beside it, and so is General's style setup
  await expect(picker.getByRole("button", { name: "Other models" })).toHaveAttribute("aria-pressed", "true");
  await picker.locator('.pk-r.off[data-preset="flux2-klein-4b"] .pk-select').click({ force: true });
  await expect(picker, "a greyed row picks nothing").toBeVisible();
  await picker.getByRole("button", { name: "Defaults" }).click();
  await picker.locator('.pk-r.off[data-preset="general--r2-2a-klein-compact8"] .pk-select').click({ force: true });
  await expect(picker, "a greyed row picks nothing").toBeVisible();
  await expect(page.locator("#modelBtn")).toContainText("Z-Image1024×1024");
  await expect(picker.locator(".pk-ctx-row:enabled"), "its sizes show, not pickable").toHaveCount(0);
});

/** Each menu's name and its rows in order; in Other models, each group's name and its rows, ready rows first. */
const groups = (page: Page) => page.locator("#imagePicker .pk-menu").evaluateAll((menus) => menus.map((m) => [m.getAttribute("aria-label"),
  ...m.querySelector("[role=group]") === null ? [...m.querySelectorAll("[data-preset]")].map((r) => r.getAttribute("data-preset"))
    : [...m.querySelectorAll("[role=group]")].map((g) => [g.getAttribute("aria-label"), ...[...g.querySelectorAll("[data-preset]")].map((r) => r.getAttribute("data-preset"))])]));

test("the picker groups setups by theme, greys what ComfyUI lacks with the reason, and downloads one with progress and Stop", async ({ page, open }, info) => {
  await comfy.close();
  comfy = await fakeComfy();
  comfy.bare(); // no model files: every setup needs files
  comfy.gpu();
  comfy.withFolders();
  comfy.slowDownloads(true);
  await stack.reset("models", 0, undefined, "system", undefined, comfy.url);
  await open(); await waitReady(page);
  await imageGenOn(page);
  await page.getByRole("button", { name: "Image", exact: true }).click();
  await page.locator("#modelBtn").click();
  const picker = page.locator("#imagePicker");
  await expect(picker.locator(".pk-r").first()).toBeVisible();
  await page.mouse.move(5, 5);
  await shot(page, "image-picker-groups.png", info);
  // Defaults: each style's setup, downloaded or not; the styles live there, not in Other models
  expect(await groups(page)).toEqual([
    ["Defaults", ...STYLES_16],
    ["Other models", ["General", "flux2-klein-4b", "z-image-int8", "moss-image", "flux2-klein-4b-compact"]],
  ]);
  const defaults = picker.getByRole("listbox", { name: "Defaults" });
  await expect(defaults.locator(".pk-nm")).toHaveText(["General", "People", "Characters", "Pixel art", "Game sprites", "Backgrounds", "Icons", "Text and logos", "Painterly and concept art"]);
  // each Other tier setup says its tier, downloaded or not; a style row is the style alone
  expect(await picker.locator(".pk-r").evaluateAll((rows) => rows.map((r) => r.querySelector(".pk-variant")?.textContent ?? null))).toEqual([...STYLES_16.map(() => null), "Fast", "Balanced", "Best", null]);
  await expect(picker.locator(".pk-title"), "no heading saying the button's name again").toHaveCount(0);
  await expect(picker).not.toContainText("Image model");
  // Klein is in Other models; the Characters style setup loads the same three files
  const characters = defaults.locator('.pk-r[data-preset="characters--klein-official4"]');
  await expect(characters.locator(".pk-why")).toHaveText(/^Needs 3 files · \d+\.\d\sGB$/);
  await picker.getByRole("button", { name: "Other models" }).click();
  const klein = picker.locator('.pk-r[data-preset="flux2-klein-4b"]');
  await expect(klein).toHaveClass(/\boff\b/);
  await expect(klein.locator(".pk-why")).toHaveText(/^Needs 3 files · \d+\.\d\sGB$/);

  // refused (ComfyUI is not answering): the row says why, and no bar is left from the press
  comfy.down(true);
  await klein.getByRole("button", { name: "Download FLUX.2 Klein 4B" }).click();
  await expect(klein.locator(".pk-why")).toHaveText("Start ComfyUI on this computer first: downloads go into its model folders.");
  await expect(klein.getByRole("progressbar")).toHaveCount(0);
  comfy.down(false);

  await klein.getByRole("button", { name: "Download FLUX.2 Klein 4B" }).click();
  await expect(klein.getByRole("progressbar")).toBeVisible();
  await expect(klein.locator(".pk-why")).toContainText(/File 1\/3 · \d+%/);
  await expect.poll(async () => Number(await klein.getByRole("progressbar").getAttribute("aria-valuenow")), "the bar moves").toBeGreaterThan(0);
  await page.mouse.move(5, 5);
  await shot(page, "image-picker-downloading.png", info);
  // the setups that load the same files show that download, said once: no "Needs 3 files" and no button to press
  await picker.getByRole("button", { name: "Defaults" }).click();
  await expect(characters.getByRole("progressbar")).toBeVisible();
  await expect(characters.locator(".pk-why")).toContainText(/File 1\/3 · \d+%/);
  await expect(characters.getByRole("button", { name: /^(Download|Stop)/ })).toHaveCount(0);
  await picker.getByRole("button", { name: "Other models" }).click();

  await klein.getByRole("button", { name: "Stop downloading FLUX.2 Klein 4B" }).click();
  await expect(klein.locator(".pk-why")).toHaveText("Download stopped; the part already downloaded is kept.");
  await expect(klein.getByRole("progressbar")).toHaveCount(0);
  await picker.getByRole("button", { name: "Defaults" }).click();
  await expect(picker.getByRole("button", { name: "Download FLUX.2 Klein 4B characters" })).toBeEnabled();
  await picker.getByRole("button", { name: "Other models" }).click();

  // again, unheld: it carries on from the part and the row turns ready, with the setups sharing its files
  comfy.slowDownloads(false);
  await klein.getByRole("button", { name: "Download FLUX.2 Klein 4B" }).click();
  await expect(klein).not.toHaveClass(/\boff\b/, { timeout: 20_000 });
  await picker.getByRole("button", { name: "Defaults" }).click();
  await expect(characters).not.toHaveClass(/\boff\b/);
  await picker.getByRole("button", { name: "Other models" }).click();
  // compact, Z-Image and MOSS need their own files
  const other = picker.getByRole("listbox", { name: "Other models" });
  expect(await other.locator(".pk-r.off").evaluateAll((rows) => rows.map((r) => r.getAttribute("data-preset")))).toEqual(["z-image-int8", "moss-image", "flux2-klein-4b-compact"]);
  await klein.locator(".pk-select").click();
  await expect(picker).toBeHidden();
  await expect(page.locator("#modelBtn")).toContainText("Klein 4B");
});

/** No model files, model folders of its own: every setup offers its download. */
async function downloadable(page: Page, open: () => Promise<void>) {
  await comfy.close();
  comfy = await fakeComfy();
  comfy.bare();
  comfy.gpu();
  comfy.withFolders();
  await stack.reset("models", 0, undefined, "system", undefined, comfy.url);
  await open(); await waitReady(page);
  await imageGenOn(page);
  await page.getByRole("button", { name: "Image", exact: true }).click();
  await page.locator("#modelBtn").click();
  const picker = page.locator("#imagePicker");
  // the default (General's style setup) is in Defaults; Klein is in Other models
  await picker.getByRole("button", { name: "Other models" }).click();
  return { picker, klein: picker.locator('.pk-r[data-preset="flux2-klein-4b"]') };
}

test("a setup's download is one bar for all its files: on the last of three it is past two thirds", async ({ page, open }, info) => {
  const { klein } = await downloadable(page, open);
  comfy.slowDownloads(true, "flux2-vae.safetensors"); // the first two arrive at once, the third trickles
  await klein.getByRole("button", { name: "Download FLUX.2 Klein 4B" }).click();
  await expect(klein.locator(".pk-why")).toContainText(/File 3\/3 · \d+%/);
  await page.mouse.move(5, 5);
  await shot(page, "image-picker-downloading-setup.png", info);
  const pct = Number(await klein.getByRole("progressbar").getAttribute("aria-valuenow"));
  expect(pct, "two of three equal files are in").toBeGreaterThanOrEqual(66);
  await expect(klein.locator(".pk-why")).toContainText(`File 3/3 · ${pct}%`);
  comfy.slowDownloads(false);
  await expect(klein).not.toHaveClass(/\boff\b/, { timeout: 20_000 });
});

test.describe("across a server restart", () => {
  // the browser logs each refused WebSocket attempt while the server is down
  test.use({ allowedErrors: [/WebSocket connection to .* failed/] });

  test("a download the restart ended leaves no frozen bar: the row offers Download again", async ({ page, open }) => {
    test.setTimeout(60_000);
    const { picker, klein } = await downloadable(page, open);
    comfy.slowDownloads(true);
    await klein.getByRole("button", { name: "Download FLUX.2 Klein 4B" }).click();
    await expect(klein.getByRole("progressbar")).toBeVisible();
    // a crash, so no push ends the download: a SIGTERM's close() would send that push and hide the bug
    await stack.restart(500, true);
    await waitReady(page);
    if (!await picker.isVisible()) await page.locator("#modelBtn").click();
    await picker.getByRole("button", { name: "Other models" }).click();
    await expect(klein.getByRole("progressbar")).toHaveCount(0);
    await expect(klein.getByRole("button", { name: "Stop downloading FLUX.2 Klein 4B" })).toHaveCount(0);
    await expect(klein.getByRole("button", { name: "Download FLUX.2 Klein 4B" })).toBeEnabled();
    await picker.getByRole("button", { name: "Defaults" }).click();
    await expect(picker.getByRole("button", { name: "Download FLUX.2 Klein 4B characters" })).toBeEnabled();
  });
});

test.describe("on the phone", () => {
  test.use({ viewport: { width: 412, height: 915 } });

  test("the picker offers no Download, Stop or Start the phone cannot do, and a pick saves the thread's choice alone with no error", async ({ page }, info) => {
    await comfy.close();
    comfy = await fakeComfy();
    comfy.only(ZIMAGE_FILES); // Z-Image's files only: every FLUX setup needs files
    comfy.gpu();
    comfy.withFolders();
    const r = await fetch(`${CONTROL_URL}/reset`, { method: "POST", body: JSON.stringify({ scenario: "models", phone: true, seed: "design", comfyUrl: comfy.url, imageTool: true }) });
    expect(r.ok, await r.clone().text()).toBe(true);
    const { phonePort } = (await r.json()) as { phonePort: number };
    await page.addInitScript(() => localStorage.setItem("gates-local.first-run-done", "1"));
    await page.goto(`http://127.0.0.1:${phonePort}/`);
    await expect(page.locator(".composer:not(.blocked)")).toBeAttached({ timeout: 10_000 });
    // at phone width Image is in the composer's options, not a pill
    await page.locator("#optBtn").click();
    await page.getByRole("menuitemcheckbox", { name: "Image" }).click();
    await page.keyboard.press("Escape");
    await page.locator("#modelBtn").click();
    const picker = page.locator("#imagePicker");
    const general = picker.locator('.pk-r[data-preset="general--r2-2a-klein-compact8"]');
    // General's style setup is greyed in Defaults; the pick (Z-Image) is in Other models, where the picker opens
    await picker.getByRole("button", { name: "Defaults" }).click();
    await expect(general.locator(".pk-why")).toHaveText(/^Needs 3 files · \d+\.\d\sGB$/);
    await page.mouse.move(5, 5);
    await shot(page, "image-picker-phone.png", info);
    await expect(picker.getByRole("button", { name: /^(Download|Stop downloading)/ })).toHaveCount(0);
    // a ready row, then its size: the thread keeps it; Settings is the computer's, so it is not written
    await picker.getByRole("button", { name: "Other models" }).click();
    await picker.locator('.pk-r[data-preset="z-image-int8"] .pk-select').click();
    await picker.locator(".pk-ctx-row").first().click();
    await expect(picker).toBeHidden();
    await expect(page.locator("#modelBtn")).toContainText("Z-Image");
  });
});

// With no ComfyUI answering at all the Image button no longer reaches the picker (image-unset.spec.ts);
// the blank row is for a ComfyUI that answers but whose files were never read.
test("ComfyUI up but never listed: one full-width row says so with Check again, and there is no Size pane", async ({ page, open }, info) => {
  await comfy.close();
  comfy = await fakeComfy(); // Klein's files
  comfy.unlisted(true);
  await stack.reset("models", 0, undefined, "system", undefined, comfy.url);
  await open(); await waitReady(page);
  await imageGenOn(page);
  await page.getByRole("button", { name: "Image", exact: true }).click();
  await page.locator("#modelBtn").click();
  const picker = page.locator("#imagePicker");
  await expect(picker).toContainText("Image models show here once ComfyUI has run.");
  await page.mouse.move(5, 5);
  await shot(page, "image-picker-empty.png", info);
  await expect(picker.locator(".pk-context"), "no Size pane before a model row").toHaveCount(0);
  await expect(picker.locator(".pk-title")).toHaveCount(0);
  const blank = picker.locator(".pk-blank");
  const [row, all] = await Promise.all([blank.boundingBox(), picker.boundingBox()]);
  expect(row && all && row.width, "the row takes the picker's width").toBeGreaterThan((all?.width ?? 0) - 40);
  // explicit, never on open: nothing was started, and the button says what it does
  const check = blank.getByRole("button", { name: "Check again" });
  comfy.unlisted(false);
  await check.click();
  // Klein: no GPU here, and the basic-PC style setups need the FP4 encoder Klein's files lack
  await expect.poll(() => picker.locator(".pk-r:not(.off)").evaluateAll((rows) => rows.map((r) => r.getAttribute("data-preset")))).toEqual(["flux2-klein-4b"]);
  await expect(picker.locator(".pk-blank")).toHaveCount(0);
  await expect(picker.locator(".pk-context")).toBeVisible();
});

test("a first send whose default settles to other files: the card keeps the box it was first drawn with, and the button names what ran", async ({ page, open }) => {
  await comfy.close();
  comfy = await fakeComfy();
  comfy.only(ZIMAGE_FILES); // Z-Image's files only, no FLUX
  comfy.gpu();
  comfy.unlisted(true); // ComfyUI is up but its file list has never been read
  await stack.reset("models", 0, undefined, "system", undefined, comfy.url);
  await open(); await waitReady(page);
  await imageGenOn(page);
  await page.getByRole("button", { name: "Image", exact: true }).click();
  await expect(page.locator("#modelBtn"), "never read: nothing named").toContainText("Image model");
  comfy.unlisted(false);
  // every size the card's box takes, from the first frame it is drawn
  await page.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { boxSeen: string[] }).boxSeen = seen;
    const look = () => {
      const box = document.querySelector<HTMLElement>("[data-image-job]");
      const rect = box?.getBoundingClientRect();
      const size = rect ? `${Math.round(rect.width)}x${Math.round(rect.height)}` : undefined;
      if (size !== undefined && seen.at(-1) !== size) seen.push(size);
    };
    new MutationObserver(look).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
  });
  await sendMessage(page, "a tree");
  const card = page.locator("[data-image-job]");
  await expect(card.getByRole("status", { name: /Making image/ })).toBeVisible();
  // the job settled to Z-Image 1024×1024 and runs it
  await expect.poll(() => comfy.prompts().length).toBe(1);
  expect(JSON.stringify(comfy.prompts()[0])).toContain("z_image_turbo_int8_convrot.safetensors");
  await expect(page.locator("#modelBtn"), "the button names what ran, without opening the picker").toContainText("Z-Image1024×1024");
  const size = async () => { const b = await card.boundingBox(); return b && { width: Math.round(b.width), height: Math.round(b.height) }; };
  const before = await size();
  expect(before && Math.abs(before.width / before.height - 1), "drawn square, the sent default's shape").toBeLessThan(0.02);
  comfy.finish();
  await expect(card.getByRole("img", { name: "Generated image" })).toBeVisible();
  expect(await size(), "the same box after the settle and when done").toEqual(before);
  expect(await page.evaluate(() => (window as unknown as { boxSeen: string[] }).boxSeen), "one size for the card's whole life").toHaveLength(1);
  await page.reload(); await waitReady(page);
  await expect(card.getByRole("img", { name: "Generated image" })).toBeVisible();
  expect(await size(), "and after a reload").toEqual(before);
});

test("Send with Image on: no chat request, one job with the words, preset and size, and the choice holds in a new thread and after a reload", async ({ page, open }, info) => {
  await stack.reset("models", 0, undefined, "system", undefined, comfy.url);
  await open(); await waitReady(page);
  const server = new URL(page.url()).searchParams.get("server");
  if (!server) throw new Error("No test server URL");
  const client = createClient(new WebSocket(server));
  try { await client.call("settings.update", { imageGen: true, imageChoice: { preset: "flux2-klein-4b", width: 1024, height: 768 } }); } finally { client.close(); }
  await page.reload(); await waitReady(page);
  const chats = (await state()).turns.length;
  await page.getByRole("button", { name: "Image", exact: true }).click();
  await expect(page.locator("#modelBtn")).toContainText("Klein 4B");
  await sendMessage(page, "a lighthouse at dusk");

  const card = page.locator("[data-image-job]");
  await expect(card.getByRole("status", { name: /Making image/ })).toBeVisible();
  await expect.poll(() => comfy.prompts().length).toBe(1);
  const graph = comfy.prompts()[0]!;
  const latent = Object.values(graph).find((n) => n.class_type === "EmptyFlux2LatentImage");
  expect(latent?.inputs).toMatchObject({ width: 1024, height: 768 });
  expect(JSON.stringify(graph)).toContain("a lighthouse at dusk");
  expect((await state()).turns.length, "no chat request").toBe(chats);

  // the turn is the question and the card: nothing of a chat reply
  const tl = page.locator(".tl");
  await expect(page.locator(".turn.u .bubble").last()).toHaveText("a lighthouse at dusk");
  await expect(tl.locator(".think, .writing, .wr")).toHaveCount(0);
  await expect(tl).not.toContainText(/tok\/s|tokens|Working/);
  await expect(page.getByRole("button", { name: "Stop", exact: true }), "a running image is the thread's running turn").toBeVisible();
  comfy.finish();
  await expect(card.getByRole("img", { name: "Generated image" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
  await expect(tl.locator(".think, .writing, .wr")).toHaveCount(0);
  await page.mouse.move(5, 5);
  await shot(page, "image-after-turn.png", info);
  expect((await state()).turns.length, "still no chat request").toBe(chats);

  await page.getByRole("button", { name: "New thread" }).click();
  await expect(page.locator("#modelBtn")).toContainText("Klein 4B");
  await expect(page.locator("#modelBtn")).toContainText("1024×768");
  await page.reload(); await waitReady(page);
  // Image itself is per session; the choice is the app's
  await page.getByRole("button", { name: "Image", exact: true }).click();
  await expect(page.locator("#modelBtn")).toContainText("Klein 4B");
  await expect(page.locator("#modelBtn")).toContainText("1024×768");
});

test("Stop on a running Image turn cancels its job", async ({ page, open }) => {
  await stack.reset("models", 0, undefined, "system", undefined, comfy.url);
  await open(); await waitReady(page);
  await imageGenOn(page);
  await page.getByRole("button", { name: "Image", exact: true }).click();
  await sendMessage(page, "a red kite");
  const card = page.locator("[data-image-job]");
  await expect(card.getByRole("status", { name: /Making image/ })).toBeVisible();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(card).toContainText("The image was cancelled");
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
});

test("Settings › Tools: Make images needs image generation, is on once a setup can run, and an off stays off", async ({ page, open }, info) => {
  await stack.reset("models", 0, undefined, "system", undefined, comfy.url);
  await open(); await waitReady(page);
  await page.keyboard.press("Control+Comma");
  await page.locator(".snav").getByRole("button", { name: "Tools", exact: true }).click();
  const make = page.getByRole("switch", { name: "Make images" });
  const row = page.locator('.srow[data-tool="images"]');
  await expect(make).toHaveAttribute("aria-checked", "false");
  await expect(make).toBeDisabled();
  await expect(row).toContainText("Needs Generate images, in Image generation.");
  await page.locator(".snav").getByRole("button", { name: "Image generation", exact: true }).click();
  await page.getByRole("switch", { name: "Generate images" }).click();
  await page.locator(".snav").getByRole("button", { name: "Tools", exact: true }).click();
  await expect(make).toBeEnabled();
  await expect(make, "Klein's files are listed: on with no click").toHaveAttribute("aria-checked", "true");
  await expect(row).toContainText("It can make a picture with the image model picked in the message box.");
  await make.click();
  await expect(make).toHaveAttribute("aria-checked", "false");
  await page.reload(); await waitReady(page);
  await page.keyboard.press("Control+Comma");
  await page.locator(".snav").getByRole("button", { name: "Tools", exact: true }).click();
  await expect(make, "switched off stays off").toHaveAttribute("aria-checked", "false");
  await make.click();
  await expect(make).toHaveAttribute("aria-checked", "true");
  await page.mouse.move(5, 5);
  await shot(page, "image-after-tools.png", info);
});
