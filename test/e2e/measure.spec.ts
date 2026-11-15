// Settings row 29, the owner 2026-11-13 (proposal 06, he picked A): "how good is this model, whats
// it for, how will it run on my hardware". A Measure button on a model's row; one click runs the
// checks through the chat's own tool loop (Tools, Files, Database, Instructions, Pages) and the
// row keeps the speed and a score out of 100. Pages run in this window, in a sandboxed frame.
// The fake's "measure" scenario passes every check but two (test/fake-ollama/measure-reply.ts):
// Instructions 4 of 5 and Pages 2 of 3, so the score is 90.
import type { Page } from "@playwright/test";
import { createClient, type PageAction, type PageSeen } from "@gates-local/contracts";
import { CASES, pageIn, type PageCase } from "../../apps/server/src/measure/cases.ts";
import { framed } from "../../apps/web/src/measure-harness.ts";
import { WRONG } from "../fake-ollama/measure-reply.ts";
import { LEFT_PATH } from "../fake-ollama/page-replies.ts";
import { expect, openModels, stack, test, waitReady } from "./fixtures.ts";
import { FAKE_URL, SERVER_PORT, TOKEN } from "./env.ts";

/** A run's steps: the speed request, each check, and the pages. */
const RUN_STEPS = CASES.length + 2;
/** The Measure button while a run goes. */
const BUSY = new RegExp(`^(Starting|Measuring \\d+ of ${RUN_STEPS})$`);

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
  await expect(button).toHaveText(new RegExp(`^Measuring \\d+ of ${RUN_STEPS}$`));
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
  await expect(detail.getByTestId("models.measure.part-tools")).toContainText("5/5");
  await expect(detail.getByTestId("models.measure.part-files")).toContainText("5/5");
  await expect(detail.getByTestId("models.measure.part-database")).toContainText("5/5");
  await expect(detail.getByTestId("models.measure.part-instructions")).toContainText("4/5");
  await expect(detail.getByTestId("models.measure.part-pages")).toContainText("2/3");
  await expect(detail.getByTestId("models.measure.pending")).toHaveCount(0);
  await expect(detail.locator(".md-check")).toHaveCount(CASES.length);
  // the three newer kinds, played right: the fact the files lack, the follow-up, the exact fix
  for (const id of ["files-absent", "tools-followup", "instr-fix"]) await expect(detail.getByTestId(`models.measure.check-${id}`)).toHaveClass(/\bok\b/);
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
  await expect(row.locator(".act-err")).toHaveText(new RegExp(`^Measure stopped at check 1 of ${CASES.length}: .*unexpected EOF`));
  await expect(score).toHaveText("90");
});

// The run is the server's: a window opened while it goes sees it, and the pages run only in the
// window that clicked Measure.
test("a window opened during a Measure sees the run, and only the window that started it runs the pages", async ({ page, open }, info) => {
  test.info().annotations.push({ type: "budget", description: "the fake holds the model's load for 6 s so a second window opens while the run goes" });
  await stack.scenario("measure", { installed: ["qwen3.5:9b", "gemma4:12b"], loadDelayMs: 6000 });
  await open();
  await waitReady(page);
  await openModels(page);
  await page.getByTestId("settings.models.measure-qwen3-5-9b").click();
  await expect(page.getByTestId("settings.models.measure-qwen3-5-9b")).toHaveText(BUSY);
  const second = await page.context().newPage();
  let frames = 0;
  second.on("frameattached", () => frames++);
  await second.goto(page.url());
  await waitReady(second);
  await openModels(second);
  await expect(second.getByTestId("settings.models.measure-gemma4-12b")).toBeVisible();
  await second.locator(".mp-card").screenshot({ path: info.outputPath("measure-second-window.png"), animations: "disabled" });
  await expect(second.getByTestId("settings.models.measure-qwen3-5-9b")).toHaveText(BUSY);
  await expect(second.getByTestId("settings.models.measure-gemma4-12b")).toBeDisabled();
  await expect(page.getByTestId("settings.models.score-qwen3-5-9b")).toHaveText("90", { timeout: 60_000 });
  await expect(second.getByTestId("settings.models.score-qwen3-5-9b")).toHaveText("90");
  expect(frames).toBe(0);
  await second.close();
});

