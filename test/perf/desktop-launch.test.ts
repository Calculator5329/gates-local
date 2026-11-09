import { expect, test } from "vitest";
import { launchPhases } from "./desktop-launch.ts";

const events = [
  { name: "main-entry", at: 110 }, { name: "app-ready", at: 120 },
  { name: "window-shown", at: 125 }, { name: "server-spawn", at: 130 },
  { name: "server-ready", at: 330 },
];
test("launch phases separate server boot from renderer readiness", () => {
  expect(launchPhases(100, events, 350, 400)).toMatchObject({ "desktop-launch": 300, "desktop-launch.window-shown": 25, "desktop-launch.server-start": 200, "desktop-launch.server-to-navigation": 20, "desktop-launch.navigation-to-composer": 50 });
});
test("missing, duplicate or inverted launch markers cannot produce a timing", () => {
  expect(() => launchPhases(100, events.slice(1), 350, 400)).toThrow("main-entry");
  expect(() => launchPhases(100, [...events, events[0]!], 350, 400)).toThrow("main-entry");
  expect(() => launchPhases(100, events, 300, 400)).toThrow("out of order");
});
