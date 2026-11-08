import path from "node:path";
import { describe, expect, it } from "vitest";
import { CLIENT_ORIGIN, clientFile, originOf, sameClient } from "../src/client-protocol.ts";

describe("clientFile", () => {
  const root = path.resolve("/srv/web");

  it("maps the client origin's paths into the web root", () => {
    expect(clientFile(root, `${CLIENT_ORIGIN}/index.html`)).toBe(path.join(root, "index.html"));
    expect(clientFile(root, `${CLIENT_ORIGIN}/`)).toBe(path.join(root, "index.html"));
    expect(clientFile(root, `${CLIENT_ORIGIN}/assets/index-x.js?v=1#top`)).toBe(path.join(root, "assets", "index-x.js"));
    expect(clientFile(root, `${CLIENT_ORIGIN}/a%20b.svg`)).toBe(path.join(root, "a b.svg"));
    // A name that only starts with two dots is still inside the root.
    expect(clientFile(root, `${CLIENT_ORIGIN}/..hidden.js`)).toBe(path.join(root, "..hidden.js"));
  });

  it("refuses paths that leave the web root", () => {
    expect(clientFile(root, `${CLIENT_ORIGIN}/..%2f..%2fetc%2fpasswd`)).toBeNull();
    expect(clientFile(root, `${CLIENT_ORIGIN}/assets/..%2f..%2f..%2fetc%2fpasswd`)).toBeNull();
    expect(clientFile(root, `${CLIENT_ORIGIN}/x%00.js`)).toBeNull();
    expect(clientFile(root, `${CLIENT_ORIGIN}/%E0%A4%A`)).toBeNull();
  });

  it("refuses backslash escapes on Windows paths", () => {
    const winRoot = "C:\\app\\web";
    expect(clientFile(winRoot, `${CLIENT_ORIGIN}/..%5c..%5cWindows%5cwin.ini`, path.win32)).toBeNull();
    expect(clientFile(winRoot, `${CLIENT_ORIGIN}/assets/x.js`, path.win32)).toBe("C:\\app\\web\\assets\\x.js");
  });

  it("refuses other hosts and schemes", () => {
    expect(clientFile(root, "gates-local://other/index.html")).toBeNull();
    expect(clientFile(root, "http://127.0.0.1:5187/index.html")).toBeNull();
    expect(clientFile(root, "file:///srv/web/index.html")).toBeNull();
    expect(clientFile(root, "not a url")).toBeNull();
  });
});

describe("originOf", () => {
  it("gives scheme and host for the custom scheme, which WHATWG URL calls opaque", () => {
    expect(new URL(`${CLIENT_ORIGIN}/index.html`).origin).toBe("null");
    expect(originOf(`${CLIENT_ORIGIN}/index.html`)).toBe(CLIENT_ORIGIN);
    expect(originOf("http://127.0.0.1:5187/")).toBe("http://127.0.0.1:5187");
  });

  it("gives null for file URLs and garbage, so neither is ever allowed", () => {
    expect(originOf("file:///srv/web/index.html")).toBeNull();
    expect(originOf("not a url")).toBeNull();
  });
});

describe("sameClient", () => {
  it("keeps navigation inside the client origin", () => {
    expect(sameClient(`${CLIENT_ORIGIN}/index.html`, `${CLIENT_ORIGIN}/index.html#thread=abc`)).toBe(true);
    expect(sameClient("http://127.0.0.1:5187/", "http://127.0.0.1:5187/#thread=abc")).toBe(true);
  });

  it("refuses another opaque-origin scheme (both would read as origin \"null\")", () => {
    expect(sameClient(`${CLIENT_ORIGIN}/index.html`, "evil://app/index.html")).toBe(false);
    expect(sameClient(`${CLIENT_ORIGIN}/index.html`, "gates-local://other/index.html")).toBe(false);
    expect(sameClient(`${CLIENT_ORIGIN}/index.html`, "https://example.com/")).toBe(false);
  });

  it("matches a file client by exact path only", () => {
    expect(sameClient("file:///srv/web/index.html", "file:///srv/web/index.html#x")).toBe(true);
    expect(sameClient("file:///srv/web/index.html", "file:///etc/passwd")).toBe(false);
  });
});