// A reload in the middle of a Measure keeps the row's running state: the server's record of the run
// comes with the window's first read, so the row says it is measuring, a second window says so too,
// and the run ends with a score. The window that started the run is gone, so the first window that
// sees the pending pages claims them from the server and runs them; any other is refused the claim.
// The reloaded window and a second one are both open when the pages come due, so a claim that let
// both through would run the pages twice and fail here.
// Before this, no window ran them: the run waited its 30 s and left Pages out.
test("a reload during a Measure still shows it measuring, and one of two open windows runs the pages, once", async ({ page, open }, info) => {
  test.setTimeout(120_000);
  test.info().annotations.push({ type: "budget", description: "the fake holds the model's load for 6 s so the reload lands while the run goes" });
  await stack.scenario("measure", { installed: ["qwen3.5:9b", "gemma4:12b"], loadDelayMs: 6000 });
  await open();
  await waitReady(page);
  await openModels(page);
  const button = page.getByTestId("settings.models.measure-qwen3-5-9b");
  await button.click();
  await expect(button).toHaveText(BUSY);
  const sent = pagesSent(page);
  await page.reload();
  await waitReady(page);
  await openModels(page);
  await expect(button).toHaveText(BUSY);
  await expect(button).toBeDisabled();
  await page.locator(".mp-card").screenshot({ path: info.outputPath("measure-after-reload.png"), animations: "disabled" });
  const second = await page.context().newPage();
  const sentSecond = pagesSent(second);
  await second.goto(page.url());
  await waitReady(second);
  await openModels(second);
  await expect(second.getByTestId("settings.models.measure-qwen3-5-9b")).toHaveText(BUSY);
  // both windows stay open while the pages come due, so both are told of them and either could run them
  const score = page.getByTestId("settings.models.score-qwen3-5-9b");
  await expect(score).toHaveText(/^\d+$/, { timeout: 90_000 });
  await expect(second.getByTestId("settings.models.score-qwen3-5-9b")).toHaveText(/^\d+$/);
  await second.close();
  await score.click();
  await page.getByTestId("models.measure.detail").screenshot({ path: info.outputPath("measure-reload-detail.png"), animations: "disabled" });
  // the pages were run and graded, so the score covers all five parts
  await expect(page.getByTestId("models.measure.left-out")).toHaveCount(0);
  await expect(page.getByTestId("models.measure.part-pages")).toContainText("2/3");
  await expect(score).toHaveText("90");
  // of the two windows open when they came due, one ran them, once
  expect(sent.length + sentSecond.length).toBe(1);
  await expect(page.locator("iframe[data-measure-page]")).toHaveCount(0);
});

// Two scores side by side are read as made alike unless the row says how they differ: one measured
// with no window open to run its pages leaves Pages out, and its row marks that beside the number.
test("a score that left a part out is marked beside its number, and a full one is not", async ({ page, open }, info) => {
  test.setTimeout(150_000);
  test.info().annotations.push({ type: "budget", description: "the second model's pages wait the server's 30 s for a window before they are left out" });
  await stack.scenario("measure", { installed: ["qwen3.5:9b", "gemma4:12b"] });
  // the second model measured with no window open: nothing runs its pages
  const client = createClient(new WebSocket(`ws://127.0.0.1:${SERVER_PORT}/?token=${TOKEN}`));
  try {
    await client.negotiate();
    await client.call("models.measure", { name: "gemma4:12b" });
    // done: no run going, and its pages no longer wait
    await expect.poll(async () => {
      const r = await client.call("models.measures", {});
      return r.run === undefined && r.measures.some((m) => m.model === "gemma4:12b" && m.checks.every((c) => c.state !== "pending"));
    }, { timeout: 100_000, intervals: [1000] }).toBe(true);
  } finally { client.close(); }
  await open();
  await waitReady(page);
  await openModels(page);
  await page.getByTestId("settings.models.measure-qwen3-5-9b").click();
  const full = page.getByTestId("settings.models.score-qwen3-5-9b");
  const short = page.getByTestId("settings.models.score-gemma4-12b");
  await expect(full).toHaveText("90", { timeout: 60_000 });
  await expect(full.getByTestId("settings.models.score-short")).toHaveCount(0);
  await expect(short.getByTestId("settings.models.score-short")).toHaveAttribute("data-tip", "Without Pages");
  await expect(short).toHaveAttribute("aria-label", /, Without Pages/);
  const rows = page.locator(".mp-card");
  // before: the same two scores as the row showed them, bare numbers with nothing to tell them apart
  const marks = await page.addStyleTag({ content: '[data-testid="settings.models.score-short"],[data-testid="settings.models.score-think"]{display:none!important}' });
  await rows.screenshot({ path: info.outputPath("scores-before.png"), animations: "disabled" });
  await marks.evaluate((el) => (el as HTMLStyleElement).remove());
  await short.getByTestId("settings.models.score-short").hover();
  await expect(page.locator("#tip")).toHaveText("Without Pages");
  await page.screenshot({ path: info.outputPath("scores-after.png"), animations: "disabled" });
  // the detail says what was left out once, and the parts table has no Pages
  await short.click();
  const detail = page.getByTestId("models.measure.detail");
  await expect(detail.getByTestId("models.measure.left-out")).toHaveText("The score leaves Pages out.");
  await expect(detail.getByTestId("models.measure.skipped-pages")).toHaveCount(1);
  await detail.screenshot({ path: info.outputPath("scores-short-detail.png"), animations: "disabled" });
});

