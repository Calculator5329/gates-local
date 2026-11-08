import path from "node:path";
import { describe, expect, it } from "vitest";
import { serverDataDir } from "../src/data-dir.ts";

const linux = { platform: "linux" as const, home: "/home/u", userData: "/home/u/.config/gates-local" };
const win = { platform: "win32" as const, home: "C:\\Users\\u", userData: "C:\\Users\\u\\AppData\\Roaming\\gates-local" };

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
