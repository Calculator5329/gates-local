// The page route on both listeners, over real sockets: a page goes in with the
// listener's own admission and comes out once, under an id, with its limits as
// headers and no token anywhere in the frame's address.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type WsServer, startWsServer } from "../ws/server.ts";
import { PAGES_KEPT, PAGE_MAX_BYTES, PAGE_TTL_MS, createPageRoute, pageDocument, pagePolicy } from "./route.ts";

const TOKEN = "per-launch-secret";
const APP = "http://127.0.0.1:5187";
const PHONE_ORIGIN = "https://hub.example.ts.net:8456";
const SERVE = { host: "localhost", "x-forwarded-host": "hub.example.ts.net:8456", "x-forwarded-for": "192.0.2.10", "tailscale-user-login": "owner@example.com" };
const PAGE = "<!doctype html><html><head><title>Hi</title></head><body><p id=out>hi</p></body></html>";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).toReversed()) await c();
});

interface Reply {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

function send(target: { port: number } | { socketPath: string }, method: string, urlPath: string, headers: Record<string, string> = {}, body?: string | Buffer): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const r = request({ ...("port" in target ? { host: "127.0.0.1", port: target.port } : { socketPath: target.socketPath }), method, path: urlPath, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    r.on("error", reject);
    r.end(body);
  });
}

async function desktop(): Promise<WsServer> {
  const server = await startWsServer({ port: 0, token: TOKEN, allowedOrigins: [APP], handlers: {}, log: () => undefined });
  cleanups.push(() => server.close());
  return server;
}

/** Hands a page to the computer's listener the way the client does, and gives the id. */
async function hand(server: WsServer, code = PAGE): Promise<string> {
  const r = await send(server, "POST", `/pages?token=${TOKEN}`, { origin: APP, "content-type": "text/plain;charset=UTF-8" }, code);
  expect(r.status).toBe(201);
  return (JSON.parse(r.body) as { id: string }).id;
}