// On a phone the row's menu is the way in to Measure; the destructive item comes last.
test("the model row's menu puts Remove last, after Measure", async ({ page, open }, info) => {
  await stack.scenario("measure", { installed: ["qwen3.5:9b", "gemma4:12b"] });
  await page.setViewportSize({ width: 390, height: 844 });
  await open();
  await waitReady(page);
  await openModels(page);
  const row = page.locator('.mp-card .mp-row[data-dm="qwen3.5:9b"]');
  await row.getByTestId("models.row-menu.open").click();
  const menu = row.getByRole("menu");
  await expect(menu.getByTestId("models.row-menu.measure")).toBeVisible();
  const items = await menu.getByRole("menuitem").evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));
  await menu.screenshot({ path: info.outputPath("measure-row-menu.png"), animations: "disabled" });
  expect(items.at(-1)).toBe("models.row-menu.remove");
  expect(items.indexOf("models.row-menu.measure")).toBe(items.length - 2);
});

// Each page check's reference, the page a model that gets it right writes, used by the window's own
// page harness in a sandboxed frame of a real browser and graded as the server grades it. The wrong
// total the fake writes fails the same way, so the grade here can fail.
test("every page check's reference page passes through the window's page harness, and a wrong one fails", async ({ page }) => {
  await page.setContent("<!doctype html><html><body></body></html>");
  const use = async (code: string, script: readonly PageAction[]) => page.evaluate((srcdoc) => new Promise<{ seen: string[]; error?: string }>((resolve) => {
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts");
    addEventListener("message", (e) => { if (e.source === frame.contentWindow) resolve(e.data as { seen: string[]; error?: string }); });
    frame.srcdoc = srcdoc;
    document.body.append(frame);
  }), framed(code, "t", script));
  const pages = CASES.filter((c): c is PageCase => c.kind === "page");
  expect(pages.map((c) => c.id)).toEqual(["page-counter", "page-filter", "page-total"]);
  for (const c of pages) {
    const seen = await use(pageIn(c.reference.answer)!, c.script);
    expect([c.id, seen.error, c.expect(seen.seen)]).toEqual([c.id, undefined, undefined]);
  }
  const total = pages.find((c) => c.id === "page-total")!;
  expect(total.expect((await use(pageIn(WRONG["page-total"]!)!, total.script)).seen)).toBe("12.5 times 3 did not show 37.50.");
});

