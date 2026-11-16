// Owner, 2026-11-13: "it tells you in a chat if you've changed models mid-chat, like image versus text versus whatever."
import type { CatalogEntry, ImagePreset, Message } from "@gates-local/contracts";
import { describe, expect, it } from "vitest";
import { type Answerer, LIVE_QUESTION, modelChanges } from "./model-change.ts";

let n = 0;
const ask = (): Message => ({ id: `u${++n}`, threadId: "T", role: "user", content: "q", createdAt: n });
const reply = (model: string): Message => ({ id: `a${++n}`, threadId: "T", role: "assistant", content: "a", model, createdAt: n });
const picture = (preset: string): Message => ({
  id: `a${++n}`, threadId: "T", role: "assistant", content: "a lighthouse", model: preset, createdAt: n,
  imageJob: { jobId: `j${n}`, state: "done", choice: { preset, width: 1024, height: 1024 } },
});
const QWEN = { kind: "chat", model: "qwen3.5:9b" } as const;
const GEMMA = { kind: "chat", model: "gemma4:e4b" } as const;
const ZIMAGE = { kind: "image", preset: "z-image-int8" } as const;

describe("modelChanges", () => {
  it("marks each question answered by another thing than the turn before, never the first", () => {
    const q1 = ask(), q2 = ask(), q3 = ask(), q4 = ask(), q5 = ask();
    const thread = [q1, reply("qwen3.5:9b"), q2, reply("qwen3.5:9b"), q3, reply("gemma4:e4b"), q4, picture("z-image-int8"), q5, reply("gemma4:e4b")];
    expect([...modelChanges(thread)]).toEqual([
      [q3.id, { from: QWEN, to: GEMMA }],
      [q4.id, { from: GEMMA, to: ZIMAGE }],
      [q5.id, { from: ZIMAGE, to: GEMMA }],
    ]);
  });

  it("a chat reply that drew a picture with its tool was answered by the chat model", () => {
    const q1 = ask(), q2 = ask();
    const thread = [q1, reply("qwen3.5:9b"), q2, picture("z-image-int8"), reply("qwen3.5:9b")];
    expect(modelChanges(thread).size).toBe(0);
  });

  it("a question with no reply saved changes nothing; the next answered one compares with the last answered", () => {
    const q1 = ask(), q2 = ask(), q3 = ask();
    expect([...modelChanges([q1, reply("qwen3.5:9b"), q2, q3, reply("gemma4:e4b")])]).toEqual([[q3.id, { from: QWEN, to: GEMMA }]]);
  });

  it("a live turn counts from its first frame: before its question is saved, and before any reply", () => {
    const q1 = ask(), q2 = ask();
    const thread = [q1, reply("qwen3.5:9b")];
    expect([...modelChanges(thread, { questionId: undefined, by: ZIMAGE })]).toEqual([[LIVE_QUESTION, { from: QWEN, to: ZIMAGE }]]);
    expect([...modelChanges([...thread, q2], { questionId: q2.id, by: GEMMA })]).toEqual([[q2.id, { from: QWEN, to: GEMMA }]]);
    // a picture its tool saved while the chat reply is still being written does not make it an image turn
    expect([...modelChanges([...thread, q2, picture("z-image-int8")], { questionId: q2.id, by: QWEN })]).toEqual([]);
  });

  it("the same model under its :latest name is no change", () => {
    const q1 = ask(), q2 = ask();
    expect(modelChanges([q1, reply("llama3.2"), q2, reply("llama3.2:latest")]).size).toBe(0);
  });
});

const imagePreset = (id: string, name: string, family: string, short?: string): ImagePreset =>
  ({ id, name, family, measured: true, sizes: [{ width: 1024, height: 1024, bytes: 0 }], ...short === undefined ? {} : { short } });
const catalogEntry = (name: string, label: string): CatalogEntry => ({ name, label, purpose: "", downloadBytes: 0, installed: true, recommended: false });
const Z_TURBO = imagePreset("z-image-int8", "Z-Image Turbo int8", "flux", "Z-Image");
const XL_PLAIN = imagePreset("sdxl-base", "SDXL Base 1.0", "sdxl");

async function drawn(from: Answerer, to: Answerer): Promise<string> {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { ModelChange } = await import("./ModelChange.tsx");
  const { setState } = await import("../lib/store/store.ts");
  const { CHAT_MODELS, suggestedList } = await import("@gates-local/contracts");
  setState({
    suggested: suggestedList(CHAT_MODELS),
    catalog: [catalogEntry("qwen3.5:9b", "Qwen 3.5 9B")],
    imagePresets: { presets: [Z_TURBO], others: [XL_PLAIN], current: { preset: Z_TURBO, width: 1024, height: 1024 } },
  });
  return renderToStaticMarkup(createElement(ModelChange, { change: { from, to } }));
}

const words = (html: string) => html.replace(/<[^>]*>/g, "");
const names = (html: string) => [...html.matchAll(/<span class="mc-name">([^<]*)<\/span>/g)].map((m) => m[1]);

describe("ModelChange", () => {
  it("draws the old answerer's mark and name, an arrow, then the new one's, and says no sentence", async () => {
    const html = await drawn(QWEN, ZIMAGE);
    expect(html).toContain('data-testid="chat.thread.model-change"');
    expect(names(html)).toEqual(["Qwen 3.5 9B", "Z-Image"]);
    const whos = html.split('<span class="mc-who">').slice(1);
    expect(whos).toHaveLength(2);
    expect(whos[0]).toMatch(/^<span class="maker-mark" aria-hidden="true"><svg[^>]*><path /);
    expect(whos[1]).toMatch(/^<span class="maker-mark" aria-hidden="true">FX<\/span><span class="mc-name">Z-Image<\/span>/);
    const arrow = html.indexOf('href="#i-arrow"');
    expect(arrow).toBeGreaterThan(html.indexOf(">Qwen 3.5 9B<"));
    expect(arrow).toBeLessThan(html.indexOf(">Z-Image<"));
    expect(words(html)).toBe("Qwen 3.5 9BFXZ-Image");
  });

  it("names each answerer as the composer's button does: the chat model's catalog name, else its friendly name, and a picture setup's short name, else its name, else its id", async () => {
    const { describeModel } = await import("../lib/words/format.ts");
    expect(names(await drawn(QWEN, GEMMA))).toEqual(["Qwen 3.5 9B", describeModel("gemma4:e4b", undefined).name]);
    expect(names(await drawn(ZIMAGE, { kind: "image", preset: "sdxl-base" }))).toEqual(["Z-Image", "SDXL Base 1.0"]);
    expect(names(await drawn({ kind: "image", preset: "gone-preset" }, QWEN))).toEqual(["gone-preset", "Qwen 3.5 9B"]);
  });
});
