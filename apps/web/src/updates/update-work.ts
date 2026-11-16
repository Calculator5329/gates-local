import { savedDrafts } from "../lib/store/drafts.ts";
import { getState, waitingReplies } from "../lib/store/store.ts";

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function updateWork(activity: readonly string[] | undefined): string[] | undefined {
  if (activity === undefined) return undefined;
  const queued = waitingReplies(getState()).length;
  const drafts = savedDrafts().filter(({ draft }) => draft.text.trim() || draft.images.length || draft.files?.length).length;
  return [
    ...activity,
    ...(queued ? [`${count(queued, "queued message", "queued messages")} in this window`] : []),
    ...(drafts ? [`${count(drafts, "unsent draft", "unsent drafts")} in this window`] : []),
  ];
}

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
    return `${w} must finish before the update.`;
  });
}