// The probe pages want out (test/fake-ollama/measure-reply.ts), so the browser logs what it refuses
// them, as in pages-lockdown.spec.ts.
test.describe("Measure's pages run locked down", () => {
  test.use({ allowedErrors: [/Content Security Policy|Refused to|ERR_BLOCKED_BY|Blocked (opening|script execution|a frame|form)|sandbox|Unsafe attempt to initiate navigation|Failed to load resource/i] });

  // A page a model wrote runs in this window; in the browser build the window's address carries the
  // server's token (?server=…token=…). The fake's counter page shows the address it resolves
  // against and its referrer where the check reads, so what the window sends back is what it learnt.
  test("a Measure page learns nothing of the window's address", async ({ page, open }) => {
    const sent = pagesSent(page);
    await startMeasure(page, async () => { await open(); expect(page.url()).toContain(`token%3D${TOKEN}`); });
    await expect.poll(() => sent.length, { timeout: 60_000 }).toBeGreaterThan(0);
    const told = sent.join("\n");
    // the page did read where it runs: its own one-time address on the server, not the window's
    expect.soft(told).toMatch(new RegExp(`at http://127\\.0\\.0\\.1:${SERVER_PORT}/pages/[0-9a-f]{32}`));
    expect(told).not.toContain(TOKEN);
  });

  // The chat's escape probe as Measure's total page, and a page that moves its own frame as the
  // filter page: each way out fails as it does for a page in a chat (pages-lockdown.spec.ts).
  test("a Measure page is held to the limits of a page in a chat", async ({ page, open }) => {
    const sent = pagesSent(page);
    const before = await leftRequests();
    await startMeasure(page, open);
    const at = page.url();
    await expect.poll(() => sent.length, { timeout: 60_000 }).toBeGreaterThan(0);
    const pages = pagesOf(JSON.parse(sent[0]!));
    const total = pages.find((p) => p.id === "page-total");
    const r = JSON.parse(total?.seen.at(-1) ?? "{}") as Record<string, unknown>;
    test.info().annotations.push({ type: "probe", description: JSON.stringify(r) });
    // the address: no referrer, the server's page address, nothing with the token in it
    expect.soft(r["referrer"]).toBe("");
    expect.soft(r["href"]).toMatch(PAGE_ADDRESS);
    expect.soft(JSON.stringify(r)).not.toContain(TOKEN);
    // the app's window
    expect.soft(r["parentDocument"]).toBe("threw SecurityError");
    expect.soft(r["parentHref"]).toBe("threw SecurityError");
    expect.soft(r["topHref"]).toBe("threw SecurityError");
    // storage
    expect.soft(r["localStorage"]).toBe("threw SecurityError");
    expect.soft(r["sessionStorage"]).toBe("threw SecurityError");
    expect.soft(r["cookie"]).toBe("threw SecurityError");
    expect.soft(r["indexedDB"]).toBe("threw SecurityError");
    // the network: nothing goes out, pictures only from data:
    expect.soft(r["fetched"]).toBe("failed TypeError");
    expect.soft(r["webImage"]).toBe("failed");
    expect.soft(r["dataImage"]).toBe("loaded");
    expect.soft(r["eval"]).toBe("threw EvalError");
    expect.soft(r["childFrame"]).toBe("refused");
    expect.soft(r["popup"]).toBe("null");
    // the page that moves its frame: the window stays, and the fake server is asked nothing
    const moved = pages.find((p) => p.id === "page-filter");
    test.info().annotations.push({ type: "moved", description: JSON.stringify(moved) });
    expect(page.url()).toBe(at);
    expect(await leftRequests()).toEqual(before);
    await expect(page.getByTestId("settings.models.score-qwen3-5-9b")).toBeVisible({ timeout: 30_000 });
    expect(await leftRequests()).toEqual(before);
  });
});

/** What this window sent back of the measure's pages, once it has sent them. */
function pagesSent(page: Page): string[] {
  const sent: string[] = [];
  page.on("websocket", (ws) => ws.on("framesent", (f) => { if (typeof f.payload === "string" && f.payload.includes('"models.measurePages"')) sent.push(f.payload); }));
  return sent;
}
/** Measure on the probe pages, from a fresh window. */
async function startMeasure(page: Page, open: () => Promise<void>): Promise<void> {
  await stack.scenario("measure", { installed: ["qwen3.5:9b", "gemma4:12b"], measureProbe: 1 });
  await open();
  await waitReady(page);
  await openModels(page);
  await page.getByTestId("settings.models.measure-qwen3-5-9b").click();
}
/** A served page's address: the server's page route under a one-time id. */
const PAGE_ADDRESS = new RegExp(`^http://127\\.0\\.0\\.1:${SERVER_PORT}/pages/[0-9a-f]{32}$`);
/** What the fake server was asked by anything that left a page's limits. */
const leftRequests = async () => ((await (await fetch(`${FAKE_URL}/__fake/state`)).json()) as { requests: { path: string }[] }).requests.map((r) => r.path).filter((p) => p.startsWith(LEFT_PATH));
/** The pages in a models.measurePages request, wherever the frame keeps its params. */
function pagesOf(v: unknown): PageSeen[] {
  if (v === null || typeof v !== "object") return [];
  const pages = (v as { pages?: unknown }).pages;
  if (Array.isArray(pages)) return pages as PageSeen[];
  return Object.values(v).flatMap(pagesOf);
}
