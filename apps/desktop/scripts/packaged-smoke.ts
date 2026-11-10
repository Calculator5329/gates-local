// Diagnostic probe for a built Linux AppImage, run on the test machine.
// No real model services: a fresh profile, discover-only, a pinned unused port.
import { _electron, expect } from "@playwright/test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { homedir } from "node:os";
import path from "node:path";
import type { GatesLocalBridge } from "../src/bridge.ts";

const artifact = process.argv[2];
if (!artifact) throw new Error("Pass the AppImage path.");
const output = path.resolve(process.argv[3] ?? "dist/packaged-smoke");
mkdirSync(output, { recursive: true });
const cache = path.join(homedir(), ".cache", "gates-local-smoke");
mkdirSync(cache, { recursive: true });
const profile = mkdtempSync(path.join(cache, "profile-"));
const env: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
for (const key of Object.keys(env)) if (key.startsWith("GATES_LOCAL_") || key === "ELECTRON_RUN_AS_NODE") delete env[key];
Object.assign(env, {
  APPIMAGE_EXTRACT_AND_RUN: "1", TMPDIR: cache,
  GATES_LOCAL_USER_DATA: profile,
  GATES_LOCAL_RUNTIME: "discover-only", GATES_LOCAL_OLLAMA_BINARY: "none",
  GATES_LOCAL_OLLAMA_URL: "http://127.0.0.1:19750",
});
const electron = await _electron.launch({
  executablePath: path.resolve(artifact), args: ["--no-sandbox", "--disable-gpu"], env,
  timeout: 30_000,
});
const mainStderr: string[] = [];
const redact = (text: string) => text.replace(/([?&]token=)[^\s&"<>]+/gi, "$1[redacted]").replace(/\b[a-f0-9]{64}\b/gi, "[redacted]");
electron.process().stderr?.on("data", (chunk: Buffer) => {
  mainStderr.push(redact(chunk.toString()));
  if (mainStderr.length > 20) mainStderr.shift();
});
try {
  const packaged = await electron.evaluate(({ app }) => app.isPackaged);
  expect(packaged).toBe(true);
  const page = await electron.firstWindow();
  await expect.poll(async () => page.evaluate(async () => {
    const state = await (globalThis as unknown as { gatesLocal?: GatesLocalBridge }).gatesLocal?.getState();
    return state?.status;
  }), { timeout: 30_000 }).toMatch(/^(ready|crashed)$/);
  const state = await page.evaluate(() => (globalThis as unknown as { gatesLocal: GatesLocalBridge }).gatesLocal.getState());
  if (state.status !== "ready") throw new Error("Packaged server did not become ready");
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.name));
  await expect(page.locator(".fr h1")).toContainText("Ollama", { timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  const handshake = new Promise<{ origin: string; status: number }>((resolve) => {
    let origin = "";
    cdp.on("Network.webSocketWillSendHandshakeRequest", event => {
      origin = String(event.request.headers["Origin"] ?? event.request.headers["origin"] ?? "");
    });
    cdp.on("Network.webSocketHandshakeResponseReceived", event => resolve({ origin, status: event.response.status }));
  });
  await page.reload();
  const measured = await Promise.race([handshake, new Promise<never>((_, reject) => {
    const timer = setTimeout(() => reject(new Error("No renderer WebSocket handshake observed")), 15_000);
    timer.unref();
  })]);
  expect(measured).toEqual({ origin: "gates-local://app", status: 101 });
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();

  // Keep the per-launch token inside this process, never in a report or log.
  const url = await page.evaluate(() => (globalThis as unknown as { gatesLocal: GatesLocalBridge }).gatesLocal.getServerUrl());
  if (!url) throw new Error("Server bridge was not ready");
  const refused: Record<string, number> = {};
  for (const origin of ["file://", "null", "http://evil.example", "gates-local://other"]) {
    const endpoint = new URL(url);
    endpoint.protocol = "http:";
    refused[origin] = await new Promise<number>((resolve, reject) => {
      const request = http.get(endpoint, { headers: {
        Origin: origin, Connection: "Upgrade", Upgrade: "websocket",
        "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
      } }, response => { response.resume(); resolve(response.statusCode ?? 0); });
      request.on("upgrade", (_response, socket) => { socket.destroy(); resolve(101); });
      request.on("error", () => reject(new Error("Origin probe connection failed")));
      request.setTimeout(5_000, () => request.destroy());
    });
    expect(refused[origin]).toBe(403);
  }
  const dataFolder = await page.evaluate(() => (globalThis as unknown as { gatesLocal: GatesLocalBridge }).gatesLocal.dataFolder());
  expect(dataFolder).toBe(path.join(profile, "server-data"));
  expect(existsSync(path.join(dataFolder, "threads.sqlite"))).toBe(true);
  const update = await page.evaluate(() => (globalThis as unknown as { gatesLocal: GatesLocalBridge }).gatesLocal.updateAndRestart({ reservation: "packaged-smoke", targetCommit: "0".repeat(40) }));
  expect(update).toEqual({ ok: false, message: "This installed copy of Gates Local cannot update itself yet. Download the new version from the release page." });
  await page.screenshot({ path: path.join(output, "first-run.png") });
  const firstRun = await page.locator(".fr h1").innerText();
  expect(errors).toEqual([]);
  writeFileSync(path.join(output, "report.json"), JSON.stringify({
    packaged, renderer: measured, refused, firstRun,
    sqliteCreated: true, isolatedProfile: true, update, rendererErrors: errors.length,
    realModels: false, upgradePersistence: "not tested", windows: "not tested",
  }, null, 2) + "\n");
  console.log("Packaged first-run probe passed; renderer origin 101, four foreign origins 403.");
} catch (error) {
  let failure: unknown;
  try {
    const page = await electron.firstWindow({ timeout: 2_000 });
    const state = await page.evaluate(() => (globalThis as unknown as { gatesLocal: GatesLocalBridge }).gatesLocal.getState());
    if (state.status === "crashed") {
      failure = { ...state, keptLog: state.logPath ? readFileSync(state.logPath, "utf8") : null };
    } else failure = { status: state.status };
  } catch (captureError) { failure = { captureError: String(captureError) }; }
  writeFileSync(path.join(output, "smoke.json"), redact(JSON.stringify({
    passed: false, error: String(error), failure, mainStderr,
  }, null, 2)) + "\n");
  throw new Error("Packaged smoke failed; see smoke.json for the server failure and kept log", { cause: error });
} finally {
  await electron.close();
}
