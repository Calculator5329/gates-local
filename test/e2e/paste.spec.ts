import type { Page } from "@playwright/test";
import { expect, sendMessage, stack, test, waitReady } from "./fixtures.ts";
import { FAKE_URL } from "./env.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGOor6//DwAFewJ94ITM6gAAAABJRU5ErkJggg==";
const VISION = "qwen3-vl:8b";
type Clip = { text?: string; images?: number; files?: boolean; paths?: string[]; html?: boolean };

// A test-only negative control disables the paste owner at the DOM boundary, without editing shipped source.
if (process.env["GL_PASTE_MUTATION"] === "no-handler") test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => window.addEventListener("paste", event => { event.preventDefault(); event.stopImmediatePropagation(); }, true));
});

async function paste(page: Page, input: Clip) {
  await page.locator("#ta").focus();
  await page.evaluate(({ clip, png }) => {
    if (clip.paths) {
      const ta = document.querySelector<HTMLTextAreaElement>("#ta")!;
      ta.dispatchEvent(new CustomEvent("gates-local:native-paste", { bubbles: true, detail: { paths: clip.paths, skipped: false, version: Number(ta.dataset["draftVersion"]), start: ta.selectionStart, end: ta.selectionEnd } }));
      return;
    }
    const data = new DataTransfer();
    if (clip.text !== undefined) data.setData("text/plain", clip.text);
    if (clip.html) data.setData("text/html", "<p>Copied words</p><img src='https://example.com/image.png'>");
    for (let i = 0; i < (clip.images ?? 0); i++) data.items.add(new File([Uint8Array.from(atob(png), c => c.charCodeAt(0))], `image-${i}.png`, { type: "image/png" }));
    if (clip.files) data.items.add(new File(["public fixture"], "a b.pdf", { type: "application/pdf" }));
    document.querySelector("#ta")?.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, { clip: input, png: PNG });
}

async function chats(prompt?: string) {
  const state = await (await fetch(`${FAKE_URL}/__fake/state`)).json() as { requests: { path: string; body: { messages: { role: string; content: string; images?: string[] }[]; options: Record<string, unknown> } }[] };
  return state.requests.filter(r => r.path === "/api/chat").map(r => r.body).filter(body => prompt === undefined || body.messages.some(message => message.role === "user" && message.content === prompt));
}

test("paste text at the selection, grow, and undo", async ({ page, context, open }) => {
  await open(); await waitReady(page);
  const ta = page.locator("#ta");
  await ta.fill("before after");
  await ta.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(7, 7));
  const before = (await ta.boundingBox())!.height;
  await paste(page, { text: "one\ntwo\nthree\nfour\n" });
  await expect(ta).toHaveValue("before one\ntwo\nthree\nfour\nafter");
  expect((await ta.boundingBox())!.height).toBeGreaterThan(before);
  await ta.press("Control+z");
  await expect(ta).toHaveValue("before after");
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await ta.fill("");
  await ta.pressSequentially("typed words");
  await ta.evaluate((el: HTMLTextAreaElement) => {
    el.addEventListener("paste", event => { el.dataset["trustedPaste"] = String(event.isTrusted); }, { once: true });
  });
  await page.evaluate(() => navigator.clipboard.writeText(" and pasted"));
  await ta.press("Control+v");
  await expect(ta).toHaveValue("typed words and pasted");
  await expect(ta).toHaveAttribute("data-trusted-paste", "true");
  await ta.press("Control+z");
  await expect(ta).toHaveValue("typed words");
});

test("paste an image, remove it, and keep the toolbar still", async ({ page, open }) => {
  await open(); await waitReady(page);
  const send = page.getByRole("button", { name: "Send message", exact: true });
  const before = await send.boundingBox();
  await paste(page, { images: 1 });
  await expect(page.locator(".att img")).toHaveCount(1);
  expect((await send.boundingBox())!.y).toBe(before!.y);
  await page.getByRole("button", { name: "Remove image 1", exact: true }).click();
  await expect(page.locator(".att img")).toHaveCount(0);
  expect((await send.boundingBox())!.y).toBe(before!.y);
});

