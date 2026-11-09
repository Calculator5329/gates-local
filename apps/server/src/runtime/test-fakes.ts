// Test fakes for the runtime module: a fake Ollama HTTP server, a fake
// non-Ollama service, a fake `ollama` binary and a fake release server.
// Nothing here touches the real Ollama or port 11434.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { chmodSync, copyFileSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { windowsTar } from "./install.ts";

export type FakeTag = { name: string; digest: string; size: number; modified_at: string; details?: Record<string, string> };
export type FakePs = { name: string; size: number; size_vram: number; expires_at?: string };

export function tmpDir(prefix: string): string {
  return mkdtempSync(path.join(os.tmpdir(), `gates-runtime-${prefix}-`));
}

export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/** Startup changes the command before announcing ready, exposing premature identity reads. */
export function spawnSleeper(): { child: ChildProcess; ready: Promise<void> } {
  const child = spawn(process.execPath, ["-e", 'process.title = "gates-test-sleeper"; console.log("ready"); setInterval(() => {}, 1000)'], { stdio: ["ignore", "pipe", "ignore"] });
  const ready = new Promise<void>((resolve, reject) => {
    const failed = (code: number | null) => reject(new Error(`sleeper exited before ready: ${code}`));
    child.once("error", reject);
    child.once("exit", failed);
    child.stdout!.once("data", () => {
      child.off("error", reject);
      child.off("exit", failed);
      resolve();
    });
  });
  return { child, ready };
}

function listen(server: http.Server, port = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

function close(server: http.Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

export type FakeOllama = {
  baseUrl: string;
  port: number;
  tags: FakeTag[];
  ps: FakePs[];
  /** When set, /api/tags answers with this raw body. */
  rawTags?: string;
  requests: string[];
  close(): Promise<void>;
};

export async function startFakeOllama(opts: { version?: string; tags?: FakeTag[]; ps?: FakePs[]; port?: number } = {}): Promise<FakeOllama> {
  const fake: FakeOllama = {
    baseUrl: "",
    port: 0,
    tags: opts.tags ?? [],
    ps: opts.ps ?? [],
    requests: [],
    close: async () => close(server),
  };
  const server = http.createServer((req, res) => {
    fake.requests.push(`${req.method} ${req.url}`);
    const json = (body: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.url === "/") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("Ollama is running");
    } else if (req.url === "/api/version") json({ version: opts.version ?? "0.0.1-fake" });
    else if (req.url === "/api/tags") {
      if (fake.rawTags !== undefined) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(fake.rawTags);
      } else json({ models: fake.tags });
    } else if (req.url === "/api/ps") json({ models: fake.ps });
    else {
      res.writeHead(404);
      res.end("404 page not found");
    }
  });
  fake.port = await listen(server, opts.port);
  fake.baseUrl = `http://127.0.0.1:${fake.port}`;
  return fake;
}

/** An HTTP service that is not Ollama (a dev server, say) holding a port. */
export async function startWrongService(port = 0, body = "<!doctype html><title>Some dev server</title>"): Promise<{ baseUrl: string; port: number; close(): Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(body);
  });
  const p = await listen(server, port);
  return { baseUrl: `http://127.0.0.1:${p}`, port: p, close: () => close(server) };
}

/** A port nothing listens on (bound briefly, then released). */
export async function freePort(): Promise<number> {
  const server = http.createServer();
  const port = await listen(server);
  await close(server);
  return port;
}

/** `count` consecutive loopback ports nothing listens on (each bound briefly, then released). */
export async function freePortRun(count: number): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const base = 20_000 + Math.floor(Math.random() * 40_000);
    const held: http.Server[] = [];
    let ok = true;
    for (let port = base; port < base + count; port++) {
      const server = http.createServer();
      try {
        await listen(server, port);
        held.push(server);
      } catch {
        ok = false;
        break;
      }
    }
    await Promise.all(held.map((s) => close(s)));
    if (ok) return base;
  }
  throw new Error(`no run of ${count} free ports found`);
}

/**
 * Source of a fake `ollama` executable: `serve` listens on OLLAMA_HOST and
 * answers like Ollama; GET /fake/env reports OLLAMA_MODELS. FAKE_LOADED (a
 * comma list) seeds /api/ps; POST /api/generate with keep_alive 0 unloads
 * one. Unloads and SIGTERM are logged to stdout (the serve log). CommonJS
 * so it runs from an extensionless file with no package.json nearby.
 */
