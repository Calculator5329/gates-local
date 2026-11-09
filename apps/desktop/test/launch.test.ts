// Background mode and the server child's environment (src/launch.ts).
// `electron apps/desktop --background` or GATES_LOCAL_BACKGROUND=1 runs the
// supervisor and server with no window; closing the last window does not
// quit; launching the app again opens a window on the running instance.
import { describe, expect, it } from "vitest";
import { launchMode, quitOnAllClosed, secondInstanceAction, serverEnv, windowAtStart } from "../src/launch.ts";

const ELECTRON_ARGV = ["/usr/lib/electron/electron", "apps/desktop"];

describe("launch mode", () => {
  it("is a normal launch without the flag: a window at start, quit when the last one closes", () => {
    const mode = launchMode(ELECTRON_ARGV, {});
    expect(mode).toEqual({ background: false });
    expect(windowAtStart(mode)).toBe(true);
    expect(quitOnAllClosed(mode)).toBe(true);
  });

  it("--background starts with no window and keeps running when the last window closes", () => {
    const mode = launchMode([...ELECTRON_ARGV, "--background"], {});
    expect(mode).toEqual({ background: true });
    expect(windowAtStart(mode)).toBe(false);
    expect(quitOnAllClosed(mode)).toBe(false);
  });

  it("GATES_LOCAL_BACKGROUND=1 is the same as the flag; any other value is not", () => {
    expect(launchMode(ELECTRON_ARGV, { GATES_LOCAL_BACKGROUND: "1" })).toEqual({ background: true });
    expect(launchMode(ELECTRON_ARGV, { GATES_LOCAL_BACKGROUND: "0" })).toEqual({ background: false });
    expect(launchMode(ELECTRON_ARGV, { GATES_LOCAL_BACKGROUND: "" })).toEqual({ background: false });
  });

  it("only the exact flag counts", () => {
    expect(launchMode([...ELECTRON_ARGV, "--background=no"], {})).toEqual({ background: false });
    expect(launchMode([...ELECTRON_ARGV, "--backgrounds"], {})).toEqual({ background: false });
  });
});

describe("a second launch", () => {
  it("creates the window when the running instance has none", () => {
    expect(secondInstanceAction({ hasWindow: false, minimized: false, background: false })).toBe("create");
  });

  it("restores a minimized window, else focuses it", () => {
    expect(secondInstanceAction({ hasWindow: true, minimized: true, background: false })).toBe("restore");
    expect(secondInstanceAction({ hasWindow: true, minimized: false, background: false })).toBe("focus");
  });

  it("does nothing when the second launch is itself a background launch", () => {
    expect(secondInstanceAction({ hasWindow: false, minimized: false, background: true })).toBe("none");
    expect(secondInstanceAction({ hasWindow: true, minimized: true, background: true })).toBe("none");
  });
});

describe("server child environment", () => {
  const phone = {
    GATES_LOCAL_WEB_LISTEN: "unix:/run/user/1000/gates-local/phone.sock",
    GATES_LOCAL_WEB_ORIGIN: "https://hub.example.ts.net:8456",
    GATES_LOCAL_WEB_USER: "owner@example.com",
  };

  it("passes the phone knobs through and names the dist dir the window serves", () => {
    const env = serverEnv({ env: { PATH: "/bin", ...phone }, clientOrigin: "gates-local://app", webRoot: "/opt/gl/web" });
    expect(env).toMatchObject({ ...phone, GATES_LOCAL_WEB_ROOT: "/opt/gl/web", GATES_LOCAL_ALLOWED_ORIGINS: "gates-local://app", PATH: "/bin" });
  });

  it("the window's dist dir wins over a stray GATES_LOCAL_WEB_ROOT", () => {
    const env = serverEnv({ env: { ...phone, GATES_LOCAL_WEB_ROOT: "/elsewhere" }, clientOrigin: null, webRoot: "/opt/gl/web" });
    expect(env["GATES_LOCAL_WEB_ROOT"]).toBe("/opt/gl/web");
  });

  it("without GATES_LOCAL_WEB_LISTEN nothing phone-related is added", () => {
    const env = serverEnv({ env: { PATH: "/bin" }, clientOrigin: "gates-local://app", webRoot: "/opt/gl/web" });
    expect(env).toEqual({ PATH: "/bin", GATES_LOCAL_ALLOWED_ORIGINS: "gates-local://app", GATES_LOCAL_DESKTOP: "1" });
  });

  it("keeps extra allowed origins and adds the client's", () => {
    const env = serverEnv({ env: { GATES_LOCAL_ALLOWED_ORIGINS: "http://a, ,http://b" }, clientOrigin: "gates-local://app", webRoot: "/w" });
    expect(env["GATES_LOCAL_ALLOWED_ORIGINS"]).toBe("http://a,http://b,gates-local://app");
  });
});
