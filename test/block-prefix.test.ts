import { expect, it } from "vitest";
import { blockPrefix } from "./e2e/block-prefix.ts";

const table = { tag: "TABLE", text: "ModelSizeSmall2" };

it.each(["M", "| Mo", "Model | Size", "| Model | Size |"])("accepts an active table header still shown as prose: %s", (text) => {
  expect(blockPrefix([{ tag: "P", text }], [table])).toBe(true);
});

it("rejects changed header content, completed-block changes and missing blocks", () => {
  expect(blockPrefix([{ tag: "P", text: "| Wrong" }], [table])).toBe(false);
  expect(blockPrefix([{ tag: "P", text: "| Mo" }, { tag: "P", text: "Next" }], [table, { tag: "P", text: "Next" }])).toBe(false);
  expect(blockPrefix([{ tag: "P", text: "Changed" }, { tag: "P", text: "Next" }], [{ tag: "P", text: "Original" }, { tag: "P", text: "Next" }])).toBe(false);
  expect(blockPrefix([table, { tag: "P", text: "Next" }], [table])).toBe(false);
});

it("still requires ordinary active prose and table contents to be text prefixes", () => {
  expect(blockPrefix([{ tag: "P", text: "Use A |" }], [{ tag: "P", text: "Use A | B" }])).toBe(true);
  expect(blockPrefix([{ tag: "TABLE", text: "ModelSize" }], [table])).toBe(true);
  expect(blockPrefix([{ tag: "TABLE", text: "Wrong" }], [table])).toBe(false);
});
