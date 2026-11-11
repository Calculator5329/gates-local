import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({ state: undefined as unknown }));
vi.mock("./store.ts", () => ({ NA: "na", useStore: (select: (s: unknown) => unknown) => select(store.state) }));
const { ModelSpeed, speedTip, tpsText } = await import("./model-speed.tsx");

describe("tpsText: whole numbers from 10 up, one decimal below", () => {
  it.each([
    [101.6, "102 TPS"],
    [10, "10 TPS"],
    [9.96, "10 TPS"], // rounds to 10.0, so it reads as a whole number
    [9.94, "9.9 TPS"],
    [8.4, "8.4 TPS"],
    [0.06, "0.1 TPS"],
  ])("%s reads %s", (value, text) => {
    expect(tpsText(value)).toBe(text);
  });

  it.each([0, 0.04, -3, Number.NaN, Number.POSITIVE_INFINITY, undefined, null, "102"])("%s shows nothing", (value) => {
    expect(tpsText(value)).toBeUndefined();
  });
});

describe("speedTip", () => {
  it("is one line naming where and how long it was measured, with the reply count", () => {
    expect(speedTip(8)).toBe("Measured on this computer over the last 14 days · 8 replies");
    expect(speedTip(1)).toBe("Measured on this computer over the last 14 days · 1 reply");
  });
});

const render = (tag: string, speeds: unknown) => {
  store.state = { speeds };
  return renderToStaticMarkup(createElement(ModelSpeed, { tag }));
};

describe("ModelSpeed", () => {
  const measured = { "qwen3.5:9b": { model: "qwen3.5:9b", tokensPerSecond: 101.6, replies: 8 }, llama3: { model: "llama3", tokensPerSecond: 8.44, replies: 1 } };

  it("draws the decorative gauge and the number, with its spoken label and tooltip", () => {
    const html = render("qwen3.5:9b", measured);
    expect(html).toBe(
      '<span class="tps" data-tip="Measured on this computer over the last 14 days · 8 replies">' +
        '<svg class="ic s14" aria-hidden="true"><use href="#i-speed"></use></svg>' +
        '<span aria-label="102 tokens per second">102 TPS</span></span>',
    );
  });

  it("matches a tag with or without :latest", () => {
    expect(render("llama3:latest", measured)).toContain('aria-label="8.4 tokens per second">8.4 TPS<');
  });

  it.each([
    ["a model never measured", "gemma3:4b", measured],
    ["before the first read lands", "qwen3.5:9b", undefined],
    ["an older server without the read", "qwen3.5:9b", "na"],
  ])("renders nothing, so it takes no width, for %s", (_why, tag, speeds) => {
    expect(render(tag, speeds)).toBe("");
  });
});
