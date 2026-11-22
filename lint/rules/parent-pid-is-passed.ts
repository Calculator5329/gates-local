import type { Rule } from "./rule.ts";

const PPID = /\bprocess\.ppid\b/g;
const COMPARED_AFTER = /^\s*[!=]==?/;
const COMPARED_BEFORE = /[!=]==?\s*$/;

/**
 * A child process learns its parent's pid from the parent, never from `process.ppid`. The child
 * programs here are written as strings, so the rule reads the file's text, strings included. The
 * one use left is comparing `process.ppid` against the pid the parent passed: a change means the
 * parent died and the child was handed to another process.
 */
const rule: Rule = {
  meta: { type: "problem", docs: { description: "A child is told its parent's pid; it never keeps process.ppid as that pid." } },
  create(context) {
    return {
      Program() {
        const text = context.sourceCode.text;
        for (const found of text.matchAll(PPID)) {
          const at = found.index;
          const end = at + found[0].length;
          if (COMPARED_AFTER.test(text.slice(end)) || COMPARED_BEFORE.test(text.slice(0, at))) continue;
          context.report({
            loc: { start: context.sourceCode.getLocFromIndex(at), end: context.sourceCode.getLocFromIndex(end) },
            message: "A child that keeps `process.ppid` as its parent's pid reads it after it starts, when the parent may "
              + "already be gone: it then holds the pid of whatever adopted it and never sees its parent die. Have the "
              + "parent pass its own pid when it spawns the child (`String(process.pid)` in the arguments), and compare "
              + "`process.ppid` against that.",
          });
        }
      },
    };
  },
};

export default rule;
