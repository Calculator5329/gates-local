import { afterEach, describe, expect, it } from "vitest";
import { json, startFakeServer, type FakeServer } from "../fit/fake-http.ts";
import { manifestBytes, manifestUrl, registryLookup, registrySize } from "./registry-size.ts";

let server: FakeServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("a model's whole download size", () => {
  it("reads library, namespaced and other-registry names from the manifest route", () => {
    expect(manifestUrl("gemma4:26b")).toBe("https://registry.ollama.ai/v2/library/gemma4/manifests/26b");
    expect(manifestUrl("gemma4")).toBe("https://registry.ollama.ai/v2/library/gemma4/manifests/latest");
    expect(manifestUrl("someone/tiny:q4")).toBe("https://registry.ollama.ai/v2/someone/tiny/manifests/q4");
    expect(manifestUrl("hf.co/a/b:Q4_K_M")).toBe("https://hf.co/v2/a/b/manifests/Q4_K_M");
    expect(manifestUrl("ollama run gemma4:26b")).toBeUndefined();
    expect(manifestUrl("a//b")).toBeUndefined();
  });

  it("adds every file, the small ones too", () => {
    expect(manifestBytes({ config: { size: 500 }, layers: [{ size: 1_110_000_000 }, { size: 15_900_000_000 }, { size: 430_000_000 }] })).toBe(17_440_000_500);
    expect(manifestBytes({ layers: [] })).toBeUndefined();
    expect(manifestBytes("nope")).toBeUndefined();
  });

  it("asks the registry, and says nothing when the registry does not answer with a manifest", async () => {
    server = await startFakeServer({
      "GET /v2/library/gemma4/manifests/26b": (_b, res) => json(res, 200, { config: { size: 10 }, layers: [{ size: 100 }, { size: 900 }] }),
      "GET /v2/library/gone/manifests/latest": (_b, res) => json(res, 404, { errors: [{ code: "MANIFEST_UNKNOWN" }] }),
    });
    const signal = new AbortController().signal;
    expect(await registrySize("gemma4:26b", signal, { registry: server.baseUrl })).toBe(1010);
    expect(await registrySize("gone", signal, { registry: server.baseUrl })).toBeUndefined();
    expect(await registrySize("gemma4:26b", signal, { registry: "http://127.0.0.1:9" })).toBeUndefined();
  });

  it("tells a name the registry does not have from a registry that did not answer (row 22)", async () => {
    server = await startFakeServer({
      "GET /v2/library/gemma4/manifests/26b": (_b, res) => json(res, 200, { config: { size: 10 }, layers: [{ size: 100 }] }),
      "GET /v2/library/gone/manifests/latest": (_b, res) => json(res, 404, { errors: [{ code: "MANIFEST_UNKNOWN" }] }),
      "GET /v2/library/busy/manifests/latest": (_b, res) => json(res, 503, {}),
    });
    const signal = new AbortController().signal;
    const registry = { registry: server.baseUrl };
    expect(await registryLookup("gemma4:26b", signal, registry)).toEqual({ kind: "size", bytes: 110 });
    expect(await registryLookup("gone", signal, registry)).toEqual({ kind: "missing" });
    expect(await registryLookup("ollama run gemma4", signal, registry)).toEqual({ kind: "missing" });
    expect(await registryLookup("busy", signal, registry)).toEqual({ kind: "unreadable" });
    expect(await registryLookup("gemma4:26b", signal, { registry: "http://127.0.0.1:9" })).toEqual({ kind: "unreadable" });
  });
});
