/// <reference lib="dom" />
// Broad diagnostic survey. Purposeful navigation, disclosure and streaming
// changes are reported for review rather than called flicker by a text diff.
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { CHECKOUT_CACHE } from "./env.ts";
import { burst, delayedMemory, transitionMetrics } from "./flicker-probe.ts";
import { expect, test, waitReady } from "./fixtures.ts";

test.use({ seed: "design", video: "on", comfyUrl: "http://127.0.0.1:1" });

for (const delay of [0, 150, 600]) {
  test(`flicker audit Settings at ${delay} ms`, async ({ page, open }) => {
    test.setTimeout(240_000);
    await delayedMemory(page, delay);
    await open();
    await waitReady(page);
    const measure = survey(page, delay);
    await measure("settings-open", ".set", () => page.keyboard.press("Control+Comma"));
    const section = async (name: string) => measure(`section-${name}`, ".set", () => page.locator(".snav").getByRole("button", { name, exact: true }).click());
    await section("General");
    for (const name of ["Light", "System", "Dark"]) await measure(`theme-${name}`, ".set", () => page.getByRole("group", { name: "Theme" }).getByRole("button", { name, exact: true }).click());
    for (const name of ["Large", "Small", "Default"]) await measure(`text-${name}`, ".set", () => page.getByRole("group", { name: "Text size" }).getByRole("button", { name, exact: true }).click());
    const updates = page.getByRole("button", { name: "Check for updates", exact: true });
    if (await updates.count()) await measure("updates-check", ".set", () => updates.click());
    const every = page.getByRole("switch", { name: "Get every change, not only releases" });
    if (await every.count()) for (const name of ["on", "off"]) await measure(`updates-every-${name}`, ".set", () => every.click());
    await section("Tools");
    for (const name of ["off", "on"]) await measure(`tools-${name}`, ".set", () => page.getByRole("switch", { name: "Let the model use tools" }).click());
    await section("Image generation");
    await measure("images-on", ".set", () => page.getByRole("switch", { name: "Generate images" }).click());
    // A deliberately unavailable test endpoint, outside every real service port.
    const address = page.getByRole("textbox", { name: "ComfyUI address" });
    await measure("image-address", ".set", async () => { await address.fill("http://127.0.0.1:1"); await address.press("Tab"); });
    await measure("image-test", ".set", () => page.getByRole("button", { name: "Test", exact: true }).click());
    await measure("images-off", ".set", () => page.getByRole("switch", { name: "Generate images" }).click());
    await section("Library");
    const folder = path.join(CHECKOUT_CACHE, "flicker-library");
    mkdirSync(folder, { recursive: true });
    await measure("library-add-open", ".set", () => page.getByRole("button", { name: "Add folder…" }).click());
    await page.getByRole("textbox", { name: "Add a folder path" }).fill(folder);
    await measure("library-add", ".set", () => page.getByRole("button", { name: "Add", exact: true }).click());
    await measure("library-menu", ".set", () => page.getByRole("button", { name: "More for flicker-library" }).click());
    await page.keyboard.press("Escape");
    await section("Runtime");
    const change = page.getByRole("button", { name: /Use .*Ollama…/ });
    if (await change.count()) {
      await measure("runtime-confirm", ".set", () => change.click());
      await measure("runtime-cancel", ".set", () => page.getByRole("button", { name: "Cancel", exact: true }).click());
    }
    await section("Advanced");
    await expect(page.locator("#gpuMemory .fp-v")).toBeVisible();
    await measure("gpu-details", "#gpuMemory", () => page.locator("#gpuMemory summary").click());
    for (const ctx of [8192, 16384, 32768, 65536]) {
      await measure(`gpu-pick-${ctx}`, "#gpuMemory", () => page.locator(`#gpuMemory [data-ctx="${ctx}"]`).click());
    }
    await page.locator('#gpuMemory [data-ctx="16384"]').click();
    await measure("reset-open", ".set", () => page.getByRole("button", { name: "Reset…" }).click());
    await measure("reset-cancel", ".set", () => page.getByRole("button", { name: "Cancel", exact: true }).click());
    await section("Shortcuts");
    await section("Models");
    await expect(page.locator(".mp-row").first()).toBeVisible();
    await measure("models-download", ".set", () => page.getByRole("tab", { name: /Download/ }).click());
    await measure("models-installed", ".set", () => page.getByRole("tab", { name: /Installed/ }).click());
    const filter = page.getByRole("textbox", { name: "Filter installed models" });
    if (await filter.count()) {
      await measure("models-filter", ".set", () => filter.fill("gemma"));
      await filter.fill("");
    }
    await measure("default-open", ".set", () => page.getByRole("button", { name: /^Default for new chats:/ }).click());
    await measure("default-pick", ".set", () => page.getByRole("listbox", { name: "Installed chat models" }).getByRole("option").filter({ hasText: "Gemma" }).click());
    await measure("models-menu", ".set", () => page.getByRole("button", { name: /^More for / }).first().click());
  });

  test(`flicker audit chat and popovers at ${delay} ms`, async ({ page, open, seededThread }) => {
    test.setTimeout(180_000);
    await delayedMemory(page, delay);
    await open(`#thread=${seededThread ?? ""}`);
    await waitReady(page);
    const measure = survey(page, delay);
    await measure("picker-open", "#picker", () => page.locator("#modelBtn").click());
    await measure("picker-search", "#picker", () => page.locator("#pkSearch").fill("gemma"));
    await measure("picker-search-clear", "#picker", () => page.locator("#pkSearch").fill(""));
    for (const ctx of [8192, 16384, 32768]) await measure(`picker-context-${ctx}`, "#picker", () => page.locator(`#picker [data-ctx="${ctx}"]`).click());
    await measure("composer-model-load", ".composer", () => page.locator('#picker .pk-r[data-m="gemma4:12b"]').click());
    await measure("picker-reopen", "#picker", () => page.locator("#modelBtn").click());
    await measure("picker-close", "#picker", () => page.keyboard.press("Escape"));
    await page.locator("#modelBtn").click();
    await page.locator('#picker .pk-r[data-m="qwen3.5:9b"]').click();
    for (const [name, opener, target] of [["plus", "#plusBtn", "#plusMenu"], ["options", "#optBtn", "#optsMenu"], ["more", "#moreBtn", "#moreMenu"]] as const) {
      if (!(await page.locator(opener).isVisible())) continue;
      await measure(`popover-${name}`, target, () => page.locator(opener).click());
      await page.keyboard.press("Escape");
    }
    await measure("sidebar-thread", ".stage", () => page.locator(".sb-row").filter({ hasText: "Fix the backup cron" }).click());
    await measure("sidebar-context-menu", "#moreMenu", () => page.locator(".sb-row").filter({ hasText: "Whisper latency check" }).click({ button: "right" }));
    await page.keyboard.press("Escape");
    await measure("new-thread", ".stage", () => page.keyboard.press("Control+n"));
  });
}

function survey(page: Page, delay: number) {
  return async (name: string, selector: string, action: () => Promise<unknown>) => {
    const frames = await burst(page, `audit-${delay}/${name}`, selector, action);
    console.log(`FLICKER_AUDIT ${delay} ${name} ${JSON.stringify(transitionMetrics(frames))}`);
    expect(frames.length, "animation-frame probe is live").toBeGreaterThan(10);
  };
}
