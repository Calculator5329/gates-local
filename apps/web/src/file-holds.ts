// Attached files a draft or a queued message still names (chat row 35). The server keeps an
// unsent copy for a day; this window starts that day again on each connect and every few
// hours, and gives a copy up as soon as its last chip here is removed.
import type { MethodName, Params, ResultOf } from "@gates-local/contracts";
import { getState } from "./store.ts";
import { draftFilePaths } from "./drafts.ts";

type Call = <M extends MethodName>(method: M, params: Params<M>) => Promise<ResultOf<M>>;

/** files.keep takes at most this many paths per call. */
const KEEP_BATCH = 512;
export const KEEP_EVERY_MS = 6 * 60 * 60 * 1000;

let call: Call | undefined;
/** session.ts hands over its call once; tests hand a fake. */
export function setFileCalls(next: Call | undefined): void { call = next; }

/** Every path a draft (or its words before a queued edit) or a queued message names. */
export function heldFilePaths(): Set<string> {
  const held = draftFilePaths();
  for (const q of getState().queued) for (const f of q.files ?? []) held.add(f.path);
  return held;
}

/** Chips removed: the copies nothing else here names go now, not after a day. */
export function releaseFiles(paths: readonly string[]): void {
  const held = heldFilePaths();
  const loose = [...new Set(paths)].filter(p => !held.has(p));
  if (call === undefined || loose.length === 0) return;
  for (let at = 0; at < loose.length; at += 64) void call("files.release", { paths: loose.slice(at, at + 64) }).catch(() => undefined);
}

/** On connect and every KEEP_EVERY_MS: the copies this window still names stay. */
export async function keepHeldFiles(): Promise<void> {
  const held = [...heldFilePaths()];
  if (call === undefined) return;
  for (let at = 0; at < held.length; at += KEEP_BATCH) await call("files.keep", { paths: held.slice(at, at + KEEP_BATCH) }).catch(() => undefined);
}
