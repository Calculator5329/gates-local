// The phone listener (GATES_LOCAL_WEB_LISTEN): a second loopback HTTP
// listener that Tailscale Serve proxies to. Real sockets on 127.0.0.1 port 0.
// Admission is the Tailscale-User-Login header, the Host header and (for the
// upgrade) the Origin header; there is no token on this listener.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import os from "node:os";
import path from "node:path";
import { type Client, type SocketLike, createClient } from "@gates-local/contracts";
import { methodSamples, pushSamples } from "@gates-local/contracts/testing";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { type Handlers, type WsServer, startWsServer } from "../src/ws/server.ts";

const TOKEN = "per-launch-secret";
const ORIGIN = "https://hub.example.ts.net:8456";
const HOST = "hub.example.ts.net:8456";
const USER = "owner@example.com";
const SECRET = "outside-the-dist-dir";
const INDEX = "<!doctype html>\n<html><head>\n<title>Gates Local</title>\n</head><body><div id=root></div></body></html>\n";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).toReversed()) await c();
});

interface Fixture {
  readonly webRoot: string;
  readonly dataDir: string;
}

function fixture(): Fixture {
  const base = path.join(os.homedir(), ".cache", "gates-local-tests");
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(path.join(base, "phone-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const webRoot = path.join(dir, "dist");
  const outside = path.join(dir, "outside");
  const dataDir = path.join(dir, "data");
  mkdirSync(path.join(webRoot, "assets"), { recursive: true });
  mkdirSync(outside);
  mkdirSync(path.join(dataDir, "images"), { recursive: true });
  writeFileSync(path.join(webRoot, "index.html"), INDEX);
  writeFileSync(path.join(webRoot, "assets", "app-abc.js"), "console.log('app');\n");
  writeFileSync(path.join(webRoot, "assets", "app-abc.css"), "body{}\n");
  writeFileSync(path.join(outside, "secret.txt"), SECRET);
  symlinkSync(path.join(outside, "secret.txt"), path.join(webRoot, "link.txt"));
  symlinkSync(outside, path.join(webRoot, "linkdir"));
  writeFileSync(path.join(dataDir, "images", "abc.png"), PNG);
  return { webRoot, dataDir };
}

function handlers(): Partial<Handlers> {
  return { "threads.list": () => methodSamples["threads.list"].result } as Partial<Handlers>;
}

async function start(fx: Fixture, logs: string[] = []): Promise<WsServer & { phonePort: number }> {
  const server = await startWsServer({
    port: 0,
    token: TOKEN,
    allowedOrigins: ["http://127.0.0.1:5187"],
    handlers: handlers(),
    dataDir: fx.dataDir,
    log: (line) => logs.push(line),
    phone: { host: "127.0.0.1", port: 0, origin: ORIGIN, user: USER, webRoot: fx.webRoot },
  });
  cleanups.push(() => server.close());
  expect(server.phonePort, "the phone listener's port").toBeTypeOf("number");
  return server as WsServer & { phonePort: number };
}

interface Reply {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

const GOOD = { host: HOST, "tailscale-user-login": USER };

/** A raw GET: node does not normalise the path, so traversal reaches the server as written. */
function get(port: number, rawPath: string, headers: Record<string, string> = GOOD): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: rawPath, method: "GET", headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("latin1") }));
    });
    req.on("error", reject);
    req.end();
  });
}

function phoneSocket(port: number, headers: Record<string, string>, origin: string | undefined): WebSocket {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers, ...(origin === undefined ? {} : { origin }) });
  cleanups.push(() => ws.terminate());
  return ws;
}

/** Upgrade outcome on the phone listener: "open" or the refusal status. */
function upgrade(port: number, headers: Record<string, string>, origin: string | undefined): Promise<number | "open"> {
  const ws = phoneSocket(port, headers, origin);
  return new Promise((resolve) => {
    ws.once("open", () => resolve("open"));
    ws.once("unexpected-response", (_req, res) => resolve(res.statusCode ?? -1));
    ws.once("error", () => resolve(-1));
  });
}

async function opened(ws: WebSocket): Promise<Client> {
  const c = createClient(ws as unknown as SocketLike, { timeoutMs: 2000 });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  return c;
}

