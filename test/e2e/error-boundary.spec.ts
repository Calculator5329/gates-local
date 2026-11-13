// Render recovery in a real React root, with the same external draft store as the app.
import { build } from "esbuild";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { ROOT, WEB_ORIGIN } from "./env.ts";

const source = `
import React, { useLayoutEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ErrorBoundary } from './ErrorBoundary.tsx';
import { editDraft, useDraft } from './drafts.ts';
let brokenThread = false, brokenApp = 'none';
function Timeline({ id }) { if (brokenThread && id === 'bad') throw new Error('Saved message could not render'); return <p>Conversation {id}</p>; }
function Composer() { const draft = useDraft(d => d.text); return <textarea aria-label="Message" value={draft} onChange={e => editDraft(e.target.value)} />; }
function Shell() {
  const [id, setId] = useState('bad');
  const [, redraw] = useState(0);
  useLayoutEffect(() => { if (brokenApp === 'effect') throw new Error('Shell effect failed'); });
  if (brokenApp === 'render') throw new Error('Shell could not render');
  return <><nav><button onClick={() => setId('good')}>Other thread</button><button onClick={() => { brokenThread = true; redraw(n => n + 1); }}>Break thread</button><button onClick={() => { brokenApp = 'render'; redraw(n => n + 1); }}>Break app</button></nav><header>Thread title</header><ErrorBoundary key={id} scope="thread"><Timeline id={id}/></ErrorBoundary><Composer/></>;
}
window.repair = () => { brokenThread = false; };
window.failInEffect = () => { brokenApp = 'effect'; };
createRoot(document.getElementById('root')).render(<ErrorBoundary scope="app"><Shell/></ErrorBoundary>);
`;

async function mount(page: Page) {
  const bundle = await build({ stdin: { contents: source, resolveDir: path.join(ROOT, "apps/web/src"), loader: "tsx" }, bundle: true, write: false, format: "iife", define: { "process.env.NODE_ENV": '"production"' } });
  const script = bundle.outputFiles[0]?.text;
  if (!script) throw new Error("The boundary probe did not build");
  const styles = await readFile(path.join(ROOT, "apps/web/src/styles.css"), "utf8");
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.route("**/boundary-probe", route => route.fulfill({ contentType: "text/html", body: `<style>${styles}</style><div id="root"></div><script>${script}</script>` }));
  await page.goto(`${WEB_ORIGIN}/boundary-probe`);
}

// Guards a shipped bug fix: a render crash blanked the app; it now shows a notice and keeps the draft.
test("render recovery keeps the draft and escalates a failed app retry to Reload window", async ({ page }) => {
  test.setTimeout(10_000);
  const errors: string[] = [];
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await mount(page);
  await page.getByRole("textbox", { name: "Message" }).fill("Keep this draft");
  await page.getByRole("button", { name: "Break thread" }).click();
  await expect(page.getByRole("alert")).toContainText("This conversation could not be shown.");
  await expect(page.getByRole("banner")).toHaveText("Thread title");
  await expect(page.getByRole("textbox")).toHaveValue("Keep this draft");
  await page.getByRole("textbox").fill("Keep editing after the error");
  await page.getByTestId("ui.error.copy").click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain("Saved message could not render");
  expect(errors).toHaveLength(1);
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByRole("button", { name: "Try again", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Reload window", exact: true })).toHaveCount(0);
  await page.evaluate("window.repair()");
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByText("Conversation bad", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Break thread" }).click();
  await page.getByRole("button", { name: "Other thread" }).click();
  await expect(page.getByText("Conversation good", { exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.evaluate("window.repair()");
  await page.getByRole("button", { name: "Break app" }).click();
  await expect(page.getByRole("alert")).toContainText("The app could not be shown.");
  await page.evaluate("window.failInEffect()");
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByRole("button", { name: "Reload window", exact: true })).toBeVisible();
  await page.getByTestId("ui.error.copy").click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain("Shell effect failed");
});
