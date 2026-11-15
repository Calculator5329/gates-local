// Measure's detail: the line that says which parts the score leaves out shows exactly when it left
// them out, and a part whose checks were all skipped for one reason says that reason once.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MEASURE_VERSION, type MeasureCheck, type ModelMeasure } from "@gates-local/contracts";

vi.mock("../lib/session/index.ts", () => ({ measureModel: () => undefined }));
const { MeasureChecks, MeasureNotes, isEarlier, samplingText, shortWords } = await import("./MeasureDetail.tsx");
const { ScoreMarks } = await import("./ModelMeasure.tsx");
const marks = (m: ModelMeasure) => renderToStaticMarkup(createElement(ScoreMarks, { m }));
const { SANDBOX_OFF_SKIP } = await import("./measure-pages.ts");

const tools: MeasureCheck = { id: "tools-read", kind: "tools", ok: true, needs: "Reads the file" };
const page = (id: string, extra: Partial<MeasureCheck>): MeasureCheck => ({ id, kind: "pages", ok: false, needs: id, ...extra });
const measure = (pages: MeasureCheck[], parts: ModelMeasure["parts"]): ModelMeasure => ({
  model: "m", digest: "d", at: 1, version: MEASURE_VERSION, numCtx: 4096, tokensPerSecond: 40, score: 100, parts, checks: [tools, ...pages],
});
const db = (id: string, extra: Partial<MeasureCheck> = {}): MeasureCheck => ({ id, kind: "database", ok: true, needs: id, ...extra });
const tool = (id: string, extra: Partial<MeasureCheck> = {}): MeasureCheck => ({ id, kind: "tools", ok: true, needs: id, ...extra });
const toolsOnly = [{ part: "tools" as const, passed: 1, total: 1, weight: 20 }];
const notes = (m: ModelMeasure) => renderToStaticMarkup(createElement(MeasureNotes, { m }));
const checks = (m: ModelMeasure) => renderToStaticMarkup(createElement(MeasureChecks, { m }));
const LEFT = "The score leaves Pages out.";

describe("the detail's notes on the score", () => {
  it("says the score leaves Pages out when every page was skipped", () => {
    const m = measure(["page-counter", "page-filter", "page-total"].map((id) => page(id, { state: "skipped", why: SANDBOX_OFF_SKIP })), toolsOnly);
    expect(notes(m)).toContain(LEFT);
  });

  it("names a part it counts over fewer checks than it has, and says they wait while they wait", () => {
    const counted = measure([page("page-counter", { ok: true }), page("page-total", { state: "skipped", why: SANDBOX_OFF_SKIP })], [...toolsOnly, { part: "pages", passed: 1, total: 1, weight: 20 }]);
    expect(notes(counted)).not.toContain("leaves");
    expect(notes(counted)).toContain("The score counts Pages over 1 of its 2 checks.");
    const waiting = measure([page("page-counter", { state: "pending" })], toolsOnly);
    expect(notes(waiting)).not.toContain(LEFT);
    expect(notes(waiting)).toContain("the score leaves Pages out until then");
    expect(notes(measure([], toolsOnly))).toBe("");
  });

  it("gives the reason pages were not run once, not under each page", () => {
    const m = measure(["page-counter", "page-filter", "page-total"].map((id) => page(id, { state: "skipped", why: SANDBOX_OFF_SKIP })), toolsOnly);
    expect(checks(m).split("Chromium&#x27;s sandbox is off in this copy")).toHaveLength(2);
    // a failed page still says its own reason
    const failed = measure([page("page-counter", { why: "It did not count." }), page("page-total", { why: "It did not add." })], toolsOnly);
    expect(checks(failed)).toContain("It did not count.");
    expect(checks(failed)).toContain("It did not add.");
  });

  it("gives a reason checks of several parts were skipped for once, above the parts", () => {
    const why = "This model's 2k context is too small for its tools, so it answered without tools.";
    const skip = (id: string, kind: MeasureCheck["kind"]): MeasureCheck => ({ id, kind, ok: false, needs: id, state: "skipped", why });
    const m = measure([skip("tools-chain", "tools"), skip("files-sum", "files"), skip("files-needle", "files"), skip("db-count", "database"), { id: "instr-caps", kind: "instructions", ok: true }], toolsOnly);
    const all = notes(m) + checks(m);
    expect(all.split("too small for its tools")).toHaveLength(2);
    expect(notes(m)).toContain("Skipped: This model&#x27;s 2k context is too small");
    // a reason one check alone has stays on it
    const one = measure([page("page-counter", { state: "skipped", why: "The page could not load." }), page("page-total", { ok: true })], toolsOnly);
    expect(checks(one)).toContain("The page could not load.");
    expect(notes(one)).not.toContain("could not load");
  });
});

describe("how a measure sampled", () => {
  it("says it in one line: Measure's own, or the chat's for one an earlier build made", () => {
    expect(samplingText({ ...measure([], toolsOnly), sampling: { temperature: 0, seed: 7 } })).toBe("Temperature 0, seed 7, model defaults");
    expect(samplingText(measure([], toolsOnly))).toBe("Your chat's sampling settings");
  });
});

describe("two scores side by side", () => {
  const full = measure([page("page-counter", { ok: true })], toolsOnly);
  const skip = { state: "skipped" as const, why: "Run commands is off on this machine, so the database can't be read." };
  const short: ModelMeasure = { ...full, think: true, checks: [tool("a"), tool("b"), tool("c", { state: "skipped", why: "No room." }), db("d", skip), db("e", skip), page("page-counter", { ok: true })] };

  it("marks the one that left checks out and names what in a few words; nothing beside a full one", () => {
    expect(shortWords(full)).toBeUndefined();
    expect(shortWords(short)).toBe("Without Database · Tools 2 of 3");
    expect(marks(full)).toBe("");
    expect(marks(short)).toContain('data-tip="Without Database · Tools 2 of 3"');
    // no sentence on the row: an icon whose tooltip says it. data-tip, not data-tipt: a data-tipt
    // shows only over a label the row cut, and an icon has none, so its tip would never open
    expect(marks(short).replace(/<[^>]+>/g, "")).toBe("");
    expect(marks(short)).not.toContain("data-tipt");
  });

  it("marks one made with Thinking on, and the detail names every part shorter than its full set", () => {
    expect(marks(short)).toContain('data-tip="Thinking on"');
    expect(marks({ ...full, think: false })).toBe("");
    expect(notes(short)).toContain("The score leaves Database out, and counts Tools over 2 of its 3 checks.");
  });

  it("marks a score the earlier checks made, which is out of 100 too but not made alike; never one made now", () => {
    const earlier: ModelMeasure = { ...full, version: 2 };
    expect([isEarlier(full), isEarlier(earlier), isEarlier({ ...full, version: undefined })]).toEqual([false, true, false]);
    expect(marks(earlier)).toContain('data-tip="Earlier checks"');
    expect(marks(earlier).replace(/<[^>]+>/g, "")).toBe("");
    expect(marks(full)).not.toContain("Earlier");
    // its other marks stay beside it
    expect(marks({ ...short, version: 2 })).toContain('data-tip="Without Database · Tools 2 of 3"');
  });
});