test("paste several images with a count limit", async ({ page, open }) => {
  await open(); await waitReady(page);
  await paste(page, { images: 7 });
  await expect(page.locator(".att img")).toHaveCount(7);
  await paste(page, { images: 2 });
  await expect(page.getByRole("status").filter({ hasText: "8 images" })).toBeVisible();
  await expect(page.locator(".att img")).toHaveCount(8);
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.items.add(new File([new Uint8Array(50 * 1024 * 1024 + 1)], "large.png", { type: "image/png" }));
    document.querySelector("#ta")?.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expect(page.getByRole("status").filter({ hasText: "8 images" })).toBeVisible();
});

test("paste file-manager paths at the cursor before images or text", async ({ page, open }) => {
  await open(); await waitReady(page);
  await page.locator("#ta").fill("see  please");
  await page.locator("#ta").evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(4, 4));
  await paste(page, { files: true, images: 1, text: "ignored", paths: ["/srv/docs/a b.pdf", "/srv/pictures/雪.png"] });
  await expect(page.locator("#ta")).toHaveValue("see /srv/docs/a b.pdf\n/srv/pictures/雪.png please");
  await expect(page.locator(".att img")).toHaveCount(0);
});

test("browser file paste explains missing paths without inserting a name", async ({ page, open }) => {
  await open(); await waitReady(page);
  await paste(page, { files: true, text: "a b.pdf" });
  await expect(page.getByRole("status").filter({ hasText: "file paths" })).toBeVisible();
  await expect(page.locator("#ta")).toHaveValue("");
});

test("mixed web text and image follows T3: the image wins", async ({ page, open }) => {
  await open(); await waitReady(page);
  await paste(page, { images: 1, text: "Copied words", html: true });
  await expect(page.locator("#ta")).toHaveValue("");
  await expect(page.locator(".att img")).toHaveCount(1);
  await paste(page, { images: 1, text: "", html: true });
  await expect(page.locator(".att img")).toHaveCount(2);
});

test.describe("vision turns", () => {
  test.use({ installed: ["qwen3.5:4b", VISION] });
  test("image-omission notice arrives during a reply and survives Stop and leaving the chat", async ({ page, open }, info) => {
    await open(); await waitReady(page);
    await page.locator("#modelBtn").click();
    await page.locator("#pkSearch").fill(VISION);
    await page.locator(`#picker .pk-r[data-m="${VISION}"]`).click();
    await paste(page, { images: 1 });
    await sendMessage(page, "Notice image fixture");
    await expect(page.locator(".turn.a.done")).toHaveCount(1);
    await page.locator("#modelBtn").click();
    await page.locator("#pkSearch").fill("qwen3.5:4b");
    await page.locator('#picker .pk-r[data-m="qwen3.5:4b"]').click();
    await stack.scenario("slow-drip", { installed: ["qwen3.5:4b", VISION], holdAfterTokens: 46 });
    await sendMessage(page, "Notice follow-up fixture");
    const notice = page.locator('.turn.a [role="status"]').filter({ hasText: "earlier images" });
    await expect(notice).toBeVisible();
    await expect(page.locator(".turn.a:not(.done) .md")).not.toBeEmpty();
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(notice).toBeVisible();
    const thread = page.url().split("#")[1]?.replace("thread=", "");
    await page.getByRole("complementary").getByRole("button", { name: /^New thread/ }).click();
    await page.locator(`.sb-row[data-thread="${thread}"]`).click();
    await expect(notice).toBeVisible();
    await page.screenshot({ path: info.outputPath("omission-notice.png") });
  });
  test("non-vision Send refuses and names an installed model that sees images", async ({ page, open }) => {
    await open(); await waitReady(page);
    await paste(page, { images: 1 });
    await page.locator("#ta").fill("What is here?");
    const send = page.getByRole("button", { name: "Send message", exact: true });
    await expect(send).toBeDisabled();
    await expect(send).toHaveAttribute("data-tip", /cannot see images.*Qwen/i);
    expect(await chats("What is here?")).toHaveLength(0);
    await expect(page.locator(".att img")).toHaveCount(1);
  });
});

