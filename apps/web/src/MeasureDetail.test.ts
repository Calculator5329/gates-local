// Measure's detail: the line that says which parts the score leaves out shows exactly when it left
// them out, and a part whose checks were all skipped for one reason says that reason once.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { MeasureCheck, ModelMeasure } from "@gates-local/contracts";

vi.mock("./session.ts", () => ({ measureModel: () => undefined }));
const { MeasureChecks, MeasureNotes } = await import("./MeasureDetail.tsx");
const { SANDBOX_OFF_SKIP } = await import("./measure-pages.ts");

const tools: MeasureCheck = { id: "tools-read", kind: "tools", ok: true, needs: "Reads the file" };
const page = (id: string, extra: Partial<MeasureCheck>): MeasureCheck => ({ id, kind: "pages", ok: false, needs: id, ...extra });
const measure = (pages: MeasureCheck[], parts: ModelMeasure["parts"]): ModelMeasure => ({
  model: "m", digest: "d", at: 1, version: 2, numCtx: 4096, tokensPerSecond: 40, score: 100, parts, checks: [tools, ...pages],
});
const toolsOnly = [{ part: "tools" as const, passed: 1, total: 1, weight: 20 }];
const notes = (m: ModelMeasure) => renderToStaticMarkup(createElement(MeasureNotes, { m }));
const checks = (m: ModelMeasure) => renderToStaticMarkup(createElement(MeasureChecks, { m }));
const LEFT = "The score leaves Pages out.";

describe("the detail's notes on the score", () => {
  it("says the score leaves Pages out when every page was skipped", () => {
    const m = measure(["page-counter", "page-filter", "page-total"].map((id) => page(id, { state: "skipped", why: SANDBOX_OFF_SKIP })), toolsOnly);
    expect(notes(m)).toContain(LEFT);
  });

  it("says nothing of it when a page counted, and says they wait while they wait", () => {
    const counted = measure([page("page-counter", { ok: true }), page("page-total", { state: "skipped", why: SANDBOX_OFF_SKIP })], [...toolsOnly, { part: "pages", passed: 1, total: 1, weight: 20 }]);
    expect(notes(counted)).not.toContain("leaves");
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
});
