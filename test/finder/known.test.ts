import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Finding } from "./detectors.ts";
import { type Case, type Known, matches, parseCase, score, triage } from "./known.ts";
import { AREA, SCREENS } from "./screens.ts";
import { command } from "../../scripts/finder-board.ts";
import { ROOT } from "./out.ts";
import { undo } from "./undo.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const f = (o: Partial<Finding>): Finding => ({ screen: "models", step: "open Models", kind: "twice", element: "qwen 3 5 9b", frames: [0], detail: "", boxes: [], ...o });
const known = (o: Partial<Known>): Known => ({ screen: "models", kind: "twice", real: true, area: "settings", wrong: "says it twice", ...o });

describe("matches", () => {
  it("needs the screen; the kind, step and element words only when given", () => {
    expect(matches(f({}), { screen: "models" })).toBe(true);
    expect(matches(f({}), { screen: "image" })).toBe(false);
    expect(matches(f({}), { screen: "models", kind: "moves" })).toBe(false);
    expect(matches(f({}), { screen: "models", step: "Download tab" })).toBe(false);
    expect(matches(f({}), { screen: "models", kind: "twice", element: "QWEN 3" })).toBe(true);
    expect(matches(f({}), { screen: "models", element: "flux" })).toBe(false);
  });
});

describe("triage", () => {
  it("sorts clean findings into known real, known not real, and not looked at", () => {
    const a = f({}), b = f({ step: "Download tab", element: "uses system memory slower" }), c = f({ kind: "moves", element: ".cf-r > *" });
    const out = triage([a, b, c], [known({ element: "qwen" }), known({ step: "Download tab", element: "system memory", real: false })]);
    expect(out).toEqual({ real: [a], notReal: [b], fresh: [c] });
  });
});

describe("score", () => {
  const c: Case = { id: "x", owner: "o", source: "s", fix: "f", undo: "u", screens: ["settings"], shows: "s", catch: [{ screen: "settings", kind: "resized", element: ".dlg" }] };
  const hit = f({ screen: "settings", step: "Advanced section", kind: "resized", element: ".dlg" });
  it("is a catch when the walk finds what the case expects", () => {
    expect(score(c, [f({}), hit], [])).toBe(hit);
    expect(score(c, [f({})], [])).toBeUndefined();
  });
  it("is not a catch when clean finds the same thing on the same step", () => {
    expect(score(c, [hit], [hit])).toBeUndefined();
    expect(score(c, [hit], [{ ...hit, step: "General section" }])).toBe(hit);
  });
});

describe("parseCase", () => {
  it("names what a case is missing", () => {
    expect(() => parseCase("x", { owner: "o", source: "s", fix: "", undo: "u", shows: "s", screens: [], catch: [{}] })).toThrow("case x: fix, screens, catch missing or empty");
  });
});

describe("the board's cases", () => {
  const dir = path.join(HERE, "cases");
  const ids = readdirSync(dir);
  const screens = new Set(SCREENS.map((s) => s.id));
  it.each(ids)("%s has its words, an undo and screens that exist", (id) => {
    const c = parseCase(id, JSON.parse(readFileSync(path.join(dir, id, "case.json"), "utf8")));
    // the undo names its lines, so only a change to the fix itself breaks it; and it still fits this tree
    expect(existsSync(path.join(dir, id, "undo.json"))).toBe(true);
    expect(undo(ROOT, path.join(dir, id), false)).toBeUndefined();
    expect([...c.screens, ...c.catch.map((e) => e.screen)].filter((s) => !screens.has(s))).toEqual([]);
    // a catch that names no kind is a bug no detector looks for yet: the case says which one would
    if (c.catch.some((e) => e.kind === undefined)) expect(c.detector).toBeTruthy();
  });
  it("known.json names real screens and areas", () => {
    const k = JSON.parse(readFileSync(path.join(HERE, "known.json"), "utf8")) as Known[];
    expect(k.filter((e) => !screens.has(e.screen) || !e.area || !e.wrong)).toEqual([]);
  });
});

it("every screen has an area, so its findings have a queue", () => {
  expect(SCREENS.map((s) => s.id).filter((id) => !AREA[id])).toEqual([]);
});

it("the board fills the runner's template", () => {
  expect(command(" bash pool.sh --finder {worktree} --screens {screens} ", { worktree: "/w/a", screens: "queue,chat" }))
    .toEqual(["bash", "pool.sh", "--finder", "/w/a", "--screens", "queue,chat"]);
});