describe("the page route on the computer's listener", () => {
  it("takes a page only with the token and an allowed Origin", async () => {
    const server = await desktop();
    expect((await send(server, "POST", "/pages", { origin: APP }, PAGE)).status).toBe(401);
    expect((await send(server, "POST", "/pages?token=wrong", { origin: APP }, PAGE)).status).toBe(401);
    expect((await send(server, "POST", `/pages?token=${TOKEN}`, { origin: "http://evil.example" }, PAGE)).status).toBe(401);
    const ok = await send(server, "POST", `/pages?token=${TOKEN}`, { origin: APP }, PAGE);
    expect(ok.status).toBe(201);
    expect(ok.headers["access-control-allow-origin"]).toBe(APP);
    expect(JSON.parse(ok.body)).toEqual({ id: expect.stringMatching(/^[0-9a-f]{32}$/) });
  });

  it("answers nothing without an id, for a wrong id, or for one already used", async () => {
    const server = await desktop();
    for (const p of ["/pages", "/pages/", "/pages/nope", `/pages/${"0".repeat(32)}`, `/pages/?token=${TOKEN}`]) {
      const r = await send(server, "GET", p);
      expect(r.status, p).toBeGreaterThanOrEqual(400);
      expect(r.body, p).toBe("");
    }
    const id = await hand(server);
    expect((await send(server, "GET", `/pages/${id.toUpperCase()}`)).status).toBe(404);
    expect((await send(server, "HEAD", `/pages/${id}`)).status).toBe(404);
    const first = await send(server, "GET", `/pages/${id}`);
    expect(first.status).toBe(200);
    expect(first.body).toContain("<p id=out>hi</p>");
    const again = await send(server, "GET", `/pages/${id}`);
    expect(again.status).toBe(404);
    expect(again.body).toBe("");
  });

  it("serves the page with its limits as headers, and its address holds no token", async () => {
    const server = await desktop();
    const id = await hand(server);
    const address = `http://127.0.0.1:${server.port}/pages/${id}`;
    expect(address).not.toContain(TOKEN);
    expect(address).not.toContain("token");
    const r = await send(server, "GET", new URL(address).pathname);
    const policy = String(r.headers["content-security-policy"]);
    const nonce = /script-src-elem 'nonce-([0-9a-f]{32})' 'strict-dynamic'/.exec(policy)?.[1];
    expect(nonce, policy).toBeDefined();
    expect(policy).toBe(pagePolicy(nonce!));
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("frame-src 'none'");
    expect(policy).toContain("child-src 'none'");
    expect(policy).toContain("sandbox allow-scripts");
    expect(policy).not.toMatch(/connect-src|unsafe-eval/);
    // script elements run by the nonce alone: a javascript: address has none, so it cannot swap the document
    expect(policy).not.toMatch(/script-src-elem[^;]*unsafe-inline/);
    expect(policy).toContain("script-src-attr 'unsafe-inline'");
    expect(r.headers).toMatchObject({ "content-type": "text/html; charset=utf-8", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff", "cache-control": "no-store" });
    // the WebRTC constructors go first, after the page's doctype
    expect(r.body.startsWith(`<!doctype html><script nonce=${nonce}>for(const k of ["RTCPeerConnection"`)).toBe(true);
    expect(r.body).not.toContain(TOKEN);
  });

  it("refuses a page past the size it serves", async () => {
    const server = await desktop();
    const big = await send(server, "POST", `/pages?token=${TOKEN}`, { origin: APP }, Buffer.alloc(PAGE_MAX_BYTES + 1, 0x61));
    expect(big.status).toBe(413);
    const fits = await send(server, "POST", `/pages?token=${TOKEN}`, { origin: APP }, Buffer.alloc(PAGE_MAX_BYTES, 0x61));
    expect(fits.status).toBe(201);
  });
});

describe("the page route on the phone's listener", () => {
  it("takes a page with Serve's admission and the exact Origin, and frames it for that origin only", async () => {
    const base = path.join(os.homedir(), ".cache", "gates-local-tests");
    mkdirSync(base, { recursive: true });
    const dir = mkdtempSync(path.join(base, "pages-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const webRoot = path.join(dir, "dist");
    mkdirSync(webRoot);
    writeFileSync(path.join(webRoot, "index.html"), "<!doctype html><html><head></head><body></body></html>");
    const socketPath = path.join(dir, "run", "phone.sock");
    const server = await startWsServer({ port: 0, token: TOKEN, allowedOrigins: [], handlers: {}, log: () => undefined, phone: { socketPath, origin: PHONE_ORIGIN, user: SERVE["tailscale-user-login"], webRoot } });
    cleanups.push(() => server.close());
    const phone = { socketPath };
    expect((await send(phone, "POST", "/pages", { ...SERVE }, PAGE)).status).toBe(403);
    expect((await send(phone, "POST", "/pages", { ...SERVE, "tailscale-user-login": "intruder@example.com", origin: PHONE_ORIGIN }, PAGE)).status).toBe(403);
    const taken = await send(phone, "POST", "/pages", { ...SERVE, origin: PHONE_ORIGIN }, PAGE);
    expect(taken.status).toBe(201);
    const { id } = JSON.parse(taken.body) as { id: string };
    // an id from the phone is the phone's: the computer's listener does not know it
    expect((await send(server, "GET", `/pages/${id}`)).status).toBe(404);
    expect((await send(phone, "GET", `/pages/${id}`, { ...SERVE, "tailscale-user-login": "intruder@example.com" })).status).toBe(403);
    const r = await send(phone, "GET", `/pages/${id}`, SERVE);
    expect(r.status).toBe(200);
    // everything else on this listener refuses framing; its pages are framed by the phone's own origin
    expect(r.headers["x-frame-options"]).toBeUndefined();
    expect(r.headers["content-security-policy"]).toMatch(/^default-src 'none'; .*; sandbox allow-scripts; frame-ancestors /);
    expect(String(r.headers["content-security-policy"]).endsWith(`; frame-ancestors ${PHONE_ORIGIN}`)).toBe(true);
    expect((await send(phone, "GET", `/pages/${id}`, SERVE)).status).toBe(404);
    expect((await send(phone, "GET", "/", SERVE)).headers["x-frame-options"]).toBe("DENY");
  });
});

describe("pages waiting for their frame", () => {
  it("expire, and only so many wait at once", async () => {
    let t = 0;
    const route = createPageRoute({ now: () => t });
    const ids: string[] = [];
    const fake = (method: string, url: string, body = "") => {
      const handlers: Record<string, Array<(x?: unknown) => void>> = {};
      const req = { method, url, headers: {}, on: (e: string, f: (x?: unknown) => void) => { (handlers[e] ??= []).push(f); return req; }, resume: () => undefined };
      let status = 0;
      let out = "";
      const res = { headersSent: false, removeHeader: () => undefined, writeHead: (s: number) => { status = s; return res; }, end: (b?: string | Buffer) => { out = b === undefined ? "" : String(b); } };
      route.handle(req as never, res as never, true);
      for (const f of handlers["data"] ?? []) f(Buffer.from(body));
      for (const f of handlers["end"] ?? []) f();
      return { status, out };
    };
    for (let i = 0; i < PAGES_KEPT + 3; i++) ids.push((JSON.parse(fake("POST", "/pages", PAGE).out) as { id: string }).id);
    expect(route.size).toBe(PAGES_KEPT);
    expect(fake("GET", `/pages/${ids[0]}`).status).toBe(404);
    expect(fake("GET", `/pages/${ids.at(-1)}`).status).toBe(200);
    t += PAGE_TTL_MS;
    expect(fake("GET", `/pages/${ids.at(-2)}`).status).toBe(404);
    expect(route.size).toBe(0);
  });

  it("a page without a doctype gets one before the WebRTC removal", () => {
    expect(pageDocument("<p>x</p>", "ab12")).toMatch(/^<!doctype html><script nonce=ab12>.*<\/script><p>x<\/p>$/);
    expect(pageDocument("  <!DOCTYPE html><p>x</p>", "ab12")).toMatch(/^ {2}<!DOCTYPE html><script nonce=ab12>/);
  });

  it("every script of the page gets the page's nonce, ahead of one the page wrote", () => {
    const doc = pageDocument('<script>a()</script><SCRIPT type="module">b()</SCRIPT><script nonce="mine">c()</script><svg><script/></svg><scripted>', "ab12");
    expect(doc).toContain("<script nonce=ab12 >a()</script>");
    expect(doc).toContain('<script nonce=ab12  type="module">b()</SCRIPT>');
    expect(doc).toContain('<script nonce=ab12  nonce="mine">c()</script>');
    expect(doc).toContain("<script nonce=ab12 /></svg>");
    expect(doc).toContain("<scripted>");
  });

  it("a script start tag inside a string of the page's own script does not end that string", () => {
    const doc = pageDocument(`<script>el.innerHTML = "<script>x</script>";</script>`, "ab12");
    expect(doc).toContain(`el.innerHTML = "<script nonce=ab12 >x</script>";`);
  });

  it("two pages get two nonces", async () => {
    const server = await desktop();
    const policies: string[] = [];
    for (let i = 0; i < 2; i++) policies.push(String((await send(server, "GET", `/pages/${await hand(server)}`)).headers["content-security-policy"]));
    expect(policies[0]).not.toBe(policies[1]);
  });
});
