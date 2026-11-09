import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fakeWhisper, wav } from "../../apps/server/src/voice/testing.ts";
import { CHECKOUT_CACHE } from "./env.ts";
import { expect, test, waitReady } from "./fixtures.ts";

const fixtureDir = path.join(homedir(), ".cache", "gates-local-voice-fixture");
mkdirSync(fixtureDir, { recursive: true });
const fixture = path.join(fixtureDir, "speech.wav");
const audio = Buffer.from(wav(2), "base64");
for (let i = 44; i < audio.length; i += 2) audio.writeInt16LE(Math.sin((i - 44) / 2 * 440 * Math.PI * 2 / 16000) * 3000, i);
writeFileSync(fixture, audio);
const shots = process.env["GL_VOICE_SHOTS"] ?? path.join(CHECKOUT_CACHE, "shots", "voice");
mkdirSync(shots, { recursive: true });
test.use({
  video: "on",
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
  await page.locator(".snav").getByRole("button", { name: "General", exact: true }).click();
  await page.getByRole("textbox", { name: "whisper.cpp address" }).fill(whisper.url);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByText("Connected for dictation.", { exact: false })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".voice")).toBeVisible();
}
const shot = (page: import("@playwright/test").Page, name: string) => page.screenshot({ path: path.join(shots, `${name}.png`) });

test("voice: VD-01 older Disconnect completion preserves the newest Connect; VC-03 another window still cancels it", async ({ page, context, open }) => {
  const checks: (() => void)[] = [];
  const healthIds = new Set<string>();
  let healthReplies = 0;
  let delay = false;
  let disconnectSave: (() => void) | undefined;
  await page.routeWebSocket(/127\.0\.0\.1:5286/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => {
      const req = JSON.parse(String(message)) as { method?: string; id?: string; params?: { whisperUrl?: string | null } };
      if (req.method === "voice.check" && req.id) healthIds.add(req.id);
      if (delay && req.method === "voice.check") checks.push(() => server.send(message));
      else if (delay && req.method === "settings.update" && req.params?.whisperUrl === null) disconnectSave = () => server.send(message);
      else server.send(message);
    });
    server.onMessage((message) => {
      const reply = JSON.parse(String(message)) as { type?: string; id?: string };
      if (reply.type === "response" && reply.id && healthIds.delete(reply.id)) healthReplies++;
      ws.send(message);
    });
  });
  await open(); await waitReady(page); await connect(page);
  await page.keyboard.press("Control+Comma");
  delay = true;
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect.poll(() => checks.length).toBe(1);
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect.poll(() => !!disconnectSave).toBe(true);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect.poll(() => checks.length).toBe(2);
  disconnectSave?.();
  await expect(page.getByText("Off. Connect your running local server", { exact: false })).toBeVisible();
  checks.splice(0).forEach((send) => send());
  await expect(page.getByText("Connected for dictation.", { exact: false })).toBeVisible();
  await shot(page, "reconnected");

  const other = await context.newPage();
  try {
    const url = new URL(page.url()); url.hash = "";
    await other.goto(url.toString()); await waitReady(other);
    await other.keyboard.press("Control+Comma");
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await expect.poll(() => checks.length).toBe(1);
    await other.getByRole("button", { name: "Disconnect", exact: true }).click();
    await expect(page.getByText("Off. Connect your running local server", { exact: false })).toBeVisible();
    const replies = healthReplies;
    checks.splice(0).forEach((send) => send());
    await expect.poll(() => healthReplies).toBe(replies + 1);
    await expect(page.getByRole("button", { name: "Connect", exact: true })).toBeEnabled();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Dictate", exact: true })).toHaveAttribute("title", /Connect whisper/);
  } finally { await other.close(); }
});

