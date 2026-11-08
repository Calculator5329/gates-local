import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CLIENT_ORIGIN, clientFile, clientResponse, externalUrl, originOf, sameClient, servedFile } from "../src/client-protocol.ts";

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

  it("canonicalises the custom scheme's host the way Chromium does", () => {
    // gates-local is registered as a standard scheme, so Chromium lowercases
    // and percent-decodes its host before it sends an Origin.
    expect(originOf("gates-local://APP/index.html")).toBe(CLIENT_ORIGIN);
    expect(originOf("gates-local://%61pp/index.html")).toBe(CLIENT_ORIGIN);
    expect(originOf("gates-local://app:5000/")).toBe("gates-local://app:5000");
    expect(originOf("gates-local://[::1]/")).toBe("gates-local://[::1]");
    expect(sameClient("gates-local://APP/index.html", `${CLIENT_ORIGIN}/index.html#t=1`)).toBe(true);
    expect(clientFile(path.resolve("/srv/web"), "gates-local://APP/a.js")).toBe(path.join(path.resolve("/srv/web"), "a.js"));
    expect(clientFile(path.resolve("/srv/web"), "gates-local://app:5000/a.js")).toBeNull();
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

describe("externalUrl", () => {
  it("passes http and https pages through, normalised", () => {
    expect(externalUrl("https://ollama.com/library")).toBe("https://ollama.com/library");
    expect(externalUrl("HTTP://Example.COM/a b?q=1#x")).toBe("http://example.com/a%20b?q=1#x");
  });

  it("refuses every other scheme, credentials, and junk", () => {
    for (const url of [
      `${CLIENT_ORIGIN}/index.html`,
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:text/html,<b>x</b>",
      "mailto:a@b.c",
      "smb://host/share",
      "ms-settings:privacy",
      "https://user:pass@example.com/",
      "https://user@example.com/",
      "not a url",
      "",
    ]) {
      expect(externalUrl(url), url).toBeNull();
    }
  });
});

describe("servedFile (on disk)", () => {
  let dir = "";
  afterEach(() => {
    if (dir !== "") rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  function layout() {
    // Under ~/.cache, never the environment's temp dir (which can be /tmp).
    const cache = path.join(homedir(), ".cache");
    mkdirSync(cache, { recursive: true });
    dir = mkdtempSync(path.join(cache, "gates-desktop-served-"));
    const root = path.join(dir, "dist");
    const outside = path.join(dir, "outside");
    mkdirSync(path.join(root, "assets"), { recursive: true });
    mkdirSync(outside);
    writeFileSync(path.join(root, "index.html"), "<p>client</p>");
    writeFileSync(path.join(root, "assets", "a.js"), "1");
    writeFileSync(path.join(outside, "secret.txt"), "secret");
    symlinkSync(path.join(outside, "secret.txt"), path.join(root, "assets", "file-link.txt"));
    symlinkSync(outside, path.join(root, "assets", "dir-link"), "dir");
    // On Windows this is a junction; on Linux the type is ignored and it is a symlink.
    symlinkSync(outside, path.join(root, "junction"), "junction");
    symlinkSync(path.join(root, "assets", "a.js"), path.join(root, "inside-link.js"));
    return root;
  }

  it("serves real files under the root, through links that stay inside it", async () => {
    const root = layout();
    expect(await servedFile(root, `${CLIENT_ORIGIN}/`)).toEqual({ kind: "file", path: path.join(root, "index.html") });
    expect(await servedFile(root, `${CLIENT_ORIGIN}/assets/a.js`)).toEqual({ kind: "file", path: path.join(root, "assets", "a.js") });
    expect(await servedFile(root, `${CLIENT_ORIGIN}/inside-link.js`)).toEqual({ kind: "file", path: path.join(root, "assets", "a.js") });
  });

  it("refuses links that resolve outside the root", async () => {
    const root = layout();
    expect(await servedFile(root, `${CLIENT_ORIGIN}/assets/file-link.txt`)).toEqual({ kind: "refused" });
    expect(await servedFile(root, `${CLIENT_ORIGIN}/assets/dir-link/secret.txt`)).toEqual({ kind: "refused" });
    expect(await servedFile(root, `${CLIENT_ORIGIN}/junction/secret.txt`)).toEqual({ kind: "refused" });
    expect(await servedFile(root, `${CLIENT_ORIGIN}/..%2foutside%2fsecret.txt`)).toEqual({ kind: "refused" });
  });

  it("calls a missing file or a directory missing, so the load fails to the retry page", async () => {
    const root = layout();
    expect(await servedFile(root, `${CLIENT_ORIGIN}/nope.js`)).toEqual({ kind: "missing" });
    expect(await servedFile(root, `${CLIENT_ORIGIN}/assets`)).toEqual({ kind: "missing" });
  });

  it("the handler's answer for a missing file names nothing from the request (Electron logs it)", async () => {
    const root = layout();
    const fetched: string[] = [];
    const fetchFile = (fileUrl: string) => {
      fetched.push(fileUrl);
      return Promise.resolve(new Response("ok"));
    };
    const error = await clientResponse(root, `${CLIENT_ORIGIN}/missing/private?token=example#frag`, fetchFile).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(error).toBeInstanceOf(Error);
    for (const part of ["missing", "private", "token", "example", "frag", root]) expect(error!.message).not.toContain(part);
    expect(fetched).toEqual([]);
    expect((await clientResponse(root, `${CLIENT_ORIGIN}/assets/file-link.txt`, fetchFile)).status).toBe(404);
    expect(await (await clientResponse(root, `${CLIENT_ORIGIN}/assets/a.js`, fetchFile)).text()).toBe("ok");
    expect(fetched).toEqual([new URL(`file://${path.join(root, "assets", "a.js")}`).href]);
  });
});
