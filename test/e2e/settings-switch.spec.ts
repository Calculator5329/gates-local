// Settings row 31 (the 0.2.3 release check): each Settings section switch took about 182 ms where
// 0.2.2 took about 45, the same 135 ms on every section. A switch is at once: the section's own
// heading is on screen within two frames of the click, and the frames after it keep the display's
// pace. The 135 ms was the blur behind the pop-up, repainted on every frame (about 55 ms a frame
// on a computer that draws without a GPU, 17 ms without the blur), not a wait.
import type { Page } from "@playwright/test";
import { expect, navButton, test, waitReady } from "./fixtures.ts";

type Switch = { frames: number; ms: number[] };
type Probe = { sectionSwitch?: Promise<Switch> };

/** Three frames with nothing changing: the pace this machine draws at just before a switch. */
async function idlePace(page: Page): Promise<number> {
  return page.evaluate(() => new Promise<number>((resolve) => {
    const ms: number[] = [];
    const frame = () => {
      ms.push(performance.now());
      if (ms.length === 4) resolve(ms[3]! - ms[0]!);
      else requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }));
}

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
  const limits: number[] = [];
  for (const label of [...labels.slice(1), labels[0]!]) {
    const idle = await idlePace(page);
    const { frames, ms } = await switchTo(page, label);
    // three frames after the one that showed it: at 60 Hz about 50 ms; the blur made it about 110
    const after = ms[frames + 2]! - ms[frames - 1]!;
    // why: a busy machine draws idle frames slowly too; the cap keeps the blur's 165 ms a red
    limits.push(Math.min(idle, 90) + 30);
    seen.push(`${label}: shown on frame ${frames}, next three frames ${Math.round(after)} ms, idle ${Math.round(idle)} ms (${ms.map(Math.round).join(" ")})`);
    await expect(page.locator(".set h1")).toHaveText(label);
  }
  console.log(seen.join("\n"));
  await page.screenshot({ path: test.info().outputPath("settings-popup.png"), animations: "disabled" });
  for (const [i, line] of seen.entries()) {
    expect(line, line).toMatch(/shown on frame [12],/);
    expect(Number(/next three frames (\d+) ms/.exec(line)![1]), line).toBeLessThan(limits[i]!);
  }
});
