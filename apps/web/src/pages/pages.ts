import { useEffect, useMemo, useSyncExternalStore } from "react";
import { type ThreadPage, pageBlocks, pageTitle } from "@gates-local/contracts";
import { runningTurn, turnOf, useStore } from "../lib/store/store.ts";
import { drawsPicture } from "../thread/turn.ts";

export interface PageReads {
  readonly pages: (threadId: string, before: string) => Promise<readonly ThreadPage[]>;
  readonly earlierOf: (threadId: string) => number;
  readonly onEarlier: (listener: () => void) => () => void;
}
let reads: PageReads = { pages: () => Promise.reject(new Error("not connected")), earlierOf: () => 0, onEarlier: () => () => undefined };
export function setPageReads(r: PageReads): void { reads = r; }
const onEarlier = (l: () => void) => reads.onEarlier(l);

export interface PageVersion {
  readonly n: number;
  readonly code: string;
  readonly title: string;
  readonly key: string;
}

export function versionsOf(texts: readonly string[], first: readonly string[] = []): PageVersion[] {
  const seen = new Set<string>();
  const out: PageVersion[] = [];
  const add = (code: string) => {
    if (seen.has(code)) return;
    seen.add(code);
    out.push({ n: out.length + 1, code, title: pageTitle(code), key: mark(code) });
  };
  for (const code of first) add(code);
  for (const text of texts) {
    for (const b of pageBlocks(text)) if (b.closed) add(b.code);
  }
  return out;
}

const older = new Map<string, { readonly before: string; readonly pages: readonly ThreadPage[] }>();
const asking = new Set<string>();
const olderListeners = new Set<() => void>();
const subscribeOlder = (l: () => void) => { olderListeners.add(l); return () => { olderListeners.delete(l); }; };

function askOlder(threadId: string, before: string): void {
  const key = `${threadId}\n${before}`;
  if (older.get(threadId)?.before === before || asking.has(key)) return;
  asking.add(key);
  void reads.pages(threadId, before)
    .catch((): readonly ThreadPage[] => older.get(threadId)?.pages ?? [])
    .then((pages) => {
      asking.delete(key);
      older.set(threadId, { before, pages });
      for (const l of olderListeners) l();
    });
}

export function usePages(threadId: string | null): { versions: PageVersion[]; writing: boolean; loaded: boolean } {
  const messages = useStore((s) => (threadId === null ? undefined : s.messages[threadId]));
  const live = useStore((s) => {
    const turn = turnOf(s, threadId);
    return turn === undefined || drawsPicture(turn) ? "" : turn.text;
  });
  const running = useStore((s) => runningTurn(s, threadId) !== undefined);
  const earlierNow = () => (threadId === null ? 0 : reads.earlierOf(threadId));
  const earlier = useSyncExternalStore(onEarlier, earlierNow, earlierNow);
  const olderNow = () => (threadId === null ? undefined : older.get(threadId));
  const before = useSyncExternalStore(subscribeOlder, olderNow, olderNow);
  const first = messages?.[0]?.id;
  // oxlint-disable-next-line gates/effect-needs-reason -- asks the server for the pages above the loaded messages once a commit shows there are some
  useEffect(() => {
    if (threadId !== null && first !== undefined && earlier > 0) askOlder(threadId, first);
  }, [threadId, first, earlier]);
  const versions = useMemo(() => {
    const here = new Set((messages ?? []).map((m) => m.id));
    const prior = earlier > 0 && before !== undefined ? before.pages.filter((p) => !here.has(p.messageId)).map((p) => p.code) : [];
    return versionsOf([...(messages ?? []).filter((m) => m.role === "assistant").map((m) => m.content), live], prior);
  }, [messages, live, earlier, before]);
  const writing = running && pageBlocks(live).at(-1)?.closed === false;
  return { versions, writing, loaded: messages !== undefined && (earlier === 0 || before !== undefined) };
}

interface View {
  readonly open: boolean;
  readonly shown: string;
  readonly newest: string;
}

const KEY = "gates-local.pages";
const LIMIT = 200;
let views: Readonly<Record<string, View>> = load();
const listeners = new Set<() => void>();

function load(): Record<string, View> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    if (raw === null || typeof raw !== "object") return {};
    const out: Record<string, View> = {};
    for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
      const o = v as { open?: unknown; shown?: unknown; newest?: unknown } | null;
      if (o === null || typeof o !== "object" || typeof o.open !== "boolean" || typeof o.newest !== "string") continue;
      out[id] = { open: o.open, shown: typeof o.shown === "string" ? o.shown : o.newest, newest: o.newest };
    }
    return out;
  } catch {
    return {};
  }
}

function save(threadId: string, view: View): void {
  const { [threadId]: _old, ...rest } = views;
  const ids = Object.keys(rest);
  const kept = ids.length >= LIMIT ? Object.fromEntries(ids.slice(ids.length - LIMIT + 1).map((id) => [id, rest[id]!])) : rest;
  views = { ...kept, [threadId]: view };
  try { localStorage.setItem(KEY, JSON.stringify(views)); } catch { /* external: a browser's private window may refuse storage; the choice holds until reload */ }
  for (const l of listeners) l();
}

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

function mark(code: string): string {
  let h = 5381;
  for (let i = 0; i < code.length; i++) h = ((h << 5) + h + code.charCodeAt(i)) | 0;
  return `${code.length}:${(h >>> 0).toString(36)}`;
}

export function useView(threadId: string | null): View | undefined {
  const snapshot = () => (threadId === null ? undefined : views[threadId]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export function follow(threadId: string, versions: readonly PageVersion[], opens = true): void {
  const newest = versions.at(-1);
  if (newest === undefined) return;
  const was = views[threadId];
  const key = newest.key;
  if (was === undefined) save(threadId, { open: opens, shown: key, newest: key });
  else if (was.newest !== key) save(threadId, { ...was, shown: key, newest: key });
}

export function showVersion(threadId: string, n: number, versions: readonly PageVersion[]): void {
  const newest = versions.at(-1);
  const on = versions[n - 1] ?? newest;
  save(threadId, { open: true, shown: on?.key ?? "", newest: newest?.key ?? "" });
}

export function closePanel(threadId: string): void {
  const was = views[threadId];
  if (was !== undefined) save(threadId, { ...was, open: false });
}

export function shownOf(view: View | undefined, versions: readonly PageVersion[]): PageVersion | undefined {
  return versions.find((v) => v.key === view?.shown) ?? versions.at(-1);
}
