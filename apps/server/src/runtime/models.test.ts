import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { json, startFakeServer } from "../fit/fake-http.ts";
import { RuntimeResponseError, createModelCatalog, listLoaded, listModels, type ModelCatalogOptions, type RetryTimers } from "./models.ts";
import { pickChatModel } from "./pick.ts";
import { type FakeOllama, type FakeTag, startFakeOllama } from "./test-fakes.ts";
import type { ModelInfo } from "./types.ts";

/** Retry timers that only run when a test fires them. */
function fakeTimers() {
  const pending = new Map<number, () => void>();
  const delays: number[] = [];
  let id = 0;
  const timers: RetryTimers & { pending(): number; delays: number[]; fire(): void } = {
    set(fn, ms) {
      pending.set(++id, fn);
      delays.push(ms);
      return id;
    },
    clear: (handle) => void pending.delete(handle as number),
    pending: () => pending.size,
    delays,
    fire() {
      const first = [...pending][0];
      if (first === undefined) throw new Error("no retry pending");
      pending.delete(first[0]);
      first[1]();
    },
  };
  return timers;
}
let timers: ReturnType<typeof fakeTimers>;
/** Every catalog here runs on the fake timers, so teardown can see a retry left armed (MP2-04). */
const catalogFor = (url: () => string | undefined, opts: ModelCatalogOptions = {}) => createModelCatalog(url, { timers, ...opts });

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
  timers = fakeTimers();
  fake = await startFakeOllama({ tags: [qwen] });
});
afterEach(async () => {
  try {
    // MP2-04: a test that is not about retries turns them off; one that is stops its catalog.
    expect(timers.pending(), "a discovery retry was left armed").toBe(0);
  } finally {
    await fake.close();
  }
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
    const catalog = catalogFor(() => fake.baseUrl, { retryMs: 0 });
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
    const catalog = catalogFor(() => fake.baseUrl, { retryMs: 0 });
    await catalog.refresh();
    fake.rawTags = "not json";
    await expect(catalog.refresh()).rejects.toBeInstanceOf(RuntimeResponseError);
    expect(catalog.current()?.map((m) => m.name)).toEqual(["qwen3:8b"]);
  });

  it("an absent runtime is an empty list", async () => {
    const catalog = catalogFor(() => undefined);
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
      const catalog = catalogFor(() => url, { retryMs: 0 });
      const emitted: string[][] = [];
      catalog.onChange((m) => emitted.push(m.map((x) => x.name)));
      const stale = catalog.refresh();
      await new Promise((r) => setTimeout(r, 20));
      url = fake.baseUrl; // the runtime switched
      await catalog.refresh();
      release();
      // The old fetch changes nothing, and its caller gets the current list, not the old runtime's (MP2-02).
      expect((await stale).models.map((m) => m.name)).toEqual(["qwen3:8b"]);
      expect(catalog.current()?.map((m) => m.name)).toEqual(["qwen3:8b"]);
      expect(emitted).toEqual([["qwen3:8b"]]);
    } finally {
      release();
      await old.close();
    }
  });

  it("makes at most one real /api/tags call per interval unless forced, and never reuses a failure", async () => {
    let t = 0;
    const catalog = catalogFor(() => fake.baseUrl, { minIntervalMs: 2000, now: () => t, retryMs: 0 });
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
      const catalog = catalogFor(() => s.baseUrl);
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
      const catalog = catalogFor(() => s.baseUrl, {
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

  it("an Ollama too old to list capabilities is told apart from one that failed to answer", async () => {
    tags = [qwen, gemma];
    const s = await startFakeServer({
      "GET /api/tags": (_b, res) => json(res, 200, { models: tags }),
      // Old Ollama: /api/show answers, with no capabilities field. Gemma's show fails.
      "POST /api/show": (b, res) => ((b as { model: string }).model === "qwen3:8b" ? json(res, 200, { details: {} }) : json(res, 503, { error: "busy" })),
    });
    try {
      const models = await listModels(s.baseUrl);
      expect(models.map((m) => [m.name, m.capabilities])).toEqual([
        ["gemma3:4b", ["unknown"]],
        ["qwen3:8b", ["unknown", "unreported"]],
      ]);
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
    const catalog = catalogFor(() => s.baseUrl, { retryMs: 10 });
    try {
      const seen: string[][] = [];
      const known = new Promise<void>((resolve) =>
        catalog.onChange((models) => {
          seen.push(models.flatMap((m) => m.capabilities));
          if (models.every((m) => !m.capabilities.includes("unknown"))) resolve();
        }),
      );
      await catalog.refresh();
      timers.fire();
      await vi.waitFor(() => expect(timers.pending()).toBe(1));
      timers.fire();
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
      const catalog = catalogFor(() => s.baseUrl, {
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
    const catalog = catalogFor(() => s.baseUrl, {
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
      timers.fire();
      await vi.waitFor(() => expect(timers.pending()).toBe(1));
      timers.fire();
      await settled;
      expect(timers.pending()).toBe(0);
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
      const catalog = catalogFor(() => s.baseUrl, {
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

/** A runtime whose /api/tags and /api/show can be down or held; counts simultaneous /api/tags requests. */
async function flakyRuntime() {
  const state = { tagsDown: false, showDown: true, hold: undefined as Promise<void> | undefined, tagCalls: 0, inFlight: 0, maxInFlight: 0 };
  const s = await startFakeServer({
    "GET /api/tags": async (_b, res) => {
      state.tagCalls++;
      state.maxInFlight = Math.max(state.maxInFlight, ++state.inFlight);
      try {
        await state.hold;
        if (state.tagsDown) json(res, 503, { error: "restarting" });
        else json(res, 200, { models: [qwen] });
      } finally {
        state.inFlight--;
      }
    },
    "POST /api/show": (_b, res) => (state.showDown ? json(res, 503, { error: "busy" }) : json(res, 200, { capabilities: ["completion"] })),
  });
  return { s, state };
}

describe("discovery retries (MP2-01, MP2-02)", () => {
  it("a retry that fails is armed again, doubled, and discovery recovers once the runtime answers", async () => {
    const { s, state } = await flakyRuntime();
    const catalog = catalogFor(() => s.baseUrl, { retryMs: 5000 });
    try {
      await catalog.refresh(); // /api/show is down: unknown, a retry is armed
      expect(timers.pending()).toBe(1);
      state.tagsDown = true; // the runtime is restarting when the retry runs
      timers.fire();
      await vi.waitFor(() => expect(state.tagCalls).toBe(2));
      await vi.waitFor(() => expect(timers.pending()).toBe(1));
      expect(timers.delays).toEqual([5000, 10_000]);
      state.tagsDown = false;
      state.showDown = false;
      timers.fire();
      await vi.waitFor(() => expect(catalog.current()?.[0]?.capabilities).toEqual(["completion"]));
      expect(timers.pending()).toBe(0);
    } finally {
      catalog.stop();
      await s.close();
    }
  });

  it("failed retries back off by doubling up to five minutes", async () => {
    const { s, state } = await flakyRuntime();
    const catalog = catalogFor(() => s.baseUrl, { retryMs: 5000 });
    try {
      await catalog.refresh();
      state.tagsDown = true;
      for (let i = 2; i <= 9; i++) {
        timers.fire();
        await vi.waitFor(() => expect(state.tagCalls).toBe(i));
        await vi.waitFor(() => expect(timers.pending()).toBe(1));
      }
      expect(timers.delays).toEqual([5000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000, 300_000]);
    } finally {
      catalog.stop();
      await s.close();
    }
  });

  it("stop() and a runtime change end the retries; the new runtime starts its backoff over", async () => {
    const { s, state } = await flakyRuntime();
    let url: string | undefined = s.baseUrl;
    const catalog = catalogFor(() => url, { retryMs: 5000 });
    try {
      await catalog.refresh();
      state.tagsDown = true;
      timers.fire();
      await vi.waitFor(() => expect(timers.pending()).toBe(1)); // re-armed at 10 s
      url = fake.baseUrl; // the runtime switched
      timers.fire();
      await new Promise((r) => setTimeout(r, 30));
      expect(state.tagCalls).toBe(2); // the old runtime is not asked again
      expect(fake.requests.filter((r) => r === "GET /api/tags")).toHaveLength(0); // the retry belonged to the old runtime
      expect(timers.pending()).toBe(0);
      await catalog.refresh(); // the new runtime (no /api/show here: unknown) arms its own retry from the base delay
      expect(timers.delays).toEqual([5000, 10_000, 5000]);
      catalog.stop();
      expect(timers.pending()).toBe(0);
    } finally {
      catalog.stop();
      await s.close();
    }
  });

  it("refreshes never overlap: a retry and a settings refresh during a held manual one wait their turn, and none is lost", async () => {
    const { s, state } = await flakyRuntime();
    const catalog = catalogFor(() => s.baseUrl, { retryMs: 5000 });
    let release!: () => void;
    try {
      await catalog.refresh(); // unknown: a retry is armed
      state.showDown = false;
      state.hold = new Promise<void>((r) => (release = r));
      const manual = catalog.refresh({ force: true }); // window focus
      await vi.waitFor(() => expect(state.inFlight).toBe(1));
      timers.fire(); // the retry comes due while the manual refresh is held
      const settings = catalog.refresh({ force: true }); // the default model changed
      const again = catalog.refresh({ force: true }); // and changed again
      await new Promise((r) => setTimeout(r, 30));
      expect(state.maxInFlight).toBe(1);
      release();
      await Promise.all([manual, settings, again]);
      expect(state.maxInFlight).toBe(1);
      // First load, the manual one (the retry joined it), one follow-up for both settings changes.
      expect(state.tagCalls).toBe(3);
      expect(catalog.current()?.[0]?.capabilities).toEqual(["completion"]);
      expect(timers.pending()).toBe(0);
    } finally {
      release?.();
      catalog.stop();
      await s.close();
    }
  });

  it("a settled refresh cancels the retry already armed", async () => {
    const { s, state } = await flakyRuntime();
    const catalog = catalogFor(() => s.baseUrl, { retryMs: 5000 });
    try {
      await catalog.refresh();
      expect(timers.pending()).toBe(1);
      state.showDown = false;
      await catalog.refresh({ force: true }); // a manual refresh reads the capabilities
      expect(timers.pending()).toBe(0);
    } finally {
      catalog.stop();
      await s.close();
    }
  });
});
