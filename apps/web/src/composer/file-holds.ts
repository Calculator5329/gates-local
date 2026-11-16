import type { MethodName, Params, ResultOf } from "@gates-local/contracts";
import { getState } from "../lib/store/store.ts";
import { draftFilePaths } from "../lib/store/drafts.ts";

type Call = <M extends MethodName>(method: M, params: Params<M>) => Promise<ResultOf<M>>;

const KEEP_BATCH = 512;
export const KEEP_EVERY_MS = 6 * 60 * 60 * 1000;

let call: Call | undefined;
export function setFileCalls(next: Call | undefined): void { call = next; }

export function heldFilePaths(): Set<string> {
  const held = draftFilePaths();
  for (const r of getState().replies.values()) if ("files" in r) for (const f of r.files ?? []) held.add(f.path);
  return held;
}

export function releaseFiles(paths: readonly string[]): void {
  const held = heldFilePaths();
  const loose = [...new Set(paths)].filter(p => !held.has(p));
  if (call === undefined || loose.length === 0) return;
  for (let at = 0; at < loose.length; at += 64) void call("files.release", { paths: loose.slice(at, at + 64) }).catch(() => undefined);
}

export async function keepHeldFiles(): Promise<void> {
  const held = [...heldFilePaths()];
  if (call === undefined) return;
  for (let at = 0; at < held.length; at += KEEP_BATCH) await call("files.keep", { paths: held.slice(at, at + KEEP_BATCH) }).catch(() => undefined);
}
