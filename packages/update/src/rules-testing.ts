import { expect, it } from "vitest";
import { type Break, breakForTest } from "./break-for-test.ts";

export interface Guard {
  readonly without: Break;
  readonly fails: RegExp;
}

const SHOW = "GATES_LOCAL_SHOW_BROKEN_RULES";

/**
 * Registers the rule's test twice: as it is, where it must pass, and with the
 * guard it rests on switched off, where it must fail with `guard.fails`.
 */
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
