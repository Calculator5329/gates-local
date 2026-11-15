// A rule of the update code, written as a test that proves itself: `rule`
// registers the test twice. Once as it is, where it must pass. Once with the
// guard the rule rests on switched off (break-for-test.ts), where it must
// fail, and with the words given. A rule's test that still passes with its
// guard gone holds nothing, and that second test says so.
import { expect, it } from "vitest";
import { type Break, breakForTest } from "./break-for-test.ts";

export interface Guard {
  /** The guard this rule rests on. */
  readonly without: Break;
  /** What the rule's test says once that guard is gone. */
  readonly fails: RegExp;
}

/** Set to 1 to print what each rule's test said with its guard off. Read by this file only. */
const SHOW = "GATES_LOCAL_SHOW_BROKEN_RULES";

export function rule(name: string, guard: Guard, body: () => Promise<void> | void): void {
  it(name, body);
  it(`${name} [and fails with ${guard.without}]`, async () => {
    let failure: unknown = null;
    breakForTest(guard.without);
    try {
      await body();
    } catch (e) {
      failure = e;
    } finally {
      breakForTest();
    }
    if (failure === null) throw new Error(`With "${guard.without}" switched off this test still passed, so it does not hold its rule.`);
    const said = failure instanceof Error ? failure.message : String(failure);
    if (process.env[SHOW] === "1") process.stdout.write(`BROKEN ${guard.without}\n  rule: ${name}\n  the test said: ${said.split("\n").join("\n    ")}\n`);
    expect(said).toMatch(guard.fails);
  });
}
