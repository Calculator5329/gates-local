// Settings row 31 (the 0.2.3 release check): each Settings section switch took about 182 ms where
// 0.2.2 took about 45, the same 135 ms on every section. A switch is at once: the section's own
// heading is on screen within two frames of the click, and the frames after it keep the display's
// pace. The 135 ms was the blur behind the pop-up, repainted on every frame (about 55 ms a frame
// on a computer that draws without a GPU, 17 ms without the blur), not a wait.
import type { Page } from "@playwright/test";
import { expect, navButton, test, waitReady } from "./fixtures.ts";

type Switch = { frames: number; ms: number[] };
type Probe = { sectionSwitch?: Promise<Switch> };

/** Frames from the click until `.set h1` reads `label`, then three more; each frame's time since the click. */
async function switchTo(page: Page, label: string): Promise<Switch> {
  await page.evaluate((want) => {
    (window as Probe).sectionSwitch = new Promise((resolve) => {
      document.addEventListener("click", () => {
        const t0 = performance.now();
        const ms: number[] = [];
        let shown: number | undefined;
        const frame = () => {
          ms.push(performance.now() - t0);
          if (shown === undefined && document.querySelector(".set h1")?.textContent === want) shown = ms.length;
          if ((shown !== undefined && ms.length >= shown + 3) || ms.length >= 60) resolve({ frames: shown ?? ms.length, ms });
          else requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      }, { capture: true, once: true });
    });
  }, label);
  await navButton(page, label).click();
  return page.evaluate(() => (window as Probe).sectionSwitch!);
}

test("a Settings section switch shows the section within two frames, and the frames after keep pace", async ({ page, open }) => {
  await open();
  await waitReady(page);
  await page.keyboard.press("Control+Comma");
  await expect(page.locator(".set h1")).toHaveText("General");
  const labels = await page.locator(".dlg-nav .sb-act .grow").allTextContents();
  expect(labels.length).toBeGreaterThan(4);
  const seen: string[] = [];
  for (const label of [...labels.slice(1), labels[0]!]) {
    const { frames, ms } = await switchTo(page, label);
    // three frames after the one that showed it: at 60 Hz about 50 ms; the blur made it about 110
    const after = ms[frames + 2]! - ms[frames - 1]!;
    seen.push(`${label}: shown on frame ${frames}, next three frames ${Math.round(after)} ms (${ms.map(Math.round).join(" ")})`);
    await expect(page.locator(".set h1")).toHaveText(label);
  }
  console.log(seen.join("\n"));
  await page.screenshot({ path: test.info().outputPath("settings-popup.png"), animations: "disabled" });
  for (const line of seen) {
    expect(line, line).toMatch(/shown on frame [12],/);
    expect(Number(/next three frames (\d+) ms/.exec(line)![1]), line).toBeLessThan(80);
  }
});
