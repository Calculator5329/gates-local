import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Tip, openTip } from "./ui.tsx";
import { setState } from "../store/store.ts";

type Box = { left: number; top: number; width: number; height: number };

class Fixture {
  isConnected = true;
  parent: Fixture | null = null;
  id = "";
  names = new Set<string>();
  box: Box = { left: 0, top: 0, width: 0, height: 0 };
  tip: string | null = null;
  classList = { add: (c: string) => void this.names.add(c), remove: (c: string) => void this.names.delete(c), contains: (c: string) => this.names.has(c) };
  getAttribute(name: string) { return name === "data-tip" ? this.tip : null; }
  matches(selector: string) {
    return selector.split(",").map(one => one.trim()).some(one =>
      one === "[data-tip]" ? this.tip !== null
        : one.startsWith("#") ? this.id === one.slice(1)
          : one.startsWith(".") ? this.names.has(one.slice(1))
            : false);
  }
  closest(selector: string): Fixture | null {
    return this.matches(selector) ? this : (this.parent?.closest(selector) ?? null);
  }
  getBoundingClientRect() {
    const { left, top, width, height } = this.box;
    return { x: left, y: top, left, top, width, height, right: left + width, bottom: top + height };
  }
}

class TipFixture extends Fixture {
  innerHTML = "";
  style: Record<string, string> = {};
  natural = { width: 100, height: 20 };
  get offsetWidth() { return Math.min(this.natural.width, innerWidth - (parseFloat(this.style["left"] ?? "0") || 0)); }
  get offsetHeight() { return this.natural.height; }
}

let tip: TipFixture;
let cleanups: (() => void)[];
beforeEach(() => {
  tip = new TipFixture(); cleanups = [];
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("innerWidth", 1440); vi.stubGlobal("innerHeight", 900);
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  vi.stubGlobal("Element", Fixture);
  vi.stubGlobal("MutationObserver", class { observe() { return undefined; } disconnect() { return undefined; } });
  vi.stubGlobal("document", { body: new Fixture(), addEventListener: () => undefined, removeEventListener: () => undefined });
  setState({ pop: null });
  const cleanup = (Tip().props as { ref: (el: unknown) => (() => void) | undefined }).ref(tip);
  if (cleanup) cleanups.push(cleanup);
});
afterEach(() => { for (const cleanup of cleanups) cleanup(); vi.unstubAllGlobals(); });

function part(box: Box, parent: Fixture | null = null, names: string[] = []) {
  const made = new Fixture();
  made.box = box;
  made.parent = parent;
  for (const name of names) made.names.add(name);
  return made;
}

function pickerRow(picker: Box, row: Box) {
  const pk = part(picker);
  pk.id = "picker";
  const made = part(row, pk, ["pk-row"]);
  made.tip = "Needs 9.1 GB of 16 GB";
  return { picker: pk.getBoundingClientRect(), row: made };
}

const shown = (at: Fixture) => {
  openTip(at as unknown as Element);
  const left = parseFloat(tip.style["left"] ?? "");
  const top = parseFloat(tip.style["top"] ?? "");
  return { left, top, right: left + tip.offsetWidth, bottom: top + tip.offsetHeight };
};

it.each([
  ["right of it when there is room", { left: 400, top: 200, width: 400, height: 400 }, "right"],
  ["left of it when the right has no room", { left: 960, top: 200, width: 440, height: 400 }, "left"],
] as const)("a picker row's tooltip opens beside the picker, outside it: %s", (_, box, side) => {
  const { picker, row } = pickerRow(box, { left: box.left + 10, top: 300, width: box.width - 20, height: 30 });
  const at = shown(row);
  expect(tip.names.has("open")).toBe(true);
  if (side === "right") expect(at.left).toBeGreaterThanOrEqual(picker.right);
  else expect(at.right).toBeLessThanOrEqual(picker.left);
  expect(at.top + 10, "level with its row").toBe(315);
});

it.each([
  ["right of it when there is room", 20, "right"],
  ["left of it when the right has no room", 1180, "left"],
] as const)("a sidebar row's tooltip opens beside the row, outside it: %s", (_, left, side) => {
  const sb = part({ left: 0, top: 0, width: 1440, height: 900 }, null, ["sb"]);
  const row = part({ left, top: 300, width: 240, height: 30 }, sb, ["sb-row"]);
  row.tip = "Last reply 2 minutes ago";
  const at = shown(row);
  expect(tip.names.has("open")).toBe(true);
  if (side === "right") expect(at.left).toBeGreaterThanOrEqual(left + 240);
  else expect(at.right).toBeLessThanOrEqual(left);
  expect(at.top + 10, "level with the row").toBe(315);
});

it.each([
  ["above the picker when there is room above", 200, "above"],
  ["below the picker when there is no room above", 10, "below"],
] as const)("with no room on either side, a picker row's tooltip goes %s", (_, top, where) => {
  vi.stubGlobal("innerWidth", 390);
  const { picker, row } = pickerRow({ left: 0, top, width: 390, height: 500 }, { left: 10, top: top + 100, width: 370, height: 30 });
  const at = shown(row);
  expect(tip.names.has("open")).toBe(true);
  if (where === "above") expect(at.bottom).toBeLessThanOrEqual(picker.top);
  else expect(at.top).toBeGreaterThanOrEqual(picker.bottom);
});

it("a tooltip opened after one near the window's right edge is centred on its anchor at its full width", () => {
  tip.natural.width = 300;
  tip.style["left"] = "1380px";
  const anchor = part({ left: 700, top: 300, width: 120, height: 20 });
  anchor.tip = "Context window: 32K tokens";
  const at = shown(anchor);
  expect(tip.offsetWidth).toBe(300);
  expect(at.left).toBe(610);
});
