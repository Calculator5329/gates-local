import { called, type AstNode, type Rule } from "./rule.ts";

const POLLS = new Set(["waitFor", "poll", "until"]);

/** A test waits for a turn's own end, never for the running-turn count: in a poll's callback or a loop's test. */
export default {
  meta: { type: "problem", docs: { description: "A test awaits the turn's end; it never polls the running-turn count." } },
  create(context) {
    return {
      CallExpression(node) {
        if (called(node.callee)?.name !== "activeTurns") return;
        for (let child: AstNode = node, at: AstNode | null = node.parent; at !== null; child = at, at = at.parent) {
          const poll = at.type === "CallExpression" && POLLS.has(called(at.callee)?.name ?? "");
          const loop = (at.type === "WhileStatement" || at.type === "DoWhileStatement" || at.type === "ForStatement") && at.test === child;
          if (poll || loop) return context.report({ node, message: "Await the turn's `ended` from sendStarted, sendTaken or app.started; a one-second poll fails on a busy machine." });
        }
      },
    };
  },
} satisfies Rule;
