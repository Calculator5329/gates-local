import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fakeWhisper, wav } from "../../apps/server/src/voice/testing.ts";
import { expect, test, waitReady } from "./fixtures.ts";

const fixtureDir = path.join(homedir(), ".cache", "gates-local-voice-fixture");
mkdirSync(fixtureDir, { recursive: true });
const fixture = path.join(fixtureDir, "speech.wav");
const audio = Buffer.from(wav(2), "base64");
for (let i = 44; i < audio.length; i += 2) audio.writeInt16LE(Math.sin((i - 44) / 2 * 440 * Math.PI * 2 / 16000) * 3000, i);
writeFileSync(fixture, audio);
test.use({
  launchOptions: {
    ...(existsSync("/usr/bin/chromium") ? { executablePath: "/usr/bin/chromium" } : {}),
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", `--use-file-for-fake-audio-capture=${fixture}`],
  },
});
let whisper: Awaited<ReturnType<typeof fakeWhisper>>;
test.beforeEach(async () => { whisper = await fakeWhisper(); });
test.afterEach(async () => { await whisper.close(); });

async function connect(page: import("@playwright/test").Page) {
  await page.keyboard.press("Control+Comma");
  await page.getByTestId("settings.nav.open-general").click();
  await page.getByTestId("settings.voice.address").fill(whisper.url);
  await page.getByTestId("settings.voice.connect").click();
  await expect(page.getByText("Connected for dictation.", { exact: false })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".voice")).toBeVisible();
}
/** The Dictate button's box in its first checked state; every later state must match it exactly. */
const boxes = new WeakMap<import("@playwright/test").Page, { x: number; y: number; width: number; height: number }>();
/** Dictate is only the microphone: no visible words in any state, and the same box in every state. */
async function expectIconOnly(page: import("@playwright/test").Page, state: string) {
  const voice = page.locator("button.voice");
  expect(await voice.evaluate(el => [...el.querySelectorAll("*")].filter(n => n.children.length === 0 && (n.textContent ?? "").trim() !== "" && n.getClientRects().length > 0 && getComputedStyle(n).clipPath === "none").map(n => n.textContent)), `${state}: no words in the button`).toEqual([]);
  await expect(voice).toHaveAttribute("data-tip", /.+/);
  await expect(voice).toHaveAttribute("aria-label", /.+/);
  const box = await voice.boundingBox();
  const first = boxes.get(page);
  if (first === undefined) boxes.set(page, box!);
  else expect(box, `${state}: the same box as before`).toEqual(first);
}

// Guards the owner's ask for voice to text: dictation lands in the draft at the cursor, from an icon-only button that never moves.
test("voice: local microphone transcript stays in the draft at the cursor; cancel and late answers are safe", async ({ page, open }) => {
  await open(); await waitReady(page);
  await expect(page.getByRole("button", { name: "Dictate", exact: true })).toBeVisible();
  await expectIconOnly(page, "not connected");
  await connect(page);
  await expectIconOnly(page, "idle");
  const ta = page.locator("#ta");
  await ta.fill("before after");
  await ta.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(7, 7));
  const box = await page.locator(".composer").boundingBox();
  const model = await page.locator("#modelBtn").boundingBox();
  await page.getByTestId("chat.composer.dictate").click();
  await expect(page.getByRole("button", { name: "Stop dictation" })).toHaveClass(/\blistening\b/);
  await expect(page.locator(".voice")).toHaveAttribute("data-elapsed", /^[1-9]\d*$/);
  await expectIconOnly(page, "listening");
  await expect(page.locator(".voice")).toHaveAttribute("data-tip", /Listening/);
  whisper.mode = "slow";
  await page.getByRole("button", { name: "Stop dictation" }).click();
  await expect(page.locator(".voice")).toHaveClass(/\btranscribing\b/);
  await expectIconOnly(page, "transcribing");
  await expect(page.locator(".voice")).toHaveAttribute("data-tip", /Transcribing/);
  expect(await page.locator(".composer").boundingBox()).toEqual(box);
  expect(await page.locator("#modelBtn").boundingBox(), "nothing beside it moves").toEqual(model);
  // A repeated press does not issue a second transcription.
  await page.locator(".voice").evaluate((el: HTMLButtonElement) => el.click());
  await expect.poll(() => whisper.requests).toBe(1);
  await page.keyboard.press("Escape");
  await expect(page.locator(".voice")).toHaveClass(/\bidle\b/);
  await expect(ta).toHaveValue("before after");
  whisper.mode = "ok";
  await page.keyboard.press("Control+Shift+Space");
  await expect(page.locator(".voice")).toHaveClass(/\blistening\b/);
  await expect(page.locator(".voice")).toHaveAttribute("data-elapsed", /^[1-9]\d*$/);
  await page.keyboard.press("Control+Shift+Space");
  await expect(ta).toHaveValue("before spoken words after");
  await expect(page.locator(".turn.u")).toHaveCount(0);
  await page.getByTestId("chat.composer.dictate").click();
  await expect(page.locator(".voice")).toHaveClass(/\blistening\b/);
  await page.keyboard.press("Escape");
  await expect(page.locator(".voice")).toHaveClass(/\bidle\b/);
  expect(whisper.requests).toBe(2);
});
