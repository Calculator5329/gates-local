import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { desktopUserDataDir, serverDataDir } from "../src/data-dir.ts";

const fake = vi.hoisted(() => ({ packaged: false, userData: "", appData: "" }));
vi.mock("electron", () => ({
  app: {
    get isPackaged() { return fake.packaged; },
    setName: vi.fn(),
    setPath: (_name: string, value: string) => { fake.userData = value; },
    getPath: () => fake.appData,
    requestSingleInstanceLock: () => false,
    quit: vi.fn(),
  },
  protocol: { registerSchemesAsPrivileged: vi.fn() },
}));
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

async function profile(packaged: boolean, override?: string): Promise<string> {
  vi.resetModules();
  fake.packaged = packaged;
  fake.appData = path.join(tmpdir(), "profile-base");
  vi.stubEnv("GATES_LOCAL_USER_DATA", override);
  vi.stubGlobal("__dirname", tmpdir());
  // Observe main's actual setPath before it asks for the single-instance lock.
  // Refusing this fake lock prevents a server, window or pid-file write.
  await import("../src/main.ts");
  return fake.userData;
}

it("PK-01: packaged main without overrides takes a different profile before the instance lock", async () => {
  const developer = await profile(false);
  const installed = await profile(true);
  expect(developer).toBe(path.join(fake.appData, "gates-local"));
  expect(installed, "packaged launches must not focus an open developer instance").not.toBe(developer);
  expect(installed).toBe(path.join(fake.appData, "gates-local-installed"));
});

it("PK-01: installed XDG/Windows defaults and invalid-base fallbacks remain local and separate", () => {
  const linux = { platform: "linux" as const, packaged: true, home: "/home/u", userData: "unused" };
  expect(serverDataDir({ ...linux, env: { XDG_DATA_HOME: "/data/u" } })).toBe("/data/u/gates-local-installed");
  expect(serverDataDir({ ...linux, env: { XDG_DATA_HOME: "relative" } })).toBe("/home/u/.local/share/gates-local-installed");
  const win = { platform: "win32" as const, packaged: true, home: "C:\\Users\\u", userData: "unused" };
  expect(serverDataDir({ ...win, env: { LOCALAPPDATA: "D:\\Local" } })).toBe("D:\\Local\\GatesLocalInstalled");
  expect(serverDataDir({ ...win, env: { LOCALAPPDATA: "relative" } })).toBe("C:\\Users\\u\\AppData\\Local\\GatesLocalInstalled");
  expect(desktopUserDataDir({ platform: "win32", env: {}, appData: "C:\\Users\\u\\AppData\\Roaming", packaged: true })).toBe("C:\\Users\\u\\AppData\\Roaming\\gates-local-installed");
  expect(desktopUserDataDir({ platform: "win32", env: {}, appData: "C:\\Users\\u\\AppData\\Roaming", packaged: false })).toBe("C:\\Users\\u\\AppData\\Roaming\\gates-local");
});

it.each(["linux", "win32"] as const)("PK-01: %s packaged data without overrides cannot be the developer store", platform => {
  const input = { platform, home: platform === "linux" ? "/home/u" : "C:\\Users\\u", userData: "unused", env: {} };
  const developer = { ...input, packaged: false };
  const installed = { ...input, packaged: true };
  expect(serverDataDir(installed), "threads, settings and runtime ownership must be separate").not.toBe(serverDataDir(developer));
});

it("PK-01: explicit profile and data overrides retain precedence in both modes", async () => {
  for (const packaged of [false, true]) {
    const chosen = path.join(tmpdir(), "chosen-profile");
    expect(await profile(packaged, chosen)).toBe(chosen);
    const input = { platform: "linux" as const, packaged, home: "/home/u", userData: chosen, env: { GATES_LOCAL_USER_DATA: chosen } };
    expect(serverDataDir(input)).toBe(path.join(chosen, "server-data"));
    expect(serverDataDir({ ...input, env: { ...input.env, GATES_LOCAL_DATA_DIR: "/chosen-data" } })).toBe("/chosen-data");
  }
});
