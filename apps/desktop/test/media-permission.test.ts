import { describe, expect, it } from "vitest";
import { allowsMicrophone } from "../src/media-permission.ts";

describe("desktop microphone permission", () => {
  it("admits only audio from the app's main frame", () => {
    expect(allowsMicrophone("gates-local://app/", "media", "gates-local://app", ["audio"], true)).toBe(true);
    for (const [page, permission, origin, media, main] of [
      ["https://example.com", "media", "gates-local://app", ["audio"], true],
      ["gates-local://app/", "media", "https://example.com", ["audio"], true],
      ["gates-local://app/", "media", "gates-local://app", ["video"], true],
      ["gates-local://app/", "media", "gates-local://app", ["audio", "video"], true],
      ["gates-local://app/", "media", "gates-local://app", [], true],
      ["gates-local://app/", "geolocation", "gates-local://app", ["audio"], true],
      ["gates-local://app/", "media", "gates-local://app", ["audio"], false],
    ] as const) expect(allowsMicrophone(page, permission, origin, media, main)).toBe(false);
  });
});
