import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { json, startFakeServer } from "../fit/fake-http.ts";
import { RuntimeResponseError, createModelCatalog, listLoaded, listModels } from "./models.ts";
import { pickChatModel } from "./pick.ts";
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
      // This fake has no /api/show, so capabilities are unknown (MP-01: never a guessed "completion").
      { name: "gemma3:4b", digest: "sha-gemma", sizeBytes: 3_300_000_000, modifiedAt: "2026-10-01T10:00:00Z", capabilities: ["unknown"] },
      {
        name: "qwen3:8b",
        digest: "sha-qwen",
        sizeBytes: 5_200_000_000,
        modifiedAt: "2026-11-01T10:00:00Z",
        family: "qwen3",
        parameterSize: "8.2B",
        quantization: "Q4_K_M",
        capabilities: ["unknown"],
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

  it("R-09: a slow fetch from the old runtime that lands after the new one's changes nothing", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const old = await startFakeServer({
      "GET /api/tags": async (_b, res) => {
        await held;
        json(res, 200, { models: [gemma] });
      },
    });
    try {
      let url = old.baseUrl;
      const catalog = createModelCatalog(() => url);
      const emitted: string[][] = [];
      catalog.onChange((m) => emitted.push(m.map((x) => x.name)));
      const stale = catalog.refresh();
      await new Promise((r) => setTimeout(r, 20));
      url = fake.baseUrl; // the runtime switched
      await catalog.refresh();
      release();
      // The old fetch answers its own caller and nothing else.
      expect((await stale).models.map((m) => m.name)).toEqual(["gemma3:4b"]);
      expect(catalog.current()?.map((m) => m.name)).toEqual(["qwen3:8b"]);
      expect(emitted).toEqual([["qwen3:8b"]]);
    } finally {
      release();
      await old.close();
    }
  });

  it("makes at most one real /api/tags call per interval unless forced, and never reuses a failure", async () => {
    let t = 0;
    const catalog = createModelCatalog(() => fake.baseUrl, { minIntervalMs: 2000, now: () => t });
    const tagCalls = () => fake.requests.filter((r) => r === "GET /api/tags").length;
    await Promise.all([catalog.refresh(), catalog.refresh(), catalog.refresh()]);
    t = 1999;
    await catalog.refresh();
    expect(tagCalls()).toBe(1);
    await catalog.refresh({ force: true });
    expect(tagCalls()).toBe(2);
    t = 4000;
    fake.rawTags = "not json";
    await expect(catalog.refresh()).rejects.toBeInstanceOf(RuntimeResponseError);
    fake.rawTags = undefined;
    await catalog.refresh();
    expect(tagCalls()).toBe(4);
  });
});

/** The models a fake server was asked to show, in order. */
const show = (s: { requests: { method: string; path: string; body: unknown }[] }) =>
  s.requests.filter((r) => r.path === "/api/show").map((r) => (r.body as { model: string }).model);

