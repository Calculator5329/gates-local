/// <reference lib="dom" />
import { expect, test, waitReady } from "./fixtures.ts";

// Guards the Library's imports arriving by push: while a sample downloads, its progress moves
// with no repeated read of the imports (the open Library once read them twice a second).
test("a downloading sample's progress moves for three seconds with at most one imports read", async ({ page, open }) => {
  const reads: number[] = [];
  page.on("websocket", socket => socket.on("framesent", frame => {
    const request = JSON.parse(String(frame.payload)) as { method?: string };
    if (request.method === "sources.imports") reads.push(Date.now());
  }));
  await open(); await waitReady(page);
  await page.keyboard.press("Control+Comma");
  await page.getByTestId("settings.nav.open-library").click();
  const button = page.locator('[data-db="sample:chinook"] .fill-btn');
  await expect(button).toHaveText("Download");
  await button.evaluate((el) => {
    const labels: string[] = [];
    (window as unknown as { labels: string[] }).labels = labels;
    new MutationObserver(() => labels.push(el.querySelector(".lab")?.textContent ?? "")).observe(el, { subtree: true, childList: true, characterData: true });
  });
  const start = Date.now();
  await button.click();
  await expect(button).toHaveText(/^\d+%$/);
  // The fake sends 512 bytes every 200 ms, so the 8 KB sample takes about three seconds.
  await expect(button, "the sample finished downloading").toHaveClass(/\bdone\b/, { timeout: 15_000 });
  const seen = (await page.evaluate(() => (window as unknown as { labels: string[] }).labels))
    .filter(label => /^\d+%$/.test(label)).map(label => Number.parseInt(label, 10));
  expect(new Set(seen).size, "the progress moved while Library was open").toBeGreaterThanOrEqual(3);
  expect(seen, "the progress never went back").toEqual(seen.toSorted((a, b) => a - b));
  expect(reads.filter(at => at >= start), "imports reads during the download").toHaveLength(0);
  expect(reads.length, "imports reads since the page opened").toBeLessThanOrEqual(1);
});
