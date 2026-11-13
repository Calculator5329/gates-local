import { describe, expect, it } from "vitest";
import { globRegex, screensFor } from "./match.ts";
import { SCREENS } from "./screens.ts";
import { burst, shotFor } from "./page.ts";
import { nameOf, renderSheet, unique } from "./sheet.ts";
import type { Finding } from "./detectors.ts";

describe("globRegex", () => {
  it("** crosses folders, * stays in one", () => {
    expect(globRegex("apps/web/src/**").test("apps/web/src/a/b/c.tsx")).toBe(true);
    expect(globRegex("apps/web/src/**/Queue*.tsx").test("apps/web/src/Queue.tsx")).toBe(true);
    expect(globRegex("apps/web/src/**/Queue*.tsx").test("apps/web/src/chat/QueueTray.tsx")).toBe(true);
    expect(globRegex("apps/web/src/*.css").test("apps/web/src/a/styles.css")).toBe(false);
    expect(globRegex("a.b").test("axb")).toBe(false);
  });
});

describe("screensFor", () => {
  const table = [
    { id: "chat", paths: ["apps/web/src/Thread.tsx"] },
    { id: "composer", paths: ["apps/web/src/Composer.tsx"] },
    { id: "sidebar", paths: ["apps/web/src/Sidebar.tsx"] },
    { id: "queue", paths: ["apps/web/src/Composer.tsx", "apps/web/src/Queue*.tsx"] },
  ];

  it("picks every screen a changed file names, in table order", () => {
    expect(screensFor(["apps/web/src/Composer.tsx"], table)).toEqual({ screens: ["composer", "queue"], unmatched: [], whole: false });
  });

  it("walks the whole app for app code no screen names: unsure is everything", () => {
    expect(screensFor(["apps/web/src/New.tsx", "docs/x.md"], table)).toEqual({ screens: ["chat", "composer", "sidebar", "queue"], unmatched: ["apps/web/src/New.tsx", "docs/x.md"], whole: true });
    expect(screensFor(["apps/server/src/new/thing.ts"], table).whole).toBe(true);
    expect(screensFor(["packages/harness/src/new.ts"], table).whole).toBe(true);
  });

  it("walks nothing for docs, scripts and tests no screen names", () => {
    expect(screensFor(["docs/x.md", "scripts/x.ts", "test/e2e/x.spec.ts", "apps/desktop/scripts/x.ts"], table)).toEqual({ screens: [], unmatched: ["docs/x.md", "scripts/x.ts", "test/e2e/x.spec.ts", "apps/desktop/scripts/x.ts"], whole: false });
  });

  it("skips unit tests", () => {
    expect(screensFor(["apps/web/src/Composer.test.ts"], table).screens).toEqual([]);
  });

  it("every real screen has a unique id and some paths", () => {
    expect(new Set(SCREENS.map((s) => s.id)).size).toBe(SCREENS.length);
    expect(SCREENS.every((s) => s.paths.length > 0 && s.steps.length + (s.load ? 1 : 0) > 0)).toBe(true);
    // a shared file walks the screens built on it, the core ones among them
    expect(screensFor(["apps/web/src/styles.css"], SCREENS).screens).toEqual(expect.arrayContaining(["chat", "composer", "sidebar", "settings", "phone"]));
  });
});

describe("shots", () => {
  const shots = Array.from({ length: 120 }, (_, i) => ({ t: 1000 + i * 16, data: Buffer.alloc(0) }));

  it("a burst keeps every frame for 600 ms, then one per 100 ms, capped", () => {
    const kept = burst(shots, 1000, 200);
    const early = kept.filter((s) => s.t <= 1600);
    expect(early).toHaveLength(38);
    const late = kept.filter((s) => s.t > 1600).map((s) => s.t);
    expect(late.every((t, i) => i === 0 || t - late[i - 1]! >= 100)).toBe(true);
    expect(burst(shots, 1000, 10)).toHaveLength(10);
  });

  it("a probe frame's shot is the first paint after it", () => {
    const frames = [{ t: 1010 }, { t: 1050 }];
    expect(shotFor(shots, frames, 0)?.t).toBe(1016);
    expect(shotFor(shots, frames, 1)?.t).toBe(1048);
    expect(shotFor(shots, frames, 5)).toBeUndefined();
    // a change is shown once it is painted, two frames on
    expect(shotFor(shots, frames, 0, true)?.t).toBe(1048);
  });
});

const f = (o: Partial<Finding>): Finding & { pics: (string | null)[] } => ({ screen: "q", step: "one", kind: "moves", element: ".cf-r > * Dictate", px: 34, ms: 120, frames: [1, 2], detail: "x 1 → 35 (34 px)", boxes: [[0, 0, 10, 10]], pics: ["a.jpg", null], ...o });

describe("sheet", () => {

  it("names boxes in words", () => {
    expect(nameOf(".cf-r > * Dictate")).toBe("composer action Dictate");
    expect(nameOf(".unknown")).toBe("unknown");
  });

  it("one card per thing, escaped, nothing for a clean walk", () => {
    const screen = { id: "q", name: "Queue", seconds: 1, steps: [
      { name: "one", frames: 9, ms: 1, findings: [f({}), f({ kind: "twice", element: "\"<b>new thread</b>\"" })] },
      { name: "two", frames: 9, ms: 1, findings: [f({ step: "two", kind: "twice", element: "\"<b>new thread</b>\"" })] },
    ] };
    expect(unique([screen]).map((x) => `${x.step} ${x.kind}`)).toEqual(["one moves", "one twice"]);
    const html = renderSheet({ title: "t", made: "now", seconds: 3, screens: [screen] });
    expect(html.match(/<article/g)).toHaveLength(2);
    expect(html).toContain("composer action Dictate moves 34 px");
    expect(html).not.toContain("<b>new");
    expect(html).not.toMatch(/gradient/);
    expect(renderSheet({ title: "t", made: "now", seconds: 3, screens: [{ ...screen, steps: [] }] })).toContain("Nothing found");
  });
});
