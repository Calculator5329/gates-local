import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { check, count, findings, readBaseline, REWRITE, rewrite, type Counts, type Finding } from "./ratchet.ts";

const RULES = ["gates/effect-needs-reason", "gates/no-wait-for-timeout"];
const EFFECT = "gates/effect-needs-reason";

const finding = (rule: string, file: string, line = 1): Finding => ({ rule, file, line, message: `what ${rule} asks for` });
const effects = (file: string, n: number) => Array.from({ length: n }, (_, at) => finding(EFFECT, file, at + 1));

const RECORDED: Counts = { [EFFECT]: { "apps/web/src/App.tsx": 2 }, "gates/no-wait-for-timeout": {} };
const TODAY = effects("apps/web/src/App.tsx", 2);

const baselineFile = () => path.join(mkdtempSync(path.join(os.tmpdir(), "lint-ratchet-")), "baseline.json");

describe("counting", () => {
  it("keeps a key for every rule, so a rule at zero is told apart from a rule never recorded", () => {
    expect(count(TODAY, RULES)).toEqual(RECORDED);
  });
});

describe("the gate", () => {
  it("passes when every count is the recorded one", () => {
    expect(check(RECORDED, TODAY, RULES)).toEqual({ ok: true, lines: ["Project rules: 2 rules, 2 recorded offenders left, none new."] });
  });

  it("fails when a file gains an offender, and names the file, the lines and the rule's own advice", () => {
    const result = check(RECORDED, effects("apps/web/src/App.tsx", 3), RULES);
    expect(result.ok).toBe(false);
    expect(result.lines.join("\n")).toContain("apps/web/src/App.tsx  3 now, 2 recorded  (lines 1, 2, 3)");
    expect(result.lines.join("\n")).toContain(`${EFFECT}: what ${EFFECT} asks for`);
  });

  it("fails when an offender shows up in a file with none recorded, and says how to re-record after a move", () => {
    const result = check(RECORDED, [...TODAY, finding("gates/no-wait-for-timeout", "test/e2e/new.spec.ts", 7)], RULES);
    expect(result.ok).toBe(false);
    expect(result.lines.join("\n")).toContain("test/e2e/new.spec.ts  1 now, 0 recorded  (lines 7)");
    expect(result.lines.join("\n")).toContain(`If these are old offenders in files that moved, run \`${REWRITE}\``);
  });

  it("puts each line's own advice under its file when the advice differs", () => {
    const imports = [
      { rule: EFFECT, file: "apps/web/src/a.ts", line: 3, message: "`../x.ts` leaves apps/web" },
      { rule: EFFECT, file: "apps/web/src/b.ts", line: 9, message: "`../y.ts` leaves apps/web" },
    ];
    expect(check({ [EFFECT]: {}, "gates/no-wait-for-timeout": {} }, imports, RULES).lines.slice(2)).toEqual([
      "",
      EFFECT,
      "  apps/web/src/a.ts  1 now, 0 recorded  (lines 3)",
      "    3: `../x.ts` leaves apps/web",
      "  apps/web/src/b.ts  1 now, 0 recorded  (lines 9)",
      "    9: `../y.ts` leaves apps/web",
    ]);
  });

  it("fails when a count fell, so a fixed offender cannot be put back unseen", () => {
    const result = check(RECORDED, effects("apps/web/src/App.tsx", 1), RULES);
    expect(result.ok).toBe(false);
    expect(result.lines[0]).toContain(`Run \`${REWRITE}\` to record the lower counts`);
    expect(result.lines[1]).toContain("apps/web/src/App.tsx  1 now, 2 recorded");
  });

  it("fails for a rule with nothing recorded, even one that fires nowhere", () => {
    const result = check({ [EFFECT]: RECORDED[EFFECT] ?? {} }, TODAY, RULES);
    expect(result).toEqual({
      ok: false,
      lines: [`Project rules: no recorded counts for gates/no-wait-for-timeout. Run \`${REWRITE}\` to record where each starts, and commit lint/baseline.json.`],
    });
  });
});

describe("re-recording", () => {
  it("follows offenders to the files they moved to, after which the gate passes", () => {
    const file = baselineFile();
    const moved = [...effects("apps/web/src/chat/Thread.tsx", 1), ...effects("apps/web/src/chat/Composer.tsx", 1)];
    expect(check(RECORDED, moved, RULES).ok).toBe(false);
    expect(rewrite(RECORDED, moved, RULES, file).ok).toBe(true);
    expect(readBaseline(file)).toEqual({
      [EFFECT]: { "apps/web/src/chat/Composer.tsx": 1, "apps/web/src/chat/Thread.tsx": 1 },
      "gates/no-wait-for-timeout": {},
    });
    expect(check(readBaseline(file), moved, RULES).ok).toBe(true);
  });

  it("records lower counts", () => {
    const file = baselineFile();
    expect(rewrite(RECORDED, effects("apps/web/src/App.tsx", 1), RULES, file).ok).toBe(true);
    expect(readBaseline(file)[EFFECT]).toEqual({ "apps/web/src/App.tsx": 1 });
  });

  it("refuses, and writes nothing, when a rule fires more often across the repo", () => {
    const file = baselineFile();
    const grown = [...effects("apps/web/src/chat/Thread.tsx", 2), ...effects("apps/web/src/chat/Composer.tsx", 1)];
    const result = rewrite(RECORDED, grown, RULES, file);
    expect(result.ok).toBe(false);
    expect(result.lines.join("\n")).toContain(`${EFFECT}: 3 now, 2 recorded`);
    expect(result.lines.join("\n")).toContain("apps/web/src/chat/Thread.tsx  2 now, 0 recorded");
    expect(existsSync(file)).toBe(false);
  });

  it("says what to do when the recorded file is left half-merged", () => {
    const file = baselineFile();
    writeFileSync(file, '<<<<<<< ours\n{ "counts": {} }\n=======\n{ "counts": {} }\n>>>>>>> theirs\n');
    expect(() => readBaseline(file)).toThrow(`take either side whole (\`git checkout --ours lint/baseline.json\`), then run \`${REWRITE}\``);
  });

  it("records where a new rule starts", () => {
    const file = baselineFile();
    const withWaits = [...TODAY, finding("gates/no-wait-for-timeout", "test/e2e/chat.spec.ts")];
    expect(rewrite({ [EFFECT]: RECORDED[EFFECT] ?? {} }, withWaits, RULES, file).ok).toBe(true);
    expect(readBaseline(file)["gates/no-wait-for-timeout"]).toEqual({ "test/e2e/chat.spec.ts": 1 });
  });
});

describe("linting", () => {
  it("is an error, not a pass, when oxlint found no files to lint", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "lint-empty-"));
    mkdirSync(path.join(root, "apps"));
    expect(() => findings(root, ["apps"])).toThrow(/no files/i);
  });
});
