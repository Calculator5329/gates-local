// The phone listener (GATES_LOCAL_WEB_LISTEN=unix:<path>): a Unix socket only
// the owner (and root's tailscaled) can open, which Tailscale Serve proxies
// to. Real sockets. Serve sends a Unix backend Host: localhost, the public
// host in X-Forwarded-Host and its own Tailscale-User-Login
// (ipn/ipnlocal/serve.go, reverseProxy.ServeHTTP and addProxyForwardedHeaders,
// v1.104.4); the upgrade and any state-changing request also need the exact
// Origin. There is no token on this listener.
import { spawn } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { type Server, createServer as createHttpServer, request } from "node:http";
import { connect, createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { type Client, type SocketLike, createClient } from "@gates-local/contracts";
import { methodSamples, pushSamples } from "@gates-local/contracts/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { type SocketTestHooks, listenOwnerSocket } from "../src/web/socket.ts";
import { type Handlers, type WsServer, startWsServer } from "../src/ws/server.ts";
import { createSettingsHandlers } from "../src/settings/handlers.ts";
import { openSettingsStore } from "../src/settings/store.ts";

const reusedIdentity = vi.hoisted(() => ({ socketPath: "", inodes: new Set<string>(), equalTimes: false }));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    lstatSync: (...args: Parameters<typeof fs.lstatSync>) => {
      const st = fs.lstatSync(...args);
      // A freed inode number can be reused by the next bind. Keep real socket
      // operations, modes and timestamps; force only that identity collision.
      if (st && args[0] === reusedIdentity.socketPath) {
        const inode = String(st.ino);
        if (reusedIdentity.inodes.size < 2) reusedIdentity.inodes.add(inode);
        if (reusedIdentity.inodes.has(inode)) {
          if (typeof st.ino === "bigint") st.ino = 1n;
          else st.ino = 1;
          if (reusedIdentity.equalTimes) {
            st.ctimeMs = typeof st.ctimeMs === "bigint" ? 1n : 1;
            st.birthtimeMs = typeof st.birthtimeMs === "bigint" ? 1n : 1;
            if ("ctimeNs" in st) st.ctimeNs = 1n;
            if ("birthtimeNs" in st) st.birthtimeNs = 1n;
          }
        }
      }
      return st;
    },
  };
});

const TOKEN = "per-launch-secret";
const ORIGIN = "https://hub.example.ts.net:8456";
const PUBLIC_HOST = "hub.example.ts.net:8456";
const USER = "owner@example.com";
const SECRET = "outside-the-dist-dir";
const INDEX = "<!doctype html>\n<html><head>\n<title>Gates Local</title>\n</head><body><div id=root></div></body></html>\n";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  reusedIdentity.socketPath = "";
  reusedIdentity.inodes.clear();
  reusedIdentity.equalTimes = false;
  for (const c of cleanups.splice(0).toReversed()) await c();
});

interface Fixture {
  readonly dir: string;
  readonly webRoot: string;
  readonly dataDir: string;
  /** Not created: the server makes it 0700. */
  readonly runDir: string;
  readonly socketPath: string;
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
  const runDir = path.join(dir, "run");
  return { dir, webRoot, dataDir, runDir, socketPath: path.join(runDir, "phone.sock") };
}

function handlers(): Partial<Handlers> {
  return { "threads.list": () => methodSamples["threads.list"].result } as Partial<Handlers>;
}

