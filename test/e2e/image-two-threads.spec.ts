// Diagnostic journey: thread-local intent, actual workflow graphs, retry and FIFO admission.
// The fake proves ordering and model routing, not real weight loading or VRAM use.
import { createClient, type ImageChoice } from "@gates-local/contracts";
import type { Locator, Page } from "@playwright/test";
import { fakeComfy } from "./fake-comfy.ts";
import { expect, sendMessage, stack, test, waitReady } from "./fixtures.ts";

test.use({ video: process.env["GL_E2E_RECORD"] ? "on" : "off" });

const X: ImageChoice = { preset: "z-image-int8", width: 1024, height: 1024 };
const Y: ImageChoice = { preset: "flux2-klein-4b", width: 1024, height: 1024 };
const red = process.env["GL_IMAGE_TWO_THREADS_RED"] === "1";

/** Picks a setup's row in the open image picker, on whichever menu (Defaults or Other models) lists it. */
async function pickRow(page: Page, preset: string) {
  const row = page.locator(`#imagePicker .pk-r[data-preset="${preset}"]`);
  // `has` is matched inside each menu, so its selector is relative to the menu
  const menu = await page.locator("#imagePicker .pk-menu", { has: page.locator(`.pk-r[data-preset="${preset}"]`) }).getAttribute("aria-label");
  await page.locator("#imagePicker .pk-rail").getByRole("button", { name: menu ?? "" }).click();
  await row.locator(".pk-select").click();
}

test("A sends the default without a pick, then B picks: A's next send runs what A ran", async ({ page, open }, info) => {
  test.setTimeout(60_000);
  info.annotations.push({ type: "budget", description: "Three fake image jobs across two threads, each finished by hand." });
  const comfy = await fakeComfy();
  comfy.withApp();
  comfy.gpu();
  const button = page.locator("#modelBtn");
  const cards = page.locator("[data-image-job]");
  const weights = (index: number) => {
    const nodes = Object.values(comfy.prompts()[index]!);
    return nodes.find(n => n.class_type === "UNETLoader")?.inputs["unet_name"] ?? nodes.find(n => n.class_type === "CheckpointLoaderSimple")?.inputs["ckpt_name"];
  };
  const run = async (index: number) => {
    await expect.poll(() => comfy.state().length).toBe(index + 1);
    comfy.finish(comfy.state()[index]!.id);
    await expect(cards.last()).toHaveAttribute("data-image-job", "done");
  };
  try {
    await stack.reset("models", 0, undefined, "system", undefined, comfy.url);
    await open(); await waitReady(page);
    await page.keyboard.press("Control+Comma");
    await page.getByTestId("settings.nav.open-images").click();
    await page.getByTestId("settings.images.enable").click();
    await page.keyboard.press("Escape");
    await page.getByTestId("chat.composer.image").click();
    // A: nothing picked anywhere, so the composer sends the default it shows (General's style setup, on Klein's weights)
    await expect(button).toContainText("General");
    await sendMessage(page, "IR320 A default");
    await run(0);
    expect(weights(0)).toBe("flux-2-klein-4b-fp8.safetensors");
    // B picks Z-Image and sends
    await page.getByTestId("sidebar.top.new-thread").click();
    await button.click();
    await pickRow(page, X.preset);
    await expect(button).toContainText("Z-Image");
    await sendMessage(page, "IR320 B picks Z-Image");
    await run(1);
    // back in A: the composer and the next send are still General's setup
    await page.locator(".sb-row", { hasText: "IR320 A default" }).click();
    await expect(cards).toHaveCount(1);
    await expect(button).toContainText("General");
    await page.screenshot({ path: info.outputPath("a-after-b-picks.png"), animations: "disabled" });
    await sendMessage(page, "IR320 A again");
    await run(2);
    expect(weights(2), "A's next send loads Klein, not B's Z-Image").toBe("flux-2-klein-4b-fp8.safetensors");
  } finally {
    await comfy.close();
  }
});

