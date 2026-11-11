// Image on in the composer: the model button names the image model and size where the chat
// model was (the same right edge, the width its name needs), its picker lists only what ComfyUI has every file for, Send goes straight
// to the image model (no chat request), and the choice is the app's: the same in a new thread
// and after a reload. Settings › Tools › Make images starts off.
import type { Page } from "@playwright/test";
import { createClient } from "@gates-local/contracts";
import { fakeComfy } from "./fake-comfy.ts";
import { expect, sendMessage, stack, test, waitReady } from "./fixtures.ts";
import { state } from "./threads-support.ts";

test.use({ video: process.env["GL_E2E_RECORD"] ? "on" : "off" });
let comfy: Awaited<ReturnType<typeof fakeComfy>>;
test.beforeEach(async () => { comfy = await fakeComfy(); comfy.withFlux(); });
test.afterEach(async () => { await comfy.close(); });

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
  await stack.reset("models", 0, undefined, "system", undefined, comfy.url);
  await open(); await waitReady(page);
  await imageGenOn(page);
  const button = page.locator("#modelBtn");
  const before = await boxes(page);
  await page.getByRole("button", { name: "Image", exact: true }).click();
  // unset: the first default ComfyUI has every file for, FLUX.2 Klein 4B at 1024x1024
  await expect(button).toContainText("Klein 4B");
  await expect(button).toContainText("1024×1024");
  expect(await boxes(page), "the Image pill and Send keep their boxes, the button its right edge").toEqual(before);
  await page.mouse.move(5, 5);
  await shot(page, "image-after-button.png", info, await composerClip(page));

  await button.click();
  const picker = page.locator("#imagePicker");
  await expect(picker).toBeVisible();
  await expect(picker.locator(".pk-r")).toHaveCount(3);
  expect(await picker.locator(".pk-r").evaluateAll((rows) => rows.map((r) => r.getAttribute("data-preset")))).toEqual(["flux2-klein-4b", "sdxl-lightning", "sdxl-lightning-pixel"]);
  await expect(picker.locator(".pk-rail"), "two families: the rail shows").toBeVisible();
  await expect(picker.locator("input"), "three rows need no search box").toHaveCount(0);
  await expect(picker.locator(".pk-r[data-tip], .pk-r [data-tip]"), "no row tooltips").toHaveCount(0);
  await expect(picker.locator(".pk-ctx-row")).toHaveCount(3);
  await shot(page, "image-after-picker.png", info);

  // a row picks that model at the size nearest the current one, as the chat picker picks a model
  await picker.locator('.pk-r[data-preset="sdxl-lightning-pixel"] .pk-select').click();
  await expect(picker).toBeHidden();
  await expect(button).toContainText("Pixel art");
  await expect(button).toContainText("1024×1024");
  // a size row picks that size
  await button.click();
  await expect(picker.locator(".pk-ctx-row")).toHaveCount(3);
  await picker.locator('.pk-ctx-row[data-size="512x768"]').click();
  await expect(picker).toBeHidden();
  await expect(button).toContainText("Pixel art");
  await expect(button).toContainText("512×768");
  expect(await boxes(page)).toEqual(before);

  // Image off: the chat model again, at the same right edge
  await page.getByRole("button", { name: "Image", exact: true }).click();
  await expect(button).not.toContainText("SDXL Lightning");
  expect(await boxes(page)).toEqual(before);
});

test("the picker lists only presets whose files ComfyUI reports", async ({ page, open }) => {
  await comfy.close();
  comfy = await fakeComfy(); // the SDXL files only, no FLUX
  await stack.reset("models", 0, undefined, "system", undefined, comfy.url);
  await open(); await waitReady(page);
  await imageGenOn(page);
  await page.getByRole("button", { name: "Image", exact: true }).click();
  // the default falls to plain SDXL without naming Klein; pixel art stays a pick, never the default
  await expect(page.locator("#modelBtn")).toContainText("Lightning768×512");
  await expect(page.locator("#modelBtn")).not.toContainText("pixel art");
  await expect(page.locator("#modelBtn")).not.toContainText("Klein");
  await page.locator("#modelBtn").click();
  const picker = page.locator("#imagePicker");
  await expect(picker.locator(".pk-r")).toHaveCount(2);
  expect(await picker.locator(".pk-r").evaluateAll((rows) => rows.map((r) => r.getAttribute("data-preset")))).toEqual(["sdxl-lightning", "sdxl-lightning-pixel"]);
  await expect(picker.locator(".pk-rail"), "one family: no rail").toHaveCount(0);
});

test("a first send whose default settles to other files: the card keeps the box it was first drawn with, and the button names what ran", async ({ page, open }) => {
  await comfy.close();
  comfy = await fakeComfy(); // the SDXL files only, no FLUX
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
  await expect(card).toContainText("Making image");
  // the job settled to SDXL 768×512 and runs it
  await expect.poll(() => comfy.prompts().length).toBe(1);
  expect(Object.values(comfy.prompts()[0]!).map((n) => n.class_type)).toContain("CheckpointLoaderSimple");
  await expect(page.locator("#modelBtn"), "the button names what ran, without opening the picker").toContainText("Lightning768×512");
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
  await expect(card).toContainText("Making image");
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
  await expect(card).toContainText("Making image");
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(card).toContainText("The image was cancelled");
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
});

test("Settings › Tools: Make images starts off and needs image generation", async ({ page, open }, info) => {
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
  await expect(make).toHaveAttribute("aria-checked", "false");
  await expect(row).toContainText("It can make a picture with the image model picked in the message box.");
  await make.click();
  await expect(make).toHaveAttribute("aria-checked", "true");
  await page.mouse.move(5, 5);
  await shot(page, "image-after-tools.png", info);
});
