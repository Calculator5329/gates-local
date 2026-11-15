import type { Params } from "@gates-local/contracts";

import type { Handlers } from "../ws/server.ts";
import { openUsageStore, type StoredReply, type UsageRead, type UsageStore } from "./store.ts";

export type { UsageRead, UsageRow } from "./store.ts";

export interface Usage {
  record: UsageStore["record"];
  readonly handlers: { readonly "usage.read": (params: Params<"usage.read">, ctx?: unknown) => UsageRead };
  close(): void;
}

export interface UsageDeps {
  file: string;
  push: (channel: "usage.changed", payload: Record<string, never>) => void;
  replies?: () => { replies: Iterable<StoredReply>; lacking: number };
  log?: (line: string) => void;
  now?: () => number;
}

const countedReplies = (n: number) => (n === 1 ? "1 counted reply has" : `${n} counted replies have`);

export function createUsage(deps: UsageDeps): Usage {
  const log = deps.log ?? (() => undefined);
  const store = openUsageStore(deps.file, { log, ...(deps.now ? { now: deps.now } : {}) });
  const replies = deps.replies;
  if (replies) {
    try {
      let lacking = 0;
      let filled = 0;
      let untimed = 0;
      const ran = store.fillOnce({
        *[Symbol.iterator]() {
          const stored = replies();
          lacking = stored.lacking;
          for (const reply of stored.replies) {
            filled++;
            if (reply.evalDurationMs === undefined) untimed++;
            yield reply;
          }
        },
      });
      if (ran) log(`usage: filled from ${filled} stored replies${lacking > 0 ? `; ${lacking} stored replies have no token counts and are not included` : ""}${untimed > 0 ? `; ${countedReplies(untimed)} no timings` : ""}`);
    } catch (err) {
      log(`usage: the fill from stored replies failed (${(err as Error).message}); it runs again next start`);
    }
  }
  const handlers = {
    "usage.read": ({ since }: Params<"usage.read">) => store.read(since),
  } satisfies Partial<Handlers>;
  return {
    record(model, figures, firstRequest) {
      try {
        store.record(model, figures, firstRequest);
      } catch (err) {
        log(`usage: could not record a request (${(err as Error).message})`);
        return;
      }
      deps.push("usage.changed", {});
    },
    handlers,
    close: () => store.close(),
  };
}
