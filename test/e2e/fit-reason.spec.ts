// The owner 2026-11-14: a model the card holds ran slowly because other programs held part of the
// card, and nothing said so. When the card fits a model and right now it spills, the model row, the
// picker's context chip and Settings › Advanced say what is in the way, biggest first with its
// size, in the words of the GPU memory panel: the short form on the row, the sentence one step
// away (a tip, or Details). The rows keep the card's verdict; Settings shows one verdict, "slower
// now" in place of it. Nothing offers to stop another program.
import type { Page, TestInfo } from "@playwright/test";
import { decodeRequest } from "@gates-local/contracts";
import { expect, listButton, openModels, stack, test, waitReady } from "./fixtures.ts";

// An 11 GiB card: Whisper (2.1 GB) and a vision runtime (1.8 GB) stay on it (test/fake-ollama/nvidia-smi.ts),
// so Qwen 3.5 9B at 16k fits the card and right now part of it goes to system memory.
const CARD_MIB = 11 * 1024;
const PHONE = { viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true };
const SHORT = /^Slower now · Whisper in the way$/;
// sizes keep their unit on the line: a no-break space before GB
// nothing is loaded here, so the spill is a prediction: said as one, with ~ (council climb-025 Q12)
// each holder named as the memory rows name it, never folded into "others" (council climb-025 Q12)
const SENTENCE = /^Fits this card with Whisper \(2\.\d\sGB\) and Media Vault vision \(1\.8\sGB\) off it\. Would use ~\d\.\d\sGB of system memory\.$/;

/** In the test body, after the fixtures' own reset of the backend. */
async function smallCard(): Promise<void> {
  await stack.scenario("models", { installed: ["qwen3.5:9b", "gemma4:12b"] });
  await stack.gpu(0, CARD_MIB);
}

/** Rings this change's parts; before a hover, since a change to the anchor closes its tip. */
const outline = (page: Page) =>
  page.evaluate(() => {
    for (const el of document.querySelectorAll<HTMLElement>('[data-testid$="slow-now"], [data-testid$="slow-line"]')) el.style.setProperty("outline", "2px solid #f5a524");
  });

/**
 * The picture now, and the picture without the row's and the picker's reason. Settings' sentence
 * stays: a page with the chip and no sentence never existed, and drawing one read as a contradiction.
 */
async function shots(page: Page, info: TestInfo, name: string, outlined = false): Promise<void> {
  if (!outlined) await outline(page);
  await page.screenshot({ path: info.outputPath(`${name}-after.png`), animations: "disabled" });
  await page.evaluate(() => {
    for (const el of document.querySelectorAll<HTMLElement>(".mm-why")) el.remove();
    for (const el of document.querySelectorAll<HTMLElement>('[data-testid="models.picker.slow-now"]')) {
      el.querySelector("small > span")?.remove();
      el.style.removeProperty("outline");
    }
    document.getElementById("tip")?.style.setProperty("display", "none");
  });
  await page.screenshot({ path: info.outputPath(`${name}-before.png`), animations: "disabled" });
  await page.evaluate(() => document.getElementById("tip")?.style.removeProperty("display"));
}

async function modelRow(page: Page, info: TestInfo, name: string): Promise<void> {
  await openModels(page);
  const row = page.locator('.mp-card .mp-row[data-dm="qwen3.5:9b"]');
  const why = row.getByTestId("models.fit.slow-now");
  await expect(why).toHaveText(new RegExp(`^${SHORT.source.slice(1, -1)}\\. ${SENTENCE.source.slice(1, -1)}$`), { timeout: 15_000 });
  await expect(why.locator("span:not(.vh)")).toHaveText(SHORT);
  // the verdict is the card's: the mark says it runs well on the GPU
  await expect(row.locator(".mm:visible")).toHaveClass(/\bgpu\b/);
  await expect(row.locator(".mm:visible")).toHaveAttribute("aria-label", /^Should run well: /);
  // too big for the card is not "in the way": Gemma at 16k has no reason line
  await expect(page.locator('.mp-card .mp-row[data-dm="gemma4:12b"]').getByTestId("models.fit.slow-now")).toHaveCount(0);
  // what is in the way is information: no control here stops another program
  await expect(row.getByRole("button", { name: /stop|quit|whisper/i })).toHaveCount(0);
  await shots(page, info, name);
}

