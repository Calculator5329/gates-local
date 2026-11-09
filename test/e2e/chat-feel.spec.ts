/// <reference lib="dom" />
// Journeys for the chat's feel: steady streaming, the code block's copy
// button, the thinking disclosure and composer pill, the runtime row only when
// the runtime needs the user, the context size inside the model picker, and
// GPU memory under Settings > Advanced.
import { DRIP_REPLY } from "../fake-ollama/fake-ollama.ts";
import { FAKE_URL } from "./env.ts";
import { blockPrefix, type BlockSnap } from "./block-prefix.ts";
import { expect, sendMessage, stack, test, waitReady } from "./fixtures.ts";

// Enabling the Image pill must never probe a real image service.
const unavailableImage = new URL(FAKE_URL);
unavailableImage.port = "9";
test.use({ comfyUrl: unavailableImage.origin, video: "on", screenshot: "only-on-failure" });

/** Records the last reply's blocks on every DOM change. */
function sampleReplies(): void {
  const w = window as unknown as { glSamples: BlockSnap[][] };
  w.glSamples = [];
  const snap = () => {
    const md = [...document.querySelectorAll(".turn.a .md")].at(-1);
    if (!md) return;
    w.glSamples.push(
      [...md.children].map((c) => ({ tag: c.tagName, text: c.textContent ?? "" })),
    );
  };
  new MutationObserver(snap).observe(document, { subtree: true, childList: true, characterData: true });
}