it("AV-01 phone updates are status-only while the desktop listener retains its controls", async () => {
  const fx = fixture();
  let mutations = 0;
  const server = await startWsServer({ port: 0, token: TOKEN, allowedOrigins: [],
    handlers: {
      "update.status": () => methodSamples["update.status"].result,
      "update.prepare": () => { mutations++; return { state: "blocked", message: "probe" }; },
      "update.commit": () => { mutations++; return { accepted: false }; },
      "update.check": () => { mutations++; return methodSamples["update.check"].result; },
      "update.cancel": () => { mutations++; return { cancelled: false }; },
      "update.dismissResult": () => { mutations++; return { dismissed: false }; },
    },
    phone: { socketPath: fx.socketPath, origin: ORIGIN, user: USER, webRoot: fx.webRoot },
  });
  cleanups.push(() => server.close());
  const client = await opened(phoneSocket(fx.socketPath, SERVE, ORIGIN));
  expect(await client.call("update.status", {})).toEqual(methodSamples["update.status"].result);
  for (const method of ["update.prepare", "update.commit", "update.check", "update.cancel", "update.dismissResult"] as const) {
    await expect(client.call(method, methodSamples[method].params as never)).rejects.toMatchObject({ code: "forbidden" });
  }
  expect(mutations).toBe(0);
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/?token=${TOKEN}`);
  cleanups.push(() => socket.terminate());
  const desktop = await opened(socket);
  expect(await desktop.call("update.prepare", { approval: "probe" })).toEqual({ state: "blocked", message: "probe" });
  expect(mutations).toBe(1);
});

it("UB-01 phone Reset preserves desktop update preferences while desktop Reset can change them", async () => {
  const fx = fixture();
  const settings = await openSettingsStore({ dataDir: fx.dataDir, systemOllamaAnswers: async () => false });
  settings.update({ updateAutomatic: false, updateEveryChange: true, theme: "light", tools: false, defaultNumCtx: 8192 });
  const pushes: unknown[] = [];
  const server = await startWsServer({ port: 0, token: TOKEN, allowedOrigins: [],
    handlers: createSettingsHandlers({ settings, push: (_channel, payload) => pushes.push(payload) }),
    phone: { socketPath: fx.socketPath, origin: ORIGIN, user: USER, webRoot: fx.webRoot },
  });
  cleanups.push(() => server.close());
  const phone = await opened(phoneSocket(fx.socketPath, SERVE, ORIGIN));
  const before = settings.get();
  const file = path.join(fx.dataDir, "settings.json");
  const saved = readFileSync(file, "utf8");
  const preferences = { updateAutomatic: true, updateEveryChange: false };
  expect.soft(await phone.call("settings.update", preferences)).toEqual(before);
  expect.soft(settings.get()).toBe(before);
  expect.soft(readFileSync(file, "utf8")).toBe(saved);
  expect.soft(pushes).toEqual([]);

  // The same fields sent by Advanced > Reset, including its non-update settings.
  const reset = { defaultModel: null, defaultNumCtx: 16384, thinking: true, theme: "dark", tools: true, imageGen: false, comfyUrl: null, whisperUrl: null, ...preferences, textSize: "default", systemPrompt: null, modelSettings: null } as const;
  const kept = { updateAutomatic: false, updateEveryChange: true, theme: "dark", tools: true, defaultNumCtx: 16384 };
  expect.soft(await phone.call("settings.update", reset)).toMatchObject(kept);
  expect.soft(settings.get()).toMatchObject(kept);
  expect.soft(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ settings: kept });
  expect.soft(pushes.at(-1)).toMatchObject(kept);

  settings.update({ updateAutomatic: false, updateEveryChange: true, theme: "light" });
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/?token=${TOKEN}`);
  cleanups.push(() => socket.terminate());
  const desktop = await opened(socket);
  expect(await desktop.call("settings.update", reset)).toMatchObject({ ...kept, ...preferences });
  expect(settings.get()).toMatchObject({ ...kept, ...preferences });
});

function startRaw(fx: Fixture, logs: string[] = [], socketPath = fx.socketPath, peers?: readonly string[]): Promise<WsServer> {
  return startWsServer({
    port: 0,
    token: TOKEN,
    allowedOrigins: ["http://127.0.0.1:5187"],
    handlers: handlers(),
    dataDir: fx.dataDir,
    log: (line) => logs.push(line),
    phone: { socketPath, origin: ORIGIN, user: USER, webRoot: fx.webRoot, ...(peers === undefined ? {} : { peers }) },
  });
}

