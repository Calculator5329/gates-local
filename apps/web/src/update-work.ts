// What an update stops: the server's activity list plus this window's queue
// and drafts. One source for the footer's ask and the installer's native one.
import { savedDrafts } from "./drafts.ts";
import { getState } from "./store.ts";

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The work an update would stop, in the server's words, then this window's; undefined when the server sent no activity list. */
export function updateWork(activity: readonly string[] | undefined): string[] | undefined {
  if (activity === undefined) return undefined;
  const queued = getState().queued.length;
  const drafts = savedDrafts().filter(({ draft }) => draft.text.trim() || draft.images.length || draft.files?.length).length;
  return [
    ...activity,
    ...(queued ? [`${count(queued, "queued message", "queued messages")} in this window`] : []),
    ...(drafts ? [`${count(drafts, "unsent draft", "unsent drafts")} in this window`] : []),
  ];
}

/**
 * One short line per piece of work: what stops and what happens to it, said
 * once. Queued messages and drafts are saved in this browser and come back
 * after the restart (draft-persistence.ts); a restored queue waits for Send now.
 */
export function workLines(work: readonly string[] | undefined): string[] {
  if (work === undefined) return ["What is running could not be read. It all stops."];
  return work.map((w) => {
    const n = Number(/^\d+/.exec(w)?.[0]);
    if (/^\d+ running repl/.test(w)) return n === 1 ? "1 reply stops. Its text is kept." : `${n} replies stop. Their text is kept.`;
    const download = /^model download: (.+)$/.exec(w);
    if (download) return `Download of ${download[1]} stops. It resumes.`;
    if (/^\d+ image generation job/.test(w)) return n === 1 ? "1 image job stops." : `${n} image jobs stop.`;
    if (/^\d+ queued messages? in this window$/.test(w)) return n === 1 ? "1 queued message waits for Send now." : `${n} queued messages wait for Send now.`;
    if (/^\d+ unsent drafts? in this window$/.test(w)) return `${count(n, "unsent draft is", "unsent drafts are")} kept.`;
    // the rest are imports, which the server will not interrupt (main.ts uninterruptible): it refuses to start until they end
    return `${w} must finish before the update.`;
  });
}
