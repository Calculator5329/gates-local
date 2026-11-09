/// <reference lib="dom" />
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { State } from "../../apps/web/src/store.ts";
import { expect, test } from "./fixtures.ts";

declare global {
  interface Window {
    streamingProof: {
      timeline(patch: Partial<State>): void;
      markdown(text: string): string;
    };
  }
}

test.use({ video: "on", screenshot: "only-on-failure" });

async function proof(page: import("@playwright/test").Page) {
  const bundle = await build({
    stdin: { resolveDir: path.resolve("apps/web"), loader: "tsx", contents: `
      import { createRoot } from 'react-dom/client';
      import { flushSync } from 'react-dom';
      import { Timeline } from './src/Thread.tsx';
      import { Markdown } from './src/markdown.tsx';
      import { reveal } from './src/reveal.ts';
      import { setState } from './src/store.ts';
      const root = createRoot(document.getElementById('proof'));
      window.streamingProof = {
        timeline(patch) { flushSync(() => { setState(patch); root.render(<Timeline threadId="proof" />); }); },
        markdown(text) {
          const shown = reveal(text, true);
          flushSync(() => root.render(<Markdown text={shown} live />));
          return shown;
        }
      };
    ` },
    bundle: true, write: false, format: "iife", jsx: "automatic", define: { "process.env.NODE_ENV": '"development"' },
  });
  await page.goto("about:blank");
  await page.setContent('<main id="proof"></main>');
  await page.addStyleTag({ content: await readFile("apps/web/src/styles.css", "utf8") });
  await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
}

test("an arriving image card preserves the live reply node, thinking and reveal", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await proof(page);
  const text = "The report total is 42. ".repeat(20);
  await page.evaluate(content => window.streamingProof.timeline({
    threadId: "proof", view: "thread", messages: { proof: [{ id: "user", threadId: "proof", role: "user", content: "A ship and a report", createdAt: 1 }] },
    live: { gen: 1, threadId: "proof", turnId: "turn", userMessageId: "user", model: "model", startedAt: Date.now(), thinking: "Checking the report", text: content, tools: [], pendingUser: null },
  }), text);
  const reply = page.locator('.turn.a:not(:has([data-image-job]))');
  await expect(page.locator("[data-image-job]")).toHaveCount(0);
  await expect(reply.locator(".md")).toContainText("The report");
  await reply.locator(".think").click();
  await expect(reply.locator(".think")).toHaveAttribute("aria-expanded", "true");
  await page.screenshot({ path: info.outputPath("before-card-arrival.png"), animations: "disabled" });
  const node = await reply.elementHandle();
  const before = Number(await reply.getAttribute("data-revealed"));
  await page.evaluate(() => window.streamingProof.timeline({ messages: { proof: [
    { id: "user", threadId: "proof", role: "user", content: "A ship and a report", createdAt: 1 },
    { id: "image", threadId: "proof", role: "assistant", content: "a ship", createdAt: 2, imageJob: { jobId: "image", threadId: "proof", state: "queued" } },
  ] } }));
  expect(await node!.evaluate(el => el.isConnected), "the original reply DOM node survives card insertion").toBe(true);
  expect(await reply.evaluate((el, original) => el === original, node), "the same DOM node still owns the live reply").toBe(true);
  await expect(reply.locator(".think")).toHaveAttribute("aria-expanded", "true");
  expect(Number(await reply.getAttribute("data-revealed"))).toBeGreaterThanOrEqual(before);
  await expect(page.locator("[data-image-job]")).toBeVisible();
  await page.screenshot({ path: info.outputPath("card-arrival.png"), animations: "disabled" });
  expect(errors).toEqual([]);
});

for (const [label, reply, witness] of [
  ["prose", "Use A | B for piping.\nOrdinary next line.", "Use A"],
  ["pipe table", "| Model | Size |\n| --- | --- |\n| Small | 2 |\n\nNext", "Model"],
  ["pipe-less table", "Use A | B\n-- | --\n1 | 2\n\nNext", "Use A"],
] as const) test(`every displayed frame keeps visible ${label}`, async ({ page }, info) => {
  await proof(page);
  const frames = await page.evaluate(async content => {
    const samples: { prefix: string; shown: string; text: string; tables: number }[] = [];
    for (let i = 1; i <= content.length; i++) {
      const prefix = content.slice(0, i);
      const shown = window.streamingProof.markdown(prefix);
      await new Promise(requestAnimationFrame);
      samples.push({ prefix, shown, text: document.querySelector(".md")?.textContent ?? "", tables: document.querySelectorAll(".md table").length });
    }
    return samples;
  }, reply);
  await info.attach("frames", { body: JSON.stringify(frames), contentType: "application/json" });
  let previous = "";
  for (const frame of frames) {
    expect(frame.shown.startsWith(previous), `retracted at ${JSON.stringify(frame.prefix)}`).toBe(true);
    if (frame.prefix.includes(witness)) expect(frame.text, `blank frame at ${JSON.stringify(frame.prefix)}`).toContain(witness);
    if (!frame.prefix.includes("--\n") && !frame.prefix.includes("--- |\n")) expect(frame.tables).toBe(0);
    previous = frame.shown;
  }
  if (label !== "prose") expect(frames.at(-1)!.tables).toBe(1);
  await page.screenshot({ path: info.outputPath(`${label.replaceAll(" ", "-")}.png`), animations: "disabled" });
});
