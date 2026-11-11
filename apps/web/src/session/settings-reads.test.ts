// The reads Settings waits for: begin, read and end in order, a failed read
// still lets Settings open, and no open waits more than the bound.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SourceImports } from "@gates-local/contracts";
import { createSettingsReads } from "./settings-reads.ts";

const IMPORTS = { samples: [], jobs: [] } as unknown as SourceImports;
const deferred = <T,>() => {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
/** Whether `p` has settled after the timers so far. */
const settled = async (p: Promise<void> | null) => {
  let done = false;
  void p?.then(() => { done = true; });
  await vi.advanceTimersByTimeAsync(0);
  return done;
};

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

it("nothing waits before a hydrate begins", () => {
  const reads = createSettingsReads({ readImports: async () => IMPORTS, readFolder: async () => "/data" });
  expect(reads.ready()).toBeNull();
});

it("begin, read, end: Settings opens once both reads are in, and keeps them", async () => {
  const imports = deferred<SourceImports>(), folder = deferred<string | null>();
  const reads = createSettingsReads({ readImports: () => imports.promise, readFolder: () => folder.promise });
  reads.begin();
  const open = reads.ready();
  expect(open).not.toBeNull();
  const reading = reads.read();
  imports.resolve(IMPORTS);
  expect(await settled(open), "one read is not enough").toBe(false);
  folder.resolve("/data");
  await reading;
  expect(await settled(open)).toBe(true);
  reads.end();
  expect(reads.imports()).toBe(IMPORTS);
  expect(reads.folder()).toBe("/data");
  expect(reads.ready(), "nothing is on its way after the reads").toBeNull();
});

it("a failed read still lets Settings open", async () => {
  const reads = createSettingsReads({ readImports: () => Promise.reject(new Error("down")), readFolder: async () => null });
  reads.begin();
  const open = reads.ready();
  await reads.read();
  expect(await settled(open)).toBe(true);
  expect(reads.imports()).toBeUndefined();
  expect(reads.folder()).toBeNull();
});

it("a hydrate that ends before its reads lets Settings open", async () => {
  const reads = createSettingsReads({ readImports: async () => IMPORTS, readFolder: async () => null });
  reads.begin();
  const open = reads.ready();
  reads.end();
  expect(await settled(open)).toBe(true);
});

it("an open waits at most the bound for a slow read", async () => {
  const reads = createSettingsReads({ readImports: () => new Promise(() => {}), readFolder: async () => null });
  reads.begin();
  void reads.read();
  const open = reads.ready();
  await vi.advanceTimersByTimeAsync(999);
  expect(await settled(open)).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(await settled(open)).toBe(true);
});

it("once a read has outlived the bound, later opens do not wait for it again", async () => {
  const reads = createSettingsReads({ readImports: () => new Promise(() => {}), readFolder: async () => null });
  reads.begin();
  void reads.read();
  const first = reads.ready();
  await vi.advanceTimersByTimeAsync(1000);
  expect(await settled(first)).toBe(true);
  expect(reads.ready(), "the next open shows placeholders at once").toBeNull();
  // a new hydrate waits again
  reads.begin();
  expect(reads.ready()).not.toBeNull();
});

it("an old open's bound passing during a newer hydrate does not mark the newer reads late", async () => {
  const second = deferred<SourceImports>();
  let calls = 0;
  const reads = createSettingsReads({ readImports: () => (++calls === 1 ? Promise.resolve(IMPORTS) : second.promise), readFolder: async () => null });
  reads.begin();
  const first = reads.ready();
  await reads.read();
  reads.end();
  expect(await settled(first), "the first reads came in fast").toBe(true);
  // a reconnect: a new hydrate begins before the first open's bound has passed
  await vi.advanceTimersByTimeAsync(500);
  reads.begin();
  void reads.read();
  await vi.advanceTimersByTimeAsync(500);
  // the first open's bound has passed; the newer reads have waited only half a second
  expect(reads.ready(), "an open now still waits for the newer reads").not.toBeNull();
});
