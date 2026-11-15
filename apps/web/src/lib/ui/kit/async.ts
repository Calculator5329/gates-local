// Waits with a limit, typing that settles, and a file handed to the browser to save.

/** `p`, or `onLate()` once `ms` pass first. A rejection of `p` passes through; the timer is cleared either way. */
export function withTimeout<T, L>(p: Promise<T>, ms: number, onLate: () => L): Promise<T | L> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<L>((resolve) => {
    // oxlint-disable-next-line gates/timer-needs-reason -- the limit on a wait that may never end; the caller names how long
    timer = setTimeout(() => resolve(onLate()), ms);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

export type Debounced<A extends unknown[]> = ((...args: A) => void) & { cancel(): void };

/** `fn` once calls have paused for `ms`, with the last call's arguments. */
export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): Debounced<A> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const call = (...args: A) => {
    clearTimeout(timer);
    // oxlint-disable-next-line gates/timer-needs-reason -- a debounce: the pause the caller names
    timer = setTimeout(() => fn(...args), ms);
  };
  return Object.assign(call, { cancel: () => clearTimeout(timer) });
}

/** How long a saved file's address lives: the browser has started the download well before. */
export const DOWNLOAD_KEEP_MS = 60_000;

/** Save `blob` as a file called `name`, as a download from the page. */
export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  a.click();
  // oxlint-disable-next-line gates/timer-needs-reason -- the blob's address must outlive the download's start; there is no event for that
  setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_KEEP_MS);
}
