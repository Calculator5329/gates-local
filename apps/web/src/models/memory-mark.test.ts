import { readFileSync } from "node:fs";
import { CHAT_MODELS, suggestedList, type FitTable, type GpuOccupant, type GpuStatus } from "@gates-local/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it } from "vitest";
import { curatedModels } from "@gates-local/server/runtime/recommended.ts";
import type { TableFit } from "../fit/fit-table.ts";
import { setState } from "../lib/store/store.ts";
import { MakerMark } from "./MakerMark.tsx";
import { SlowLine, markWhole } from "./MemoryMark.tsx";

const GIB = 1024 ** 3;
const css = readFileSync(new URL("../app/styles.css", import.meta.url), "utf8");

const gpu = (totalBytes: number | undefined): GpuStatus => ({ vendor: "nvidia", name: "RTX", ...(totalBytes === undefined ? {} : { totalBytes }), occupants: [], systemMemoryAvailableBytes: 32 * GIB, measuredAt: 0 });
const table = (memory: FitTable["memory"]): FitTable => ({ reading: { boot: "b", seq: 1, measuredAt: 0 }, memory, rows: [] });

const fitWith = (inTheWay: readonly GpuOccupant[] | undefined): TableFit => ({
  model: "a:1", numCtx: 16384, verdict: "fits", freeVramBytes: 16 * GIB, needVramBytes: 6 * GIB, spillRamBytes: 0, source: "estimate", measuredAt: 0, stops: [],
  ...(inTheWay === undefined ? {} : { slowNow: { inTheWay, spillRamBytes: GIB } }),
});
const whisper: GpuOccupant = { label: "whisper-large", bytes: 2 * GIB, kind: "whisper", protected: true };
const comfy: GpuOccupant = { label: "ComfyUI", bytes: 2 * GIB, kind: "other-app", protected: true };

const slow = (props: Parameters<typeof SlowLine>[0]) => renderToStaticMarkup(createElement(SlowLine, props)).replaceAll("\u00a0", " ");
const text = (html: string) => html.replace(/<[^>]+>/g, "");

function hueOf(colour: string): { hue: number; sat: number } {
  const hsl = /^hsl\((\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)%/.exec(colour);
  if (hsl) return { hue: Number(hsl[1]), sat: Number(hsl[2]) };
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(colour);
  if (!hex) throw new Error(`not a colour this test reads: ${colour}`);
  const [r, g, b] = [hex[1], hex[2], hex[3]].map((h) => parseInt(h ?? "0", 16) / 255) as [number, number, number];
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (d === 0) return { hue: 0, sat: 0 };
  const sat = (d / (1 - Math.abs(max + min - 1))) * 100;
  const hue = max === r ? 60 * (((g - b) / d + 6) % 6) : max === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4);
  return { hue, sat };
}

function fillColours(kind: string): { hue: number; sat: number }[] {
  const rule = new RegExp(`\\.mm\\.${kind} \\.mm-bar i\\{background:var\\(--([\\w-]+)\\)\\}`).exec(css);
  if (!rule) throw new Error(`no fill rule for .mm.${kind}`);
  const values = [...css.matchAll(new RegExp(`--${rule[1]}:([^;]+);`, "g"))].map((m) => (m[1] ?? "").trim());
  expect(values.length, `--${rule[1]} is defined`).toBeGreaterThan(0);
  return values.map(hueOf);
}

beforeEach(() => {
  setState({ suggested: suggestedList(CHAT_MODELS), fitTable: undefined, gpu: undefined });
});

it("a maker's mark draws in the text's one colour and never in a brand colour", () => {
  const tags = curatedModels().map((m) => m.name);
  expect(tags.length).toBeGreaterThan(0);
  for (const tag of tags) {
    const html = renderToStaticMarkup(createElement(MakerMark, { tag }));
    expect(html, tag).toContain('<svg viewBox="0 0 24 24" fill="currentColor"');
    const colours = [...html.matchAll(/\b(fill|stroke|color|style|stop-color)="([^"]*)"/g)].map((m) => `${m[1]}=${m[2]}`);
    expect(colours, tag).toEqual(["fill=currentColor"]);
  }
});

