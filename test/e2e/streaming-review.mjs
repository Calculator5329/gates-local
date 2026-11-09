// Displayed component proof, using the real hook and renderer in development
// StrictMode. Run only through the browser runner, not on the local desktop.
import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, expect } from "@playwright/test";

const output = process.env.GL_E2E_RESULTS;
if (!output) throw new Error("The browser runner must supply GL_E2E_RESULTS");
await mkdir(output, { recursive: true });
const bundle = await build({
  stdin: { resolveDir: path.resolve("apps/web"), loader: "tsx", contents: `
    import './src/styles.css';
    import { StrictMode, useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { usePacedText } from './src/paced.ts';
    import { reveal } from './src/reveal.ts';
    import { Markdown } from './src/markdown.tsx';
    function Probe() {
      const [reply, setReply] = useState({ text: 'Returning to a streaming reply', streaming: true });
      window.setReply = (text, streaming = true) => setReply({ text, streaming });
      const paced = usePacedText(reply.text, reply.streaming);
      const live = reply.streaming || paced.length < reply.text.length;
      return <div className="turn a" data-received={reply.text.length} data-revealed={paced.length}>
        <h2>Streaming review</h2><Markdown text={reveal(paced, live)} live={live} />
      </div>;
    }
    createRoot(document.getElementById('root')).render(<StrictMode><Probe /></StrictMode>);
  ` },
  outfile: path.join(output, "review.js"),
  bundle: true, write: false, format: "iife", jsx: "automatic", define: { "process.env.NODE_ENV": '"development"' },
});
const css = bundle.outputFiles.filter(file => file.path.endsWith(".css")).map(file => file.text).join("\n");
const script = bundle.outputFiles.find(file => file.path.endsWith(".js"));
if (!script) throw new Error("The streaming review bundle emitted no JavaScript");
const html = path.join(output, "review.html");
await writeFile(html, `<!doctype html><html><head><meta charset="utf-8"><style>${css}
body{display:block;padding:32px}#root{max-width:800px;margin:auto}.turn{padding:24px}</style></head><body><div id="root"></div><script>${script.text}</script></body></html>`);
const browser = await chromium.launch({ headless: false });
const context = await browser.newContext({ viewport: { width: 1024, height: 900 }, colorScheme: "dark", recordVideo: { dir: output } });
const page = await context.newPage();
const errors = [];
const checks = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
async function show(value, live = true) {
  await page.evaluate(({ text, streaming }) => window.setReply(text, streaming), { text: value, streaming: live });
  await expect.poll(() => page.locator(".turn").getAttribute("data-revealed")).toBe(String(value.length));
}
async function shot(name) { await page.screenshot({ path: path.join(output, `${name}.png`), fullPage: true }); }
try {
  await page.goto(pathToFileURL(html).href);
  await expect(page.locator(".md")).toContainText("Returning");
  checks.push("StrictMode mount effect replay resumes pacing");
  await show("| literal bar line |\nOrdinary next line.\n\nLater content");
  await expect(page.locator(".md")).toContainText("Later content");
  await shot("literal-pipe");
  for (const tail of ["-", "--", "-- | -"]) {
    await show(`A | B\n${tail}`);
    await expect(page.locator(".md")).toContainText("A | B");
  }
  await show("A | B\n-- | --\n1 | 2\n\nNext");
  await expect(page.locator(".md table")).toHaveCount(1);
  await shot("pipe-less-table");
  checks.push("literal pipe release and pipe-less table boundaries");
  const destination = "https://example.com/" + "long-destination/".repeat(40);
  await show(`See [the guide](${destination}`);
  await expect(page.locator(".md p")).toHaveText("See the guide");
  await expect(page.locator(".md a")).toHaveCount(0);
  const before = await page.locator(".md p").evaluate((el) => { const r = document.createRange(); r.selectNodeContents(el); return r.getBoundingClientRect().width; });
  await shot("pending-link");
  await show(`See [the guide](${destination})`);
  await expect(page.locator(".md a")).toHaveText("the guide");
  const after = await page.locator(".md p").evaluate((el) => { const r = document.createRange(); r.selectNodeContents(el); return r.getBoundingClientRect().width; });
  expect(Math.abs(after - before)).toBeLessThan(1);
  await shot("closed-link");
  await show(`See [the guide](${destination}`, false);
  await expect(page.locator(".md p")).toContainText(`[the guide](${destination}`);
  checks.push("pending link keeps label width and malformed terminal text survives");
  const sample = "A😀B e\u0301 👩🏽‍💻 🇺🇸🇨🇦 क्‍ष end".repeat(8);
  await page.evaluate((text) => {
    const boundaries = new Set([...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map((s) => s.index));
    boundaries.add(text.length);
    window.invalidCuts = [];
    window.setReply(text);
    const tick = () => {
      const cut = Number(document.querySelector(".turn").getAttribute("data-revealed"));
      if (!boundaries.has(cut)) window.invalidCuts.push(cut);
      if (cut !== text.length) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, sample);
  await expect.poll(() => page.locator(".turn").getAttribute("data-revealed")).toBe(String(sample.length));
  expect(await page.evaluate(() => window.invalidCuts)).toEqual([]);
  await shot("graphemes");
  checks.push("every visible Unicode cut is a grapheme boundary");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await show("## Reduced motion\n\nText arrives immediately. **Bold stays styled**.");
  await page.evaluate(async () => {
    window.motionFrames = [];
    const text = "Immediate arrival ".repeat(200);
    window.setReply(text);
    for (let i = 0; i < 8; i++) {
      await new Promise(requestAnimationFrame);
      window.motionFrames.push(Number(document.querySelector(".turn").getAttribute("data-revealed")));
    }
  });
  const frames = await page.evaluate(() => window.motionFrames);
  expect(frames.every((n) => n === 0 || n === "Immediate arrival ".repeat(200).length)).toBe(true);
  await show("A | B\n-- | -");
  await expect(page.locator(".md")).toContainText("A | B");
  await show("Reduced motion: [the guide](https://example.com");
  await expect(page.locator(".md p")).toHaveText("Reduced motion: the guide");
  await shot("reduced-motion");
  checks.push("reduced motion bypasses pacing and retains structural guards");
  expect(errors).toEqual([]);
} finally {
  await writeFile(path.join(output, "review-results.json"), JSON.stringify({ checks, errors }, null, 2));
  await context.close();
  await browser.close();
}
console.log(JSON.stringify({ checks, errors }));
