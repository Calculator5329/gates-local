// The app's own frame policy: which addresses the client may put in a frame.
// A page a model wrote can try to move its own frame, and the only thing that
// stops it in a browser is this policy, so it names the page route and no
// other host.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { withMeta } from "./static.ts";

const INDEX = readFileSync(fileURLToPath(new URL("../../../web/index.html", import.meta.url)), "utf8");
const framePolicy = (html: string): string | undefined => /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/i.exec(html)?.[1];
const PHONE = "https://hub.example.ts.net:8456";

describe("the client's frame policy", () => {
  it("as built names only this computer's page route, on loopback", () => {
    expect(framePolicy(INDEX)).toBe("frame-src http://127.0.0.1:*/pages/");
  });

  it("on the phone listener names only that listener's own page route", () => {
    expect(framePolicy(withMeta(INDEX, PHONE))).toBe(`frame-src ${PHONE}/pages/`);
  });

  it("names no wildcard host anywhere: a page cannot move its frame to somebody else's server", () => {
    for (const html of [INDEX, withMeta(INDEX, PHONE)]) {
      const sources = (framePolicy(html) ?? "").split(/\s+/).slice(1);
      expect(sources.length).toBe(1);
      for (const s of sources) expect(new URL(s.replace(":*", ":1")).hostname.includes("*"), s).toBe(false);
    }
  });

  it("is left alone for a listener with no origin of its own", () => {
    expect(framePolicy(withMeta(INDEX))).toBe(framePolicy(INDEX));
  });
});