async function start(fx: Fixture, logs: string[] = [], peers?: readonly string[]): Promise<WsServer & { phoneSocket: string }> {
  const server = await startRaw(fx, logs, fx.socketPath, peers);
  cleanups.push(() => server.close());
  expect(server.phoneSocket, "the phone listener's socket").toBe(fx.socketPath);
  return server as WsServer & { phoneSocket: string };
}

interface Reply {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

/** The phone's tailnet address in these tests: TEST-NET-1, never one of this machine's. */
const PHONE_ADDR = "192.0.2.10";

/** What Serve sends a Unix backend for the owner's request from the phone. */
const SERVE = { host: "localhost", "x-forwarded-host": PUBLIC_HOST, "x-forwarded-for": PHONE_ADDR, "tailscale-user-login": USER };

/** A raw request over the socket: node does not normalise the path, so traversal reaches the server as written. */
function req(socketPath: string, rawPath: string, headers: Record<string, string | string[]> = SERVE, method = "GET"): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const r = request({ socketPath, path: rawPath, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("latin1") }));
    });
    r.on("error", reject);
    r.end();
  });
}

function phoneSocket(socketPath: string, headers: Record<string, string>, origin: string | undefined, urlPath = "/ws"): WebSocket {
  const ws = new WebSocket(`ws+unix:${socketPath}:${urlPath}`, { headers, ...(origin === undefined ? {} : { origin }) });
  cleanups.push(() => ws.terminate());
  return ws;
}

