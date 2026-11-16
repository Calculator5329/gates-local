import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WireError } from "@gates-local/contracts";
import { methodSamples } from "@gates-local/contracts/testing";
import { type Browser, installBrowser, tick, until } from "../../../test/harness.ts";
import { failure } from "./connection.ts";
import { type State, chatReady, getState as initialStore } from "../store/store.ts";

type Session = typeof import("./index.ts");
type Store = typeof import("../store/store.ts");

let b: Browser;
let session: Session;
let store: Store;
let disconnect: (() => void) | undefined;

const SERVER = "ws://127.0.0.1:1/?token=t";

beforeEach(async () => {
  b = installBrowser();
  vi.resetModules();
  disconnect = undefined;
});

afterEach(async () => {
  disconnect?.();
  b.server.accepting = false;
  for (const s of b.server.sockets) s.close();
  await tick();
  vi.unstubAllGlobals();
});

async function load(): Promise<void> {
  session = await import("./index.ts");
  store = await import("../store/store.ts");
}

function desktop(dataFolder: () => Promise<string>): void {
  vi.stubGlobal("gatesLocal", { getServerUrl: async () => SERVER, onState: () => () => undefined, dataFolder });
}

const hydrated = () => store.getState().imageStatus !== undefined && store.getState().conn.kind === "open";

async function boot(): Promise<void> {
  await load();
  disconnect = session.connect();
  await until(hydrated, 2000, "hydration");
  await tick();
}

async function reconnect(): Promise<void> {
  const before = b.server.calls("sync.negotiate").length;
  b.server.socket.close();
  await until(() => b.server.calls("sync.negotiate").length > before && hydrated(), 2000, "the next connection's hydration");
  await tick();
}

const refusedWith = (message: string) => failure("add the folder", new Error(message));

it("an action the server did not answer in time says Gates Local didn't answer in time, then what to do", () => {
  expect(failure("save the settings", new WireError("timeout", "settings.update timed out after 30000 ms"), "try again in a moment"))
    .toBe("Couldn't save the settings because Gates Local didn't answer in time; try again in a moment.");
});

it("an action this build's server cannot do says so, with nothing to try", () => {
  expect(failure("remove the model", new WireError("not-implemented", "models.remove is not implemented")))
    .toBe("Couldn't remove the model because this build can't do that yet.");
});

it("a path Gates Local may not read says it isn't allowed to read it", () => {
  for (const message of ["EACCES: permission denied, scandir '/root'", "EPERM: operation not permitted", "Permission denied"]) {
    expect(refusedWith(message), message).toBe("Couldn't add the folder because Gates Local isn't allowed to read it; try again.");
  }
});

it("a path of the wrong kind is named by the kind it has to be, a folder or a file", () => {
  expect(refusedWith("Source path must be a folder")).toBe("Couldn't add the folder because that path is not a folder; try again.");
  expect(refusedWith("Source path must be a file")).toBe("Couldn't add the folder because that path is not a file; try again.");
});

it("a path inside the app's own data folder is refused because it holds Gates Local's own data", () => {
  expect(refusedWith("Cannot connect the app's own data directory or a folder containing it"))
    .toBe("Couldn't add the folder because it holds Gates Local's own data; try again.");
});

it("a long refusal is cut to 120 characters in the sentence, and one of 120 stays whole", () => {
  const whole = "x".repeat(120);
  expect(refusedWith(`Error: ${whole}.`)).toBe(`Couldn't add the folder because Gates Local refused it (${whole}); try again.`);
  const long = "y".repeat(150);
  expect(refusedWith(long)).toBe(`Couldn't add the folder because Gates Local refused it (${"y".repeat(117)}…); try again.`);
});

it("chat cannot send while the server is not connected, even with Ollama ready", () => {
  const ready: State = { ...initialStore(), runtime: methodSamples["runtime.status"].result };
  expect(chatReady({ ...ready, conn: { kind: "open" } })).toBe(true);
  expect(chatReady({ ...ready, conn: { kind: "down", since: 0 } })).toBe(false);
  expect(chatReady({ ...ready, conn: { kind: "no-server" } })).toBe(false);
});

it("a typed name's estimate is the server's answer, and nothing when the server cannot say", async () => {
  await boot();
  const answer = methodSamples["models.estimate"].result;
  b.server.answer("models.estimate", () => answer);
  await expect(session.estimateModel("gemma4:26b", 16384)).resolves.toEqual(answer);
  b.server.answer("models.estimate", () => { throw { code: "not-implemented", message: "models.estimate is not implemented" }; });
  await expect(session.estimateModel("gemma4:26b", 16384)).resolves.toBeUndefined();
  b.server.answer("models.estimate", () => { throw { code: "internal", message: "registry unreachable" }; });
  await expect(session.estimateModel("gemma4:26b", 16384)).resolves.toBeUndefined();
});

it("the desktop app's data folder is read from its bridge once for the window, however often it reconnects", async () => {
  const read = vi.fn(async () => "/data/gates");
  desktop(read);
  await boot();
  await until(() => store.getState().dataFolder === "/data/gates", 2000, "the data folder");
  await reconnect();
  await reconnect();
  expect(read).toHaveBeenCalledTimes(1);
  expect(store.getState().dataFolder).toBe("/data/gates");
});

it("a data folder read the bridge failed is read again, and the folder still lands", async () => {
  const read = vi.fn<() => Promise<string>>().mockRejectedValueOnce(new Error("bridge not ready")).mockResolvedValue("/data/gates");
  desktop(read);
  await boot();
  await until(() => store.getState().dataFolder === "/data/gates", 2000, "the data folder");
  expect(read).toHaveBeenCalledTimes(2);
});

it("outside the desktop app there is no data folder", async () => {
  await boot();
  await until(() => store.getState().dataFolder !== undefined, 2000, "the data folder");
  expect(store.getState().dataFolder).toBeNull();
});

it("the desktop data folder shows even when the connection fails before it reads anything from the server", async () => {
  b.server.answer("sync.negotiate", () => { throw { code: "internal", message: "Negotiation refused" }; });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  desktop(async () => "/data/gates");
  await load();
  disconnect = session.connect();
  await until(() => store.getState().dataFolder === "/data/gates", 2000, "the data folder");
  expect(b.server.calls("settings.get")).toHaveLength(0);
  vi.restoreAllMocks();
});

it("when the server has no image status read, Settings › Tools says image making is not available in this build", async () => {
  b.server.answer("image.status", () => { throw { code: "not-implemented", message: "image.status is not implemented" }; });
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  await boot();
  expect(store.getState().imageStatus).toBe(store.NA);
  const { SettingsView } = await import("../../settings/Settings.tsx");
  store.setState({ view: "settings", section: "tools", sources: [], settings: { ...methodSamples["settings.get"].result, tools: true, imageGen: true } });
  const html = renderToStaticMarkup(createElement(SettingsView));
  const row = html.slice(html.search(/data-tool="images"/));
  expect(row).toContain("Not available in this build.");
});