test("two threads: sequential models, an impatient send, and a retry keep their identity", async ({ page, open }, info) => {
  test.setTimeout(90_000);
  info.annotations.push({ type: "budget", description: "One dependent journey holds six fake image jobs and checks a failed job's retry across two threads." });
  const comfy = await fakeComfy();
  comfy.withApp();
  comfy.gpu(); // Only the stack's fake nvidia-smi is read.
  const observations: Record<string, unknown> = {};
  // Opt-in mutation run makes every routing/order/completion assertion wrong while
  // retaining the real preconditions, so one run watches all diagnostic checks fail.
  function check(actual: unknown, expected: unknown, wrong: unknown, label: string) {
    observations[label] = actual;
    if (red) expect.soft(actual, `RED ${label}`).toEqual(wrong);
    else expect(actual, label).toEqual(expected);
  }
  const button = page.locator("#modelBtn");
  const cards = page.locator("[data-image-job]");
  const shot = async (name: string) => {
    await cards.last().scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`${name}.png`), animations: "disabled" });
  };
  const pick = async (choice: ImageChoice, name: string) => {
    await button.click();
    await pickRow(page, choice.preset);
    await expect(page.locator("#imagePicker")).toBeHidden();
    await expect(button).toContainText(name);
    await expect(button).toContainText("1024×1024");
  };
  const started = async (count: number) => {
    await expect.poll(() => comfy.state().length).toBe(count);
    return comfy.state()[count - 1]!;
  };
  const finished = async (card: Locator, index: number) => {
    const run = comfy.state()[index];
    if (!run) throw new Error("No fake prompt to finish");
    comfy.finish(run.id);
    await expect(card).toHaveAttribute("data-image-job", "done");
    // Images are lazy: a visible DOM box below the viewport has not loaded yet.
    await card.scrollIntoViewIfNeeded();
    await expect(card.getByRole("img", { name: "Generated image" })).toBeVisible();
    await expect.poll(() => card.getByRole("img").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
    check(await card.getAttribute("data-image-job"), "done", "error", `job ${index + 1} completed`);
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
  };
  const graph = (index: number, preset: string) => {
    const nodes = Object.values(comfy.prompts()[index]!);
    const actual = nodes.find(n => n.class_type === "CheckpointLoaderSimple")?.inputs["ckpt_name"]
      ?? nodes.find(n => n.class_type === "UNETLoader")?.inputs["unet_name"];
    const x = "z_image_turbo_int8_convrot.safetensors", y = "flux-2-klein-4b-fp8.safetensors";
    check(actual, preset === X.preset ? x : y, preset === X.preset ? y : x, `job ${index + 1} workflow weights`);
    check(nodes.some(n => n.class_type === "LoraLoader"), false, true, `job ${index + 1} has no unpicked LoRA`);
  };
  let client: ReturnType<typeof createClient> | undefined;
  try {
    await stack.reset("models", 0, undefined, "system", undefined, comfy.url);
    await open(); await waitReady(page);
    const server = new URL(page.url()).searchParams.get("server");
    if (!server) throw new Error("No test server");
    client = createClient(new WebSocket(server));
    await page.keyboard.press("Control+Comma");
    await page.getByTestId("settings.nav.open-images").click();
    await page.getByTestId("settings.images.enable").click();
    await page.keyboard.press("Escape");
    await page.getByTestId("chat.composer.image").click();

    await test.step("A makes Z-Image, then B makes FLUX after A releases the GPU", async () => {
      await pick(X, "Z-Image");
      await sendMessage(page, "IPT A lighthouse");
      await started(1);
      graph(0, X.preset);
      await finished(cards.first(), 0);
      observations["A initial composer"] = await button.innerText();
      observations["A initial card words"] = await cards.first().innerText();
      await shot("a-initial-card-composer");
      await page.getByTestId("sidebar.top.new-thread").click();
      await pick(Y, "Klein 4B");
      await sendMessage(page, "IPT B mountains");
      await started(2);
      graph(1, Y.preset);
      check(comfy.state()[1]!.startedAt >= comfy.state()[0]!.endedAt!, true, false, "sequential B starts after A ends");
      await finished(cards.first(), 1);
      observations["B composer"] = await button.innerText();
      observations["B initial card words"] = await cards.first().innerText();
      await shot("b-initial-card-composer");
    });

    let aAfterB = "", aLater: ImageChoice | undefined;
    let aLaterWeights: unknown;
    await test.step("return to A and send again without choosing another model", async () => {
      await page.locator(".sb-row", { hasText: "IPT A lighthouse" }).click();
      await expect(cards).toHaveCount(1);
      aAfterB = await button.innerText();
      observations["A composer after B's pick"] = aAfterB;
      await shot("a-after-b-switch");
      await sendMessage(page, "IPT A later without repicking");
      await started(3);
      aLaterWeights = Object.values(comfy.prompts()[2]!).find(n => n.class_type === "UNETLoader")?.inputs["unet_name"]
        ?? Object.values(comfy.prompts()[2]!).find(n => n.class_type === "CheckpointLoaderSimple")?.inputs["ckpt_name"];
      await finished(cards.last(), 2);
      const threadId = new URLSearchParams(new URL(page.url()).hash.slice(1)).get("thread");
      if (!threadId) throw new Error("No A thread");
      aLater = (await client!.call("threads.get", { threadId })).messages.findLast(m => m.imageJob)?.imageJob?.choice;
      observations["A later saved choice"] = aLater;
      observations["A later workflow weights"] = aLaterWeights;
      await shot("a-later-card-composer");
    });

    await test.step("A's failed Z-Image retries Z-Image while the composer says FLUX; B queues behind it", async () => {
      await pick(X, "Z-Image");
      comfy.missing();
      await sendMessage(page, "IPT A failed Z-Image");
      const retryCard = cards.last();
      await expect(retryCard).toHaveAttribute("data-image-job", "error");
      await expect(retryCard).toContainText("z_image_turbo_int8_convrot.safetensors");
      check(comfy.state().length, 3, 4, "missing Z-Image submits no workflow");
      await shot("a-failed-zimage");
      comfy.restore(false);
      await page.locator(".sb-row", { hasText: "IPT B mountains" }).click();
      await pick(Y, "Klein 4B");
      await page.locator(".sb-row", { hasText: "IPT A lighthouse" }).click();
      await expect(retryCard.getByRole("button", { name: "Try again" })).toBeVisible();
      await retryCard.getByRole("button", { name: "Try again" }).click();
      await started(4);
      graph(3, X.preset);
      observations["A composer during retry"] = await button.innerText();
      await shot("a-retry-zimage-composer-flux");
      await page.locator(".sb-row", { hasText: "IPT B mountains" }).click();
      await sendMessage(page, "IPT B impatient FLUX");
      await expect(cards.last()).toContainText("Waiting for the GPU");
      check(await cards.last().getAttribute("data-image-job"), "queued", "running", "impatient B is queued");
      check(comfy.state().length, 4, 5, "queued B has not submitted to ComfyUI");
      check(comfy.state()[3]?.endedAt === undefined, true, false, "A is still running while B waits");
      await shot("b-waiting-for-a");
      comfy.finish(comfy.state()[3]!.id);
      await started(5);
      graph(4, Y.preset);
      check(comfy.state()[4]!.startedAt >= comfy.state()[3]!.endedAt!, true, false, "impatient B starts after retry A ends");
      check(comfy.state()[4]?.endedAt === undefined, true, false, "finishing A does not finish B in the fake");
      await finished(cards.last(), 4);
      await shot("b-impatient-done");
      await page.locator(".sb-row", { hasText: "IPT A lighthouse" }).click();
      await expect(cards.last()).toHaveAttribute("data-image-job", "done");
      const threadId = new URLSearchParams(new URL(page.url()).hash.slice(1)).get("thread");
      if (!threadId) throw new Error("No A thread");
      const attempts = (await client!.call("threads.get", { threadId })).messages.filter(m => m.imageJob);
      check(attempts.at(-1)?.imageJob?.choice, X, Y, "retry persisted original X");
      check(attempts.at(-1)?.imageJob?.state, "done", "error", "retry A completed");
      check(attempts.at(-2)?.imageJob?.retryJobId, attempts.at(-1)?.id, "wrong-job", "retry links to the failed card");
      await shot("a-retry-done-composer-flux");
      await page.locator(".sb-row", { hasText: "IPT B mountains" }).click();
      await sendMessage(page, "IPT B later without repicking");
      await started(6);
      graph(5, Y.preset);
      await finished(cards.last(), 5);
      await shot("b-later-card-composer");
    });

    observations["runs"] = comfy.state();
    await info.attach("observations", { body: JSON.stringify(observations, null, 2), contentType: "application/json" });
    // IPT-01 (each thread keeps its model) and IPT-02 (each card names its model), after the runtime checks.
    expect(aAfterB, "IPT-01 A retains its own composer choice after B picks FLUX").toContain("Z-Image");
    expect(aLater, "IPT-01 A's later send retains Z-Image").toEqual(X);
    expect(aLaterWeights, "IPT-01 A's later workflow loads Z-Image weights").toEqual("z_image_turbo_int8_convrot.safetensors");
    expect(observations["A initial card words"], "IPT-02 A card names its actual model").toContain("Z-Image Turbo int8");
    expect(observations["B initial card words"], "IPT-02 B card names its actual model").toContain("FLUX.2 Klein 4B");
  } finally {
    client?.close();
    await comfy.close();
  }
});
