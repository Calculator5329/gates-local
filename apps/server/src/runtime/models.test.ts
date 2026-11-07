import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RuntimeResponseError, createModelCatalog, listLoaded, listModels } from "./models.ts";
import { type FakeOllama, type FakeTag, startFakeOllama } from "./test-fakes.ts";
import type { ModelInfo } from "./types.ts";

const qwen: FakeTag = {
  name: "qwen3:8b",
  digest: "sha-qwen",
  size: 5_200_000_000,
  modified_at: "2026-11-01T10:00:00Z",
  details: { family: "qwen3", parameter_size: "8.2B", quantization_level: "Q4_K_M", format: "gguf" },
};
const gemma: FakeTag = { name: "gemma3:4b", digest: "sha-gemma", size: 3_300_000_000, modified_at: "2026-10-01T10:00:00Z" };

let fake: FakeOllama;
beforeEach(async () => {
  fake = await startFakeOllama({ tags: [qwen] });
});
afterEach(async () => {
  await fake.close();
});

describe("listModels", () => {
  it("maps /api/tags to ModelInfo, sorted by name", async () => {
    fake.tags.push(gemma);
    expect(await listModels(fake.baseUrl)).toEqual([
      { name: "gemma3:4b", digest: "sha-gemma", sizeBytes: 3_300_000_000, modifiedAt: "2026-10-01T10:00:00Z" },
      {
        name: "qwen3:8b",
        digest: "sha-qwen",
        sizeBytes: 5_200_000_000,
        modifiedAt: "2026-11-01T10:00:00Z",
        family: "qwen3",
        parameterSize: "8.2B",
        quantization: "Q4_K_M",
      },
    ]);
  });

  it("refuses a malformed /api/tags with a named error", async () => {
    fake.rawTags = JSON.stringify({ models: [{ name: 7 }] });
    await expect(listModels(fake.baseUrl)).rejects.toBeInstanceOf(RuntimeResponseError);
  });
});

describe("listLoaded", () => {
  it("maps /api/ps to loaded models with VRAM size", async () => {
    fake.ps.push({ name: "qwen3:8b", size: 6_000_000_000, size_vram: 5_500_000_000, expires_at: "2026-11-07T12:00:00Z" });
    expect(await listLoaded(fake.baseUrl)).toEqual([
      { name: "qwen3:8b", sizeBytes: 6_000_000_000, sizeVramBytes: 5_500_000_000, expiresAt: "2026-11-07T12:00:00Z" },
    ]);
  });
});

describe("model catalog refresh", () => {
  it("emits on first load, stays quiet when nothing changed, and emits a model pulled in a terminal", async () => {
    const catalog = createModelCatalog(() => fake.baseUrl);
    const emitted: (readonly ModelInfo[])[] = [];
    catalog.onChange((m) => emitted.push(m));

    expect((await catalog.refresh()).changed).toBe(true);
    expect((await catalog.refresh()).changed).toBe(false);
    expect(emitted).toHaveLength(1);

    fake.tags.push(gemma); // `ollama pull gemma3:4b` in a terminal
    const r = await catalog.refresh();
    expect(r.changed).toBe(true);
    expect(emitted).toHaveLength(2);
    expect(emitted[1]?.map((m) => m.name)).toEqual(["gemma3:4b", "qwen3:8b"]);

    fake.tags[0] = { ...qwen, digest: "sha-qwen-v2", modified_at: "2026-11-07T09:00:00Z" }; // re-pulled
    expect((await catalog.refresh()).changed).toBe(true);
    expect(emitted).toHaveLength(3);
  });

  it("keeps the last good list when a refresh fails", async () => {
    const catalog = createModelCatalog(() => fake.baseUrl);
    await catalog.refresh();
    fake.rawTags = "not json";
    await expect(catalog.refresh()).rejects.toBeInstanceOf(RuntimeResponseError);
    expect(catalog.current()?.map((m) => m.name)).toEqual(["qwen3:8b"]);
  });

  it("an absent runtime is an empty list", async () => {
    const catalog = createModelCatalog(() => undefined);
    expect(await catalog.refresh()).toEqual({ models: [], changed: true });
  });
});
