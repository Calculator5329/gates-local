import { callRule, repoPath, type Rule } from "./rule.ts";

/** The one file that may wait on the clock: its `holds` checks a claim through the whole span. */
export const CLOCK_HELPER = "test/e2e/waits.ts";

const RULE = "gates/no-wait-for-timeout";
const DIRECTIVE = /^[\s*]*(?:oxlint|eslint)-disable(?:-next-line|-line)?(?![\w-])/;

const waits = callRule(
  "A browser test waits for a condition, never for a time.",
  call => call.name === "waitForTimeout" && call.on !== undefined,
  "A fixed wait passes on a fast machine and fails on a slow one. Wait for the thing itself: "
    + "a locator (`await expect(locator).toBeVisible()`), a value (`expect.poll`), a response "
    + "(`page.waitForResponse`), or `painted` / `settled` from `test/e2e/waits.ts` before reading a box. "
    + "If the claim is that nothing happens for a while, use `holds` from that file: it checks the claim "
    + "through the whole span, not only at its end.",
);

const rule: Rule = {
  meta: waits.meta,
  create(context) {
    if (repoPath(context) === CLOCK_HELPER) return {};
    const visitor = waits.create?.(context) ?? {};
    return {
      ...visitor,
      // switching the rule off by hand would let the clock back in anywhere: only the helper may use it
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          const head = comment.value.split(/\s--\s/)[0] ?? "";
          if (!DIRECTIVE.test(head) || !head.includes(RULE)) continue;
          context.report({
            loc: comment.loc,
            message: `This rule is not switched off by hand. A claim that nothing happens for a while goes through \`holds\` in ${CLOCK_HELPER}.`,
          });
        }
      },
    };
  },
};

export default rule;
