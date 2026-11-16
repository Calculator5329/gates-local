import { afterEach, expect, it, vi } from "vitest";
import type { AttachedFile } from "@gates-local/contracts";
import { installBrowser } from "../../../test/harness.ts";
import { drain } from "../../../test/ordering-world.ts";

const HOUR = 60 * 60 * 1000;
const held: AttachedFile = { path: "files/att-0f8b5c1e-3a2d-4c7e-9b1a-2d3e4f5a6b7c", name: "notes.txt", size: 5, type: "text/plain" };

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("the window tells the server which copies its drafts still hold when it connects, and again every few hours, so a day-old cleanup spares them", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  const browser = installBrowser();
  vi.resetModules();
  const drafts = await import("../store/drafts.ts");
  const session = await import("./index.ts");
  drafts.replaceDraft("t1", { text: "see the file", files: [held] });
  const keeps = () => browser.server.calls("files.keep").map((c) => c.params);
  const close = session.connect();
  for (let turn = 0; turn < 40 && keeps().length === 0; turn++) await vi.advanceTimersByTimeAsync(0);
  expect(keeps()).toEqual([{ paths: [held.path] }]);
  await vi.advanceTimersByTimeAsync(HOUR);
  await drain();
  expect(keeps(), "not again within the hour").toHaveLength(1);
  await vi.advanceTimersByTimeAsync(5 * HOUR);
  await drain();
  expect(keeps(), "again within six hours, well inside the day").toEqual([{ paths: [held.path] }, { paths: [held.path] }]);
  close();
});
