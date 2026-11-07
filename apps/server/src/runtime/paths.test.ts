import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultAppDataDir, detectModelsDir, findModelsDirs, findOnPath } from "./paths.ts";
import { probe } from "./probe.ts";
import { freePort, removeDir, startFakeOllama, startWrongService, tmpDir, writeFakeBinary } from "./test-fakes.ts";

let work: string;
beforeEach(() => {
  work = tmpDir("paths");
});
afterEach(() => removeDir(work));

describe("defaultAppDataDir", () => {
  it("uses XDG_DATA_HOME when absolute, else ~/.local/share", () => {
    expect(defaultAppDataDir({ XDG_DATA_HOME: "/x/data" }, "/home/u")).toBe("/x/data/gates-local");
    expect(defaultAppDataDir({ XDG_DATA_HOME: "relative" }, "/home/u")).toBe("/home/u/.local/share/gates-local");
    expect(defaultAppDataDir({}, "/home/u")).toBe("/home/u/.local/share/gates-local");
  });
});

describe("detectModelsDir", () => {
  it("prefers an existing OLLAMA_MODELS, then ~/.ollama/models, and ignores missing candidates", () => {
    const home = path.join(work, "home");
    const custom = path.join(work, "models");
    expect(detectModelsDir({}, home, [])).toBeUndefined();
    mkdirSync(path.join(home, ".ollama", "models", "blobs"), { recursive: true });
    expect(detectModelsDir({ OLLAMA_MODELS: custom }, home, [])?.source).toBe("home-default");
    mkdirSync(path.join(custom, "manifests"), { recursive: true });
    expect(detectModelsDir({ OLLAMA_MODELS: custom }, home, [])).toEqual({ path: custom, writable: true, hasModels: false, source: "OLLAMA_MODELS" });
  });

  it("picks a writable store that has models over an empty one earlier in the order", () => {
    const home = path.join(work, "home");
    mkdirSync(path.join(home, ".ollama", "models", "blobs"), { recursive: true });
    const system = path.join(work, "system-store");
    mkdirSync(path.join(system, "manifests", "registry.ollama.ai"), { recursive: true });
    expect(detectModelsDir({}, home, [system])).toEqual({ path: system, writable: true, hasModels: true, source: "system" });
  });

  it("never hands over a store this user cannot write, but still reports it", () => {
    const home = path.join(work, "home");
    mkdirSync(path.join(home, ".ollama", "models", "blobs"), { recursive: true });
    const system = path.join(work, "readonly-store");
    mkdirSync(path.join(system, "manifests", "registry.ollama.ai"), { recursive: true });
    chmodSync(system, 0o555);
    try {
      expect(detectModelsDir({}, home, [system])?.path).toBe(path.join(home, ".ollama", "models"));
      expect(findModelsDirs({}, home, [system]).find((d) => d.path === system)).toMatchObject({ writable: false, hasModels: true });
    } finally {
      chmodSync(system, 0o755);
    }
  });
});

describe("findOnPath", () => {
  it("finds an executable ollama and skips non-executables", () => {
    const a = path.join(work, "a");
    const b = path.join(work, "b");
    mkdirSync(a, { recursive: true });
    writeFakeBinary(path.join(b, "ollama"));
    expect(findOnPath({ PATH: `${a}:${b}` })).toBe(path.join(b, "ollama"));
    expect(findOnPath({ PATH: a })).toBeUndefined();
  });
});

describe("probe", () => {
  it("tells Ollama, a wrong service and nothing apart", async () => {
    const ollama = await startFakeOllama({ version: "1.2.3" });
    const other = await startWrongService();
    try {
      expect(await probe(ollama.baseUrl, 500)).toEqual({ kind: "ollama", version: "1.2.3" });
      const w = await probe(other.baseUrl, 500);
      expect(w.kind).toBe("wrong-service");
      expect(w.kind === "wrong-service" && w.detail).toContain(`port ${other.port}`);
      expect(await probe(`http://127.0.0.1:${await freePort()}`, 500)).toEqual({ kind: "none" });
    } finally {
      await ollama.close();
      await other.close();
    }
  });
});
