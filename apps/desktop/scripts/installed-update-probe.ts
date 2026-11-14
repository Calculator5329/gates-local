// What the installed-update probes share: the loopback release page with a
// key made in the process, the seeded data folder, the probe's RPC, and the
// steps a person takes in Settings › Updates. packaged-upgrade.ts drives the
// Linux AppImage; packaged-windows-update.ts drives the Windows installer.
// Run on the test machine only.
import { expect, type Locator, type Page } from "@playwright/test";
import { decodeResult, decodeServerMessage, encodeRequest, type MethodName, type Params, type ResultOf } from "@gates-local/contracts";
import { createHash, type KeyObject } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { defaultSettings, SETTINGS_FILE_NAME, SETTINGS_FILE_VERSION } from "../../server/src/settings/store.ts";
import { openThreadStore } from "../../server/src/threads/store.ts";
import { encodeManifest, signManifest } from "../../server/src/update/release-manifest.ts";
import type { GatesLocalBridge } from "../src/bridge.ts";
import { findFreePort } from "../src/supervisor.ts";
import { artifactFor } from "./packaged-copy.ts";

// Ports the runtime and ComfyUI own on a real machine; nothing here uses them.
export const FORBIDDEN_PORTS = new Set([8188, ...Array.from({ length: 11 }, (_, i) => 11434 + i)]);

export const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export const sha512Of = (bytes: Uint8Array) => createHash("sha512").update(bytes).digest("hex");
export const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "";

const UNANSWERED: unique symbol = Symbol("unanswered");
export async function until<T>(what: string, timeoutMs: number, probe: () => T | null | undefined | false | Promise<T | null | undefined | false>, everyMs = 200): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    // A check that never answers (a page call into a window that is going away) ends the wait too, a little after its deadline.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const value = await Promise.race([
      Promise.resolve().then(probe),
      new Promise<typeof UNANSWERED>((resolve) => { timer = setTimeout(() => resolve(UNANSWERED), Math.max(end - Date.now(), 0) + 5_000); }),
    ]).finally(() => clearTimeout(timer));
    if (value === UNANSWERED) throw new Error(`timed out after ${Math.round(timeoutMs / 1000)} s waiting for ${what}: a check did not answer`);
    if (value !== null && value !== undefined && value !== false) return value;
    if (Date.now() >= end) throw new Error(`timed out after ${Math.round(timeoutMs / 1000)} s waiting for ${what}`);
    await pause(everyMs);
  }
}

const handedPorts = new Set<number>();
/** A free loopback port, never a reserved one, never one handed out before. */
export async function freePort(): Promise<number> {
  for (;;) {
    const port = await findFreePort();
    if (!FORBIDDEN_PORTS.has(port) && !handedPorts.has(port)) {
      handedPorts.add(port);
      return port;
    }
  }
}

/** One request to the copy's server, as its renderer would make it (no Origin: Node sends none). */
export async function rpc<M extends MethodName>(page: Page, method: M, params: Params<M>): Promise<ResultOf<M>> {
  const url = await page.evaluate(() => (globalThis as unknown as { gatesLocal: GatesLocalBridge }).gatesLocal.getServerUrl());
  if (!url) throw new Error("Server is not ready");
  const request = encodeRequest("upgrade-probe", method, params);
  if (!request.ok) throw new Error("Invalid probe request");
  const result = await new Promise<unknown>((resolve, reject) => {
    // No Origin is sent by Node. Renderer-origin admission is checked by packaged-smoke.
    const ws = new WebSocket(url);
    const timer = setTimeout(() => { ws.close(); reject(new Error(`Timed out: ${method}`)); }, 10_000);
    const finish = () => { clearTimeout(timer); ws.close(); };
    ws.addEventListener("open", () => ws.send(request.value));
    ws.addEventListener("error", () => { finish(); reject(new Error(`Connection failed: ${method}`)); });
    ws.addEventListener("message", event => {
      const reply = decodeServerMessage(String(event.data));
      if (!reply.ok || reply.value.type !== "response" || reply.value.id !== "upgrade-probe") return;
      finish();
      if (!reply.value.ok) reject(new Error(`Request failed: ${method}`));
      else resolve(reply.value.result);
    });
  });
  const decoded = decodeResult(method, result);
  if (!decoded.ok) throw new Error(`Invalid result: ${method}`);
  return decoded.value;
}

