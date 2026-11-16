import type { Reply, ReplyChange } from "@gates-local/contracts";

export interface WindowRules {
  readonly windowOrdersByRev: boolean;
}
export const KEPT: WindowRules = { windowOrdersByRev: true };

const ENDED: ReadonlySet<Reply["stage"]> = new Set<Reply["stage"]>(["done", "stopped", "failed"]);
export const ended = (r: Reply): r is Extract<Reply, { readonly stage: "done" | "stopped" | "failed" }> => ENDED.has(r.stage);

export function createRecords(rules: WindowRules = KEPT) {
  // why: the server may have started again since, its count with it: the first word of each wins
  const stale = new Set<string>();
  // why: a change sent before a record left or ended cannot bring it back
  const leftAt = new Map<string, number>();
  return {
    connected(held: Iterable<string>): void {
      stale.clear();
      leftAt.clear();
      for (const id of held) stale.add(id);
    },
    takes(has: Reply | undefined, change: ReplyChange): boolean {
      const { id, rev } = change.kind === "is" ? change.reply : change;
      const first = stale.delete(id);
      if (rules.windowOrdersByRev && !first && rev <= Math.max(has?.rev ?? -1, leftAt.get(id) ?? -1)) return false;
      if (change.kind === "left" || ended(change.reply)) leftAt.set(id, rev);
      return true;
    },
    // why: the list has been taken: what it did not name the server no longer has
    unlisted(): readonly string[] {
      const ids = [...stale];
      stale.clear();
      return ids;
    },
  };
}
