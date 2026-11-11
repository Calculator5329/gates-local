/// <reference lib="dom" />
// The owner's picker, 2026-11-11: a 27B model loaded at 16k and partly in
// system memory, the picker open on it, then a new GPU reading. What the owner
// should see: every context row on one basis (a larger context never needs
// less), the list row agreeing with the chosen context row, and every frame
// showing one reading, the footer included: never an older reading's value
// after a newer one, and no "previous check" in between.
import { FAKE_URL } from "./env.ts";
import { expect, stack, test, waitReady } from "./fixtures.ts";

const MODEL = "qwen3.8-abliterated:27b";
const GIB = 1024 ** 3;
const CONTEXTS = [8192, 16384, 32768, 65536] as const;

interface Frame { list: string; rows: string[]; footer: string }
const key = (f: Frame) => JSON.stringify(f);
const need = (text: string) => Number(/(\d+(?:\.\d+)?)\s*GB/u.exec(text)?.[1] ?? Number.NaN);

test.use({ viewport: { width: 1440, height: 900 } });

test("one reading and one basis across the picker while the GPU reading changes", async ({ page, open }, info) => {
  // The model's GPU part is capped at 10 GiB; the rest of its 17.4 GiB sits in system memory.
  await stack.scenario("models", { vramCapBytes: 10 * GIB });
  const loaded = await fetch(`${FAKE_URL}/api/generate`, { method: "POST", body: JSON.stringify({ model: MODEL, prompt: "", options: { num_ctx: 16384 } }) });
  expect(loaded.ok).toBe(true);

  await open(); await waitReady(page);
  await page.locator("#modelBtn").click();
  const row = page.locator(`#picker [data-m="${MODEL}"]`);
  await row.hover();
  const values = page.locator("#picker .pk-ctx-row .pk-cost-caption > span:first-child");
  await expect(values).toHaveCount(CONTEXTS.length);
  await expect(row.locator(".pk-v")).toHaveText(/GB/u);
  for (const c of CONTEXTS) await expect(page.locator(`#picker [data-ctx="${c}"] .pk-cost-caption`)).toBeVisible();

  // The page records what each frame shows: the list row, each context row and the footer.
  await page.evaluate((model) => {
    const w = window as unknown as { fitFrames: string[]; fitStop: boolean };
    w.fitFrames = []; w.fitStop = false;
    const sample = () => {
      const picker = document.getElementById("picker");
      const read = (sel: string, root?: ParentNode) => ((root ?? picker)?.querySelector(sel)?.textContent ?? "").replace(/\s+/gu, " ").trim();
      const frame = {
        list: read(`[data-m="${CSS.escape(model)}"] .pk-v`),
        rows: [...(picker?.querySelectorAll(".pk-ctx-row") ?? [])].map((r) => `${read(".pk-cost-caption", r)}|${(r.querySelector<HTMLElement>(".pk-cost-fill")?.style.width) ?? ""}`),
        footer: read(".pk-bottom > span:last-child"),
      };
      const k = JSON.stringify(frame);
      if (w.fitFrames.at(-1) !== k) w.fitFrames.push(k);
      if (!w.fitStop) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }, MODEL);
  const frames = async () => (await page.evaluate(() => (window as unknown as { fitFrames: string[] }).fitFrames)).map((s) => JSON.parse(s) as Frame);
  const settled = async () => {
    let last = "";
    await expect.poll(async () => {
      const now = key((await frames()).at(-1) ?? { list: "", rows: [], footer: "" });
      const same = now === last;
      last = now;
      return same && !/Checking|Previous check|Couldn't/u.test(now);
    }, { intervals: [750], timeout: 20_000 }).toBe(true);
    return (await frames()).at(-1) as Frame;
  };

  const before = await settled();
  const needs = before.rows.map(need);
  const wrong = needs.flatMap((n, i) => needs.slice(0, i).some((m) => m > n) ? [CONTEXTS[i]] : []);
  const selected = await page.locator('#picker .pk-ctx-row[aria-checked="true"] .pk-cost-caption > span:first-child').textContent();
  const listWrong = need(before.list) !== need(selected ?? "");
  // Outline the values that break the basis in amber, for the before/after shots.
  await page.evaluate(({ ctxs, list, model }) => {
    for (const c of ctxs) document.querySelector<HTMLElement>(`#picker [data-ctx="${c}"] .pk-cost`)?.style.setProperty("outline", "2px solid #f5a524");
    if (list) document.querySelector<HTMLElement>(`#picker [data-m="${CSS.escape(model)}"] .pk-v`)?.style.setProperty("outline", "2px solid #f5a524");
  }, { ctxs: wrong, list: listWrong, model: MODEL });
  await page.locator("#picker").screenshot({ path: info.outputPath("fit-table-picker.png") });
  expect.soft(wrong, `context rows read ${before.rows.map((r) => r.split("|")[0]).join(" / ")}`).toEqual([]);
  expect.soft(need(before.list), `the list row reads ${before.list}`).toBe(need(selected ?? ""));

  // Another program takes 1.5 GB of GPU memory: a new reading with the picker open.
  const from = (await frames()).length - 1;
  await stack.gpu(1536);
  await expect.poll(async () => (await frames()).at(-1)?.footer, { timeout: 15_000 }).not.toBe(before.footer);
  const after = await settled();
  await page.evaluate(() => { (window as unknown as { fitStop: boolean }).fitStop = true; });

  const seen = (await frames()).slice(from).map(key);
  const a = key(before), b = key(after);
  const mixed = seen.filter((f) => f !== a && f !== b);
  const firstB = seen.indexOf(b);
  const olderAfterNewer = firstB < 0 ? [] : seen.slice(firstB).filter((f) => f === a);
  expect.soft(mixed, `frames between reading A (${a}) and reading B (${b})`).toEqual([]);
  expect.soft(olderAfterNewer.length, "frames showing the older reading after the newer one").toBe(0);
});
