// The update status at the client boundary: a read answered with number n that lands after a
// newer status (a push, or an action's answer) must not undo it. The window keeps no ticket of its
// own for this; the numbers decide.
import { afterEach, expect, it, vi } from "vitest";
import type { UpdateStatus } from "@gates-local/contracts";
import { methodSamples } from "@gates-local/contracts/testing";
import { installBrowser } from "../../../test/harness.ts";
import { numberServer } from "../../../test/numbered-server.ts";
import { drain } from "../../../test/ordering-world.ts";

const older: UpdateStatus = methodSamples["update.status"].result;
const checked = methodSamples["update.check"].result;
const pushed: UpdateStatus = { ...older, lastCheck: { state: "up-to-date", checkedAt: 1_762_500_009_000, channel: "release", current: "v0.1.0" } };

async function boot() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  const browser = installBrowser();
  const server = numberServer(browser.server, { serves: ["settings", "sources", "updates"], commits: ["update.check", "update.download", "update.dismissResult"] });
  vi.resetModules();
  const session = await import("./index.ts");
  const store = await import("../store/store.ts");
  const shown = () => { const update = store.getState().update; return update === undefined || update === "na" ? undefined : update; };
  return { browser, server, session, store, shown };
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("a slow status read never undoes the answer of a check made while it was out", async () => {
  const { browser, session, shown } = await boot();
  const reading = browser.server.hold("update.status");
  const close = session.connect();
  const slow = await reading;
  expect(await session.checkForUpdates()).toBeNull();
  await drain();
  expect(shown()?.lastCheck).toEqual(checked.lastCheck);
  slow.respond(older);
  await drain();
  expect(shown()?.lastCheck, "the check's status stays").toEqual(checked.lastCheck);
  close();
});

it("a slow status read never undoes a newer update.changed", async () => {
  const { browser, server, session, shown } = await boot();
  const reading = browser.server.hold("update.status");
  const close = session.connect();
  const slow = await reading;
  server.push("update.changed", pushed);
  await drain();
  slow.respond(older);
  await drain();
  expect(shown()?.lastCheck).toEqual(pushed.lastCheck);
  close();
});

it("the status an update ask reads again never undoes a push that overtook it", async () => {
  const { browser, server, session, store, shown } = await boot();
  const close = session.connect();
  for (let turn = 0; turn < 20 && store.getState().update === undefined; turn++) await drain();
  expect(store.getState().update).toEqual(older);
  const reading = browser.server.hold("update.status");
  const asked = session.readUpdateStatus();
  const slow = await reading;
  server.push("update.changed", pushed);
  await drain();
  slow.respond(older);
  expect(await asked).toBeNull();
  await drain();
  expect(shown()?.lastCheck).toEqual(pushed.lastCheck);
  close();
});
