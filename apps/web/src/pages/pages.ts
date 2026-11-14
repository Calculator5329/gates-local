// The pages of the chat on screen and how its panel is left. A version is
// each distinct page a reply wrote, oldest first, saved replies then the one
// being written; the same code again is the same version. Which version is on
// show and whether the panel is open are kept per chat in this browser, so
// they survive a reload.
import { useMemo, useSyncExternalStore } from "react";
import { pageBlocks, pageTitle } from "@gates-local/contracts";
import { runningTurn, turnOf, useStore } from "../store.ts";

export interface PageVersion {
  readonly n: number;
  readonly code: string;
  readonly title: string;
}

/** Every page in these texts, in order, each code once. */
export function versionsOf(texts: readonly string[]): PageVersion[] {
  const seen = new Set<string>();
  const out: PageVersion[] = [];
  for (const text of texts) {
    for (const b of pageBlocks(text)) {
      if (!b.closed || seen.has(b.code)) continue;
      seen.add(b.code);
      out.push({ n: out.length + 1, code: b.code, title: pageTitle(b.code) });
    }
  }
  return out;
}

/** The versions of a chat's pages, and whether one is being written now. */
export function usePages(threadId: string | null): { versions: PageVersion[]; writing: boolean; loaded: boolean } {
  const messages = useStore((s) => (threadId === null ? undefined : s.messages[threadId]));
  const live = useStore((s) => {
    const turn = turnOf(s, threadId);
    return turn === undefined || turn.image === true ? "" : turn.text;
  });
  const running = useStore((s) => runningTurn(s, threadId) !== undefined);
  const versions = useMemo(
    () => versionsOf([...(messages ?? []).filter((m) => m.role === "assistant").map((m) => m.content), live]),
    [messages, live],
  );
  const writing = running && pageBlocks(live).at(-1)?.closed === false;
  return { versions, writing, loaded: messages !== undefined };
}

// ---------------------------------------------------------------- panel state

interface View {
  readonly open: boolean;
  /** The version on show, 1-based. */
  readonly shown: number;
  /** The newest version this browser has seen, so a new one comes to the front once. */
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
      const o = v as Partial<View> | null;
      if (o !== null && typeof o === "object" && typeof o.open === "boolean" && typeof o.shown === "number" && typeof o.newest === "string") out[id] = { open: o.open, shown: o.shown, newest: o.newest };
    }
    return out;
  } catch {
    return {};
  }
}

function save(threadId: string, view: View): void {
  const { [threadId]: _old, ...rest } = views;
  // newest last; the oldest chats drop off past the limit
  const ids = Object.keys(rest);
  const kept = ids.length >= LIMIT ? Object.fromEntries(ids.slice(ids.length - LIMIT + 1).map((id) => [id, rest[id]!])) : rest;
  views = { ...kept, [threadId]: view };
  try { localStorage.setItem(KEY, JSON.stringify(views)); } catch { /* the choice holds for this session */ }
  for (const l of listeners) l();
}

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

/** A short fingerprint of a page's code. */
function mark(code: string): string {
  let h = 5381;
  for (let i = 0; i < code.length; i++) h = ((h << 5) + h + code.charCodeAt(i)) | 0;
  return `${code.length}:${(h >>> 0).toString(36)}`;
}

export function useView(threadId: string | null): View | undefined {
  const snapshot = () => (threadId === null ? undefined : views[threadId]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/**
 * Bring a chat's panel up to date with its pages: the first page opens it,
 * and a new version comes on show (the panel stays as the person left it).
 */
export function follow(threadId: string, versions: readonly PageVersion[]): void {
  const newest = versions.at(-1);
  if (newest === undefined) return;
  const was = views[threadId];
  const key = mark(newest.code);
  if (was === undefined) save(threadId, { open: true, shown: newest.n, newest: key });
  else if (was.newest !== key) save(threadId, { ...was, shown: newest.n, newest: key });
}

export function showVersion(threadId: string, n: number, versions: readonly PageVersion[]): void {
  const newest = versions.at(-1);
  save(threadId, { open: true, shown: n, newest: newest === undefined ? "" : mark(newest.code) });
}

export function closePanel(threadId: string): void {
  const was = views[threadId];
  if (was !== undefined) save(threadId, { ...was, open: false });
}

/** The version on show: the saved one while it still exists, else the newest. */
export function shownOf(view: View | undefined, versions: readonly PageVersion[]): PageVersion | undefined {
  if (versions.length === 0) return undefined;
  return versions[Math.min(Math.max(view?.shown ?? versions.length, 1), versions.length) - 1];
}
