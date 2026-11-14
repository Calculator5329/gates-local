// Settings row 29, the owner 2026-11-13 (proposal 06, he picked A): "how good is this model, whats
// it for, how will it run on my hardware". A Measure button on a model's row; one click runs a
// short check on this computer (speed, tool use, questions against a database) and the row keeps
// the numbers. Nothing uses the card unless asked.
import { expect, openModels, stack, test, waitReady } from "./fixtures.ts";
import { FAKE_URL } from "./env.ts";

const chatRequests = async (model: string) => {
  const state = (await (await fetch(`${FAKE_URL}/__fake/state`)).json()) as { requests: { path: string; body: { model?: string } }[] };
  return state.requests.filter((r) => r.path === "/api/chat" && r.body.model === model).length;
};

test("Measure runs only on a click, shows its steps, and the row keeps the speed and score", async ({ page, open }, info) => {
  await stack.scenario("models", { installed: ["qwen3.5:9b", "gemma4:12b"] });
  await open();
  await waitReady(page);
  await openModels(page);
  const row = page.locator('.mp-card .mp-row[data-dm="qwen3.5:9b"]');
  const button = page.getByTestId("settings.models.measure-qwen3-5-9b");
  await expect(button).toBeVisible();
  await expect(page.getByTestId("settings.models.measure-gemma4-12b")).toBeVisible();
  await expect(page.locator(".mp-th")).toContainText("Speed");
  await expect(page.locator(".mp-th")).toContainText("Score");
  // nothing is sent to the model before the click
  expect(await chatRequests("qwen3.5:9b")).toBe(0);
  await page.screenshot({ path: info.outputPath("measure-before.png"), animations: "disabled" });

  await button.click();
  // its steps show on the button while it runs, and the other row cannot start a second run
  await expect(button).toHaveText(/^Measuring \d of 9$/);
  await expect(page.getByTestId("settings.models.measure-gemma4-12b")).toBeDisabled();
  await page.screenshot({ path: info.outputPath("measure-running.png"), animations: "disabled" });

  const speed = row.locator(".mp-spd");
  const score = row.locator(".mp-score");
  await expect(speed).toHaveText(/^\d+(\.\d)? TPS$/, { timeout: 30_000 });
  await expect(score).toHaveText(/^\d{1,3}$/);
  await expect(button).toHaveCount(0);
  await expect(score).toHaveAttribute("data-tip", /^Passed \d of 8 checks on this computer: tool use \d of 3, database questions \d of 5/);
  // a speed check and eight checks, one request each
  expect(await chatRequests("qwen3.5:9b")).toBe(9);
  expect(await chatRequests("gemma4:12b")).toBe(0);
  await expect(page.getByTestId("settings.models.measure-gemma4-12b")).toBeEnabled();
  await page.screenshot({ path: info.outputPath("measure-after.png"), animations: "disabled" });

  // the numbers are kept: a reload shows them without measuring again
  const kept = [await speed.textContent(), await score.textContent()];
  await page.reload();
  await waitReady(page);
  await openModels(page);
  await expect(speed).toHaveText(kept[0]!);
  await expect(score).toHaveText(kept[1]!);
  expect(await chatRequests("qwen3.5:9b")).toBe(9);

  // on a phone the numbers are a grey line of their own, inside the row, and Measure is in the row's menu
  await page.setViewportSize({ width: 390, height: 844 });
  const line = row.locator(".mp-mline");
  await expect(line).toBeVisible();
  await expect(line).toHaveText(`${kept[0]} · score ${kept[1]}`);
  // the settings page remounts as the phone layout after the resize, its boxes all zero for a moment;
  // a zero-sized card is "not yet", so the words' edge is polled until the card is laid out
  const past = () =>
    line.evaluate((el) => {
      const words = document.createRange();
      words.selectNodeContents(el);
      const card = el.closest(".mp-card")!.getBoundingClientRect();
      return card.width === 0 ? Number.NaN : words.getBoundingClientRect().right - card.right;
    });
  await expect.poll(past, { message: "the line's words end inside the card", timeout: 3000 }).toBeLessThanOrEqual(0);
  await expect(page.getByTestId("settings.models.measure-gemma4-12b")).toBeHidden();
  await row.getByTestId("models.row-menu.open").click();
  await expect(row.getByTestId("models.row-menu.measure")).toHaveText("Measure again");
  await page.screenshot({ path: info.outputPath("measure-phone.png"), animations: "disabled" });
});
