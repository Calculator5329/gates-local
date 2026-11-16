import { describe, expect, it } from "vitest";
import { type SyncMetadata, chatScope } from "@gates-local/contracts";
import { createThreadNumbers } from "./numbers.ts";

const stamped = (epoch: string, list: number, chats: Record<string, number> = {}): SyncMetadata => ({ epoch, changes: [
  { scope: "threads", kind: "snapshot", rev: list },
  ...Object.entries(chats).map(([id, rev]) => ({ scope: chatScope(id), kind: "snapshot" as const, rev })),
] });

describe("the numbers a window holds for its chats", () => {
  it("a row older than the row already applied for the same chat is refused, and a newer one applies", () => {
    const numbers = createThreadNumbers();
    numbers.begin("first", []);
    expect(numbers.row("a", 5)).toBe(true);
    expect(numbers.row("a", 3)).toBe(false);
    expect(numbers.row("a", 5)).toBe(false);
    expect(numbers.row("b", 3)).toBe(true);
    expect(numbers.row("a", 6)).toBe(true);
  });

  it("a sync gives a number only for a scope it names on this connection's epoch", () => {
    const numbers = createThreadNumbers();
    expect(numbers.of(stamped("first", 4), "threads")).toBeUndefined();
    numbers.begin("first", []);
    expect(numbers.of(stamped("first", 4, { a: 2 }), "threads")).toBe(4);
    expect(numbers.of(stamped("first", 4, { a: 2 }), chatScope("a"))).toBe(2);
    expect(numbers.of(stamped("second", 4, { a: 2 }), "threads")).toBeUndefined();
    expect(numbers.of(stamped("second", 4, { a: 2 }), chatScope("a"))).toBeUndefined();
    expect(numbers.of(stamped("first", 4), chatScope("a"))).toBeUndefined();
    expect(numbers.of(undefined, "threads")).toBeUndefined();
  });

  it("a list read no newer than the list already applied is ignored, and a newer one names the rows that came after it", () => {
    const numbers = createThreadNumbers();
    numbers.begin("first", []);
    expect(numbers.list(5)).toEqual(new Set());
    expect(numbers.list(5)).toBeUndefined();
    expect(numbers.list(4)).toBeUndefined();
    expect(numbers.list(undefined)).toBeUndefined();
    numbers.row("a", 9);
    numbers.row("b", 6);
    expect(numbers.list(7)).toEqual(new Set(["a"]));
  });

  it("a read whose answer has no number counts as being at the newest number named for its chat", () => {
    const numbers = createThreadNumbers();
    numbers.begin("first", []);
    expect(numbers.asked("a")).toBe(0);
    numbers.announce("a", 3);
    numbers.announce("a", 7);
    numbers.announce("a", 5);
    numbers.announce("a", undefined);
    expect(numbers.asked("a")).toBe(7);
    expect(numbers.asked("b")).toBe(0);
  });

  it("a copy put in without a read counts as being at 0: current until a newer number is named", () => {
    const numbers = createThreadNumbers();
    numbers.begin("first", []);
    expect(numbers.current("a")).toBe(true);
    numbers.announce("a", 0);
    expect(numbers.current("a")).toBe(true);
    numbers.announce("a", 1);
    expect(numbers.current("a")).toBe(false);
  });
});
