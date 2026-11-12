/// <reference lib="dom" />
// Nothing moves: the picker opens before the first fit table with same-size
// skeletons, the table fills them in place, and two later tables (each pushed
// by the server after a new GPU reading) change values in place. Every frame
// is sampled: no box moves or resizes from the first frame to the last, and
// after the first table no value is a skeleton or empty.
import { expect, stack, test, waitReady } from "./fixtures.ts";

test.use({ viewport: { width: 1137, height: 749 } });

interface Sample { boxes: Record<string, number[]>; skeletons: number; empty: string[]; footer: string }
interface StillWindow extends Window { stillFrames?: Sample[]; stillStop?: () => void }

// Rows, context rows, the footer and the picker keep their whole box. A value's own text may be
// wider or narrower than its skeleton, so a value keeps its line: top and height.
const shape = (key: string, b: number[] | undefined) => JSON.stringify(/^(value|cost|memory)\b/u.test(key) ? b && [b[1], b[3]] : b);

test("the picker's fit values fill and change in place: first table, then two pushes", async ({ page, open }) => {
  let holding = true;
  const held: (() => void)[] = [];
  await page.routeWebSocket(/.*/, ws => {
    const server = ws.connectToServer(), asked = new Set<unknown>();
    ws.onMessage(message => {
      const frame = JSON.parse(String(message)) as { id?: unknown; method?: string };
      if (frame.method === "fit.table") asked.add(frame.id);
      server.send(message);
    });
    server.onMessage(message => {
      const frame = JSON.parse(String(message)) as { id?: unknown; type?: string; channel?: string };
      const table = (frame.type === "response" && asked.delete(frame.id)) || (frame.type === "push" && frame.channel === "fit.changed");
      if (table && holding) held.push(() => ws.send(message));
      else ws.send(message);
    });
  });
  await open(); await waitReady(page);
  await page.locator("#modelBtn").click();
  const picker = page.locator("#picker");
  await expect(picker.locator(".pk-context")).toBeVisible();
  await expect.poll(() => held.length, "the first table is held").toBeGreaterThan(0);
  await expect(picker.locator(".pk-cost .fit-skel").first()).toBeVisible();
  await expect(picker.locator(".pk-bottom .fit-skel")).toBeVisible();

  await page.evaluate(() => {
    const w = window as StillWindow;
    w.stillFrames = [];
    let active = true;
    w.stillStop = () => { active = false; };
    const sample = () => {
      const root = document.getElementById("picker");
      const boxes: Record<string, number[]> = {};
      const box = (key: string, el: Element | null | undefined) => {
        if (!el) return;
        const r = el.getBoundingClientRect();
        boxes[key] = [r.x, r.y, r.width, r.height];
      };
      box("picker", root);
      box("footer", root?.querySelector(".pk-bottom"));
      box("memory", root?.querySelector(".pk-bottom > span:last-child"));
      for (const row of root?.querySelectorAll<HTMLElement>(".pk-r") ?? []) {
        box(`row ${row.dataset["m"]}`, row);
        box(`value ${row.dataset["m"]}`, row.querySelector(".pk-v"));
      }
      for (const row of root?.querySelectorAll<HTMLElement>(".pk-ctx-row") ?? []) {
        box(`context ${row.dataset["ctx"]}`, row);
        box(`cost ${row.dataset["ctx"]}`, row.querySelector(".pk-cost, .pk-cap"));
      }
      const empty = [
        ...[...root?.querySelectorAll<HTMLElement>(".pk-r") ?? []].filter(r => !r.querySelector(".pk-v")?.textContent?.trim()).map(r => `row ${r.dataset["m"]}`),
        ...[...root?.querySelectorAll<HTMLElement>(".pk-ctx-row") ?? []].filter(r => !r.querySelector(".pk-cost, .pk-cap")?.textContent?.trim()).map(r => `context ${r.dataset["ctx"]}`),
      ];
      const footer = root?.querySelector(".pk-bottom > span:last-child")?.textContent?.trim() ?? "";
      w.stillFrames?.push({ boxes, skeletons: root?.querySelectorAll(".fit-skel, .pk-cost.skel").length ?? 0, empty: footer ? empty : [...empty, "footer"], footer });
      if (active) requestAnimationFrame(sample);
    };
    sample();
  });
  const frames = () => page.evaluate(() => (window as StillWindow).stillFrames ?? []);
  const footer = async () => (await frames()).at(-1)?.footer ?? "";

  // The first table.
  holding = false;
  for (const release of held.splice(0)) release();
  await expect(picker.locator(".fit-skel, .pk-cost.skel")).toHaveCount(0);
  // The samples run on animation frames, so the last one can still hold the skeleton's empty footer:
  // read the first table's footer from a sample that has it, or the first poll passes on the table itself.
  await expect.poll(async () => (await frames()).at(-1)?.skeletons, "a sampled frame with the first table").toBe(0);
  const first = await footer();
  // Two new GPU readings; the server pushes a table after each.
  await stack.gpu(1024);
  await expect.poll(footer, { message: "the first push changes the footer", timeout: 15_000 }).not.toBe(first);
  const second = await footer();
  await stack.gpu(2560);
  await expect.poll(footer, { message: "the second push changes the footer", timeout: 15_000 }).not.toBe(second);
  // A few more frames after the last change.
  await page.evaluate(() => new Promise<void>(resolve => { let n = 10; const f = () => --n ? requestAnimationFrame(f) : resolve(); requestAnimationFrame(f); }));
  await page.evaluate(() => (window as StillWindow).stillStop?.());
  const all = await frames();

  const tabled = all.findIndex(f => f.skeletons === 0);
  expect(tabled, "a frame with the first table").toBeGreaterThan(0);
  expect(all[0]?.skeletons, "the sampling starts on the skeletons").toBeGreaterThan(0);
  const footers = [...new Set(all.slice(tabled).map(f => f.footer))];
  expect(footers.length, `footer values after the first table: ${footers.join(" | ")}`).toBeGreaterThanOrEqual(3);
  const after = all.slice(tabled);
  expect(after.filter(f => f.skeletons > 0).length, "frames with a skeleton after the first table").toBe(0);
  expect([...new Set(after.flatMap(f => f.empty))], "values empty in some frame after the first table").toEqual([]);
  const base = all[0]?.boxes ?? {};
  const moved = new Set<string>();
  for (const f of all) {
    for (const key of new Set([...Object.keys(base), ...Object.keys(f.boxes)])) {
      if (shape(key, base[key]) !== shape(key, f.boxes[key])) moved.add(`${key}: ${JSON.stringify(base[key])} -> ${JSON.stringify(f.boxes[key])}`);
    }
  }
  expect([...moved], `boxes that moved or resized across ${all.length} frames`).toEqual([]);
  await test.info().attach("fit-still-frames", { body: JSON.stringify({ frames: all.length, tabled, footers }), contentType: "application/json" });
});
