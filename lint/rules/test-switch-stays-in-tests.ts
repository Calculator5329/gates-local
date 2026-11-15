import { repoPath, type Rule } from "./rule.ts";

/** The option a factory reads to leave one of its guards out, so a test can watch its rule break. */
export const SWITCH = "faultForTest";
/** The one file that is not a test and may set it: the world the GPU rules run in. */
export const HARNESS = "apps/server/src/gpu/rules-harness.ts";

const RULE = "gates/test-switch-stays-in-tests";
const DIRECTIVE = /^[\s*]*(?:oxlint|eslint)-disable(?:-next-line|-line)?(?![\w-])/;
const MESSAGE = `\`${SWITCH}\` leaves a guard out so a test can watch its rule break. Only a test file or ${HARNESS} sets it: `
  + "product code that set it would ship with the guard off.";

const rule: Rule = {
  meta: { type: "problem", docs: { description: "A guard's test-only switch is set by tests, never by the product." } },
  create(context) {
    const file = repoPath(context);
    if (/\.test\.tsx?$/.test(file) || file === HARNESS) return {};
    return {
      // `{ faultForTest: … }` and `{ faultForTest }`: the two ways an options object carries it
      ObjectExpression(node) {
        for (const property of node.properties) {
          if (property.type !== "Property" || property.computed) continue;
          const { key } = property;
          const name = key.type === "Identifier" ? key.name : key.type === "Literal" ? key.value : undefined;
          if (name === SWITCH) context.report({ node: property, message: MESSAGE });
        }
      },
      // `options.faultForTest = …`
      AssignmentExpression(node) {
        const { left } = node;
        if (left.type !== "MemberExpression" || left.computed || left.property.type !== "Identifier") return;
        if (left.property.name === SWITCH) context.report({ node, message: MESSAGE });
      },
      // switching the rule off by hand would put the switch within reach of any file
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          const head = comment.value.split(/\s--\s/)[0] ?? "";
          if (!DIRECTIVE.test(head) || !head.includes(RULE)) continue;
          context.report({ loc: comment.loc, message: "This rule is not switched off by hand. A test sets the switch; the product never does." });
        }
      },
    };
  },
};

export default rule;
