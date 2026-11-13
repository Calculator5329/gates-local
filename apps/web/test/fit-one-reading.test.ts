// The owner's picker, 2026-11-11: with the picker open, a new GPU reading
// arrives. Every value on screen must come from one reading: never one
// context row from the new reading beside another still showing the old one,
// and never an older table replacing a newer one.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { FitTable } from "@gates-local/contracts";
import type { State } from "../src/store.ts";
import { type Browser, installBrowser, tick, until } from "./harness.ts";

vi.mock("../src/store.ts", async (original) => {
  const actual = await original<typeof import("../src/store.ts")>();
  return { ...actual, useStore: <T>(selector: (s: State) => T) => selector(actual.getState()) };
});
vi.mock("../src/ui.tsx", async original => ({ ...await original<typeof import("../src/ui.tsx")>(), useMedia: () => false, isTouch: () => false }));

const GIB = 1024 ** 3;
const MODEL = "qwen3:14b";
const CONTEXTS = [8192, 16384, 32768, 65536] as const;
/** Reading 1 says 10.x GB for each context, reading 2 says 20.x GB: a shown number names its reading. */
const need = (reading: number, numCtx: number) => Math.round((reading * 10 + numCtx / 8192 / 10) * GIB);
const valuesOf = (reading: number) => CONTEXTS.map((c) => `${(need(reading, c) / GIB).toFixed(1)}`);
const tableOf = (reading: number, boot = "b1"): FitTable => ({
  reading: { boot, seq: reading, measuredAt: reading },
  memory: { kind: "gpu", freeBytes: 40 * GIB, usableBytes: 39 * GIB },
  rows: CONTEXTS.map((numCtx) => ({ model: MODEL, numCtx, freeVramBytes: 40 * GIB, needVramBytes: need(reading, numCtx), spillRamBytes: 0, verdict: "fits", source: "estimate", stops: [] })),
});

let b: Browser;
let session: typeof import("../src/session.ts");
let store: typeof import("../src/store.ts");
let Picker: typeof import("../src/Picker.tsx")["Picker"];
let disconnect: (() => void) | undefined;

beforeEach(async () => {
  b = installBrowser();
  vi.resetModules();
  b.server.answer("fit.table", () => tableOf(1));
  session = await import("../src/session.ts");
  store = await import("../src/store.ts");
  Picker = (await import("../src/Picker.tsx")).Picker;
  disconnect = session.connect();
  await until(() => store.getState().fitTable !== undefined, 2000, "the first table");
  await tick();
  store.setState({ model: MODEL, numCtx: 16384, pop: { id: "picker", kb: false, ready: true } });
});

afterEach(async () => {
  disconnect?.();
  b.server.accepting = false;
  for (const s of b.server.sockets) s.close();
  await tick(10);
  vi.unstubAllGlobals();
});

/** The GB numbers in the context rows, in order; an estimate carries a ~ in front. */
function contextValues(): string[] {
  const html = renderToStaticMarkup(createElement(Picker));
  return CONTEXTS.map((c) =>/<span>~?(\d+\.\d)\sGB<\/span>/.exec(html.split(`data-ctx="${c}"`)[1]?.split("</button>")[0] ?? "")?.[1] ?? "none");
}

it("after a newer reading has been shown, no context row still shows the older reading's number", async () => {
  expect(contextValues()).toEqual(valuesOf(1));

  b.server.push("fit.changed", tableOf(2));
  await until(() => store.getState().fitTable?.reading.seq === 2, 2000, "the newer table");
  expect(contextValues()).toEqual(valuesOf(2));

  // A table from before arrives late: it never replaces the newer one.
  b.server.push("fit.changed", tableOf(1));
  await tick(20);
  expect(contextValues()).toEqual(valuesOf(2));
});

// A lost connection withdraws the table: a restarted server on changed memory is another machine
// state, so every fit value waits on its placeholder until that server's own table is in.
const tableCalls = () => b.server.calls("fit.table").length;
/** A reconnect's hydrate chooses the model again from the fake server's list: keep the picker on this one. */
const onModel = () => store.setState({ model: MODEL, numCtx: 16384 });

it("a lost connection withdraws every fit value: the picker shows placeholders, not the last table", async () => {
  expect(contextValues()).toEqual(valuesOf(1));
  b.server.accepting = false;
  b.server.socket.close();
  await until(() => store.getState().conn.kind === "down", 2000, "the connection is down");
  expect(store.getState().fitTable).toBeUndefined();
  expect(contextValues()).toEqual(CONTEXTS.map(() => "none"));
  expect(renderToStaticMarkup(createElement(Picker))).toContain("fit-skel");
});

it("after a reconnect the fit values wait for the new server's table, and that table restores them", async () => {
  const next = b.server.hold("fit.table");
  const asked = tableCalls();
  b.server.socket.close();
  await until(() => tableCalls() > asked && store.getState().conn.kind === "open", 2000, "the reconnect asks for its table");
  await tick(20);
  onModel();
  expect(store.getState().fitTable).toBeUndefined();
  expect(contextValues()).toEqual(CONTEXTS.map(() => "none"));
  (await next).respond(tableOf(2, "b2"));
  await until(() => store.getState().fitTable?.reading.boot === "b2", 2000, "the new server's table");
  expect(contextValues()).toEqual(valuesOf(2));
});

it("a table from the old boot, answered as its connection closes, never restores the fit values", async () => {
  // A second connection whose table is still out when it drops: its answer (the old boot's) lands
  // in the same moment as the close, and the third connection's table is held.
  const second = b.server.hold("fit.table");
  b.server.socket.close();
  const late = await second;
  const third = b.server.hold("fit.table");
  const asked = tableCalls();
  late.respond(tableOf(5, "b1"));
  b.server.socket.close();
  await until(() => tableCalls() > asked && store.getState().conn.kind === "open", 2000, "the third connection asks for its table");
  await tick(20);
  onModel();
  expect(store.getState().fitTable).toBeUndefined();
  expect(contextValues()).toEqual(CONTEXTS.map(() => "none"));
  (await third).respond(tableOf(1, "b2"));
  await until(() => store.getState().fitTable?.reading.boot === "b2", 2000, "the third connection's table");
  expect(contextValues()).toEqual(valuesOf(1));
});

it("a restarted server's first table replaces the last one even with a lower seq", async () => {
  b.server.push("fit.changed", tableOf(3));
  await until(() => store.getState().fitTable?.reading.seq === 3, 2000, "seq 3");
  b.server.push("fit.changed", tableOf(2, "b2"));
  await until(() => store.getState().fitTable?.reading.boot === "b2", 2000, "the new boot's table");
  expect(contextValues()).toEqual(valuesOf(2));
});
