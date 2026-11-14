// Measure's pages in this window: a page the window or the server could not run is skipped with
// why, not failed, since that is not the model's doing; a page too big to run is the model's.
import { afterEach, describe, expect, it, vi } from "vitest";
import { SANDBOX_OFF_SKIP, SANDBOX_UNKNOWN_SKIP, SERVER_REFUSED_SKIP, runPage, runPages } from "./measure-pages.ts";

const SERVER = "http://127.0.0.1:1";
const page = "<!doctype html><html><body><p id=out>1</p></body></html>";
const script = [{ do: "read" as const, target: "#out" }];
const checks = [{ id: "page-total", state: "pending", page, script }, { id: "page-counter", state: "pending", page, script }];
const answer = (r: () => Promise<Response>) => vi.stubGlobal("fetch", vi.fn(r));

afterEach(() => vi.unstubAllGlobals());

describe("Measure's pages in this window", () => {
  it("a page the server did not take is skipped with why; one too big to run fails", async () => {
    answer(async () => new Response("", { status: 401 }));
    expect(await runPage("page-total", page, script, 100, { origin: SERVER, token: "t" })).toEqual({ id: "page-total", seen: [], skipped: SERVER_REFUSED_SKIP });
    answer(() => Promise.reject(new TypeError("Failed to fetch")));
    expect(await runPage("page-total", page, script, 100, { origin: SERVER, token: "t" })).toEqual({ id: "page-total", seen: [], skipped: SERVER_REFUSED_SKIP });
    answer(async () => new Response("", { status: 413 }));
    expect(await runPage("page-total", page, script, 100, { origin: SERVER, token: "t" })).toMatchObject({ error: expect.stringMatching(/^The page is too big to run here/) });
  });

  it("with the sandbox off every page goes back skipped, saying why", async () => {
    expect(await runPages(checks, () => Promise.resolve(true))).toEqual(checks.map((c) => ({ id: c.id, seen: [], skipped: SANDBOX_OFF_SKIP })));
  });

  it("a sandbox answer that never comes does not hold the pages for ever: they go back skipped", async () => {
    const seen = await runPages(checks, () => new Promise<boolean>(() => undefined), 20);
    expect(seen).toEqual(checks.map((c) => ({ id: c.id, seen: [], skipped: SANDBOX_UNKNOWN_SKIP })));
  });
});