/** Upgrade outcome on the phone listener: "open" or the refusal status. */
function upgrade(socketPath: string, headers: Record<string, string>, origin: string | undefined, urlPath = "/ws"): Promise<number | "open"> {
  const ws = phoneSocket(socketPath, headers, origin, urlPath);
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

/** Every request shape that is not Serve's for the owner. */
const NOT_SERVE: ReadonlyArray<readonly [string, Record<string, string>]> = [
  ["no login", { host: "localhost", "x-forwarded-host": PUBLIC_HOST, "x-forwarded-for": PHONE_ADDR }],
  ["a wrong user", { ...SERVE, "tailscale-user-login": "intruder@example.com" }],
  ["the public Host (a TCP-backend shape)", { ...SERVE, host: PUBLIC_HOST }],
  ["no X-Forwarded-Host", { host: "localhost", "x-forwarded-for": PHONE_ADDR, "tailscale-user-login": USER }],
  ["a wrong X-Forwarded-Host", { ...SERVE, "x-forwarded-host": "evil.example:8456" }],
];

describe("phone listener admission (Serve's Unix-backend header shape)", () => {
  it("a static GET is refused for every shape that is not Serve's for the owner, and admitted for Serve's", async () => {
    const fx = fixture();
    const logs: string[] = [];
    const s = await start(fx, logs);
    for (const [what, headers] of NOT_SERVE) {
      const r = await req(s.phoneSocket, "/", headers);
      expect(r.status, what).toBe(403);
      expect(r.body, what).not.toContain("Gates Local");
      expectSecurityHeaders(r);
    }
    const ok = await req(s.phoneSocket, "/");
    expect(ok.status).toBe(200);
    expect(ok.body).toContain("<title>Gates Local</title>");
    expectSecurityHeaders(ok);
    // One line per refusal, naming the reason and never a header value.
    expect(logs.filter((l) => l.includes("phone refused"))).toHaveLength(NOT_SERVE.length);
    for (const l of logs) {
      expect(l).not.toContain("intruder@example.com");
      expect(l).not.toContain(USER);
      expect(l).not.toContain("evil.example");
    }
  });

  it("the upgrade is refused for every non-Serve shape and for a wrong or missing Origin", async () => {
    const fx = fixture();
    const logs: string[] = [];
    const s = await start(fx, logs);
    for (const [what, headers] of NOT_SERVE) expect(await upgrade(s.phoneSocket, headers, ORIGIN), what).toBe(403);
    expect(await upgrade(s.phoneSocket, SERVE, "https://evil.example")).toBe(403);
    expect(await upgrade(s.phoneSocket, SERVE, "https://hub.example.ts.net")).toBe(403);
    expect(await upgrade(s.phoneSocket, SERVE, undefined)).toBe(403);
    expect(logs.filter((l) => l.includes("phone refused"))).toHaveLength(NOT_SERVE.length + 3);
    for (const l of logs) {
      expect(l).not.toContain("intruder@example.com");
      expect(l).not.toContain("evil.example");
      expect(l).not.toContain(USER);
    }
  });

  it("an upgrade in Serve's shape with the exact Origin opens without a token and answers a real method", async () => {
    const fx = fixture();
    const s = await start(fx);
    const c = await opened(phoneSocket(s.phoneSocket, SERVE, ORIGIN));
    expect(await c.call("threads.list", {})).toEqual(methodSamples["threads.list"].result);
  });

  it("an admitted upgrade on any path but /ws gets 404", async () => {
    const fx = fixture();
    const s = await start(fx);
    expect(await upgrade(s.phoneSocket, SERVE, ORIGIN, "/")).toBe(404);
    expect(await upgrade(s.phoneSocket, SERVE, ORIGIN, `/?token=${TOKEN}`)).toBe(404);
    expect(await upgrade(s.phoneSocket, SERVE, ORIGIN, "/ws/x")).toBe(404);
  });

  it("a state-changing request needs the exact Origin before anything else answers", async () => {
    const fx = fixture();
    const s = await start(fx);
    expect((await req(s.phoneSocket, "/", SERVE, "POST")).status).toBe(403);
    expect((await req(s.phoneSocket, "/", { ...SERVE, origin: "https://evil.example" }, "POST")).status).toBe(403);
    expect((await req(s.phoneSocket, "/", { ...SERVE, origin: ORIGIN }, "POST")).status).toBe(405);
    expect((await req(s.phoneSocket, "/", { ...SERVE, origin: ORIGIN }, "DELETE")).status).toBe(405);
  });

  it("a push reaches a token-listener client and a phone-listener client both", async () => {
    const fx = fixture();
    const s = await start(fx);
    const desk = new WebSocket(`ws://127.0.0.1:${s.port}/?token=${TOKEN}`);
    cleanups.push(() => desk.terminate());
    const deskClient = await opened(desk);
    const phoneClient = await opened(phoneSocket(s.phoneSocket, SERVE, ORIGIN));
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

/** This machine's own addresses as os.networkInterfaces() gives them, link-local ones with their zone id as a socket would show it. */
function ownAddresses(): string[] {
  const out: string[] = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list ?? []) out.push(a.family === "IPv6" && a.address.startsWith("fe80:") ? `${a.address}%${name}` : a.address);
  }
  return out;
}

/** Spellings of a self source Serve or a hand-made request could carry: mapped, expanded and upper-case forms. */
const SELF_SPELLINGS = ["127.0.0.1", "::1", "0:0:0:0:0:0:0:1", "::ffff:127.0.0.1", "::FFFF:127.0.0.1", "::ffff:7f00:1"];

// Serve stamps the owner's login on a connection from this machine too (WhoIs
// finds the self node by its Tailscale address), so the source address is
// checked apart from the login: every case here carries the right login.
describe("phone listener source address (Serve's X-Forwarded-For)", () => {
  it("refuses a request and an upgrade from any of this machine's own addresses, in every spelling", async () => {
    const fx = fixture();
    const logs: string[] = [];
    const s = await start(fx, logs);
    const selves = [...SELF_SPELLINGS, ...ownAddresses(), ...ownAddresses().filter((a) => a.includes(":")).map((a) => a.toUpperCase())];
    for (const self of selves) {
      expect((await req(s.phoneSocket, "/", { ...SERVE, "x-forwarded-for": self })).status, self).toBe(403);
      expect(await upgrade(s.phoneSocket, { ...SERVE, "x-forwarded-for": self }, ORIGIN), self).toBe(403);
    }
    expect(logs.filter((l) => l.includes("this machine")).length).toBe(selves.length * 2);
    for (const l of logs) expect(l).not.toContain("127.0.0.1");
  });

  it("refuses a missing, multi-valued or malformed X-Forwarded-For", async () => {
    const fx = fixture();
    const s = await start(fx);
    const { "x-forwarded-for": _, ...noSource } = SERVE;
    const bad: ReadonlyArray<readonly [string, Record<string, string | string[]>]> = [
      ["missing", noSource],
      ["empty", { ...SERVE, "x-forwarded-for": "" }],
      ["a list", { ...SERVE, "x-forwarded-for": `${PHONE_ADDR}, 192.0.2.11` }],
      ["a list without a space", { ...SERVE, "x-forwarded-for": `${PHONE_ADDR},192.0.2.11` }],
      ["two header lines", { ...SERVE, "x-forwarded-for": [PHONE_ADDR, "192.0.2.11"] }],
      ["an address with a port", { ...SERVE, "x-forwarded-for": `${PHONE_ADDR}:443` }],
      ["a host name", { ...SERVE, "x-forwarded-for": "phone.example.ts.net" }],
      ["a trailing comma", { ...SERVE, "x-forwarded-for": `${PHONE_ADDR},` }],
      ["a zone on IPv4", { ...SERVE, "x-forwarded-for": `${PHONE_ADDR}%eth0` }],
      ["bracketed IPv6", { ...SERVE, "x-forwarded-for": "[2001:db8::7]" }],
    ];
    for (const [what, headers] of bad) {
      expect((await req(s.phoneSocket, "/", headers)).status, what).toBe(403);
      expect(await upgrade(s.phoneSocket, headers as Record<string, string>, ORIGIN), what).toBe(403);
    }
  });

  it("with GATES_LOCAL_WEB_PEERS set admits only the listed phones, in any spelling, and still needs the login", async () => {
    const fx = fixture();
    const s = await start(fx, [], [PHONE_ADDR, "2001:db8::7"]);
    for (const outside of ["192.0.2.11", "2001:db8::8", "100.64.0.9"]) {
      expect((await req(s.phoneSocket, "/", { ...SERVE, "x-forwarded-for": outside })).status, outside).toBe(403);
      expect(await upgrade(s.phoneSocket, { ...SERVE, "x-forwarded-for": outside }, ORIGIN), outside).toBe(403);
    }
    for (const listed of [PHONE_ADDR, `::ffff:${PHONE_ADDR}`, "2001:db8::7", "2001:DB8:0:0:0:0:0:7"]) {
      expect((await req(s.phoneSocket, "/", { ...SERVE, "x-forwarded-for": listed })).status, listed).toBe(200);
      expect(await upgrade(s.phoneSocket, { ...SERVE, "x-forwarded-for": listed }, ORIGIN), listed).toBe("open");
    }
    expect((await req(s.phoneSocket, "/", { ...SERVE, "tailscale-user-login": "intruder@example.com" })).status).toBe(403);
  });

  it("an allowlist naming this machine still refuses this machine", async () => {
    const fx = fixture();
    const s = await start(fx, [], ["127.0.0.1", PHONE_ADDR]);
    expect((await req(s.phoneSocket, "/", { ...SERVE, "x-forwarded-for": "127.0.0.1" })).status).toBe(403);
    expect((await req(s.phoneSocket, "/")).status).toBe(200);
  });

  it("refuses a malformed allowlist at start", async () => {
    const fx = fixture();
    await expect(startRaw(fx, [], fx.socketPath, ["192.0.2.10", "phone"])).rejects.toThrow(/peer/);
    expect(existsSync(fx.socketPath)).toBe(false);
  });
});

describe("phone listener static files", () => {
  it("GET / and any path that is not a file give index.html with the same-origin meta, no-cache", async () => {
    const fx = fixture();
    const s = await start(fx);
    for (const p of ["/", "/index.html", "/thread/42", "/assets/", "/nope.js"]) {
      const r = await req(s.phoneSocket, p);
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
    const js = await req(s.phoneSocket, "/assets/app-abc.js");
    expect(js.status).toBe(200);
    expect(js.headers["content-type"]).toMatch(/^text\/javascript/);
    expect(js.body).toBe("console.log('app');\n");
    expectSecurityHeaders(js);
    const css = await req(s.phoneSocket, "/assets/app-abc.css?v=1");
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
    const r = await req(s.phoneSocket, raw);
    expect([403, 404]).toContain(r.status);
    expect(r.body).not.toContain(SECRET);
    expect(r.body).not.toContain("root:");
    expectSecurityHeaders(r);
  });

  it("serves /files/ images with this listener's admission instead of the token", async () => {
    const fx = fixture();
    const s = await start(fx);
    const ok = await req(s.phoneSocket, "/files/images/abc.png");
    expect(ok.status).toBe(200);
    expect(ok.headers["content-type"]).toBe("image/png");
    expect(Buffer.from(ok.body, "latin1")).toEqual(PNG);
    expectSecurityHeaders(ok);
    const refused = await req(s.phoneSocket, `/files/images/abc.png?token=${TOKEN}`, { host: "localhost", "x-forwarded-host": PUBLIC_HOST });
    expect(refused.status).toBe(403);
    expect(refused.body).toBe("");
    const missing = await req(s.phoneSocket, "/files/images/none.png");
    expect(missing.status).toBe(404);
  });
});

/** Run fn with this umask, restoring the old one after. */
/** A promise and the function that resolves it. */
function gate(): { promise: Promise<void>; resolve: () => void } {
  let resolve: (() => void) | null = null;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve: () => resolve?.() };
}

/** A socket file at fx.socketPath that nothing listens on: a child binds it and is SIGKILLed. */
async function staleSocket(fx: Fixture): Promise<void> {
  mkdirSync(fx.runDir, { mode: 0o700 });
  const child = spawn(process.execPath, ["-e", `require("node:net").createServer().listen(${JSON.stringify(fx.socketPath)}, () => console.log("up"))`], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise<void>((resolve) => child.stdout.once("data", () => resolve()));
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGKILL");
  await exited;
  expect(lstatSync(fx.socketPath).isSocket()).toBe(true);
}

async function withUmask<T>(mask: number, fn: () => Promise<T>): Promise<T> {
  const old = process.umask(mask);
  try {
    return await fn();
  } finally {
    process.umask(old);
  }
}

describe("phone socket", () => {
  it("makes a missing parent 0700 and the socket 0600 even under umask 0, owned by this uid", async () => {
    const fx = fixture();
    const s = await withUmask(0, () => start(fx));
    const dir = lstatSync(fx.runDir);
    expect(dir.isDirectory()).toBe(true);
    expect((dir.mode & 0o777).toString(8)).toBe("700");
    const sock = lstatSync(s.phoneSocket);
    expect(sock.isSocket()).toBe(true);
    expect((sock.mode & 0o777).toString(8)).toBe("600");
    expect(sock.uid).toBe(process.getuid?.());
  });

  it("accepts an existing 0700 parent", async () => {
    const fx = fixture();
    mkdirSync(fx.runDir, { mode: 0o700 });
    await start(fx);
  });

  it.each([0o750, 0o740, 0o705, 0o701, 0o770])("refuses a parent with mode %o (group or other access) and creates nothing", async (mode) => {
    const fx = fixture();
    mkdirSync(fx.runDir);
    chmodSync(fx.runDir, mode);
    await expect(startRaw(fx)).rejects.toThrow(/group or other access/);
    expect(existsSync(fx.socketPath)).toBe(false);
    expect(statSync(fx.runDir).mode & 0o777).toBe(mode);
  });

  it("refuses a parent that is a symlink, even to a 0700 directory", async () => {
    const fx = fixture();
    const real = path.join(fx.dir, "real-run");
    mkdirSync(real, { mode: 0o700 });
    symlinkSync(real, fx.runDir);
    await expect(startRaw(fx)).rejects.toThrow(/not a real directory/);
    expect(existsSync(path.join(real, "phone.sock"))).toBe(false);
  });

  it("refuses a parent that is a file", async () => {
    const fx = fixture();
    writeFileSync(fx.runDir, "x");
    await expect(startRaw(fx)).rejects.toThrow(/not a real directory/);
  });

  it("refuses a stale non-socket at the path and leaves it alone", async () => {
    const fx = fixture();
    mkdirSync(fx.runDir, { mode: 0o700 });
    writeFileSync(fx.socketPath, "not a socket");
    await expect(startRaw(fx)).rejects.toThrow(/not a socket/);
    expect(readFileSync(fx.socketPath, "utf8")).toBe("not a socket");
  });

  it("refuses a symlink at the socket path and leaves it alone", async () => {
    const fx = fixture();
    mkdirSync(fx.runDir, { mode: 0o700 });
    symlinkSync(path.join(fx.dir, "elsewhere.sock"), fx.socketPath);
    await expect(startRaw(fx)).rejects.toThrow(/not a socket/);
    expect(lstatSync(fx.socketPath).isSymbolicLink()).toBe(true);
  });

  it("removes a stale socket a dead server left, then listens", async () => {
    const fx = fixture();
    await staleSocket(fx);
    const s = await start(fx);
    expect((await req(s.phoneSocket, "/")).status).toBe(200);
  });

  it("RJ equal identity: never removes a live socket with reused inode and equal timestamps", async () => {
    const fx = fixture(); await staleSocket(fx);
    reusedIdentity.socketPath = fx.socketPath; reusedIdentity.equalTimes = true;
    const before = lstatSync(fx.socketPath,{bigint:true});
    const winner = createHttpServer((_q,r)=>r.end("winner"));
    const loser = createHttpServer((_q,r)=>r.end("loser"));
    cleanups.push(()=>new Promise(resolve=>loser.close(resolve)));
    cleanups.push(()=>new Promise(resolve=>winner.close(resolve)));
    const attempt = listenOwnerSocket(loser,fx.socketPath,{afterRefusedProbe:async()=>{
      rmSync(fx.socketPath);
      await withUmask(0o177,()=>new Promise<void>(resolve=>winner.listen(fx.socketPath,resolve)));
      const after = lstatSync(fx.socketPath,{bigint:true});
      expect([after.ino,after.ctimeNs,after.birthtimeNs]).toEqual([before.ino,before.ctimeNs,before.birthtimeNs]);
    }});
    await expect(attempt).rejects.toThrow(/already listening/);
    expect((await req(fx.socketPath,"/")).body).toBe("winner");
    expect(loser.listening).toBe(false);
  });

  it.each(["exit", "kill"])("RJ socket lease: excludes a live process and recovers after %s", async (mode) => {
    const fx = fixture();
    const script = `import {createServer} from "node:http"; import {listenOwnerSocket} from ${JSON.stringify(path.resolve("apps/server/src/web/socket.ts"))}; const server=createServer((_q,r)=>r.end("child")); await listenOwnerSocket(server,${JSON.stringify(fx.socketPath)}); process.stdin.once("data",()=>process.exit(0)); console.log("ready");`;
    const child = spawn(process.execPath,["--input-type=module","-e",script],{stdio:["pipe","pipe","inherit"]});
    const exited = new Promise<void>(resolve=>child.once("exit",()=>resolve()));
    cleanups.push(async()=>{ if (child.exitCode===null && child.signalCode===null) child.kill("SIGKILL"); await exited; });
    await new Promise<void>((resolve,reject)=>{ child.stdout.once("data",()=>resolve()); child.once("error",reject); child.once("exit",()=>reject(new Error("socket child ended before readiness"))); });
    const lock = `${fx.socketPath}.lock`;
    expect(existsSync(lock)).toBe(true);
    await expect(startRaw(fx)).rejects.toThrow(/locked by another starter/);
    expect((await req(fx.socketPath,"/")).body).toBe("child");
    if (mode==="exit") child.stdin.end("exit"); else child.kill("SIGKILL");
    await exited;
    expect(existsSync(lock)).toBe(mode==="kill");
    if (mode==="kill") expect(lstatSync(fx.socketPath).isSocket()).toBe(true);
    const server = await startRaw(fx);
    try { expect((await req(fx.socketPath,"/")).status).toBe(200); }
    finally { await server.close(); }
    expect(existsSync(lock)).toBe(false);
  });

  it.each([false, true])("two starts that both find the same stale socket: exactly one binds, and the path reaches it (reused inode: %s)", async (reuseInode) => {
    const fx = fixture();
    await staleSocket(fx);
    if (reuseInode) reusedIdentity.socketPath = fx.socketPath;
    reusedIdentity.equalTimes = reuseInode;
    // Hold the first starter inside cleanup while the second tries to
    // enter. Only the lease owner may probe or unlink the stale socket.
    const firstProbed = gate();
    const secondDone = gate();
    const firstHooks: SocketTestHooks = {
      afterRefusedProbe: () => {
        firstProbed.resolve();
        return secondDone.promise;
      },
    };
    const servers = ["first", "second"].map((name) => {
      const s = createHttpServer((_q, r) => r.end(name));
      cleanups.push(() => new Promise((resolve) => s.close(resolve)));
      return s;
    });
    const first = listenOwnerSocket(servers[0] as Server, fx.socketPath, firstHooks);
    await firstProbed.promise;
    const results = await Promise.allSettled([first, listenOwnerSocket(servers[1] as Server, fx.socketPath).finally(() => secondDone.resolve())]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
    expect(String((results[1] as PromiseRejectedResult).reason)).toMatch(/locked by another starter/);
    expect(servers[1]?.listening).toBe(false);
    expect((await req(fx.socketPath, "/")).body).toBe("first");
  });

  it.each([false, true])("refuses to run when the path is no longer the socket it bound, and leaves the other socket alone (reused inode: %s)", async (reuseInode) => {
    const fx = fixture();
    if (reuseInode) reusedIdentity.socketPath = fx.socketPath;
    mkdirSync(fx.runDir, { mode: 0o700 });
    const other = createServer((c) => c.on("error", () => undefined).end("other\n"));
    cleanups.push(() => new Promise((resolve) => other.close(resolve)));
    const ours = createHttpServer((_q, r) => r.end("ours"));
    cleanups.push(() => new Promise((resolve) => ours.close(resolve)));
    const hooks: SocketTestHooks = {
      // Another start of the same user replaces the path, owner-only too, the
      // moment after this one bound it.
      afterBind: () => {
        rmSync(fx.socketPath);
        return withUmask(0o177, () => new Promise<void>((resolve) => other.listen(fx.socketPath, resolve)));
      },
    };
    await expect(listenOwnerSocket(ours, fx.socketPath, hooks)).rejects.toThrow(/not the socket this server bound/);
    const reply = await new Promise<string>((resolve, reject) => {
      const c = connect(fx.socketPath);
      let text = "";
      c.on("data", (d: Buffer) => (text += d.toString()));
      c.on("end", () => resolve(text));
      c.on("error", reject);
    });
    expect(reply).toBe("other\n");
  });

  it("refuses a socket another server is listening on, and that server keeps it", async () => {
    const fx = fixture();
    mkdirSync(fx.runDir, { mode: 0o700 });
    // The probe connects and drops at once; the reset lands on this end.
    const other = createServer((c) => c.on("error", () => undefined).end("other\n"));
    await new Promise<void>((resolve) => other.listen(fx.socketPath, resolve));
    cleanups.push(() => new Promise((resolve) => other.close(resolve)));
    await expect(startRaw(fx)).rejects.toThrow(/already listening/);
    expect(lstatSync(fx.socketPath).isSocket()).toBe(true);
  });

  it("refuses a relative socket path", async () => {
    const fx = fixture();
    await expect(startRaw(fx, [], "run/phone.sock")).rejects.toThrow(/absolute/);
  });

  it("close removes the socket file", async () => {
    const fx = fixture();
    const s = await startRaw(fx);
    expect(existsSync(fx.socketPath)).toBe(true);
    await s.close();
    expect(existsSync(fx.socketPath)).toBe(false);
  });
});
