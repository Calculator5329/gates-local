// Settings row 29, the owner 2026-11-13 (proposal 06, he picked A): "how good is this model, whats
// it for, how will it run on my hardware". A Measure button on a model's row; one click runs the
// checks through the chat's own tool loop (Tools, Files, Database, Instructions, Pages) and the
// row keeps the speed and a score out of 100. Pages run in this window, in a sandboxed frame.
// The fake's "measure" scenario passes every check but two (test/fake-ollama/measure-reply.ts):
// Instructions 3 of 4 and Pages 2 of 3, so the score is 90.
import { expect, openModels, stack, test, waitReady } from "./fixtures.ts";
import { FAKE_URL, SERVER_PORT, TOKEN } from "./env.ts";

const chatRequests = async (model: string) => {
  const state = (await (await fetch(`${FAKE_URL}/__fake/state`)).json()) as { requests: { path: string; body: { model?: string } }[] };
  return state.requests.filter((r) => r.path === "/api/chat" && r.body.model === model).length;
};

test("Measure runs only on a click, grades pages in this window, and the score opens its parts and checks", async ({ page, open }, info) => {
  await stack.scenario("measure", { installed: ["qwen3.5:9b", "gemma4:12b"] });
  await open();
  await waitReady(page);
  await openModels(page);
  const row = page.locator('.mp-card .mp-row[data-dm="qwen3.5:9b"]');
  const button = page.getByTestId("settings.models.measure-qwen3-5-9b");
  await expect(button).toBeVisible();
  // nothing is sent to the model before the click
  expect(await chatRequests("qwen3.5:9b")).toBe(0);
  await page.screenshot({ path: info.outputPath("measure-before.png"), animations: "disabled" });

  await button.click();
  // a warm-up, twenty checks and the pages: the button is the progress, one model at a time
  await expect(button).toHaveText(/^Measuring \d+ of 22$/);
  await expect(page.getByTestId("settings.models.measure-gemma4-12b")).toBeDisabled();

  const speed = row.locator(".mp-spd");
  const score = page.getByTestId("settings.models.score-qwen3-5-9b");
  await expect(speed).toHaveText(/^\d+(\.\d)? tok\/s$/, { timeout: 60_000 });
  // the pages were graded here, so the score covers all five parts
  await expect(score).toHaveText("90");
  await expect(score).toHaveAttribute("aria-label", /^Score 90 of 100, /);
  await expect(row.locator(".mp-slow")).toHaveCount(0);
  await expect(page.locator("iframe[data-measure-page]")).toHaveCount(0);
  expect(await chatRequests("gemma4:12b")).toBe(0);
  const sent = await chatRequests("qwen3.5:9b");
  expect(sent).toBeGreaterThan(20);
  await page.screenshot({ path: info.outputPath("measure-after.png"), animations: "disabled" });

  // the score opens the detail: five parts with their weights, and every check with what it needs
  await score.click();
  const detail = page.getByTestId("models.measure.detail");
  await expect(detail).toBeVisible();
  await expect(detail.getByTestId("models.measure.part-tools")).toContainText("4/4");
  await expect(detail.getByTestId("models.measure.part-database")).toContainText("5/5");
  await expect(detail.getByTestId("models.measure.part-instructions")).toContainText("3/4");
  await expect(detail.getByTestId("models.measure.part-pages")).toContainText("2/3");
  await expect(detail.getByTestId("models.measure.pending")).toHaveCount(0);
  await expect(detail.locator(".md-check")).toHaveCount(20);
  const caps = detail.getByTestId("models.measure.check-instr-caps");
  await expect(caps).toHaveClass(/\bno\b/);
  await expect(caps.locator(".md-why")).toBeVisible();
  // the page that shows 37.5 fails on what this window saw it show
  const total = detail.getByTestId("models.measure.check-page-total");
  await expect(total.locator(".md-why")).toHaveText("12.5 times 3 did not show 37.50.");
  await total.locator(".md-cl").click();
  await expect(total.locator(".md-call").last()).toHaveText("37.5 · 50");
  await expect(detail.getByTestId("models.measure.check-page-counter")).toHaveClass(/\bok\b/);
  // a check's evidence: the database call it made through the chat's shell, and its reply
  const top = detail.getByTestId("models.measure.check-db-top");
  await top.locator(".md-cl").click();
  await expect(top.locator(".md-call").first()).toContainText("sqlite3 /data/measure-shop.db");
  await expect(top.locator(".md-reply")).toContainText("Ben Okafor");
  await page.screenshot({ path: info.outputPath("measure-detail.png"), animations: "disabled" });
  await page.keyboard.press("Escape");
  await expect(detail).toBeHidden();

  // the numbers are kept: a reload shows them without measuring again or running a page
  const kept = await speed.textContent();
  await page.reload();
  await waitReady(page);
  await openModels(page);
  await expect(speed).toHaveText(kept!);
  await expect(score).toHaveText("90");
  await expect(page.locator("iframe[data-measure-page]")).toHaveCount(0);
  expect(await chatRequests("qwen3.5:9b")).toBe(sent);

  // on a phone the numbers are a grey line in the row, and the line opens the same detail
  await page.setViewportSize({ width: 390, height: 844 });
  const line = page.getByTestId("settings.models.measure-line-qwen3-5-9b");
  await expect(line).toBeVisible();
  await expect(line).toHaveText(`${kept} · score 90`);
  await line.click();
  await expect(detail).toBeVisible();
  await expect(detail.getByTestId("models.measure.part-pages")).toContainText("2/3");
  await page.screenshot({ path: info.outputPath("measure-phone.png"), animations: "disabled" });
});