function expectSecurityHeaders(r: Reply): void {
  expect(r.headers["x-content-type-options"]).toBe("nosniff");
  expect(r.headers["referrer-policy"]).toBe("no-referrer");
  expect(r.headers["x-frame-options"]).toBe("DENY");
}

describe("phone listener admission", () => {
  it("a static GET is refused without the user header, with a wrong user or a wrong Host, and admitted with both right", async () => {
    const fx = fixture();
    const logs: string[] = [];
    const s = await start(fx, logs);
    const missing = await get(s.phonePort, "/", { host: HOST });
    const wrongUser = await get(s.phonePort, "/", { host: HOST, "tailscale-user-login": "intruder@example.com" });
    const wrongHost = await get(s.phonePort, "/", { host: "evil.example:8456", "tailscale-user-login": USER });
    const loopbackHost = await get(s.phonePort, "/", { host: `127.0.0.1:${s.phonePort}`, "tailscale-user-login": USER });
    for (const r of [missing, wrongUser, wrongHost, loopbackHost]) {
      expect(r.status).toBe(403);
      expect(r.body).not.toContain("Gates Local");
      expectSecurityHeaders(r);
    }
    const ok = await get(s.phonePort, "/");
    expect(ok.status).toBe(200);
    expect(ok.body).toContain("<title>Gates Local</title>");
    expectSecurityHeaders(ok);
    // One line per refusal, naming the reason and never a header value.
    const refusals = logs.filter((l) => l.includes("phone refused"));
    expect(refusals).toHaveLength(4);
    for (const l of logs) {
      expect(l).not.toContain("intruder@example.com");
      expect(l).not.toContain(USER);
      expect(l).not.toContain("evil.example");
    }
  });

  it("the upgrade is refused for a missing header, a wrong user, a wrong Host and a wrong or missing Origin", async () => {
    const fx = fixture();
    const logs: string[] = [];
    const s = await start(fx, logs);
    expect(await upgrade(s.phonePort, { host: HOST }, ORIGIN)).toBe(403);
    expect(await upgrade(s.phonePort, { host: HOST, "tailscale-user-login": "intruder@example.com" }, ORIGIN)).toBe(403);
    expect(await upgrade(s.phonePort, { host: "evil.example:8456", "tailscale-user-login": USER }, ORIGIN)).toBe(403);
    expect(await upgrade(s.phonePort, GOOD, "https://evil.example")).toBe(403);
    expect(await upgrade(s.phonePort, GOOD, "https://hub.example.ts.net")).toBe(403);
    expect(await upgrade(s.phonePort, GOOD, undefined)).toBe(403);
    expect(logs.filter((l) => l.includes("phone refused"))).toHaveLength(6);
    for (const l of logs) {
      expect(l).not.toContain("intruder@example.com");
      expect(l).not.toContain("evil.example");
      expect(l).not.toContain(USER);
    }
  });

  it("an upgrade with all three right opens without a token and answers a real method", async () => {
    const fx = fixture();
    const s = await start(fx);
    const c = await opened(phoneSocket(s.phonePort, GOOD, ORIGIN));
    expect(await c.call("threads.list", {})).toEqual(methodSamples["threads.list"].result);
  });

  it("the token listener's upgrade path does not open on the phone listener, and the token does not stand in for the headers", async () => {
    const fx = fixture();
    const s = await start(fx);
    const ws = new WebSocket(`ws://127.0.0.1:${s.phonePort}/?token=${TOKEN}`, { origin: "http://127.0.0.1:5187" });
    cleanups.push(() => ws.terminate());
    const outcome = await new Promise<number | "open">((resolve) => {
      ws.once("open", () => resolve("open"));
      ws.once("unexpected-response", (_req, res) => resolve(res.statusCode ?? -1));
      ws.once("error", () => resolve(-1));
    });
    expect(outcome).toBe(403);
  });

  it("a push reaches a token-listener client and a phone-listener client both", async () => {
    const fx = fixture();
    const s = await start(fx);
    const desk = new WebSocket(`ws://127.0.0.1:${s.port}/?token=${TOKEN}`);
    cleanups.push(() => desk.terminate());
    const deskClient = await opened(desk);
    const phoneClient = await opened(phoneSocket(s.phonePort, GOOD, ORIGIN));
    const got: { desk: unknown[]; phone: unknown[] } = { desk: [], phone: [] };
    deskClient.subscribe("threads.changed", (p) => got.desk.push(p));
    phoneClient.subscribe("threads.changed", (p) => got.phone.push(p));
    const payload = pushSamples["threads.changed"][0];
    s.push("threads.changed", payload as never);
    // A round trip on each socket after the push proves both have read it.
    await deskClient.call("threads.list", {});
    await phoneClient.call("threads.list", {});
    expect(got.desk).toEqual([payload]);
    expect(got.phone).toEqual([payload]);
  });
});

