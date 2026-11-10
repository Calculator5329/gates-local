// Every bound of the installed copy's one network read, against real
// loopback servers on ports the system picks (never a runtime's port).
import http, { type IncomingHttpHeaders, type ServerResponse } from "node:http";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { boundedGet, FEED_LIMITS, refusedAddress, USER_AGENT } from "./feed.ts";

type Handler = (path: string, res: ServerResponse) => void;
const closers: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closers.splice(0)) await close(); });

function portOf(server: net.Server): number {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return address.port;
}

async function serve(handler: Handler): Promise<{ base: string; seen: { path: string; headers: IncomingHttpHeaders }[] }> {
  const seen: { path: string; headers: IncomingHttpHeaders }[] = [];
  const server = http.createServer((req, res) => {
    seen.push({ path: req.url ?? "", headers: req.headers });
    handler(req.url ?? "", res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  return { base: `http://127.0.0.1:${portOf(server)}`, seen };
}

const signal = () => new AbortController().signal;
const loopback = boundedGet({ allowLoopbackHttp: true });

// The total time belongs to the caller's signal (checkInstalled's one
// deadline, or the module closing); the reader keeps no clock of its own.
function abortAfter(ms: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error("stopped from outside")), ms);
  return controller.signal;
}

describe("the release list read", () => {
  it("has the contract's bounds", () => {
    expect(FEED_LIMITS).toEqual({ redirects: 5, listBytes: 65_536, signatureBytes: 1024, idleMs: 30_000, totalMs: 60_000 });
    expect(USER_AGENT).toBe("Gates-Local");
  });

  it("sends GET with User-Agent Gates-Local, no version, no query and no cookie, even after one is set", async () => {
    const feed = await serve((path, res) => {
      res.setHeader("Set-Cookie", "session=1; Path=/");
      if (path === "/start") res.writeHead(302, { Location: "/end" }).end();
      else res.writeHead(200).end("body");
    });
    const got = await loopback(new URL(`${feed.base}/start`), 100, signal());
    expect(got).toEqual({ kind: "ok", bytes: Buffer.from("body") });
    expect(feed.seen.map((s) => s.path)).toEqual(["/start", "/end"]);
    for (const { path, headers } of feed.seen) {
      expect(path).not.toContain("?");
      expect(headers["user-agent"]).toBe("Gates-Local");
      expect(headers.cookie).toBeUndefined();
    }
  });

  it("adds no query itself, and follows a redirect that carries one (GitHub's signed asset links)", async () => {
    const feed = await serve((path, res) => {
      if (path === "/latest/download/release.json") res.writeHead(302, { Location: "/download/v1.3.0/release.json" }).end();
      else if (path === "/download/v1.3.0/release.json") res.writeHead(302, { Location: "/asset/release.json?sp=r&sig=abc" }).end();
      else res.writeHead(200).end("list");
    });
    expect(await loopback(new URL(`${feed.base}/latest/download/release.json`), 100, signal())).toEqual({ kind: "ok", bytes: Buffer.from("list") });
    expect(feed.seen.map((s) => s.path)).toEqual(["/latest/download/release.json", "/download/v1.3.0/release.json", "/asset/release.json?sp=r&sig=abc"]);
  });

  it("follows five redirects and refuses a sixth", async () => {
    const feed = await serve((path, res) => {
      const n = Number(path.slice(1));
      if (n > 0) res.writeHead(302, { Location: `/${n - 1}` }).end();
      else res.writeHead(200).end("end");
    });
    expect(await loopback(new URL(`${feed.base}/5`), 100, signal())).toEqual({ kind: "ok", bytes: Buffer.from("end") });
    const before = feed.seen.length;
    expect(await loopback(new URL(`${feed.base}/6`), 100, signal())).toEqual({ kind: "failed", detail: "more than 5 redirects" });
    expect(feed.seen.length - before).toBe(6);
  });

  it("reads only https unless a test build allows loopback http", async () => {
    const feed = await serve((_path, res) => res.writeHead(200).end("x"));
    expect(await boundedGet()(new URL(`${feed.base}/list`), 100, signal())).toEqual({ kind: "failed", detail: "refused a http: address (only https is read)" });
    expect(feed.seen).toEqual([]);
    expect(await loopback(new URL(`${feed.base}/list`), 100, signal())).toMatchObject({ kind: "ok" });
    expect(refusedAddress(new URL("https://example.invalid/r"), false)).toBeNull();
    expect(refusedAddress(new URL("http://example.invalid/r"), true)).not.toBeNull();
    expect(refusedAddress(new URL("https://user:pass@example.invalid/r"), false)).not.toBeNull();
  });

  it("refuses a redirect to http that is not a test build's loopback", async () => {
    const feed = await serve((_path, res) => res.writeHead(302, { Location: "http://example.invalid/release.json" }).end());
    expect(await loopback(new URL(`${feed.base}/list`), 100, signal())).toEqual({ kind: "failed", detail: "refused a http: address (only https is read)" });
  });

  it.each([
    ["list", FEED_LIMITS.listBytes],
    ["signature", FEED_LIMITS.signatureBytes],
  ])("drops a %s over its limit, declared or streamed, and reads one at the limit", async (_name, limit) => {
    const feed = await serve((path, res) => {
      // Declared: headers only, no body ever, so only the declared size can answer in time.
      if (path === "/declared") { res.writeHead(200, { "Content-Length": limit + 1 }); res.flushHeaders(); }
      else if (path === "/streamed") { res.writeHead(200); res.write(Buffer.alloc(limit)); res.end(Buffer.alloc(1)); }
      else res.writeHead(200, { "Content-Length": limit }).end(Buffer.alloc(limit));
    });
    const read = boundedGet({ allowLoopbackHttp: true, idleMs: 1_000 });
    expect(await read(new URL(`${feed.base}/declared`), limit, signal())).toEqual({ kind: "too-large" });
    expect(await read(new URL(`${feed.base}/streamed`), limit, signal())).toEqual({ kind: "too-large" });
    expect(await read(new URL(`${feed.base}/at`), limit, signal())).toEqual({ kind: "ok", bytes: Buffer.alloc(limit) });
  });

  it.each([302, 404, 503])("hangs up on a %i whose body streams forever, instead of reading on", async (status) => {
    const closed: Promise<number>[] = [];
    const feed = await serve((path, res) => {
      if (path === "/end") { res.writeHead(200).end("x"); return; }
      const socket = res.req.socket;
      closed.push(new Promise((resolve) => socket.on("close", () => resolve(Date.now()))));
      res.writeHead(status, status === 302 ? { Location: "/end" } : {});
      const timer = setInterval(() => res.write(Buffer.alloc(1024)), 5);
      res.on("close", () => clearInterval(timer));
    });
    await loopback(new URL(`${feed.base}/body`), 2, signal());
    const returned = Date.now();
    const hungUp = await Promise.race([closed[0], new Promise<null>((resolve) => setTimeout(() => resolve(null), 400))]);
    expect(hungUp).not.toBeNull();
    expect((hungUp ?? Infinity) - returned).toBeLessThan(400);
  });

  it("says a missing file is missing and another status failed", async () => {
    const feed = await serve((path, res) => res.writeHead(path === "/gone" ? 404 : 503).end());
    expect(await loopback(new URL(`${feed.base}/gone`), 100, signal())).toEqual({ kind: "missing" });
    expect(await loopback(new URL(`${feed.base}/busy`), 100, signal())).toEqual({ kind: "failed", detail: "HTTP 503" });
  });

  it("stops a server that goes quiet after its headers", async () => {
    const feed = await serve((_path, res) => { res.writeHead(200); res.write("a"); });
    const got = await boundedGet({ allowLoopbackHttp: true, idleMs: 200 })(new URL(`${feed.base}/quiet`), 100, signal());
    expect(got).toEqual({ kind: "failed", detail: "no answer for 0 seconds" });
  });

  it("stops a connection that never finishes connecting", async () => {
    // A TCP listener that never answers the TLS handshake: https never connects.
    const sockets: net.Socket[] = [];
    const server = net.createServer((socket) => { sockets.push(socket); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    closers.push(() => new Promise<void>((resolve) => { for (const s of sockets) s.destroy(); server.close(() => resolve()); }));
    const started = Date.now();
    const got = await boundedGet({ idleMs: 1_000 })(new URL(`https://127.0.0.1:${portOf(server)}/list`), 100, signal());
    expect(got).toEqual({ kind: "failed", detail: "no answer for 1 seconds" });
    // One idle period from the start of the request, not one per stage of the connection.
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it("an outside abort ends a read that keeps trickling, and hangs up", async () => {
    const closed: Promise<void>[] = [];
    const feed = await serve((_path, res) => {
      const socket = res.req.socket;
      closed.push(new Promise((resolve) => socket.on("close", () => resolve())));
      res.writeHead(200);
      const timer = setInterval(() => res.write("a"), 30);
      res.on("close", () => clearInterval(timer));
    });
    const started = Date.now();
    const got = await boundedGet({ allowLoopbackHttp: true, idleMs: 1_000 })(new URL(`${feed.base}/slow`), 1_000_000, abortAfter(300));
    expect(got).toEqual({ kind: "failed", detail: "stopped from outside" });
    expect(Date.now() - started).toBeLessThan(600);
    await closed[0];
  });

  it("an outside abort counts across redirects", async () => {
    const feed = await serve((path, res) => {
      const n = Number(path.slice(1));
      setTimeout(() => res.writeHead(302, { Location: `/${n + 1}` }).end(), 120);
    });
    const got = await boundedGet({ allowLoopbackHttp: true, idleMs: 1_000 })(new URL(`${feed.base}/0`), 100, abortAfter(300));
    expect(got).toEqual({ kind: "failed", detail: "stopped from outside" });
    expect(feed.seen.length).toBeLessThanOrEqual(4);
  });
});
