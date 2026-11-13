/// <reference lib="dom" />
// Journeys for the chat's feel: steady streaming, the code block's copy
// button, the thinking disclosure and composer pill, the runtime row only when
// the runtime needs the user, the context size inside the model picker, and
// GPU memory under Settings > Advanced.
import { DRIP_REPLY } from "../fake-ollama/fake-ollama.ts";
import { decodeRequest } from "@gates-local/contracts";
import { FAKE_URL } from "./env.ts";
import { blockPrefix, type BlockSnap } from "./block-prefix.ts";
import { expect, sendMessage, stack, test, waitReady } from "./fixtures.ts";

// Enabling the Image pill must never probe a real image service.
const unavailableImage = new URL(FAKE_URL);
unavailableImage.port = "9";
test.use({ comfyUrl: unavailableImage.origin, video: process.env["GL_E2E_RECORD"] || process.env["GL_FLICKER_MEASURE"] ? "on" : "off", screenshot: "only-on-failure" });

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

// Guards the owner's ask: a reply streams as it is written, then shows the whole answer.
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

test.describe("code blocks", () => {
  test.use({ seed: 2, permissions: ["clipboard-read", "clipboard-write"] });

  // Guards the owner's ask: a code block has its own working Copy.
  test("a code block's own copy button puts the exact code on the clipboard", async ({ page, open, seededThread }) => {
    await open(`#thread=${seededThread ?? ""}`);
    await waitReady(page);
    const reply = page.locator(".turn.a").last();
    // one button per fenced block; inline code spans get none
    await expect(reply.locator(".md li code").filter({ hasText: "PATH" })).toBeVisible();
    await expect(reply.getByTestId("chat.markdown.copy-code")).toHaveCount(1);
    const block = reply.locator(".md .cb");
    await expect(block.locator(".cb-lang")).toHaveText("sh");
    const copy = block.getByTestId("chat.markdown.copy-code");
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

// Guards the owner's ask: finished thinking collapses to one labelled row that opens on click.
test("a finished thinking row keeps its label and chevron at rest", async ({ page, open }) => {
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

// Guards the owner's ruling: the Thinking pill never changes size, so nothing beside it moves.
test("composer Thinking keeps its size on hover and focus, so its neighbours never move", async ({ page, open }) => {
  await open();
  await waitReady(page);
  await page.keyboard.press("Control+Comma");
  await page.getByTestId("settings.nav.open-images").click();
  await page.getByTestId("settings.images.enable").click();
  await page.keyboard.press("Escape");
  const pill = page.locator('.cf-l button[aria-label="Thinking"]');
  const label = pill.locator(".plbl");
  await expect(label).toBeHidden();
  const model = await page.locator("#modelBtn").boundingBox();
  const image = await page.locator('.cf-l button[aria-label="Image"]').boundingBox();
  const send = await page.getByTestId("chat.composer.send").boundingBox();
  const rest = await pill.boundingBox();
  await pill.hover();
  await expect(page.locator("#tip")).toHaveClass(/\bopen\b/);
  await expect(page.locator("#tip")).toContainText("Thinking");
  await expect(label).toBeHidden();
  expect(await pill.boundingBox()).toEqual(rest);
  expect(await page.locator("#modelBtn").boundingBox()).toEqual(model);
  expect(await page.locator('.cf-l button[aria-label="Image"]').boundingBox()).toEqual(image);
  expect(await page.getByTestId("chat.composer.send").boundingBox()).toEqual(send);
  await page.mouse.move(5, 5);
  await pill.focus();
  await expect(label).toBeHidden();
  expect(await pill.boundingBox()).toEqual(rest);
  const on = await pill.evaluate((el) => ({ color: getComputedStyle(el).color, background: getComputedStyle(el).backgroundColor }));
  await pill.click();
  await expect(pill).toHaveAttribute("aria-pressed", "false");
  expect(await pill.evaluate((el) => ({ color: getComputedStyle(el).color, background: getComputedStyle(el).backgroundColor }))).not.toEqual(on);
  await expect(pill).toHaveAttribute("data-tip", /Thinking off/);
});

// Guards the footer's Settings icon showing runtime state only when it is true (healthy half).
test("no runtime dot or words on the sidebar's Settings icon while the runtime is healthy", async ({ page, open }) => {
  await open();
  await waitReady(page);
  await expect(page.locator(".sb-foot")).toBeVisible();
  const gear = page.locator(".sb-foot").getByRole("button", { name: "Settings", exact: true });
  await expect(gear).toHaveAttribute("data-tip", "Settings · Ctrl ,");
  await expect(gear.locator(".fdot")).toHaveCount(0);
  await expect(page.locator(".sb-foot")).not.toContainText("Ollama 0.40.4");
  await expect(gear).not.toHaveAttribute("data-tip", /0\.40\.4/);
  // Settings > Runtime carries the state, and no version number anywhere (test/e2e/no-ollama-version.spec.ts)
  await page.keyboard.press("Control+Comma");
  await page.getByTestId("settings.nav.open-runtime").click();
  await expect(page.locator(".set")).toContainText("Running");
  await expect(page.locator(".set")).not.toContainText("0.40.4");
});

test.describe("runtime down", () => {
  test.use({ scenario: "wrong-service", runtimeMode: "system" });

  // Guards the footer's Settings icon showing runtime state only when it is true (down half).
  test("the Settings icon shows a dot and the runtime's words when the runtime needs the user, and opens Settings > Runtime", async ({ page, open }) => {
    await open();
    const gear = page.locator(".sb-foot").getByRole("button", { name: /^Settings/ });
    await expect(gear.locator(".fdot.red")).toBeVisible();
    await expect(gear).toHaveAccessibleName("Settings · Port 5288 · busy");
    await expect(gear).toHaveAttribute("data-tip", /^<b>Port 5288 · busy<\/b>/);
    await gear.click();
    await expect(page.getByRole("heading", { name: "Runtime" })).toBeVisible();
  });
});

// Guards the owner's ask: the context size is picked inside the model picker.
test("the picker's context column changes the context size shown in the model trigger", async ({ page, open }) => {
  await open();
  await waitReady(page);
  await expect(page.locator("#fitBtn")).toHaveCount(0);
  await expect(page.locator(".composer")).not.toContainText("on GPU");

  await page.locator("#modelBtn").click();
  const picker = page.locator("#picker");
  const ctx = picker.getByRole("radiogroup", { name: "Context length" });
  await expect(ctx).toBeVisible();
  await expect(ctx.locator('[data-ctx="16384"]')).toHaveAttribute("aria-checked", "true");
  await expect(ctx.locator('[data-ctx="16384"] .pk-cost.gpu')).toHaveCount(1);
  // the fit is on the row's face and in its name; the row opens no tooltip
  await expect(ctx.locator('[data-ctx="16384"] .pk-cost.gpu')).toHaveAccessibleName(/; Fits$/);
  await ctx.locator('[data-ctx="32768"]').click();
  await expect(picker).toBeHidden();
  await expect(page.locator("#modelBtn .picker-trigger-ctx")).toHaveText("32k");
  await page.locator("#modelBtn").click();
  await expect(ctx.locator('[data-ctx="32768"]')).toHaveAttribute("aria-checked", "true");
  await expect(ctx.locator('[data-ctx="16384"]')).toHaveAttribute("aria-checked", "false");
  await page.keyboard.press("Escape");
  await expect(picker).toBeHidden();

  await sendMessage(page, "Use the bigger context");
  await expect(page.locator(".turn.a").last()).toHaveClass(/\bdone\b/, { timeout: 15_000 });
  const state = (await (await fetch(`${FAKE_URL}/__fake/state`)).json()) as { requests: { path: string; body: { options?: { num_ctx?: number } } }[] };
  expect(state.requests.findLast((r) => r.path === "/api/chat")?.body.options?.num_ctx).toBe(32768);
});

// Guards the owner's ask: GPU memory lives in Settings > Advanced and updates live.
test("Settings > Advanced shows GPU memory, live", async ({ page, open }) => {
  await open();
  await waitReady(page);
  await page.keyboard.press("Control+Comma");
  const nav = page.locator(".snav").getByRole("button");
  await expect(nav.last()).toHaveText("Shortcuts");
  await expect(page.getByTestId("settings.nav.open-memory")).toHaveCount(0);
  await page.getByTestId("settings.nav.open-advanced").click();
  const set = page.locator(".set");
  await expect(set.getByRole("heading", { name: "Advanced" })).toBeVisible();
  await expect(set.locator(".grp").first()).toContainText("GPU memory");
  await set.getByText("Details", { exact: true }).click();
  await expect(set.getByText("In use right now")).toBeVisible();
  await expect(set).toContainText("Qwen 3.5 9B");
  // live: a new size is what the control, the verdict and Details all speak about
  const size32 = set.locator('[data-ctx="32768"]');
  await expect(size32).toHaveAttribute("aria-pressed", "false");
  await expect(set.locator(".fp-more")).not.toContainText("32k");
  await size32.click();
  await expect(size32).toHaveAttribute("aria-pressed", "true");
  await expect(set.locator(".fp-more")).toContainText("Not measured at 32k yet.");
  // the control already says 32k, so the verdict does not say it again
  await expect(set.locator(".fp-v:visible")).not.toContainText("32k");
  // each size's fit is on its own segment, never in a sentence about a size not chosen
  await expect(set.locator('[data-ctx="65536"]')).toHaveAttribute("data-tip", /at 64k/);
  await expect(set).not.toContainText("At 64k: ");
});

// Guards a refused send saying why and leading to the fix.
test("a send refused for memory says why and its click opens Settings > Advanced", async ({ page, open }) => {
  // The fake's 500-request history rolls over during a full suite. Observe
  // this client's sends directly, including requests the server would reject.
  let sends = 0;
  page.on("websocket", socket => socket.on("framesent", frame => {
    const request = decodeRequest(frame.payload);
    if (request.ok && request.value.method === "chat.send") sends++;
  }));
  await open();
  await waitReady(page);
  await page.locator("#modelBtn").click();
  await page.locator("#pkSearch").fill("gemma");
  await page.locator('#picker .pk-r[data-m="gemma4:12b"]').click();
  await expect(page.locator("#modelBtn")).toContainText("Gemma 4 12B");
  await page.keyboard.press("Control+Comma");
  await page.getByTestId("settings.nav.open-advanced").click();
  await page.locator(".set").getByRole("button", { name: "64k" }).first().click();
  // Settings judges the card's own memory, where it spills; Send judges right now, where it won't fit
  await expect(page.locator(".set .fp-v")).toContainText("Should run slower");
  await page.keyboard.press("Escape");
  await page.locator("#ta").fill("Too big?");
  const sendBtn = page.getByTestId("chat.composer.send");
  await expect(sendBtn).toHaveAttribute("data-tip", /not enough memory at 64k/);
  await expect(sendBtn).toHaveAttribute("data-tip", /Settings › Advanced/);
  await sendBtn.hover();
  await expect(page.locator("#tip")).toContainText("Settings › Advanced");
  const before = sends;
  await sendBtn.dispatchEvent("click");
  await expect(page.locator(".set").getByRole("heading", { name: "Advanced" })).toBeVisible();
  await expect(page.locator("#gpuMemory")).toContainText("Gemma 4 12B");
  // the click opened the why; nothing was sent
  expect(sends).toBe(before);
});