test("voice: local microphone transcript stays in the draft at the cursor; cancel and late answers are safe", async ({ page, open }) => {
  await open(); await waitReady(page);
  await expect(page.getByRole("button", { name: "Dictate", exact: true })).toBeVisible();
  await shot(page, "off");
  await connect(page);
  await shot(page, "idle");
  const ta = page.locator("#ta");
  await ta.fill("before after");
  await ta.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(7, 7));
  const box = await page.locator(".composer").boundingBox();
  await page.getByRole("button", { name: "Dictate", exact: true }).click();
  await expect(page.getByRole("button", { name: "Stop dictation" })).toContainText("Listening");
  await expect(page.locator(".voice")).toContainText("1s");
  await shot(page, "listening");
  whisper.mode = "slow";
  await page.getByRole("button", { name: "Stop dictation" }).click();
  await expect(page.locator(".voice")).toContainText("Transcribing");
  await shot(page, "transcribing");
  expect(await page.locator(".composer").boundingBox()).toEqual(box);
  // A repeated press does not issue a second transcription.
  await page.locator(".voice").evaluate((el: HTMLButtonElement) => el.click());
  await expect.poll(() => whisper.requests).toBe(1);
  await page.keyboard.press("Escape");
  await expect(page.locator(".voice")).toContainText("Dictate");
  await expect(ta).toHaveValue("before after");
  whisper.mode = "ok";
  await page.keyboard.press("Control+Shift+Space");
  await expect(page.locator(".voice")).toContainText("Listening");
  await expect(page.locator(".voice")).toContainText("1s");
  await page.keyboard.press("Control+Shift+Space");
  await expect(ta).toHaveValue("before spoken words after");
  await expect(page.locator(".turn.u")).toHaveCount(0);
  await shot(page, "transcript");
  await page.getByRole("button", { name: "Dictate", exact: true }).click();
  await expect(page.locator(".voice")).toContainText("Listening");
  await page.keyboard.press("Escape");
  await expect(page.locator(".voice")).toContainText("Dictate");
  expect(whisper.requests).toBe(2);
});

test("voice: permission denial, no microphone, unsupported context, silence and service failure explain recovery", async ({ page, open }) => {
  await open(); await waitReady(page); await connect(page);
  for (const [name, message] of [["NotAllowedError", "permission was denied"], ["NotFoundError", "No microphone found"]]) {
    await page.evaluate((n) => { navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException("fake", n)); }, name!);
    await page.getByRole("button", { name: "Dictate", exact: true }).click();
    await expect(page.locator(".c-note")).toContainText(message!);
    await shot(page, name!);
  }
  await page.reload(); await waitReady(page);
  whisper.text = "";
  await page.getByRole("button", { name: "Dictate", exact: true }).click();
  await expect(page.locator(".voice")).toContainText("1s");
  await page.getByRole("button", { name: "Stop dictation" }).click();
  await expect(page.locator(".c-note")).toContainText("Nothing heard");
  await shot(page, "nothing-heard");
  await whisper.close();
  await page.getByRole("button", { name: "Dictate", exact: true }).click();
  await expect(page.locator(".voice")).toContainText("1s");
  await page.getByRole("button", { name: "Stop dictation" }).click();
  await expect(page.locator(".c-note")).toContainText("did not answer");
  await shot(page, "service-down");
  await page.evaluate(() => { Object.defineProperty(window, "isSecureContext", { configurable: true, value: false }); });
  // Changing the draft forces a render using the unsupported context.
  await page.locator("#ta").fill("kept");
  await page.locator(".voice").evaluate((el: HTMLButtonElement) => el.click());
  await expect(page.locator(".voice")).toHaveAttribute("title", /HTTPS/);
  await expect(page.locator(".c-note")).toContainText("HTTPS");
  await shot(page, "https-required");
});