test.describe("image history", () => {
  test.use({ installed: [VISION] });
  test("images reach Ollama, persist, edit and retry, and resend in follow-ups", async ({ page, open }, testInfo) => {
    await open(); await waitReady(page);
    await paste(page, { images: 2 });
    await page.screenshot({ path: testInfo.outputPath("attachments.png") });
    await sendMessage(page, "Describe these");
    await expect(page.locator(".turn.a.done")).toHaveCount(1);
    expect((await chats("Describe these")).at(-1)?.messages.at(-1)?.images).toEqual([PNG, PNG]);
    expect((await chats("Describe these")).at(-1)?.options).not.toHaveProperty("num_gpu");
    await expect(page.locator(".turn.u img")).toHaveCount(2);
    await page.reload(); await waitReady(page);
    await expect(page.locator(".turn.u img")).toHaveCount(2);
    await page.locator("[data-edit]").click();
    await expect(page.locator(".att img")).toHaveCount(2);
    await page.getByRole("button", { name: "Remove image 2", exact: true }).click();
    await page.getByRole("button", { name: "Remove image 1", exact: true }).click();
    await page.locator("#ta").fill("");
    await page.locator("[data-regen]").click();
    await expect.poll(async () => (await chats("Describe these")).length).toBe(2);
    expect((await chats("Describe these")).at(-1)?.messages.at(-1)?.images).toEqual([PNG, PNG]);
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
    await sendMessage(page, "Which is brighter?");
    await expect.poll(async () => (await chats("Describe these")).length).toBe(3);
    expect((await chats("Describe these")).at(-1)?.messages.find(m => m.content === "Describe these")?.images).toEqual([PNG, PNG]);
  });

  test.describe("deliberate server restart", () => {
    test.use({ allowedErrors: [/WebSocket connection.*ERR_CONNECTION_REFUSED/] });
    test("queued images survive restart, reload, editing and send now", async ({ page, open }) => {
    await open(); await waitReady(page);
    await stack.scenario("slow-drip", { installed: [VISION], holdAfterTokens: 46 });
    await sendMessage(page, "A slow answer");
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
    await expect.poll(async () => (await chats("A slow answer")).length).toBe(1);
    await paste(page, { images: 1 });
    await sendMessage(page, "Queued image");
    await expect(page.locator(".qt-r")).toHaveCount(1);
    await stack.restart();
    await page.reload(); await waitReady(page);
    await expect(page.locator(".qt-r")).toContainText("On hold");
    await page.locator("[data-edit-queued]").click();
    await expect(page.locator(".att img")).toHaveCount(1);
    await page.locator("#ta").fill("Edited image");
    await page.locator("#ta").press("Enter");
    await page.locator("[data-send-now]").click();
    await expect.poll(async () => (await chats("A slow answer")).length).toBe(2);
    expect((await chats("A slow answer")).at(-1)?.messages.at(-1)).toMatchObject({ content: "Edited image", images: [PNG] });
    });
  });

  test("an unsent image draft survives reload and can send without text", async ({ page, open }) => {
    await open(); await waitReady(page);
    await paste(page, { images: 1 });
    await expect(page.locator(".att img")).toHaveCount(1);
    await page.reload(); await waitReady(page);
    await expect(page.locator(".att img")).toHaveCount(1);
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(page.locator(".turn.u img")).toHaveCount(1);
    await expect(page.locator(".turn.a.done")).toHaveCount(1);
    expect((await chats()).at(-1)?.messages.at(-1)?.images).toEqual([PNG]);
  });
});