describe("phone listener static files", () => {
  it("GET / and any path that is not a file give index.html with the same-origin meta, no-cache", async () => {
    const fx = fixture();
    const s = await start(fx);
    for (const p of ["/", "/index.html", "/thread/42", "/assets/", "/nope.js"]) {
      const r = await get(s.phonePort, p);
      expect(r.status, p).toBe(200);
      expect(r.headers["content-type"], p).toMatch(/^text\/html/);
      expect(r.headers["cache-control"], p).toBe("no-cache");
      expect(r.body, p).toMatch(/<head>\s*<meta name="gates-local-server" content="same-origin">/);
      expect(r.body, p).toContain("<title>Gates Local</title>");
      expectSecurityHeaders(r);
    }
  });

  it("real files serve with their content types", async () => {
    const fx = fixture();
    const s = await start(fx);
    const js = await get(s.phonePort, "/assets/app-abc.js");
    expect(js.status).toBe(200);
    expect(js.headers["content-type"]).toMatch(/^text\/javascript/);
    expect(js.body).toBe("console.log('app');\n");
    expectSecurityHeaders(js);
    const css = await get(s.phonePort, "/assets/app-abc.css?v=1");
    expect(css.status).toBe(200);
    expect(css.headers["content-type"]).toMatch(/^text\/css/);
  });

  it.each([
    "/../outside/secret.txt",
    "/assets/../../outside/secret.txt",
    "/%2e%2e/outside/secret.txt",
    "/%2E%2E%2Foutside%2Fsecret.txt",
    "/assets/..%2f..%2foutside%2fsecret.txt",
    "/assets/..%5c..%5coutside%5csecret.txt",
    "//etc/passwd",
    "/%2fetc%2fpasswd",
    "/link.txt",
    "/linkdir/secret.txt",
    "/assets/%00.js",
  ])("refuses %s with 403 or 404 and never a file outside the dir", async (raw) => {
    const fx = fixture();
    const s = await start(fx);
    const r = await get(s.phonePort, raw);
    expect([403, 404]).toContain(r.status);
    expect(r.body).not.toContain(SECRET);
    expect(r.body).not.toContain("root:");
    expectSecurityHeaders(r);
  });

  it("serves /files/ images with this listener's admission instead of the token", async () => {
    const fx = fixture();
    const s = await start(fx);
    const ok = await get(s.phonePort, "/files/images/abc.png");
    expect(ok.status).toBe(200);
    expect(ok.headers["content-type"]).toBe("image/png");
    expect(Buffer.from(ok.body, "latin1")).toEqual(PNG);
    expectSecurityHeaders(ok);
    const refused = await get(s.phonePort, `/files/images/abc.png?token=${TOKEN}`, { host: HOST });
    expect(refused.status).toBe(403);
    expect(refused.body).toBe("");
    const missing = await get(s.phonePort, "/files/images/none.png");
    expect(missing.status).toBe(404);
  });

  it("refuses a method other than GET or HEAD", async () => {
    const fx = fixture();
    const s = await start(fx);
    const r = await new Promise<number>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: s.phonePort, path: "/", method: "POST", headers: GOOD }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
    });
    expect(r).toBe(405);
  });
});

describe("phone listener bind", () => {
  it("refuses a non-loopback host", async () => {
    const fx = fixture();
    await expect(
      startWsServer({
        port: 0,
        token: TOKEN,
        allowedOrigins: [],
        handlers: {},
        phone: { host: "0.0.0.0", port: 0, origin: ORIGIN, user: USER, webRoot: fx.webRoot },
      }),
    ).rejects.toThrow(/loopback only/);
  });
});
