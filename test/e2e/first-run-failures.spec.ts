// Journey: what a person reads when something fails before the first chat. A download that is not
// the pinned file says it couldn't be verified (the checksum in its details), a full disk names the disk, a failed first model says so in
// its offer, and with no card read a model that fits never says the GPU. Each state is shot at
// desktop width with the changed words outlined.
import { fitWords, type FitRow, type FitTable } from "@gates-local/contracts";
import type { Page, TestInfo } from "@playwright/test";
import { expect, openGpuMemory, stack, test, waitReady } from "./fixtures.ts";
import { footerSocket } from "./footer-fixture.ts";
import { fakeRuntime, type Status } from "./runtime-fake.ts";

test.use({ scenario: "no-models", skipFirstRun: false, video: "off", viewport: { width: 1280, height: 800 } });

const HEX = "0123456789abcdef".repeat(4);
const failed = (failure: string, detail: string) => (r: Status): Status => ({ ...r, state: "error", owner: "none", failure, detail });

/** Outline what the change is about, then shoot the page as a person sees it. */
async function shot(page: Page, info: TestInfo, name: string, selector: string): Promise<void> {
  await page.evaluate((sel) => {
    for (const el of document.querySelectorAll<HTMLElement>(sel)) el.style.setProperty("outline", "2px solid #f5a524");
  }, selector);
  await page.mouse.move(2, 2);
  await page.screenshot({ path: info.outputPath(`${name}.png`), animations: "disabled" });
}

// Scorecard Q16: the headline says what happened and what to do in plain words; the checksum is the details'.
test("a download that is not the pinned file says it couldn't be verified, with the checksum kept in the details", async ({ page, open }, info) => {
  const detail = `The Ollama download did not match its pinned checksum (expected sha256 ${HEX}, got ${"fedcba9876543210".repeat(4)}). Nothing was installed. Retry once; if it fails again the release file changed and the pinned manifest needs updating.`;
  await fakeRuntime(page, failed("checksum", detail));
  await open();
  await expect(page.locator(".fr h1")).toHaveText("The download couldn't be verified");
  await expect(page.locator(".fr .sub")).toContainText("Download it again.");
  await expect(page.locator(".fr .sub")).toHaveAttribute("data-why", detail);
  await expect(page.locator(".fr")).not.toContainText("sha256");
  await expect(page.locator(".fr")).not.toContainText("checksum");
  await expect(page.locator(".fr")).not.toContainText("Check the network");
  await shot(page, info, "checksum", ".fr h1, .fr .sub");
});

test("a disk short of room says the disk, with the figure once", async ({ page, open }, info) => {
  await fakeRuntime(page, failed("disk", "The disk is full. Needs 2.4 GB free."));
  await open();
  await expect(page.locator(".fr h1")).toHaveText("Not enough disk space for Ollama");
  expect((await page.locator(".fr").innerText()).split("2.4 GB")).toHaveLength(2);
  await expect(page.locator(".fr")).not.toContainText("didn't install");
  await shot(page, info, "disk", ".fr h1, .fr .sub");
});

test.describe("in the chat", () => {
  test.use({ skipFirstRun: true });

  test("after the first model's download failed, its offer says so once", async ({ page, open }, info) => {
    const s = await footerSocket(page);
    await open();
    const offer = page.locator(".banner", { hasText: "Download your first model" });
    await expect(offer).toContainText("Qwen 3.5 9B");
    s.pull({ name: "qwen3.5:9b", state: "error", completedBytes: 0, totalBytes: 6_600_000_000, message: "no space left on device" });
    await expect(offer).toContainText("Qwen 3.5 9B did not finish downloading.");
    expect((await offer.innerText()).split("did not finish")).toHaveLength(2);
    await shot(page, info, "first-model-failed", ".banner .bm");
  });
});

test.describe("with no card the app can read", () => {
  test.use({ scenario: "models", skipFirstRun: true });

  // A row the server judged in system memory that fits there: the verdict says system memory, and
  // Details never says the GPU beside it. The fake's no-card computer makes every model spill, so
  // the rows are rewritten on the socket to that state.
  test("a model that fits in system memory never says the GPU in Details", async ({ page, open }, info) => {
    await fitsInSystemMemory(page);
    await stack.computer(16, "none");
    await open();
    await waitReady(page);
    const gpu = await openGpuMemory(page);
    await expect(gpu.locator(".fp-v")).toHaveText(/^Should run in system memory/);
    await gpu.locator("details.fp-more summary").click();
    const numbers = gpu.locator(".fp-numbers");
    await expect(numbers).toContainText("Runs in system memory.");
    await expect(numbers).not.toContainText("on the GPU");
    await shot(page, info, "no-card", "#gpuMemory .fp-numbers");
  });
});

/** A row that fits, in the words for a computer with no card read. */
function fits(row: FitRow): FitRow {
  const { card: _card, ...rest } = row;
  const report = { ...rest, verdict: "fits" as const, spillRamBytes: 0 };
  return { ...report, words: fitWords(report, "card", true) };
}
const table = (v: unknown): v is FitTable => typeof v === "object" && v !== null && "rows" in v && "memory" in v;

/** Every fit row the server sends becomes one that fits in system memory. */
async function fitsInSystemMemory(page: Page): Promise<void> {
  await page.routeWebSocket(/\/\?token=/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((raw) => server.send(raw));
    server.onMessage((raw) => {
      if (typeof raw !== "string") return ws.send(raw);
      const m = JSON.parse(raw) as { result?: unknown; payload?: unknown };
      if (table(m.result)) return ws.send(JSON.stringify({ ...m, result: { ...m.result, rows: m.result.rows.map(fits) } }));
      if (table(m.payload)) return ws.send(JSON.stringify({ ...m, payload: { ...m.payload, rows: m.payload.rows.map(fits) } }));
      ws.send(raw);
    });
  });
}
