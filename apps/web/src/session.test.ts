// Where the client connects when there is no desktop bridge. A page the
// server's phone listener served carries <meta name="gates-local-server"
// content="same-origin"> (apps/server/src/web/static.ts); the client then
// opens its socket on the page's own host, and image URLs follow that origin
// with no token. Runs under node with the browser globals stubbed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class FakeSocket {
  static opened: FakeSocket[] = [];
  readonly readyState = 0;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
    FakeSocket.opened.push(this);
  }
  send(): void {}
  close(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}

function page(href: string, meta: boolean): void {
  const url = new URL(href);
  vi.stubGlobal("window", {});
  vi.stubGlobal("location", { href, host: url.host, protocol: url.protocol, search: url.search, hash: url.hash, pathname: url.pathname });
  vi.stubGlobal("document", {
    querySelector: (selector: string) =>
      meta && selector === 'meta[name="gates-local-server"]' ? { getAttribute: (name: string) => (name === "content" ? "same-origin" : null) } : null,
    documentElement: { setAttribute() {}, removeAttribute() {} },
  });
  vi.stubGlobal("WebSocket", FakeSocket);
}

async function boot(): Promise<typeof import("./session.ts") & { store: typeof import("./store.ts") }> {
  const session = await import("./session.ts");
  const store = await import("./store.ts");
  session.connect();
  // The loop resolves the server URL before it opens a socket.
  for (let i = 0; i < 50 && FakeSocket.opened.length === 0 && store.getState().conn.kind !== "no-server"; i++) await new Promise((r) => setTimeout(r, 2));
  return { ...session, store };
}

beforeEach(() => {
  vi.resetModules();
  FakeSocket.opened = [];
});
afterEach(() => vi.unstubAllGlobals());

describe("same-origin server discovery", () => {
  it("with the meta and no bridge, an https page opens wss://<host>/ws and image URLs are https with no token", async () => {
    page("https://hub.example.ts.net:8456/", true);
    const s = await boot();
    expect(FakeSocket.opened.map((w) => w.url)).toEqual(["wss://hub.example.ts.net:8456/ws"]);
    const st = s.store.getState();
    expect(st.serverOrigin).toBe("https://hub.example.ts.net:8456");
    expect(st.fileToken).toBeNull();
    expect(s.fileUrl(st.serverOrigin ?? "", st.fileToken, "images/a b.png")).toBe("https://hub.example.ts.net:8456/files/images/a%20b.png");
  });

  it("an http page opens ws://<host>/ws", async () => {
    page("http://127.0.0.1:40123/#thread=t1", true);
    const s = await boot();
    expect(FakeSocket.opened.map((w) => w.url)).toEqual(["ws://127.0.0.1:40123/ws"]);
    expect(s.store.getState().serverOrigin).toBe("http://127.0.0.1:40123");
  });

  it("without the meta and with no other source there is no server, as before", async () => {
    page("https://hub.example.ts.net:8456/", false);
    const s = await boot();
    expect(FakeSocket.opened).toEqual([]);
    expect(s.store.getState().conn.kind).toBe("no-server");
  });

  it("?server= still wins over the meta, and its token stays on image URLs", async () => {
    const server = "ws://127.0.0.1:5286/?token=abc";
    page(`http://127.0.0.1:5287/?server=${encodeURIComponent(server)}`, true);
    const s = await boot();
    expect(FakeSocket.opened.map((w) => w.url)).toEqual([server]);
    const st = s.store.getState();
    expect(st.serverOrigin).toBe("http://127.0.0.1:5286");
    expect(st.fileToken).toBe("abc");
    expect(s.fileUrl(st.serverOrigin ?? "", st.fileToken, "images/x.png")).toBe("http://127.0.0.1:5286/files/images/x.png?token=abc");
  });
});
