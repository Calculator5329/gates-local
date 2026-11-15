import { beforeAll, describe, expect, it } from "vitest";
import { installBrowser } from "../../test/harness.ts";

let listOrder: typeof import("./Sidebar.tsx").listOrder;

beforeAll(async () => {
  installBrowser();
  ({ listOrder } = await import("./Sidebar.tsx"));
});

const newestFirst = ["new", "mid", "old"].map((id) => ({ id }));
const ids = (running: readonly string[], shownNothingSince: Readonly<Record<string, number>>) =>
  listOrder(newestFirst, new Set(running), new Map(Object.entries(shownNothingSince))).map((t) => t.id);

describe("the thread list's order", () => {
  it("is newest first while every reply has shown something", () => {
    expect(ids(["old", "new"], {})).toEqual(["new", "mid", "old"]);
  });

  it("puts a thread whose reply has shown nothing yet under the running thread that has", () => {
    expect(ids(["new", "old"], { new: 5 })).toEqual(["mid", "old", "new"]);
  });

  it("puts it under a thread asked before it and leaves it above one asked after it", () => {
    expect(ids(["new", "mid", "old"], { new: 5, old: 3 })).toEqual(["mid", "old", "new"]);
    expect(ids(["new", "old"], { new: 3, old: 5 })).toEqual(["new", "mid", "old"]);
  });

  it("leaves it in its place by date under no running thread", () => {
    expect(ids([], { new: 5 })).toEqual(["new", "mid", "old"]);
  });
});
