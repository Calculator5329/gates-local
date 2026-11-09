import path from "node:path";
import { mkdirSync, mkdtempSync, renameSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import type { OwnershipCheck } from "../../server/src/runtime/ownership.ts";
import { modelFolderActions, serverDataDir } from "../src/data-dir.ts";

const linux = { platform: "linux" as const, home: "/home/u", userData: "/home/u/.config/gates-local" };
const win = { platform: "win32" as const, home: "C:\\Users\\u", userData: "C:\\Users\\u\\AppData\\Roaming\\gates-local" };

it("SR-04: refuses a real symlink substituted after the owned folder was displayed", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "models-folder-"));
  const models = path.join(root, "models");
  const other = path.join(root, "unrelated");
  mkdirSync(models);
  mkdirSync(other);
  const record = { pid: 1, startTime: "1", command: "ollama serve", baseUrl: "http://runtime.invalid", binary: "/app/ollama", startedAt: 1, modelsDir: models };
  const openPath = vi.fn(async (_folder: string) => "");
  const actions = modelFolderActions({ ownership: () => ({ kind: "ours", record }), isFolder: folder => statSync(folder).isDirectory(), openPath });
  expect(actions.modelsFolder()).toBe(models);
  renameSync(models, path.join(root, "original"));
  symlinkSync(other, models, "dir");
  await actions.openModelsFolder();
  expect(openPath, "the owned process must not authorize a substituted directory").not.toHaveBeenCalled();
  expect(actions.modelsFolder()).toBeNull();
});

describe("SQ-01: main resolves the owned models folder", () => {
  const models = mkdtempSync(path.join(tmpdir(), "owned-models-"));
  const record = { pid: 1, startTime: "1", command: "ollama serve", baseUrl: "http://runtime.invalid", binary: "/app/ollama", startedAt: 1, modelsDir: models };

  it("opens the folder from verified ownership, ignoring every renderer argument", async () => {
    const openPath = vi.fn(async (_folder: string) => "");
    const isFolder = vi.fn((folder: string) => folder === models);
    const actions = modelFolderActions({ ownership: () => ({ kind: "ours", record }), isFolder, openPath });
    expect(actions.modelsFolder()).toBe(models);
    for (const supplied of ["/etc/models", "/links/models", "\\\\server\\share\\models", { toString: () => models }]) {
      expect(await Reflect.apply(actions.openModelsFolder, undefined, [supplied])).toBeNull();
    }
    expect(openPath.mock.calls).toEqual([[models], [models], [models], [models]]);
    expect(isFolder.mock.calls.every(([folder]) => folder === models)).toBe(true);
  });

  it.each<OwnershipCheck>([
    { kind: "no-record" }, { kind: "gone", record }, { kind: "not-ours", record, detail: "different process" },
    { kind: "ours", record: { ...record, modelsDir: undefined } },
    { kind: "ours", record: { ...record, modelsDir: "relative/models" } },
  ])("has no folder or action for unverified or unknown ownership ($kind)", async owned => {
    const openPath = vi.fn(async (_folder: string) => "");
    const actions = modelFolderActions({ ownership: () => owned, isFolder: () => true, openPath });
    expect(actions.modelsFolder()).toBeNull();
    expect(await actions.openModelsFolder()).toBeNull();
    expect(openPath).not.toHaveBeenCalled();
  });

  it("rechecks ownership and folder existence when Open is clicked", async () => {
    let ownership: OwnershipCheck = { kind: "ours", record };
    let exists = true;
    const openPath = vi.fn(async (_folder: string) => "");
    const actions = modelFolderActions({ ownership: () => ownership, isFolder: () => exists, openPath });
    expect(actions.modelsFolder()).toBe(models);
    ownership = { kind: "gone", record };
    expect(await actions.openModelsFolder()).toBeNull();
    ownership = { kind: "ours", record };
    exists = false;
    expect(actions.modelsFolder()).toBeNull();
    expect(await actions.openModelsFolder()).toBeNull();
    expect(openPath).not.toHaveBeenCalled();
  });

  it("returns a file-manager failure without changing the trusted target", async () => {
    const actions = modelFolderActions({ ownership: () => ({ kind: "ours", record }), isFolder: () => true, openPath: async () => "not available" });
    expect(await actions.openModelsFolder()).toBe("Couldn't open the folder: not available");
  });
});

describe("serverDataDir", () => {
  it("Linux: the XDG data folder, never ~/.config (models and the Ollama install are large)", () => {
    expect(serverDataDir({ ...linux, env: {} })).toBe("/home/u/.local/share/gates-local");
    expect(serverDataDir({ ...linux, env: { XDG_DATA_HOME: "/data/u" } })).toBe("/data/u/gates-local");
    // a relative XDG_DATA_HOME is invalid by the spec and ignored
    expect(serverDataDir({ ...linux, env: { XDG_DATA_HOME: "rel" } })).toBe("/home/u/.local/share/gates-local");
  });

  it("Windows: %LOCALAPPDATA%, never the roaming profile", () => {
    expect(serverDataDir({ ...win, env: { LOCALAPPDATA: "D:\\Local" } })).toBe("D:\\Local\\GatesLocal");
    expect(serverDataDir({ ...win, env: {} })).toBe("C:\\Users\\u\\AppData\\Local\\GatesLocal");
    expect(serverDataDir({ ...win, env: { LOCALAPPDATA: "D:\\Local" } }).toLowerCase()).not.toContain("roaming");
  });

  it("macOS: under userData (Application Support is local)", () => {
    const mac = { platform: "darwin" as const, home: "/Users/u", userData: "/Users/u/Library/Application Support/gates-local", env: {} };
    expect(serverDataDir(mac)).toBe(path.posix.join(mac.userData, "server-data"));
  });

  it("an isolated profile keeps the server's per-instance data inside it", () => {
    expect(serverDataDir({ ...linux, userData: "/work/user-data", env: { GATES_LOCAL_USER_DATA: "/work/user-data" } })).toBe("/work/user-data/server-data");
  });

  it("GATES_LOCAL_DATA_DIR wins over everything", () => {
    expect(serverDataDir({ ...win, env: { GATES_LOCAL_DATA_DIR: "E:\\gl", GATES_LOCAL_USER_DATA: "E:\\p", LOCALAPPDATA: "D:\\Local" } })).toBe("E:\\gl");
  });
});
