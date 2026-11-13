/// <reference lib="dom" />
// Opens the desktop app, opens Settings and visits each section with the
// frame watch in flicker-probe.ts (the browser journeys are in
// flicker-audit.spec.ts). Here code chunks come through the app's own
// protocol, so a section whose code is not in hand shows it. Answers from the
// server are slowed like in the browser journeys. Run with the external
// runner's virtual display. All app data is test-owned.
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { _electron, type TestInfo } from "@playwright/test";
import { FAKE_URL, ROOT } from "./env.ts";
import { type Delay, type WholeFinding, type WholeOptions, delayEverything, settled, watchWhole, wholeFindings } from "./flicker-probe.ts";
import { expect, test, waitReady } from "./fixtures.ts";

test.beforeAll(async () => {
  await promisify(execFile)("pnpm", ["--filter", "@gates-local/desktop", "build"], { cwd: ROOT });
});

async function desktop(info: TestInfo) {
  const work = await mkdtemp(path.join(tmpdir(), "gates-settings-cards-"));
  const desktopRoot = path.join(ROOT, "apps/desktop");
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  delete env["ELECTRON_RUN_AS_NODE"];
  delete env["GATES_LOCAL_WEB_URL"];
  delete env["GATES_LOCAL_WEB"];
  const app = await _electron.launch({
    executablePath: createRequire(path.join(desktopRoot, "package.json"))("electron") as string,
    args: [desktopRoot, ...(process.platform === "linux" ? ["--ozone-platform=x11"] : [])],
    env: {
      ...env,
      GATES_LOCAL_USER_DATA: path.join(work, "profile"),
      GATES_LOCAL_DATA_DIR: path.join(work, "data"),
      XDG_DATA_HOME: path.join(work, "xdg"),
      GATES_LOCAL_RUNTIME: "discover-only",
      GATES_LOCAL_OLLAMA_BINARY: "none",
      GATES_LOCAL_OLLAMA_URL: FAKE_URL,
      GATES_LOCAL_COMFY_URL: "http://127.0.0.1:1",
      GATES_LOCAL_NVIDIA_SMI: path.join(ROOT, "test/fake-ollama/nvidia-smi.ts"),
      GATES_LOCAL_MEMINFO: path.join(ROOT, "test/fake-ollama/meminfo.txt"),
    },
    recordVideo: { dir: info.outputPath("desktop-video"), size: { width: 1200, height: 800 } },
  });
  const page = await app.firstWindow();
  await page.waitForURL("gates-local://app/index.html");
  // The app's own server listens on a port of its choosing; slow every answer from it.
  let delay: Delay | undefined;
  try { delay = await delayEverything(page, 600, /^wss?:\/\/127\.0\.0\.1:\d+/); } catch (e) { console.log(`SETTINGS_CARDS no answer delay in this window: ${(e as Error).message}`); }
  await page.evaluate(() => localStorage.setItem("gates-local.first-run-done", "1"));
  await page.reload();
  await waitReady(page);
  if (delay) await settled(delay);
  return { app, page, delay };
}

const section = (name: string): WholeOptions => ({ root: ".set", arrive: { selector: ".set-h h1, .mp-head h1", text: name } });

// Guards the owner's ruling (N21): nothing moves; each Settings section is whole on its first frame.
test("every Settings section is whole on its first frame", async ({ seededThread: _seeded }, info) => {
  test.setTimeout(180_000);
  const { app, page, delay } = await desktop(info);
  const all: WholeFinding[] = [];
  const report = (step: string, frames: Parameters<typeof wholeFindings>[1]) => {
    const found = wholeFindings(step, frames);
    console.log(`SETTINGS_CARDS ${step}: ${frames.length} frames, first shown at frame ${frames.findIndex((f) => f.arrived)}, ${found.length} findings`);
    for (const finding of found) console.log(`SETTINGS_CARDS FINDING ${JSON.stringify(finding)}`);
    all.push(...found);
  };
  try {
    report("open Settings", await watchWhole(page, section("General"), () => page.keyboard.press("Control+Comma"), delay));
    await page.screenshot({ path: info.outputPath("general-settled.png") });
    const sections = (await page.locator(".snav button:not(.back)").allInnerTexts()).map(text => text.trim()).filter(text => text !== "" && text !== "General");
    console.log(`SETTINGS_CARDS sections: ${JSON.stringify(sections)}`);
    for (const name of sections) {
      if (delay) await settled(delay, 3000);
      const button = page.locator(".snav").getByRole("button", { name, exact: true });
      report(`first visit to ${name}`, await watchWhole(page, section(name), () => button.click(), delay));
    }
    if (delay) await settled(delay, 3000);
    report("back to General, second visit", await watchWhole(page, section("General"), () => page.locator(".snav").getByRole("button", { name: "General", exact: true }).click(), delay));
    // Models is the footer bot's own pop-up (settings row 6), not a section; the footer is under the Settings pop-up's blur
    await page.keyboard.press("Escape");
    await page.locator(".dlg").waitFor({ state: "detached" });
    if (delay) await settled(delay, 3000);
    report("open Models", await watchWhole(page, { root: ".dlg", arrive: { selector: ".dlg-head h2", text: "Models" } }, () => page.locator(".sb-foot").getByRole("button", { name: /^Models/ }).click(), delay));
    if (delay) await settled(delay, 3000);
    report("Models, Download tab", await watchWhole(page, { root: ".dlg", arrive: { selector: ".mp-tab[aria-selected=true] .mp-lbl", text: "Download" } }, () => page.getByRole("tab", { name: /Download/ }).click(), delay));
  } finally { await app.close(); }
  // Findings can carry a test-owned temporary path; they stay in the run's output, not in a file here.
  expect(all, "what arrived late, moved or changed its words").toEqual([]);
});