export function fakeOllamaScript(version = "0.0.2-fake-app"): string {
  return `#!${process.execPath}
const http = require("node:http");
const [cmd] = process.argv.slice(2);
if (cmd === "--version" || cmd === "-v") { console.log("ollama version is ${version}"); process.exit(0); }
if (cmd !== "serve") { console.error("fake ollama: unknown command " + cmd); process.exit(2); }
const [host, port] = (process.env.OLLAMA_HOST || "127.0.0.1:11434").split(":");
const loaded = (process.env.FAKE_LOADED || "").split(",").filter(Boolean);
const server = http.createServer((req, res) => {
  const json = (b) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
  if (req.url === "/") { res.writeHead(200); res.end("Ollama is running"); }
  else if (req.url === "/api/version") json({ version: "${version}" });
  else if (req.url === "/api/tags") json({ models: [{ name: "fake:1b", digest: "d1", size: 1, modified_at: "2026-01-01T00:00:00Z" }] });
  else if (req.url === "/api/ps") json({ models: loaded.map((name) => ({ name, size: 1, size_vram: 1 })) });
  else if (req.url === "/api/generate" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const b = JSON.parse(body || "{}");
      if (b.keep_alive === 0 && loaded.includes(b.model)) { loaded.splice(loaded.indexOf(b.model), 1); console.log("unloaded " + b.model); }
      json({ model: b.model, response: "", done: true });
    });
  }
  else if (req.url === "/fake/env") json({ OLLAMA_MODELS: process.env.OLLAMA_MODELS ?? null, OLLAMA_HOST: process.env.OLLAMA_HOST });
  else { res.writeHead(404); res.end(); }
});
server.listen(Number(port), host, () => console.log("fake ollama listening on " + host + ":" + port));
process.on("SIGTERM", () => { console.log("got SIGTERM"); server.close(); process.exit(0); });
`;
}

/**
 * POSIX: the script itself, run through its #! line. Windows runs only real
 * executables, so there `<dir>/ollama.exe` is Node itself (a hard link, or a
 * copy across volumes) and the script is `<dir>/serve`: the app starts
 * `ollama.exe serve` in the binary's folder (runtime.ts), and Node runs the
 * file named by its first argument. The script then sees argv ["serve"] as
 * on POSIX. Returns the path to run: `file`, with `.exe` on Windows.
 */
export function writeFakeBinary(file: string, script = fakeOllamaScript()): string {
  mkdirSync(path.dirname(file), { recursive: true });
  if (process.platform !== "win32") {
    writeFileSync(file, script);
    chmodSync(file, 0o755);
    return file;
  }
  const exe = file.toLowerCase().endsWith(".exe") ? file : `${file}.exe`;
  rmSync(exe, { force: true });
  try {
    linkSync(process.execPath, exe);
  } catch {
    copyFileSync(process.execPath, exe);
  }
  const nl = script.indexOf("\n");
  const [shebang, body] = script.startsWith("#!") ? [script.slice(0, nl + 1), script.slice(nl + 1)] : ["", script];
  writeFileSync(path.join(path.dirname(exe), "serve"), `${shebang}process.argv.splice(2, 0, "serve");\n${body}`);
  return exe;
}

/** A small release tarball (tar.zst) laid out like Ollama's: bin/ollama, lib/ollama/. */
export function buildFakeTarball(workDir: string): Buffer {
  const src = path.join(workDir, "tarball-src");
  writeFakeBinary(path.join(src, "bin", "ollama"));
  mkdirSync(path.join(src, "lib", "ollama"), { recursive: true });
  writeFileSync(path.join(src, "lib", "ollama", "libfake.so"), "not really a library\n");
  const tar = execFileSync("tar", ["-cf", "-", "-C", src, "bin", "lib"]);
  return zlib.zstdCompressSync(tar);
}

/** The archive format of this host's Ollama release: what buildFakeRelease makes. */
export const FAKE_RELEASE_FORMAT: "tar.zst" | "zip" = process.platform === "win32" ? "zip" : "tar.zst";

/** A file under lib/ollama/ in the fake release, relative to the install dir. */
export const FAKE_RELEASE_LIB = path.join("lib", "ollama", process.platform === "win32" ? "fake.dll" : "libfake.so");

/**
 * This host's release, laid out like Ollama's: on Linux the tar.zst above;
 * on Windows a ZIP with ollama.exe at the top and lib\ollama\ beside it, as
 * in ollama-windows-amd64.zip. Its ollama.exe runs as the fake server
 * (writeFakeBinary). Stored, not deflated: Node is large and compressing
 * it would only slow the tests.
 */
export function buildFakeRelease(workDir: string): Buffer {
  if (process.platform !== "win32") return buildFakeTarball(workDir);
  const src = path.join(workDir, "release-src");
  writeFakeBinary(path.join(src, "ollama.exe"));
  mkdirSync(path.join(src, "lib", "ollama"), { recursive: true });
  writeFileSync(path.join(src, FAKE_RELEASE_LIB), "not really a library\n");
  const out = path.join(workDir, "release.zip");
  execFileSync(windowsTar(), ["-a", "-c", "-f", out, "--options", "zip:compression=store", "-C", src, "ollama.exe", "serve", "lib"], { windowsHide: true });
  return readFileSync(out);
}

export type ReleaseServer = {
  url: string;
  hits: number;
  mode: "ok" | "truncate" | "404";
  close(): Promise<void>;
};

/** Serves one asset; "truncate" sends half the bytes and drops the socket. */
export async function startReleaseServer(asset: Buffer): Promise<ReleaseServer> {
  const rs: ReleaseServer = { url: "", hits: 0, mode: "ok", close: async () => close(server) };
  const server = http.createServer((req, res) => {
    rs.hits++;
    if (rs.mode === "404" || req.url !== "/asset") {
      res.writeHead(404);
      res.end("Not Found");
      return;
    }
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(asset.length) });
    if (rs.mode === "truncate") {
      res.write(asset.subarray(0, Math.floor(asset.length / 2)), () => {
        setTimeout(() => res.socket?.destroy(), 20);
      });
      return;
    }
    res.end(asset);
  });
  const port = await listen(server);
  rs.url = `http://127.0.0.1:${port}/asset`;
  return rs;
}