// Every check failing at once on the runtime's error is not the model's score: the run stops, the
// earlier measure stays, and the row says the run stopped and why.
test("a Measure the runtime broke keeps the earlier score, and the row says it stopped and why", async ({ page, open }, info) => {
  const installed = ["qwen3.5:9b", "gemma4:12b"];
  await stack.scenario("measure", { installed });
  await open();
  await waitReady(page);
  await openModels(page);
  const row = page.locator('.mp-card .mp-row[data-dm="qwen3.5:9b"]');
  const score = page.getByTestId("settings.models.score-qwen3-5-9b");
  await page.getByTestId("settings.models.measure-qwen3-5-9b").click();
  await expect(score).toHaveText("90", { timeout: 60_000 });
  // from here every reply breaks with the runtime's error
  await stack.scenario("mid-stream-error", { installed });
  await score.click();
  await page.getByTestId("models.measure.again").click();
  // the run's end: the row says why it stopped, or (the bug) a new score took the old one's place
  await expect(row.locator(".act-err").or(score.filter({ hasNotText: /^90$/ }))).toBeVisible({ timeout: 60_000 });
  await row.screenshot({ path: info.outputPath("measure-stopped-row.png"), animations: "disabled" });
  await expect(row.locator(".act-err")).toHaveText(/^Measure stopped at check 1 of 20: .*unexpected EOF/);
  await expect(score).toHaveText("90");
});

// The run is the server's: a window opened while it goes sees it, and the pages run only in the
// window that clicked Measure.
test("a window opened during a Measure sees the run, and only the window that started it runs the pages", async ({ page, open }, info) => {
  await stack.scenario("measure", { installed: ["qwen3.5:9b", "gemma4:12b"], loadDelayMs: 6000 });
  await open();
  await waitReady(page);
  await openModels(page);
  await page.getByTestId("settings.models.measure-qwen3-5-9b").click();
  await expect(page.getByTestId("settings.models.measure-qwen3-5-9b")).toHaveText(/^(Starting|Measuring \d+ of 22)$/);
  const second = await page.context().newPage();
  let frames = 0;
  second.on("frameattached", () => frames++);
  await second.goto(page.url());
  await waitReady(second);
  await openModels(second);
  await expect(second.getByTestId("settings.models.measure-gemma4-12b")).toBeVisible();
  await second.locator(".mp-card").screenshot({ path: info.outputPath("measure-second-window.png"), animations: "disabled" });
  await expect(second.getByTestId("settings.models.measure-qwen3-5-9b")).toHaveText(/^(Starting|Measuring \d+ of 22)$/);
  await expect(second.getByTestId("settings.models.measure-gemma4-12b")).toBeDisabled();
  await expect(page.getByTestId("settings.models.score-qwen3-5-9b")).toHaveText("90", { timeout: 60_000 });
  await expect(second.getByTestId("settings.models.score-qwen3-5-9b")).toHaveText("90");
  expect(frames).toBe(0);
  await second.close();
});

// A page a model wrote runs in this window; in the browser build the window's address carries the
// server's token (?server=…token=…). The fake's counter page shows the address it resolves
// against and its referrer where the check reads, so what the window sends back is what it learnt.
test("a Measure page learns nothing of the window's address", async ({ page, open }) => {
  await stack.scenario("measure", { installed: ["qwen3.5:9b", "gemma4:12b"], measureProbe: 1 });
  const sent: string[] = [];
  page.on("websocket", (ws) => ws.on("framesent", (f) => { if (typeof f.payload === "string" && f.payload.includes("models.measurePages")) sent.push(f.payload); }));
  await open();
  await waitReady(page);
  expect(page.url()).toContain(`token%3D${TOKEN}`);
  await openModels(page);
  await page.getByTestId("settings.models.measure-qwen3-5-9b").click();
  await expect.poll(() => sent.length, { timeout: 60_000 }).toBeGreaterThan(0);
  const told = sent.join("\n");
  // the page did read where it runs: its own one-time address on the server, not the window's
  expect.soft(told).toMatch(new RegExp(`at http://127\\.0\\.0\\.1:${SERVER_PORT}/pages/[0-9a-f]{32}`));
  expect(told).not.toContain(TOKEN);
});
