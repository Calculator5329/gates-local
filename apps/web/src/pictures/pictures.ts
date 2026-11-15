// The Pictures screen's list: pages of pictures.list newest first, a prompt search, the
// selection, and a picture that finishes while the screen is open. Its own small store,
// so the chat's store never holds thousands of pictures.
import type { Picture, PictureList, PictureListParams } from "@gates-local/contracts";

export interface PicturesView {
  readonly pictures: readonly Picture[];
  /** Every picture the search matches, not only the pages in hand. */
  readonly count: number;
  readonly next: string | undefined;
  readonly q: string;
  /** "loading" until the first answer since the screen opened; "error" when that failed. */
  readonly status: "loading" | "ready" | "error";
  /** Selected job ids, in the order picked. */
  readonly sel: readonly string[];
  /** Enter's large view of the selected picture. */
  readonly large: boolean;
}

const FIRST = 200;
const MORE = 200;
/** A finished picture is looked for among this many newest. */
const NEWEST = 24;
/** A slow server does not hold the screen shut longer than this; the tiles land when it answers. */
const OPEN_BOUND_MS = 1000;
const SEARCH_WAIT_MS = 150;

const words = (q: string) => (q.trim() === "" ? {} : { q: q.trim() });

export function createPictures({ list }: { list: (params: PictureListParams) => Promise<PictureList> }) {
  let view: PicturesView = { pictures: [], count: 0, next: undefined, q: "", status: "loading", sel: [], large: false };
  const listeners = new Set<() => void>();
  /** Bumped by each new first page: an older answer is dropped. */
  let ticket = 0;
  let paging = false;
  let shown = false;
  let searchTimer: ReturnType<typeof setTimeout> | undefined;

  function set(patch: Partial<PicturesView>): void {
    view = { ...view, ...patch };
    for (const listener of listeners) listener();
  }

  /** The first page for a search, replacing the list. The selection keeps what is still listed, else the newest. */
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

    /** Opening the screen: a fresh first page, the search cleared. Resolves when it is in, or at the bound. */
    enter(): Promise<void> {
      clearTimeout(searchTimer);
      set({ q: "", large: false, ...(view.status === "error" ? { status: "loading" as const } : {}) });
      const loaded = firstPage("");
      return Promise.race([loaded, new Promise<void>((resolve) => setTimeout(resolve, OPEN_BOUND_MS))]);
    },

    /** The screen is on show; a picture finishing meanwhile joins the top. */
    shown(on: boolean): void {
      shown = on;
      if (!on) { clearTimeout(searchTimer); if (view.large) set({ large: false }); }
    },

    search(q: string): void {
      set({ q });
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => void firstPage(q), SEARCH_WAIT_MS);
    },

    /** The next page, once at a time. */
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
      } catch {
        // the next scroll to the end asks again
      } finally {
        paging = false;
      }
    },

    /** An image job finished: while the screen is on show, its picture joins the top of the list. */
    async finished(): Promise<void> {
      if (!shown || view.status !== "ready") return;
      const mine = ticket;
      try {
        const page = await list({ limit: NEWEST, ...words(view.q) });
        if (mine !== ticket) return;
        const have = new Set(view.pictures.map((p) => p.jobId));
        const fresh = page.pictures.filter((p) => !have.has(p.jobId));
        if (fresh.length > 0) set({ pictures: [...fresh, ...view.pictures], count: page.count });
      } catch {
        // the next open reads the list again
      }
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
