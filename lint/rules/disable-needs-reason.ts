import type { Rule } from "./rule.ts";

const DISABLE = /^[\s*]*(?:oxlint|eslint)-disable(?:-next-line|-line)?(?![\w-])([\s\S]*)$/;
const REASON = /\s--\s+\S/;

const rule: Rule = {
  meta: {
    type: "suggestion",
    docs: { description: "Every switched-off lint rule says why." },
  },
  create(context) {
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          const rest = DISABLE.exec(comment.value)?.[1];
          if (rest === undefined || REASON.test(rest)) continue;
          context.report({
            loc: comment.loc,
            message: "Say why the rule is off here: end the directive with `-- <reason>`. "
              + "Without one, the next reader cannot tell a decision from a shortcut.",
          });
        }
      },
    };
  },
};

export default rule;
