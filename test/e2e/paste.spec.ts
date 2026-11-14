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
  if (input.text !== undefined && !input.images && !input.files && !input.paths && !input.html) {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.evaluate(text => navigator.clipboard.writeText(text), input.text);
    await page.locator("#ta").press("Control+v");
    return;
  }
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

// Guards the owner's ask to paste text, including the app's own right-click Paste.
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

// Guards a shipped bug fix: large text pastes stopped being editable.
test("large text paste preserves selection, undo, typing and the saved draft", async ({ page, context, open }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await open(); await waitReady(page);
  const ta = page.locator("#ta");
  const text = "paste text line\n".repeat(3125);
  await ta.fill("before after");
  await ta.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(7, 12));
  await ta.evaluate(el => {
    let inputs = 0;
    el.addEventListener("input", () => { inputs++; });
    Object.defineProperty(el, "largePasteInputEvents", { get: () => inputs });
  });
  await page.evaluate(value => navigator.clipboard.writeText(value), text);
  await ta.press("Control+v");
  await expect(ta).toHaveValue("before " + text);
  expect(await ta.evaluate(el => Reflect.get(el, "largePasteInputEvents"))).toBe(1);
  await ta.press("Control+z");
  await expect(ta).toHaveValue("before after");
  await ta.press("Control+Shift+z");
  await expect(ta).toHaveValue("before " + text);
  const draft = "before " + text + "x";
  await ta.press("x");
  await page.reload(); await waitReady(page);
  await expect(ta).toHaveValue(draft);
});

// Guards the owner's ask to paste images, and his rule that nothing moves.
test("paste an image, remove it, and keep the toolbar still", async ({ page, open }) => {
  await open(); await waitReady(page);
  const send = page.getByTestId("chat.composer.send");
  const before = await send.boundingBox();
  await paste(page, { images: 1 });
  await expect(page.locator(".att img")).toHaveCount(1);
  expect((await send.boundingBox())!.y).toBe(before!.y);
  await page.getByTestId("chat.attachment.remove-image-1").click();
  await expect(page.locator(".att img")).toHaveCount(0);
  expect((await send.boundingBox())!.y).toBe(before!.y);
});

// Guards the owner's ask to paste file paths from the file manager.
test("paste file-manager paths at the cursor before images or text", async ({ page, open }) => {
  await open(); await waitReady(page);
  await page.locator("#ta").fill("see  please");
  await page.locator("#ta").evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(4, 4));
  await paste(page, { files: true, images: 1, text: "ignored", paths: ["/srv/docs/a b.pdf", "/srv/pictures/雪.png"] });
  await expect(page.locator("#ta")).toHaveValue("see /srv/docs/a b.pdf\n/srv/pictures/雪.png please");
  await expect(page.locator(".att img")).toHaveCount(0);
});

// Guards the owner's rule that T3 Code is the reference: a web copy of text and image pastes the image (unsure: no owner line on this case).
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
  // Guards the owner's ruling (chat row 17): a text-only follow-up says nothing about the earlier image.
  test("a text-only follow-up in an image thread says nothing about the earlier image (chat row 17)", async ({ page, open }, info) => {
    await open(); await waitReady(page);
    await page.locator("#modelBtn").click();
    await page.locator("#pkSearch").fill(VISION);
    await page.locator(`#picker .pk-r[data-m="${VISION}"]`).click();
    await expect(page.locator("#picker")).toBeHidden();
    await paste(page, { images: 1 });
    await expect(page.locator(".att img")).toHaveCount(1);
    await page.locator("#ta").fill("Notice image fixture");
    await expect(page.getByTestId("chat.composer.send")).not.toHaveAttribute("aria-disabled", "true");
    await page.locator("#ta").press("Enter");
    await expect(page.locator(".turn.a.done")).toHaveCount(1);
    await page.locator("#modelBtn").click();
    await page.locator("#pkSearch").fill("qwen3.5:4b");
    await page.locator('#picker .pk-r[data-m="qwen3.5:4b"]').click();
    await expect(page.locator("#picker")).toBeHidden();
    await stack.scenario("slow-drip", { installed: ["qwen3.5:4b", VISION], holdAfterTokens: 46 });
    await sendMessage(page, "Notice follow-up fixture");
    // the model is told the image is gone (the server tests check the marker); the person is not
    const notice = page.locator(".turn.a").filter({ hasText: "earlier images" });
    await expect(page.locator(".turn.a:not(.done) .md")).not.toBeEmpty();
    await expect.soft(notice).toHaveCount(0);
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    const thread = page.url().split("#")[1]?.replace("thread=", "");
    await page.getByTestId("sidebar.top.new-thread").click();
    await page.locator(`.sb-row[data-thread="${thread}"]`).click();
    await expect(page.locator(".turn.a")).toHaveCount(2);
    await page.screenshot({ path: info.outputPath("follow-up.png") });
    await expect(notice).toHaveCount(0);
  });
});

test.describe("image history", () => {
  test.use({ installed: [VISION] });
  // Guards the owner's ask to paste images: they reach the model and persist (unsure: the edit and retry steps may be more than he asked).
  test("images reach Ollama, persist, edit and retry, and resend in follow-ups", async ({ page, open }) => {
    await open(); await waitReady(page);
    await paste(page, { images: 2 });
    await sendMessage(page, "Describe these");
    await expect(page.locator(".turn.a.done")).toHaveCount(1);
    expect((await chats("Describe these")).at(-1)?.messages.at(-1)?.images).toEqual([PNG, PNG]);
    expect((await chats("Describe these")).at(-1)?.options).not.toHaveProperty("num_gpu");
    await expect(page.locator(".turn.u img")).toHaveCount(2);
    await page.reload(); await waitReady(page);
    await expect(page.locator(".turn.u img")).toHaveCount(2);
    await page.locator("[data-edit]").click();
    await expect(page.locator(".att img")).toHaveCount(2);
    await page.getByTestId("chat.attachment.remove-image-2").click();
    await page.getByTestId("chat.attachment.remove-image-1").click();
    await page.locator("#ta").fill("");
    await page.locator("[data-regen]").click();
    await expect.poll(async () => (await chats("Describe these")).length).toBe(2);
    expect((await chats("Describe these")).at(-1)?.messages.at(-1)?.images).toEqual([PNG, PNG]);
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
    await sendMessage(page, "Which is brighter?");
    await expect.poll(async () => (await chats("Describe these")).length).toBe(3);
    expect((await chats("Describe these")).at(-1)?.messages.find(m => m.content === "Describe these")?.images).toEqual([PNG, PNG]);
  });
});
