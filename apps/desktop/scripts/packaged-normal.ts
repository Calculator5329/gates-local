// Run an actual AppImage without extraction or no-sandbox. Raw spawn retains
// early FUSE/sandbox stderr even when Electron never reaches DevTools.
import { chromium, expect, type Browser } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { findFreePort } from "../src/supervisor.ts";

const artifact = process.argv[2];
if (!artifact) throw new Error("Pass the AppImage path.");
const output = path.resolve(process.argv[3] ?? "dist/packaged-normal");
mkdirSync(output, { recursive: true });
const cache = path.join(homedir(), ".cache", "gates-local-normal");
mkdirSync(cache, { recursive: true });
const work = mkdtempSync(path.join(cache, "run-"));
const env: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
  if (value !== undefined && !key.startsWith("GATES_LOCAL_") && !key.startsWith("APPIMAGE") && key !== "APPDIR" && key !== "ELECTRON_RUN_AS_NODE") env[key] = value;
}
Object.assign(env, {
  TMPDIR: work, XDG_DATA_HOME: path.join(work, "data"), XDG_CONFIG_HOME: path.join(work, "config"),
  GATES_LOCAL_RUNTIME: "discover-only", GATES_LOCAL_OLLAMA_BINARY: "none",
  GATES_LOCAL_OLLAMA_URL: "http://127.0.0.1:19750", GATES_LOCAL_COMFY_URL: "http://127.0.0.1:1",
});
const port = await findFreePort();
// Debugging allows observation only; neither switch disables the sandbox.
const child = spawn(path.resolve(artifact), [`--remote-debugging-port=${port}`, "--enable-automation"], { env, stdio: ["ignore", "ignore", "pipe"] });
let stderr = "";
child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-128_000); });
const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
  child.once("exit", (code, signal) => resolve({ code, signal }));
  child.once("error", () => reject(new Error("Could not execute the AppImage")));
});
let browser: Browser | undefined;
let report: Record<string, unknown> = { launched: false, cause: "Probe did not finish" };
try {
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => { clearInterval(interval); clearTimeout(timeout); if (error) reject(error); else resolve(); };
    const interval = setInterval(() => {
      void fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(500) }).then(response => { if (response.ok) finish(); }).catch(() => {});
    }, 100);
    const timeout = setTimeout(() => finish(new Error("No DevTools endpoint within 15 seconds")), 15_000);
    void exited.then(() => finish(new Error("AppImage exited before Electron was ready")), error => finish(error));
  });
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page = browser.contexts()[0]?.pages()[0];
  if (!page) throw new Error("No renderer window");
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible({ timeout: 20_000 });
  const session = await browser.newBrowserCDPSession();
  const command = await session.send("Browser.getBrowserCommandLine").catch(() => null);
  report = { launched: true, callerNoSandbox: false, extractionMode: false,
    effectiveNoSandbox: command?.arguments.includes("--no-sandbox") ?? "unavailable", firstRun: await page.locator(".fr h1").innerText() };
  await page.screenshot({ path: path.join(output, "first-run.png") });
} catch {
  report = { launched: false, callerNoSandbox: false, extractionMode: false,
    cause: /fuse/i.test(stderr) ? "FUSE unavailable" : /sandbox|namespace/i.test(stderr) ? "Chromium sandbox unavailable" : "Launch failed; needs further diagnosis",
    missingFuseLibrary: /libfuse\.so\.2/.test(stderr),
    diagnosticLines: stderr.split("\n").filter(line => /libfuse|AppImages require FUSE|Cannot mount AppImage|fuse:|No usable sandbox|SUID sandbox helper|Failed to move to new namespace/.test(line)).map(line => line.replaceAll(homedir(), "<home>")),
  };
} finally {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  const kill = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, 5_000);
  const status = await exited;
  clearTimeout(kill);
  await browser?.close().catch(() => {});
  report = { ...report, exit: status };
}
writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
console.log(`Normal AppImage launch: ${report["launched"] === true ? "reached first run" : String(report["cause"])}`);