test("a model the card holds says what is in the way on its row, its picker chip and Settings", async ({ page, open }, info) => {
  await smallCard();
  await open();
  await waitReady(page);
  await modelRow(page, info, "model-row-desktop");
  await page.keyboard.press("Escape");

  // Settings shows the chat's model, Qwen 3.5 9B at 16k (picking in the picker would load it, and then it fits)
  await page.keyboard.press("Control+Comma");
  await page.getByTestId("settings.nav.open-advanced").click();
  const gpu = page.locator(".set #gpuMemory");
  // one verdict on the card: "slower now" stands in for "Should run well at 16k" while something is in the way
  await expect(gpu.locator(".fp-v")).toHaveText(SHORT);
  await expect(gpu.locator(".fp-v")).toHaveAttribute("data-testid", "models.fit-panel.slow-line");
  await expect(gpu).not.toContainText("Should run well");
  await gpu.getByTestId("models.fit-panel.details").click();
  await expect(gpu.getByTestId("models.fit-panel.slow-now")).toHaveText(SENTENCE);
  await shots(page, info, "fit-panel-desktop");
  await page.keyboard.press("Escape");

  await page.locator("#modelBtn").click();
  await page.locator('#picker .pk-r[data-m="qwen3.5:9b"]').hover();
  const chip = page.locator('#picker [data-ctx="16384"]').getByTestId("models.picker.slow-now");
  await expect(chip).toBeVisible();
  // one verdict: the chip says what its tip, the Models row and Settings say; the tip names who
  await expect(chip.locator("small")).toHaveText("Slower now");
  await expect(chip).toHaveAttribute("aria-label", /; Slower now\. Fits this card with Whisper/);
  await outline(page);
  await chip.hover();
  await expect(page.locator("#tip.open")).toHaveText("Whisper in the way");
  await expect(page.locator("#tip")).toBeVisible();
  await shots(page, info, "picker-desktop", true);
});

test.describe("on a phone", () => {
  test.use(PHONE);

  test("the row, the picker's context step and Settings say what is in the way", async ({ page, open }, info) => {
    await smallCard();
    await open();
    await waitReady(page);
    await modelRow(page, info, "model-row-phone");
    await page.getByTestId("settings.shell.back").tap();
    await listButton(page, "Advanced").tap();
    const gpu = page.locator(".set #gpuMemory");
    await expect(gpu.getByTestId("models.fit-panel.slow-line")).toHaveText(SHORT);
    await gpu.getByTestId("models.fit-panel.details").tap();
    await expect(gpu.getByTestId("models.fit-panel.slow-now")).toHaveText(SENTENCE);
    await shots(page, info, "fit-panel-phone");
    await page.getByTestId("settings.shell.back").tap();
    await page.getByTestId("settings.shell.done").tap();

    await page.locator("#modelBtn").tap();
    await page.locator('#picker .pk-r[data-m="qwen3.5:9b"]').tap();
    await expect(page.locator("#picker .pk-context")).toBeVisible();
    const chip = page.locator('#picker [data-ctx="16384"]').getByTestId("models.picker.slow-now");
    await expect(chip).toBeVisible();
    await expect(chip).toHaveAttribute("aria-label", /; Slower now\. Fits this card with Whisper/);
    await shots(page, info, "picker-phone");
  });
});

test.describe("a send refused for memory", () => {
  // no image engine answers here
  test.use({ comfyUrl: "http://127.0.0.1:9" });

  // Guards a refused send saying why and leading to the fix.
  test("a send refused for memory says why and its click opens Settings > Advanced", async ({ page, open }) => {
    // The fake's 500-request history rolls over during a full suite. Observe
    // this client's sends directly, including requests the server would reject.
    let sends = 0;
    page.on("websocket", socket => socket.on("framesent", frame => {
      const request = decodeRequest(frame.payload);
      if (request.ok && request.value.method === "reply.send") sends++;
    }));
    // An 8 GB computer: 5 GiB of spill, and Gemma 4 12B at 64k needs about 18.6 GiB by the server's
    // estimate. Beside the whole card (15.4 GiB) it spills; beside what the card has free now (11.5,
    // after the fake's resident programs) it won't fit. On the fixture's 32 GB both run.
    await stack.computer(8);
    await open();
    await waitReady(page);
    await page.locator("#modelBtn").click();
    await page.locator("#pkSearch").fill("gemma");
    await page.locator('#picker .pk-r[data-m="gemma4:12b"]').click();
    await expect(page.locator("#modelBtn")).toContainText("Gemma 4 12B");
    // context is chosen in the picker only (decision 13)
    await page.locator("#modelBtn").click();
    await page.locator('#picker [data-ctx="65536"]').click();
    await expect(page.locator("#picker")).toBeHidden();
    await page.keyboard.press("Control+Comma");
    await page.getByTestId("settings.nav.open-advanced").click();
    // Settings judges the card's own memory, where it spills; Send judges right now, where it won't fit
    await expect(page.locator(".set .fp-v")).toContainText("Should run slower");
    await page.keyboard.press("Escape");
    await page.locator("#ta").fill("Too big?");
    const sendBtn = page.getByTestId("chat.composer.send");
    await expect(sendBtn).toHaveAttribute("data-tip", "Not enough memory at 64k");
    await sendBtn.hover();
    await expect(page.locator("#tip")).toContainText("Not enough memory at 64k");
    const before = sends;
    await sendBtn.dispatchEvent("click");
    await expect(page.locator(".set").getByRole("heading", { name: "Advanced" })).toBeVisible();
    await expect(page.locator("#gpuMemory")).toContainText("Gemma 4 12B");
    // the click opened the why; nothing was sent
    expect(sends).toBe(before);
  });
});
