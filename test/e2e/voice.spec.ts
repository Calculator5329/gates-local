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
  await expect(page.getByTestId("settings.voice.disconnect")).toBeVisible();
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
  await expect(page.locator(".voice")).toHaveAttribute("data-tip", "Stop dictation · Ctrl Shift Space");
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

/** The device's voice as a recording: every sentence it is asked to say, and each time it is told to stop. */
function recordSpeech() {
  type Said = { said: string[]; cancels: number };
  const w = window as unknown as { speechHeard: Said };
  w.speechHeard = { said: [], cancels: 0 };
  const voice = { name: "Test voice", lang: "en-US", localService: true, default: true, voiceURI: "test" };
  class Utterance { voice: unknown = null; lang = ""; text: string; constructor(text: string) { this.text = text; } }
  Object.defineProperty(window, "SpeechSynthesisUtterance", { configurable: true, value: Utterance });
  Object.defineProperty(window, "speechSynthesis", { configurable: true, value: {
    getVoices: () => [voice], speak: (u: { text: string }) => { w.speechHeard.said.push(u.text); },
    cancel: () => { w.speechHeard.cancels++; }, addEventListener() {}, removeEventListener() {},
  } });
}
const speech = (page: import("@playwright/test").Page) => page.evaluate(() => (window as unknown as { speechHeard: { said: string[]; cancels: number } }).speechHeard);

// Chat row 38, owner pick A (a try-out): hold the microphone or Space to talk, let go to send; the reply
// is read aloud a sentence at a time, and the speaker icon turns that off. Off until turned on in Settings.
test("talk mode: hold to talk sends, the reply is read aloud, the speaker turns it off", async ({ page, open }) => {
  test.info().annotations.push({ type: "budget", description: "Three spoken turns, each a held recording and a transcription: two replies streamed and read to their end, one stopped as it is read." });
  await page.addInitScript(recordSpeech);
  await open(); await waitReady(page);
  await connect(page);
  await expect(page.getByTestId("chat.composer.speak"), "talk mode is off until it is turned on").toHaveCount(0);
  await page.keyboard.press("Control+Comma");
  await page.getByTestId("settings.nav.open-general").click();
  await page.getByTestId("settings.voice.talk").click();
  await expect(page.getByTestId("settings.voice.talk")).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  const mic = page.getByTestId("chat.composer.dictate");
  const speaker = page.getByTestId("chat.composer.speak");
  await expect(speaker).toHaveAttribute("aria-pressed", "true");
  await expect(mic).toHaveAttribute("data-tip", /Hold/);
  await page.locator(".composer").screenshot({ path: test.info().outputPath("row38-talk-composer.png") });

  // hold the microphone: it listens while held, and letting go sends what was said
  const box = await mic.boundingBox();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await expect(mic).toHaveClass(/\blistening\b/);
  await expect(mic).toHaveAttribute("data-elapsed", /^[1-9]\d*$/);
  await page.locator(".composer").screenshot({ path: test.info().outputPath("row38-talk-listening.png") });
  await page.mouse.up();
  await expect(page.locator(".turn.u")).toHaveCount(1);
  await expect(page.locator(".turn.u").first()).toContainText("spoken words");
  await expect(page.locator("#ta")).toHaveValue("");
  await expect.poll(async () => (await speech(page)).said[0], { timeout: 15_000 }).toBe("You asked: spoken words.");
  await expect(page.locator(".turn.a")).toHaveCount(1);
  await expect(page.getByTestId("chat.composer.send")).not.toHaveAttribute("aria-label", "Stop", { timeout: 30_000 });
  // the words come out at a steady pace and can still be arriving on screen when Stop goes: wait for the whole reply
  await expect(page.locator(".turn.a").first()).toHaveClass(/\bdone\b/);
  const read = (await speech(page)).said;
  expect(read.length, "the rest of the reply is read after its first sentence").toBeGreaterThan(1);
  const reply = (await page.locator(".turn.a .md").first().innerText()).replace(/\s+/g, " ").trim();
  expect(read.join(" "), "every word of the reply, in order, then nothing more").toBe(reply);
  expect(read.join(" "), "the thinking is never read").not.toContain("The question is short");

  // a tap of Space on an empty draft is not a talk: nothing is sent and no space is typed
  await page.locator("#ta").focus();
  await page.keyboard.press("Space");
  await expect(page.locator("#ta")).toHaveValue("");
  // hold Space: the same as holding the microphone
  await page.keyboard.down("Space");
  await expect(mic).toHaveClass(/\blistening\b/);
  await expect(mic).toHaveAttribute("data-elapsed", /^[1-9]\d*$/);
  await page.keyboard.up("Space");
  await expect(page.locator(".turn.u")).toHaveCount(2);
  expect(whisper.requests, "the tap sent nothing to transcribe").toBe(2);

  // chat row 42: Stop on a reply also stops its reading, and pulls back what waits in the voice
  const send = page.getByTestId("chat.composer.send");
  await expect.poll(async () => (await speech(page)).said.filter((s) => s.startsWith("You asked")).length, { timeout: 15_000 }).toBe(2);
  await expect(send).toHaveAttribute("aria-label", "Stop");
  const talking = await speech(page);
  await send.click();
  const stopped = await speech(page);
  expect(stopped.cancels, "Stop pulls back the sentences waiting in the voice").toBeGreaterThan(talking.cancels);
  await expect(send).not.toHaveAttribute("aria-label", "Stop");
  await expect(page.locator(".turn.a")).toHaveCount(2);
  expect((await speech(page)).said, "nothing more of the stopped reply is read").toEqual(stopped.said);

  // the speaker turns the reading off and stops it now
  const before = (await speech(page)).cancels;
  await speaker.click();
  await expect(speaker).toHaveAttribute("aria-pressed", "false");
  expect((await speech(page)).cancels).toBeGreaterThan(before);
  await expect(page.getByTestId("chat.composer.send")).not.toHaveAttribute("aria-label", "Stop", { timeout: 30_000 });
  const off = (await speech(page)).said.length;
  // Space talks from the message box; Stop left the focus on its own button
  await page.locator("#ta").focus();
  await page.keyboard.down("Space");
  await expect(mic).toHaveAttribute("data-elapsed", /^[1-9]\d*$/);
  await page.keyboard.up("Space");
  await expect(page.locator(".turn.u")).toHaveCount(3);
  await expect(page.getByTestId("chat.composer.send")).not.toHaveAttribute("aria-label", "Stop", { timeout: 30_000 });
  expect((await speech(page)).said, "nothing is read with the speaker off").toHaveLength(off);
});