test("a streaming reply grows through partial blocks, then the whole answer", async ({ page, open }) => {
  await page.addInitScript(sampleReplies);
  await open();
  await waitReady(page);
  await stack.scenario("slow-drip");
  await sendMessage(page, "How do I check disk space before a download?");
  const reply = page.locator(".turn.a").last();
  await expect(reply).toHaveClass(/\bdone\b/, { timeout: 15_000 });
  await expect(reply.locator(".md table")).toBeVisible();

  const samples = await page.evaluate(() => (window as unknown as { glSamples: BlockSnap[][] }).glSamples);
  const final = samples.at(-1) ?? [];
  // Prose appears before its paragraph completes; finished blocks stay put.
  expect(samples.filter((s) => s.length > 0 && s.length < final.length).length).toBeGreaterThan(2);
  expect(samples.filter((s) => s[0]?.tag === "P" && s[0].text.length > 0 && s[0].text.length < (final[0]?.text.length ?? 0)).length).toBeGreaterThan(2);
  for (const s of samples) expect(blockPrefix(s, final), JSON.stringify(s.at(-1))).toBe(true);
  expect(final.map((b) => b.tag)).toEqual(["P", "H2", "UL", "DIV", "TABLE", "P"]);
  // the final text is the whole answer: every word of the reply, in order
  const words = DRIP_REPLY.split(/\s+/).filter((w) => w !== "" && !/^(#+|-|```\w*|\||---)$/.test(w));
  const finalText = final.map((b) => b.text).join(" ");
  let from = 0;
  for (const w of words) {
    const at = finalText.indexOf(w, from);
    expect(at, `"${w}" in the final reply`).toBeGreaterThanOrEqual(0);
    from = at + w.length;
  }
});

test("a paused delivery keeps Writing below the visible partial code block", async ({ page, open }) => {
  await open();
  await waitReady(page);
  // the fake stops inside the code block: paragraph, heading and list are finished
  await stack.scenario("slow-drip", { holdAfterTokens: 46 });
  await sendMessage(page, "How do I check disk space before a download?");
  const reply = page.locator(".turn.a").last();
  await expect(reply.locator(".md ul li")).toHaveCount(3);
  await page.waitForTimeout(300);
  await expect(reply.locator(".md")).toContainText("df -h");
  await expect(reply.locator(".writing")).toHaveText("Writing");
  const [md, writing] = [await reply.locator(".md").boundingBox(), await reply.locator(".writing").boundingBox()];
  expect(writing?.y ?? 0).toBeGreaterThanOrEqual((md?.y ?? 0) + (md?.height ?? 0) - 0.5);
  await page.getByRole("button", { name: "Stop" }).click();
  // stopping shows all the text there is, the half code block included
  await expect(reply.locator(".md")).toContainText("du -sh");
  await expect(reply.locator(".writing")).toHaveCount(0);
});

test.describe("code blocks", () => {
  test.use({ seed: 2, permissions: ["clipboard-read", "clipboard-write"] });

  test("a code block's own copy button puts the exact code on the clipboard", async ({ page, open, seededThread }) => {
    await open(`#thread=${seededThread ?? ""}`);
    await waitReady(page);
    const reply = page.locator(".turn.a").last();
    // one button per fenced block; inline code spans get none
    await expect(reply.locator(".md li code").filter({ hasText: "PATH" })).toBeVisible();
    await expect(reply.getByRole("button", { name: "Copy code" })).toHaveCount(1);
    const block = reply.locator(".md .cb");
    await expect(block.locator(".cb-lang")).toHaveText("sh");
    const copy = block.getByRole("button", { name: "Copy code" });
    await expect(copy).toHaveCSS("opacity", "0");
    await block.hover();
    await expect(copy).toHaveCSS("opacity", "1");
    await copy.click();
    await expect(copy).toHaveText("Copied");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("PATH=/usr/local/bin:/usr/bin:/bin");
    // "Copied" for about 1.5 s, then the plain icon again
    await expect(copy).toHaveText("", { timeout: 3000 });
    // the reply's own hover row is unchanged: copy, regenerate, meta
    await reply.locator(".md p").first().hover();
    await expect(reply.locator(".a-act [data-copy]")).toBeVisible();
    await expect(reply.locator(".a-act [data-regen]")).toBeVisible();
  });
});

test("a finished thinking row keeps its label and chevron at rest", async ({ page, open }, info) => {
  await open();
  await waitReady(page);
  await sendMessage(page, "Tell me about cron");
  const reply = page.locator(".turn.a").last();
  await expect(reply).toHaveClass(/\bdone\b/, { timeout: 15_000 });
  const think = reply.locator("button.think");
  const label = think.getByText(/^Thought for \d+ s$/);
  await expect(think.locator(".th-i")).toBeVisible();
  await expect(label).toHaveCount(1);
  await expect(label).toBeVisible();
  await expect(think.locator(".th-x")).toBeVisible();
  await page.screenshot({ path: info.outputPath("thinking-row-rest.png") });
  const before = await reply.locator(".md").boundingBox();

  await think.hover();
  await expect(label).toBeVisible();
  expect(await reply.locator(".md").boundingBox()).toEqual(before);

  await page.mouse.move(5, 5);
  await expect(label).toBeVisible();
  await think.focus();
  await expect(label).toBeVisible();

  // click opens the reasoning, and it stays open after the pointer leaves
  await think.click();
  await page.mouse.move(5, 5);
  await expect(think).toHaveAttribute("aria-expanded", "true");
  await expect(reply.locator(".think-body")).toBeVisible();
  await expect(reply.locator(".think-body")).toContainText("Answer it plainly");
});

test("composer Thinking reveals its label on hover and focus without moving its neighbours", async ({ page, open }, info) => {
  await open();
  await waitReady(page);
  await page.keyboard.press("Control+Comma");
  await page.locator(".snav").getByRole("button", { name: "Image generation", exact: true }).click();
  await page.getByRole("switch", { name: "Generate images" }).click();
  await page.keyboard.press("Escape");
  const pill = page.locator('.cf-l button[aria-label="Thinking"]');
  const label = pill.locator(".plbl");
  await expect(label).toBeHidden();
  await page.screenshot({ path: info.outputPath("thinking-pill-rest.png") });
  const model = await page.locator("#modelBtn").boundingBox();
  const image = await page.locator('.cf-l button[aria-label="Image"]').boundingBox();
  const send = await page.getByRole("button", { name: "Send message" }).boundingBox();
  const collapsed = await pill.boundingBox();
  await pill.hover();
  await expect(label).toBeVisible();
  await page.screenshot({ path: info.outputPath("thinking-pill-hover.png") });
  expect((await pill.boundingBox())!.width).toBeGreaterThan(collapsed!.width);
  expect(await page.locator("#modelBtn").boundingBox()).toEqual(model);
  expect(await page.locator('.cf-l button[aria-label="Image"]').boundingBox()).toEqual(image);
  expect(await page.getByRole("button", { name: "Send message" }).boundingBox()).toEqual(send);
  await page.mouse.move(5, 5);
  await expect(label).toBeHidden();
  await pill.focus();
  await expect(label).toBeVisible();
  const on = await pill.evaluate((el) => ({ color: getComputedStyle(el).color, background: getComputedStyle(el).backgroundColor }));
  await pill.click();
  await expect(pill).toHaveAttribute("aria-pressed", "false");
  expect(await pill.evaluate((el) => ({ color: getComputedStyle(el).color, background: getComputedStyle(el).backgroundColor }))).not.toEqual(on);
  await expect(pill).toHaveAttribute("data-tip", /Thinking off/);
});

test.describe("phone Thinking", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  test("composer Thinking remains a labelled option in the sheet", async ({ page, open }) => {
    await open();
    await waitReady(page);
    await expect(page.locator('.cf-l button[aria-label="Thinking"]')).toBeHidden();
    await page.getByRole("button", { name: "Chat options", exact: true }).click();
    await expect(page.getByRole("menuitemcheckbox", { name: /Thinking/ })).toBeVisible();
  });
});

test("no runtime row in the sidebar while the runtime is healthy", async ({ page, open }) => {
  await open();
  await waitReady(page);
  await expect(page.locator(".sb-foot")).toBeVisible();
  await expect(page.locator(".sb-foot .rt")).toHaveCount(0);
  await expect(page.locator(".sb-foot")).not.toContainText("Ollama 0.40.4");
  // Settings > Runtime carries the state, and no version number anywhere (test/e2e/no-ollama-version.spec.ts)
  await page.keyboard.press("Control+Comma");
  await page.locator(".snav").getByRole("button", { name: "Runtime", exact: true }).click();
  await expect(page.locator(".set")).toContainText("Running");
  await expect(page.locator(".set")).not.toContainText("0.40.4");
});

test.describe("runtime down", () => {
  test.use({ scenario: "wrong-service", runtimeMode: "system" });

  test("the runtime row shows when the runtime needs the user, and opens Settings > Runtime", async ({ page, open }) => {
    await open();
    const row = page.locator(".sb-foot .rt");
    await expect(row).toBeVisible();
    await expect(row).toContainText("Port 5288 · busy");
    await row.click();
    await expect(page.getByRole("heading", { name: "Runtime" })).toBeVisible();
  });
});

test("the picker's Context setting changes the context size; the composer has no context chip", async ({ page, open }) => {
  await open();
  await waitReady(page);
  await expect(page.locator("#fitBtn")).toHaveCount(0);
  await expect(page.locator(".composer")).not.toContainText("on GPU");

  await page.locator("#modelBtn").click();
  const picker = page.locator("#picker");
  const ctx = picker.getByRole("radiogroup", { name: "Context" });
  await expect(ctx).toBeVisible();
  await expect(picker).toContainText("How much of the chat the model can read at once.");
  await expect(ctx.getByRole("radio", { name: "16k" })).toHaveAttribute("aria-checked", "true");
  // each size carries the highlighted model's fit as a dot and a tooltip
  await expect(ctx.getByRole("radio", { name: "16k" }).locator(".vd.gpu")).toHaveCount(1);
  await expect(ctx.getByRole("radio", { name: "16k" })).toHaveAttribute("data-tip", /fits/i);
  await ctx.getByRole("radio", { name: "32k" }).click();
  await expect(ctx.getByRole("radio", { name: "32k" })).toHaveAttribute("aria-checked", "true");
  await expect(ctx.getByRole("radio", { name: "16k" })).toHaveAttribute("aria-checked", "false");
  await page.keyboard.press("Escape");
  await expect(picker).toBeHidden();

  await sendMessage(page, "Use the bigger context");
  await expect(page.locator(".turn.a").last()).toHaveClass(/\bdone\b/, { timeout: 15_000 });
  const state = (await (await fetch(`${FAKE_URL}/__fake/state`)).json()) as { requests: { path: string; body: { options?: { num_ctx?: number } } }[] };
  expect(state.requests.findLast((r) => r.path === "/api/chat")?.body.options?.num_ctx).toBe(32768);
});

test("Settings > Advanced shows GPU memory, live", async ({ page, open }) => {
  await open();
  await waitReady(page);
  await page.keyboard.press("Control+Comma");
  const nav = page.locator(".snav").getByRole("button");
  await expect(nav.last()).toHaveText("Shortcuts");
  await expect(page.locator(".snav").getByRole("button", { name: "Memory", exact: true })).toHaveCount(0);
  await page.locator(".snav").getByRole("button", { name: "Advanced", exact: true }).click();
  const set = page.locator(".set");
  await expect(set.getByRole("heading", { name: "Advanced" })).toBeVisible();
  await expect(set.locator(".grp").first()).toContainText("GPU memory");
  await set.getByText("Details", { exact: true }).click();
  await expect(set.getByText("Where the memory goes")).toBeVisible();
  await expect(set).toContainText("Qwen 3.5 9B");
  // live: a context change elsewhere shows here
  await set.getByRole("button", { name: "32k" }).first().click();
  await expect(set.locator(".fp-v")).toContainText("at 32k");
  // each size's fit is on its own segment, never in a sentence about a size not chosen
  await expect(set.locator('[data-ctx="65536"]')).toHaveAttribute("data-tip", /at 64k/);
  await expect(set).not.toContainText("At 64k: ");
});

/** How many /api/chat requests the fake has seen. */
async function chats(): Promise<number> {
  const state = (await (await fetch(`${FAKE_URL}/__fake/state`)).json()) as { requests: { path: string }[] };
  return state.requests.filter((r) => r.path === "/api/chat").length;
}

test("a send refused for memory says why and its click opens Settings > Advanced", async ({ page, open }) => {
  await open();
  await waitReady(page);
  await page.locator("#modelBtn").click();
  await page.locator("#pkSearch").fill("gemma");
  await page.locator('#picker .pk-r[data-m="gemma4:12b"]').click();
  await page.keyboard.press("Control+Comma");
  await page.locator(".snav").getByRole("button", { name: "Advanced", exact: true }).click();
  await page.locator(".set").getByRole("button", { name: "64k" }).first().click();
  await expect(page.locator(".set")).toContainText("Needs ");
  await page.keyboard.press("Escape");
  await page.locator("#ta").fill("Too big?");
  const sendBtn = page.getByRole("button", { name: "Send message" });
  await expect(sendBtn).toHaveAttribute("data-tip", /not enough memory at 64k/);
  await expect(sendBtn).toHaveAttribute("data-tip", /Settings › Advanced/);
  await sendBtn.hover();
  await expect(page.locator("#tip")).toContainText("Settings › Advanced");
  const before = await chats();
  await sendBtn.dispatchEvent("click");
  await expect(page.locator(".set").getByRole("heading", { name: "Advanced" })).toBeVisible();
  await expect(page.locator("#gpuMemory")).toContainText("Gemma 4 12B");
  // the click opened the why; nothing was sent
  expect(await chats()).toBe(before);
});
