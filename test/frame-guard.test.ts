// The desktop window's frame guard on its own (apps/desktop/src/links.ts), with the client's frame
// policy out of the way. In the app the policy in apps/web/index.html refuses most frame addresses
// before main ever hears of them, so a browser run never shows what the guard decides. Here the
// guard decides with nothing in front of it: a page this server really handed out loads where the
// window put it, and every address the policy would let through but which is not that page (another
// port, a page moving its own frame) is refused by the guard alone. So are the addresses the policy
// refuses, so a policy that is wider or missing loses nothing.
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { type FrameNavigation, type GuardedContents, guardNavigation } from "../apps/desktop/src/links.ts";
import { type WsServer, startWsServer } from "../apps/server/src/ws/server.ts";

const TOKEN = "per-launch-secret";
const APP = "gates-local://app";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).toReversed()) await c();
});

/** The client's frame policy as built: the one frame-src source in index.html. */
function builtFrameSource(): string {
  const html = readFileSync(new URL("../apps/web/index.html", import.meta.url), "utf8");
  const policy = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1] ?? "";
  const sources = /(?:^|;)\s*frame-src\s+([^;]+)/.exec(policy)?.[1]?.trim().split(/\s+/) ?? [];
  expect(sources).toHaveLength(1);
  return sources[0]!;
}

/** Whether a CSP host source with a wildcard port and a path ending in "/" allows `url`. */
function sourceAllows(source: string, url: string): boolean {
  const s = /^(https?):\/\/([^/:]+):\*(\/.*\/)$/.exec(source);
  expect(s, source).not.toBeNull();
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  return u.protocol === `${s![1]}:` && u.hostname === s![2] && u.port !== "" && u.pathname.startsWith(s![3]!);
}

/** The server hands out a page's one-time id the way it does for the window. */
function hand(server: WsServer): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port: server.port, method: "POST", path: `/pages?token=${TOKEN}`, headers: { origin: APP } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        expect(res.statusCode).toBe(201);
        resolve((JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id: string }).id);
      });
    });
    r.on("error", reject);
    r.end("<!doctype html><title>P</title><p>hi</p>");
  });
}

/** The guard on one window's contents: whether it lets a frame navigation go ahead. */
function guarded(port: number | undefined) {
  let onFrame: ((d: FrameNavigation) => void) | undefined;
  const contents: GuardedContents = {
    setWindowOpenHandler: () => undefined,
    on: (event: string, listener: unknown) => {
      if (event === "will-frame-navigate") onFrame = listener as (d: FrameNavigation) => void;
    },
    setWebRTCIPHandlingPolicy: () => undefined,
  };
  const logged: string[] = [];
  guardNavigation(contents, { isClientUrl: (u) => u.startsWith(`${APP}/`), openExternal: () => Promise.resolve(), log: (l) => logged.push(l), pagePort: () => port });
  const lets = (url: string, initiator: FrameNavigation["initiator"]) => {
    let prevented = false;
    onFrame!({ url, isMainFrame: false, initiator, preventDefault: () => (prevented = true) });
    return !prevented;
  };
  return { lets, logged };
}

const WINDOW = { parent: null };
const PAGE_ITSELF = { parent: WINDOW };

describe("the desktop frame guard, with no frame policy in front of it", () => {
  it("lets the window frame the page this server handed out, and refuses whatever the policy would let past it", async () => {
    const server = await startWsServer({ port: 0, token: TOKEN, allowedOrigins: [APP], handlers: {}, log: () => undefined });
    cleanups.push(() => server.close());
    const source = builtFrameSource();
    const page = `http://127.0.0.1:${server.port}/pages/${await hand(server)}`;
    const other = `http://127.0.0.1:${server.port}/pages/${await hand(server)}`;
    const elsewhere = `http://127.0.0.1:${server.port === 65_535 ? 65_534 : server.port + 1}/pages/${"0".repeat(32)}`;
    const g = guarded(server.port);

    expect(sourceAllows(source, page)).toBe(true);
    expect(g.lets(page, WINDOW)).toBe(true);
    expect(g.lets(page, undefined)).toBe(true);

    // the policy lets each of these through; only the guard stands in the way
    const past = [
      [elsewhere, WINDOW], // another program on this computer serving under /pages/
      [page, PAGE_ITSELF], // a page reloading itself
      [other, PAGE_ITSELF], // a page moving its own frame to another page
      [`http://127.0.0.1:${server.port}/pages/x`, WINDOW],
      [`http://127.0.0.1:${server.port}/pages/${"0".repeat(32)}?token=${TOKEN}`, WINDOW],
    ] as const;
    for (const [url, initiator] of past) {
      expect(sourceAllows(source, url), url).toBe(true);
      expect(g.lets(url, initiator), url).toBe(false);
    }

    // the policy refuses these first in the app; the guard refuses them as well
    const refusedFirst = ["https://example.com/collect?k=1", "about:blank", "about:srcdoc", "data:text/html,<p>x", "blob:gates-local://app/1", `${APP}/index.html`, page.replace("127.0.0.1", "localhost")];
    for (const url of refusedFirst) {
      expect(sourceAllows(source, url), url).toBe(false);
      expect(g.lets(url, WINDOW), url).toBe(false);
      expect(g.lets(url, PAGE_ITSELF), url).toBe(false);
    }
    expect(g.logged.join("\n")).not.toContain(TOKEN);
    expect(g.logged.join("\n")).not.toContain("collect");
  });

  it("with no server ready, the window frames nothing", async () => {
    const server = await startWsServer({ port: 0, token: TOKEN, allowedOrigins: [APP], handlers: {}, log: () => undefined });
    cleanups.push(() => server.close());
    const page = `http://127.0.0.1:${server.port}/pages/${await hand(server)}`;
    expect(guarded(undefined).lets(page, WINDOW)).toBe(false);
  });
});