describe("capabilities and the chat pick", () => {
  const embedTag: FakeTag = { name: "nomic-embed-text:latest", digest: "sha-embed", size: 274_000_000, modified_at: "2026-10-02T10:00:00Z" };
  const caps: Record<string, string[]> = { "qwen3:8b": ["completion", "thinking"], "nomic-embed-text:latest": ["embedding"] };
  let tags: FakeTag[];
  const server = () =>
    startFakeServer({
      "GET /api/tags": (_b, res) => json(res, 200, { models: tags }),
      "POST /api/show": (b, res) => {
        const c = caps[(b as { model: string }).model];
        if (c === undefined) json(res, 404, { error: "model not found" });
        else json(res, 200, { capabilities: c });
      },
    });

  it("reads capabilities from /api/show once per digest, and again for a re-pulled model", async () => {
    tags = [qwen, embedTag];
    const s = await server();
    try {
      const catalog = createModelCatalog(() => s.baseUrl);
      const first = await catalog.refresh();
      expect(first.models.map((m) => [m.name, m.capabilities])).toEqual([
        ["nomic-embed-text:latest", ["embedding"]],
        ["qwen3:8b", ["completion", "thinking"]],
      ]);
      await catalog.refresh({ force: true });
      expect(show(s).toSorted()).toEqual(["nomic-embed-text:latest", "qwen3:8b"]);
      tags = [{ ...qwen, digest: "sha-qwen-v2" }, embedTag];
      await catalog.refresh({ force: true });
      expect(show(s).toSorted()).toEqual(["nomic-embed-text:latest", "qwen3:8b", "qwen3:8b"]);
    } finally {
      await s.close();
    }
  });

  it("MP-01: a failed /api/show is unknown, never completion, so an embedding alias is never picked; asks again next time", async () => {
    // An embedding model under a chat-looking alias: the name and family say nothing.
    const search: FakeTag = { name: "search:latest", digest: "sha-search", size: 600_000_000, modified_at: "2026-10-03T10:00:00Z", details: { family: "qwen3" } };
    tags = [search, { ...qwen, name: "qwen3:8b" }];
    const s = await startFakeServer({
      "GET /api/tags": (_b, res) => json(res, 200, { models: tags }),
      "POST /api/show": (b, res) =>
        (b as { model: string }).model === "search:latest" ? json(res, 503, { error: "busy" }) : json(res, 200, { capabilities: ["completion"] }),
    });
    try {
      const catalog = createModelCatalog(() => s.baseUrl, {
        retryMs: 0,
        pick: (models) => pickChatModel({ models, defaultModel: "search:latest", numCtx: 16384, fit: async () => undefined }),
      });
      const r = await catalog.refresh();
      expect(r.models.map((m) => [m.name, m.capabilities, m.pick !== undefined])).toEqual([
        ["qwen3:8b", ["completion"], true],
        ["search:latest", ["unknown"], false],
      ]);
      await catalog.refresh({ force: true });
      expect(show(s).filter((n) => n === "search:latest")).toHaveLength(2);
    } finally {
      await s.close();
    }
  });

  it("MP-01: discovery retries on its own until the unknown model's capabilities are read", async () => {
    tags = [{ ...embedTag, name: "search:latest", digest: "sha-search" }];
    let failures = 2;
    const s = await startFakeServer({
      "GET /api/tags": (_b, res) => json(res, 200, { models: tags }),
      "POST /api/show": (_b, res) => (failures-- > 0 ? json(res, 503, { error: "busy" }) : json(res, 200, { capabilities: ["embedding"] })),
    });
    const catalog = createModelCatalog(() => s.baseUrl, { retryMs: 10 });
    try {
      const seen: string[][] = [];
      const known = new Promise<void>((resolve) =>
        catalog.onChange((models) => {
          seen.push(models.flatMap((m) => m.capabilities));
          if (models.every((m) => !m.capabilities.includes("unknown"))) resolve();
        }),
      );
      await catalog.refresh();
      await known;
      expect(seen).toEqual([["unknown"], ["embedding"]]);
      expect(show(s)).toHaveLength(3);
    } finally {
      catalog.stop();
      await s.close();
    }
  });

  it("MP-02: an incomplete pick is not cached: the next refresh picks again; a complete one is kept", async () => {
    tags = [qwen];
    const s = await server();
    let complete = false;
    let calls = 0;
    try {
      const catalog = createModelCatalog(() => s.baseUrl, {
        retryMs: 0,
        pick: async () => {
          calls++;
          return { name: "qwen3:8b", pick: { numCtx: 16384, verdict: "fits" }, complete };
        },
      });
      await catalog.refresh();
      await catalog.refresh({ force: true });
      expect(calls).toBe(2);
      complete = true;
      await catalog.refresh({ force: true });
      await catalog.refresh({ force: true });
      expect(calls).toBe(3);
    } finally {
      await s.close();
    }
  });

  it("MP-02: an incomplete pick is retried on its own", async () => {
    tags = [qwen];
    const s = await server();
    let calls = 0;
    const catalog = createModelCatalog(() => s.baseUrl, {
      retryMs: 10,
      pick: async () => {
        calls++;
        return calls < 3
          ? { name: "qwen3:8b", pick: { numCtx: 16384 }, complete: false }
          : { name: "qwen3:8b", pick: { numCtx: 16384, verdict: "fits" }, complete: true };
      },
    });
    try {
      const settled = new Promise<void>((resolve) => catalog.onChange((models) => models[0]?.pick?.verdict === "fits" && resolve()));
      await catalog.refresh();
      await settled;
      expect(calls).toBe(3);
    } finally {
      catalog.stop();
      await s.close();
    }
  });

  it("stamps the pick on one model and re-runs it only when the list or the pick key changes", async () => {
    tags = [qwen, embedTag];
    const s = await server();
    let key = "a";
    const calls: string[][] = [];
    try {
      const catalog = createModelCatalog(() => s.baseUrl, {
        pick: async (models) => {
          calls.push(models.map((m) => m.name));
          return { name: "qwen3:8b", pick: { numCtx: 16384, verdict: "fits" }, complete: true };
        },
        pickKey: () => key,
      });
      const r = await catalog.refresh();
      expect(r.models.filter((m) => m.pick).map((m) => [m.name, m.pick])).toEqual([["qwen3:8b", { numCtx: 16384, verdict: "fits" }]]);
      await catalog.refresh({ force: true });
      expect(calls).toHaveLength(1);
      key = "b"; // the default model or context changed
      await catalog.refresh({ force: true });
      expect(calls).toHaveLength(2);
      tags = [qwen]; // the embedding model was removed
      await catalog.refresh({ force: true });
      expect(calls).toEqual([
        ["nomic-embed-text:latest", "qwen3:8b"],
        ["nomic-embed-text:latest", "qwen3:8b"],
        ["qwen3:8b"],
      ]);
    } finally {
      await s.close();
    }
  });
});
