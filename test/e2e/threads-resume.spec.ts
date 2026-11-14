/// <reference lib="dom" />
import { test, expect, waitReady } from "./fixtures.ts";
import { INSTALLED, configure, start } from "./threads-support.ts";

test.use({ installed: INSTALLED, video: "on" });

// Guards a shipped bug fix: returning to a live reply showed it empty before the words came back.
test("returning to a live reply shows the already received prefix on the first committed frame", async ({ page, open }, testInfo) => {
  await open(); await waitReady(page);
  await configure({ prompts: { alpha: { holdAfterTokens: 28 }, beta: { holdAfterTokens: 28 } }, parallelLimit: 2 });
  await start(page, "alpha");
  await expect(page.locator(".turn.a .md p")).toHaveCount(3);
  const received = Number(await page.locator(".turn.a").getAttribute("data-received"));
  await page.getByTestId("sidebar.top.new-thread").click();
  await start(page, "beta");
  await expect(page.locator(".turn.a .md p")).toHaveCount(3);
  const first = await page.locator(".sb-row", { hasText: "alpha" }).locator(".sb-thread").evaluate(button => new Promise<number>(resolve => {
    const observer = new MutationObserver(() => {
      if (document.querySelector(".turn.u .bubble")?.textContent !== "alpha") return;
      const reply = document.querySelector<HTMLElement>(".turn.a");
      if (reply) { observer.disconnect(); resolve(Number(reply.dataset["revealed"])); }
    });
    observer.observe(document.querySelector(".stage")!, { childList: true, subtree: true, attributes: true });
    (button as HTMLButtonElement).click();
  }));
  expect(first).toBeGreaterThanOrEqual(received);
  // Keep the immediate-commit probe above; capture after the entrance fade
  // so the evidence shows the words rather than its first transparent frame.
  await expect(page.locator(".sb-row.on .t")).toHaveText("alpha");
  await expect(page.locator(".turn.u .bubble")).toHaveText("alpha");
  await expect(page.locator(".turn.a .md")).toContainText("Reply 1 for alpha.");
  await expect(page.locator(".turn.a")).toHaveCSS("opacity", "1");
  await page.screenshot({ path: testInfo.outputPath("resumed-current-text.png") });
});