export interface IuFeed { readonly url: string; readonly requests: string[]; stop(): Promise<void> }

/** The release page: the signed list for one version and its artifact for this platform, the real file. */
export async function startFeed(version: string, artifact: Buffer, key: KeyObject, platform: "linux" | "win32" = "linux"): Promise<IuFeed> {
  const row = artifactFor(platform, version);
  const list = encodeManifest({ schema: 1, version, commit: "b".repeat(40), artifacts: [{ ...row, size: artifact.length, sha512: sha512Of(artifact) }] });
  const sig = signManifest(list, key);
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    const url = req.url ?? "";
    requests.push(url);
    if (url === "/latest/download/release.json") { res.writeHead(200).end(list); return; }
    if (url === "/latest/download/release.json.sig") { res.writeHead(200).end(sig); return; }
    if (url === `/download/v${version}/${row.file}`) {
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": String(artifact.length) });
      res.end(artifact);
      return;
    }
    res.writeHead(404).end("not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address: AddressInfo | string | null = server.address();
  if (address === null || typeof address === "string") throw new Error("The loopback feed has no port.");
  if (FORBIDDEN_PORTS.has(address.port)) throw new Error(`The loopback feed got a reserved port ${address.port}; run again.`);
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    stop: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

/** The test key's public half, as GATES_LOCAL_UPDATE_TEST_KEYS takes it. */
export const publicKeyBase64 = (key: KeyObject) => key.export({ type: "spki", format: "der" }).toString("base64");

export function storeVersionOf(file: string): number | null {
  try {
    const db = new DatabaseSync(file, { readOnly: true });
    try { return Number(db.prepare("PRAGMA user_version").get()?.["user_version"]); } finally { db.close(); }
  } catch {
    return null;
  }
}

/** The thread titles in a data folder's store, read without the app. */
export function threadTitles(dataDir: string): string[] {
  const db = new DatabaseSync(path.join(dataDir, "threads.sqlite"), { readOnly: true });
  try { return db.prepare("SELECT title FROM threads").all().map(r => String(r["title"])); } finally { db.close(); }
}

/**
 * A data folder as if the person had used the app: automatic checks set (on,
 * so the copy downloads the newer version by itself), and one thread. The
 * store's version after it.
 */
export function seedData(dataDir: string, o: { readonly automatic: boolean; readonly thread?: string }): number | null {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(path.join(dataDir, SETTINGS_FILE_NAME), `${JSON.stringify({ version: SETTINGS_FILE_VERSION, settings: { ...defaultSettings("app"), updateAutomatic: o.automatic } }, null, 2)}\n`);
  if (o.thread !== undefined) {
    const store = openThreadStore(path.join(dataDir, "threads.sqlite"));
    try { store.createThread({ title: o.thread }); } finally { store.close(); }
  }
  return storeVersionOf(path.join(dataDir, "threads.sqlite"));
}

/** Collects what is wrong instead of stopping at the first. */
export class Checks {
  readonly problems: string[] = [];
  /** A failed step's whole message: Playwright's call log says what it waited for. */
  readonly full: string[] = [];
  that(ok: boolean, what: string): void { if (!ok) this.problems.push(what); }
  async step<T>(what: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      this.full.push(`${what}: ${(error instanceof Error ? error.message : String(error)).split("\n").filter(l => l.trim() !== "").slice(0, 12).join(" | ")}`);
      throw new Error(`${what}: ${message(error)}`, { cause: error });
    }
  }
}

export const updatesGroup = (page: Page) => page.locator(".grp").filter({ has: page.locator(".grp-t", { hasText: /^Updates$/ }) });

/** The page's document, as far as these checks read it (these scripts are typed without the DOM). */
export interface PageDocument {
  readonly visibilityState: string;
  hasFocus(): boolean;
  elementFromPoint(x: number, y: number): { readonly tagName: string; readonly className: unknown } | null;
}

/**
 * A click a person could make. Playwright's click waits for animation frames,
 * which a window the X server does not paint never gives; then, and only when
 * the element is the topmost one at its centre (nothing covers it), the click
 * is sent as an event, and the notes say so with why Playwright's stalled.
 */
export async function personClick(target: Locator, notes: string[]): Promise<void> {
  try {
    await target.click({ timeout: 10_000 });
  } catch (error) {
    const seen = await target.evaluate((el) => {
      const doc = (globalThis as unknown as { document: PageDocument }).document;
      const r = el.getBoundingClientRect();
      const top = doc.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return { topmost: top !== null && (top === (el as unknown) || el.contains(top as never)), at: top === null ? "nothing" : `${top.tagName.toLowerCase()}.${String(top.className)}`, visibility: doc.visibilityState, focused: doc.hasFocus() };
    }, undefined, { timeout: 5_000 }).catch(() => null);
    const why = (error instanceof Error ? error.message : String(error)).split("\n").filter(l => l.trim() !== "").slice(0, 8).join(" | ");
    notes.push(`click on ${String(target)}: ${seen === null ? "no such element" : JSON.stringify(seen)}; ${why}`);
    if (seen === null || !seen.topmost) throw error;
    await target.dispatchEvent("click");
  }
}

/**
 * Settings › General › Updates (no Ollama here, so the runtime's Retry shows):
 * from the first-run screen's Settings link before the first thread, from the
 * sidebar gear once a thread exists.
 */
export async function openUpdates(page: Page, notes: string[], timeoutMs = 90_000): Promise<Locator> {
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible({ timeout: timeoutMs });
  const firstRun = page.locator(".fr-cta").getByRole("button", { name: "Settings", exact: true });
  await personClick((await firstRun.count()) > 0 ? firstRun : page.locator("button.ibtn[aria-label^='Settings']"), notes);
  await personClick(page.locator(".snav").getByRole("button", { name: "General", exact: true }), notes);
  const group = updatesGroup(page);
  await expect(group).toBeVisible({ timeout: 15_000 });
  return group;
}

/** The download of the newer version is checked: either Restart to update, or the words for a copy that cannot use it. */
export async function waitDownloaded(group: Locator): Promise<string> {
  // The state is row 2 (its label and its control) and the block under it.
  await expect(group.locator(".box")).toContainText(/Restart to update|cannot install it by itself|cannot replace its own file|cannot update itself/, { timeout: 180_000 });
  return await group.locator(".box").innerText();
}

export const restartButton = (group: Locator) => group.getByRole("button", { name: "Restart to update", exact: true });

/** The Updates group at one fixed crop, the result line outlined; and the footer's update icon when the sidebar shows it. */
export async function shoot(page: Page, group: Locator, output: string, name: string): Promise<string[]> {
  const files: string[] = [];
  await page.addStyleTag({ content: ".grp .srow:nth-child(2), .ibtn.upd { outline: 3px solid #e5484d !important; outline-offset: -3px; }" });
  const box = await group.boundingBox();
  if (box !== null) {
    const file = path.join(output, `${name}-settings.png`);
    await page.screenshot({ path: file, clip: { x: Math.max(0, box.x - 12), y: Math.max(0, box.y - 12), width: box.width + 24, height: 340 } });
    files.push(file);
  }
  const icon = page.locator(".ibtn.upd").first();
  const iconBox = await icon.isVisible() ? await icon.boundingBox() : null;
  if (iconBox !== null) {
    const file = path.join(output, `${name}-footer.png`);
    await page.screenshot({ path: file, clip: { x: Math.max(0, iconBox.x - 120), y: Math.max(0, iconBox.y - 40), width: 280, height: iconBox.height + 80 } });
    files.push(file);
  }
  return files;
}

/** The update note in the client's main area, outlined, at one fixed crop: its words, and the shot. */
export async function shootNote(page: Page, output: string, name: string): Promise<{ line: string; shot: string | null }> {
  const note = page.locator(".upd-note").first();
  await expect(note).toBeVisible({ timeout: 60_000 });
  const line = await note.locator(".bm").first().innerText();
  await page.addStyleTag({ content: ".upd-note { outline: 3px solid #e5484d !important; outline-offset: 2px; }" });
  const box = await note.boundingBox();
  if (box === null) return { line, shot: null };
  const file = path.join(output, `${name}.png`);
  await page.screenshot({ path: file, clip: { x: Math.max(0, box.x - 12), y: Math.max(0, box.y - 12), width: box.width + 24, height: 180 } });
  return { line, shot: path.relative(output, file) };
}
