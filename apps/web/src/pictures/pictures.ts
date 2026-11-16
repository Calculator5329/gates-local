import type { Picture, PictureList, PictureListParams } from "@gates-local/contracts";
import { debounce, withTimeout } from "../lib/ui/kit/async.ts";

export interface PicturesView {
  readonly pictures: readonly Picture[];
  readonly count: number;
  readonly next: string | undefined;
  readonly q: string;
  readonly status: "loading" | "ready" | "error";
  readonly sel: readonly string[];
  readonly large: boolean;
}

const FIRST = 200;
const MORE = 200;
const NEWEST = 24;
const OPEN_BOUND_MS = 1000;
const SEARCH_WAIT_MS = 150;

const words = (q: string) => (q.trim() === "" ? {} : { q: q.trim() });

export function createPictures({ list }: { list: (params: PictureListParams) => Promise<PictureList> }) {
  let view: PicturesView = { pictures: [], count: 0, next: undefined, q: "", status: "loading", sel: [], large: false };
  const listeners = new Set<() => void>();
  let ticket = 0;
  let paging = false;
  let shown = false;
  const searchLater = debounce((q: string) => void firstPage(q), SEARCH_WAIT_MS);

  function set(patch: Partial<PicturesView>): void {
    view = { ...view, ...patch };
    for (const listener of listeners) listener();
  }

  async function firstPage(q: string): Promise<void> {
    const mine = ++ticket;
    try {
      const page = await list({ limit: FIRST, ...words(q) });
      if (mine !== ticket) return;
      const ids = new Set(page.pictures.map((p) => p.jobId));
      const kept = view.sel.filter((id) => ids.has(id));
      const newest = page.pictures[0];
      set({ pictures: page.pictures, count: page.count, next: page.next, status: "ready", sel: kept.length > 0 ? kept : newest ? [newest.jobId] : [], large: view.large && kept.length > 0 });
    } catch {
      if (mine === ticket) set({ status: "error" });
    }
  }

  return {
    get: () => view,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },

    enter(): Promise<void> {
      searchLater.cancel();
      set({ q: "", large: false, ...(view.status === "error" ? { status: "loading" as const } : {}) });
      return withTimeout(firstPage(""), OPEN_BOUND_MS, () => undefined);
    },

    shown(on: boolean): void {
      shown = on;
      if (!on) { searchLater.cancel(); if (view.large) set({ large: false }); }
    },

    search(q: string): void {
      set({ q });
      searchLater(q);
    },

    async more(): Promise<void> {
      const before = view.next;
      if (before === undefined || paging) return;
      paging = true;
      const mine = ticket;
      try {
        const page = await list({ limit: MORE, before, ...words(view.q) });
        if (mine !== ticket) return;
        const have = new Set(view.pictures.map((p) => p.jobId));
        set({ pictures: [...view.pictures, ...page.pictures.filter((p) => !have.has(p.jobId))], count: page.count, next: page.next });
      } catch {} finally {
        paging = false;
      }
    },

    async finished(): Promise<void> {
      if (!shown || view.status !== "ready") return;
      const mine = ticket;
      try {
        const page = await list({ limit: NEWEST, ...words(view.q) });
        if (mine !== ticket) return;
        const have = new Set(view.pictures.map((p) => p.jobId));
        const fresh = page.pictures.filter((p) => !have.has(p.jobId));
        if (fresh.length > 0) set({ pictures: [...fresh, ...view.pictures], count: page.count });
      } catch {}
    },

    select(sel: readonly string[]): void {
      set({ sel, ...(sel.length === 1 ? {} : { large: false }) });
    },

    setLarge(large: boolean): void {
      if (large !== view.large && (!large || view.sel.length === 1)) set({ large });
    },
  };
}

export type PicturesSession = ReturnType<typeof createPictures>;