it("the memory mark's fill is green on the GPU, amber when it spills to system memory, and grey when it cannot run", () => {
  for (const c of fillColours("gpu")) {
    expect(c.hue).toBeGreaterThanOrEqual(90);
    expect(c.hue).toBeLessThanOrEqual(170);
    expect(c.sat).toBeGreaterThan(20);
  }
  for (const c of fillColours("spill")) {
    expect(c.hue).toBeGreaterThanOrEqual(20);
    expect(c.hue).toBeLessThanOrEqual(50);
    expect(c.sat).toBeGreaterThan(50);
  }
  for (const c of fillColours("no")) expect(c.sat).toBe(0);
});

it("with no reading of the whole from the table, a mark is drawn against the GPU's own size", () => {
  expect(markWhole({ fitTable: undefined, gpu: gpu(12 * GIB) })).toBe(12 * GIB);
  expect(markWhole({ fitTable: table({ kind: "unreadable", detail: "nvidia-smi failed" }), gpu: gpu(12 * GIB) })).toBe(12 * GIB);
  expect(markWhole({ fitTable: table({ kind: "gpu", freeBytes: 10 * GIB, usableBytes: 9 * GIB }), gpu: gpu(12 * GIB) })).toBe(12 * GIB);
  expect(markWhole({ fitTable: table({ kind: "gpu", freeBytes: 10 * GIB, usableBytes: 9 * GIB, totalBytes: 16 * GIB }), gpu: gpu(12 * GIB) })).toBe(16 * GIB);
  expect(markWhole({ fitTable: undefined, gpu: gpu(undefined) })).toBeUndefined();
  expect(markWhole({ fitTable: undefined, gpu: "na" })).toBeUndefined();
});

it("the slower-now line puts the measured speed after Slower now, before who is in the way", () => {
  expect(text(slow({ fit: fitWith([whisper]), tps: "7.3 tok/s", tip: false }))).toBe("Slower now, 7.3 tok/s · Whisper in the way");
  expect(text(slow({ fit: fitWith([whisper]), tip: false }))).toBe("Slower now · Whisper in the way");
});

it("the slower-now line has no tip, and its screen-reader words are the sentence with the sizes", () => {
  const sentence = "Fits this card with Whisper (2.0 GB) off it. 1.0 GB is in system memory now.";
  const html = slow({ fit: fitWith([whisper]) });
  expect(html).not.toContain("data-tip");
  expect(html).toContain(`<span class="vh">. ${sentence}</span>`);
  expect(text(html)).toBe(`Slower now · Whisper in the way. ${sentence}`);
});

it("where the sentence is a step away, the slower-now line has neither a tip nor the sentence for a screen reader", () => {
  const html = slow({ fit: fitWith([whisper]), tip: false });
  expect(html).not.toContain("data-tip");
  expect(html).not.toContain('class="vh"');
  expect(text(html)).toBe("Slower now · Whisper in the way");
});

it("in a list whose own line names the programs holding the card, the slower-now line does not name them again", () => {
  setState({ fitTable: table({ kind: "gpu", freeBytes: 10 * GIB, usableBytes: 9 * GIB, others: { programs: ["ComfyUI"], bytes: 2 * GIB } }) });
  const listed = slow({ fit: fitWith([comfy]), listed: true });
  expect(text(listed)).toBe("Slower now");
  expect(listed).toContain('data-testid="models.fit.slow-now"');
  expect(text(slow({ fit: fitWith([comfy]) }))).toContain("ComfyUI in the way");
});

it("a model that runs as the card says, with nothing in its way, has no slower-now line", () => {
  expect(slow({ fit: fitWith(undefined) })).toBe("");
  expect(slow({ fit: fitWith([]) })).toBe("");
  expect(slow({ fit: undefined })).toBe("");
});
