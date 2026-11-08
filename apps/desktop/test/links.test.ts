import { describe, expect, it } from "vitest";
import { type GuardedContents, guardNavigation, type LinkDeps, openOutside } from "../src/links.ts";

const CLIENT = "gates-local://app";

function rig(opts: { openFails?: boolean } = {}) {
  const opened: string[] = [];
  const logged: string[] = [];
  const deps: LinkDeps = {
    isClientUrl: (url) => url.startsWith(`${CLIENT}/`),
    openExternal: (url) => {
      opened.push(url);
      return opts.openFails ? Promise.reject(new Error(`xdg-open failed for ${url}`)) : Promise.resolve();
    },
    log: (line) => logged.push(line),
  };
  let windowOpen: ((d: { url: string }) => { action: "deny" }) | undefined;
  let willNavigate: ((e: { preventDefault(): void }, url: string) => void) | undefined;
  const contents: GuardedContents = {
    setWindowOpenHandler: (h) => {
      windowOpen = h;
    },
    on: (_event, listener) => {
      willNavigate = listener;
    },
  };
  guardNavigation(contents, deps);
  const navigate = (url: string) => {
    let prevented = false;
    willNavigate!({ preventDefault: () => (prevented = true) }, url);
    return prevented;
  };
  return { opened, logged, deps, open: (url: string) => windowOpen!({ url }), navigate };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("guardNavigation", () => {
  it("a target=_blank web link opens in the system browser and no window opens", () => {
    const r = rig();
    expect(r.open("https://ollama.com/library")).toEqual({ action: "deny" });
    expect(r.opened).toEqual(["https://ollama.com/library"]);
  });

  it("a plain web link leaves the window where it is and opens in the system browser", () => {
    const r = rig();
    expect(r.navigate("https://example.com/a")).toBe(true);
    expect(r.opened).toEqual(["https://example.com/a"]);
  });

  it("navigation inside the client is left alone", () => {
    const r = rig();
    expect(r.navigate(`${CLIENT}/index.html#thread=1`)).toBe(false);
    expect(r.opened).toEqual([]);
  });

  it("other schemes are stopped and never reach the shell", () => {
    const r = rig();
    expect(r.open("file:///etc/passwd")).toEqual({ action: "deny" });
    expect(r.navigate("javascript:alert(1)")).toBe(true);
    expect(r.opened).toEqual([]);
  });
});

describe("openOutside logs", () => {
  it("never log a refused link's credentials, path or query", () => {
    const r = rig();
    openOutside("https://user:hunter2@example.com/private?token=abc123", r.deps);
    openOutside("file:///home/someone/secret-notes.txt", r.deps);
    expect(r.opened).toEqual([]);
    expect(r.logged).toHaveLength(2);
    for (const line of r.logged) {
      expect(line).not.toMatch(/hunter2|user|private|abc123|secret-notes|someone/);
    }
  });

  it("name only the origin when the browser cannot be opened", async () => {
    const r = rig({ openFails: true });
    openOutside("https://example.com/reset?token=abc123", r.deps);
    await settle();
    expect(r.logged).toHaveLength(1);
    expect(r.logged[0]).toContain("https://example.com");
    expect(r.logged[0]).not.toMatch(/abc123|reset/);
  });
});
