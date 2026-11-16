// A tab's window id: a reload keeps it, a duplicated tab (whose copied sessionStorage names a
// window another open tab holds) takes its own.
import { expect, it, onTestFinished } from "vitest";
import { claimWindow, type Locks } from "./window-id.ts";

function fakeLocks(): Locks & { held: Set<string> } {
  const held = new Set<string>();
  return {
    held,
    request(name, _options, run) {
      const free = !held.has(name);
      if (free) held.add(name);
      return Promise.resolve(run(free ? { name } : null));
    },
  };
}

function fakeStorage(start?: string) {
  const items = new Map<string, string>(start === undefined ? [] : [["gates-local-window", start]]);
  return { getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => void items.set(k, v), items };
}

let n = 0;
const make = () => `new-${++n}`;

it("a reload keeps its window", async () => {
  const locks = fakeLocks();
  expect(await claimWindow(fakeStorage("a"), locks, undefined, make)).toBe("a");
  expect(locks.held).toEqual(new Set(["gates-local-window:a"]));
});

it("a duplicated tab whose copied window another tab holds takes its own, and keeps it", async () => {
  const locks = fakeLocks();
  const original = fakeStorage("a");
  const copy = fakeStorage("a");
  expect(await claimWindow(original, locks, undefined, make)).toBe("a");
  const own = await claimWindow(copy, locks, undefined, make);
  expect(own).not.toBe("a");
  expect(copy.items.get("gates-local-window")).toBe(own);
  expect(locks.held.has(`gates-local-window:${own}`)).toBe(true);
  expect(original.items.get("gates-local-window")).toBe("a");
});

it("a tab with no stored window takes a new one and stores it", async () => {
  const storage = fakeStorage();
  const id = await claimWindow(storage, fakeLocks(), undefined, make);
  expect(storage.items.get("gates-local-window")).toBe(id);
});

it("without Web Locks or storage it still answers: the stored window, or a new one", async () => {
  expect(await claimWindow(fakeStorage("a"), undefined, undefined, make)).toBe("a");
  expect(await claimWindow(undefined, undefined, undefined, make)).toMatch(/^new-/);
});

function tabs(count: number): BroadcastChannel[] {
  const name = `windows-${++n}`;
  const all = Array.from({ length: count }, () => new BroadcastChannel(name));
  onTestFinished(() => { for (const c of all) c.close(); });
  return all;
}
const refused: Locks = { request: () => Promise.reject(new Error("SecurityError")) };

it.each([["has no Web Locks", undefined], ["refuses the lock request", refused]])("a page that %s asks the open tabs, so a duplicated tab still takes its own", async (_, locks) => {
  const [original, copy] = tabs(2);
  expect(await claimWindow(fakeStorage("a"), locks, original, make)).toBe("a");
  const own = await claimWindow(fakeStorage("a"), locks, copy, make);
  expect(own).not.toBe("a");
});

it.each([["has no Web Locks", undefined], ["refuses the lock request", refused]])("two tabs on a page that %s, opened at once with the same copied window, end with one each", async (_, locks) => {
  const [one, two] = tabs(2);
  const ids = await Promise.all([claimWindow(fakeStorage("a"), locks, one, make), claimWindow(fakeStorage("a"), locks, two, make)]);
  expect(ids).toContain("a");
  expect(new Set(ids).size).toBe(2);
});