test("voice: a late permission grant, navigation and the clip limit all release the microphone", async ({ page, open }) => {
  await page.addInitScript(() => {
    const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    const probe = { tracks: [] as MediaStreamTrack[], hold: false, release: () => {} };
    Object.defineProperty(window, "micProbe", { value: probe });
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const stream = await real(constraints);
      probe.tracks.push(...stream.getTracks());
      if (probe.hold) await new Promise<void>((resolve) => { probe.release = resolve; });
      return stream;
    };
  });
  await open(); await waitReady(page); await connect(page);
  await page.setViewportSize({ width: 390, height: 844 });
  // Resizing animates the desktop sidebar offscreen. Capture the microphone
  // permission state after that transition, rather than a half-open drawer.
  await expect.poll(() => page.locator(".sb").evaluate((el) => el.getBoundingClientRect().right)).toBeLessThanOrEqual(0);
  await page.evaluate(() => { (window as unknown as { micProbe: { hold: boolean } }).micProbe.hold = true; });
  await page.getByRole("button", { name: "Dictate", exact: true }).click();
  await expect(page.locator(".voice")).toContainText("Allow mic");
  await expect.poll(() => page.evaluate(() => (window as unknown as { micProbe: { tracks: MediaStreamTrack[] } }).micProbe.tracks.length)).toBe(1);
  await shot(page, "asking-phone");
  await page.keyboard.press("Escape");
  await page.evaluate(() => { const probe = (window as unknown as { micProbe: { hold: boolean; release(): void } }).micProbe; probe.hold = false; probe.release(); });
  await expect.poll(() => page.evaluate(() => (window as unknown as { micProbe: { tracks: MediaStreamTrack[] } }).micProbe.tracks.every((t) => t.readyState === "ended"))).toBe(true);
  await page.clock.install();
  await page.getByRole("button", { name: "Dictate", exact: true }).click();
  await expect(page.locator(".voice")).toContainText("Listening");
  await page.clock.runFor(1100);
  await expect(page.locator(".voice")).toContainText("1s");
  await shot(page, "listening-phone");
  await page.clock.fastForward(61_000);
  await expect(page.locator(".c-note")).toContainText("60 seconds");
  await expect(page.locator(".voice")).toContainText("Dictate");
  await shot(page, "clip-too-long");
  await page.getByRole("button", { name: "Dictate", exact: true }).click();
  await expect(page.locator(".voice")).toContainText("Listening");
  await page.keyboard.press("Control+Comma");
  await expect.poll(() => page.evaluate(() => (window as unknown as { micProbe: { tracks: MediaStreamTrack[] } }).micProbe.tracks.every((t) => t.readyState === "ended"))).toBe(true);
  expect(whisper.requests).toBe(0);
});

test("voice: a transcription timeout recovers without changing the draft", async ({ page, open }) => {
  test.setTimeout(45_000);
  await open(); await waitReady(page); await connect(page);
  await page.locator("#ta").fill("kept draft");
  whisper.mode = "slow";
  await page.getByRole("button", { name: "Dictate", exact: true }).click();
  await expect(page.locator(".voice")).toContainText("1s");
  await page.getByRole("button", { name: "Stop dictation" }).click();
  await expect(page.locator(".c-note")).toContainText("timed out", { timeout: 25_000 });
  await expect(page.locator("#ta")).toHaveValue("kept draft");
  await expect(page.locator(".voice")).toContainText("Dictate");
  await shot(page, "timeout");
});

test("voice: VO-02 one undo removes only the transcript and redo restores it", async ({ page, open }) => {
  await open(); await waitReady(page); await connect(page);
  const ta = page.locator("#ta");
  // Real typing catches speech merging into the preceding edit transaction.
  await ta.pressSequentially("existing draft");
  await page.getByRole("button", { name: "Dictate", exact: true }).click();
  await expect(page.locator(".voice")).toContainText("1s");
  await page.getByRole("button", { name: "Stop dictation" }).click();
  await expect(ta).toHaveValue("existing draft spoken words");
  await ta.press("Control+z");
  await expect(ta).toHaveValue("existing draft");
  await expect(page.locator(".turn.u")).toHaveCount(0);
  await ta.press("Control+Shift+z");
  await expect(ta).toHaveValue("existing draft spoken words");
  // An insertion in the middle preserves the selected words, too.
  await ta.press("Control+z");
  await ta.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(9, 14));
  await page.getByRole("button", { name: "Dictate", exact: true }).click();
  await expect(page.locator(".voice")).toContainText("1s");
  await page.getByRole("button", { name: "Stop dictation" }).click();
  await expect(ta).toHaveValue("existing spoken words draft");
  await ta.press("Control+z");
  await expect(ta).toHaveValue("existing draft");
  await ta.press("Control+Shift+z");
  await expect(ta).toHaveValue("existing spoken words draft");
});
