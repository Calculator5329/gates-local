// IndexedDB can hold image drafts larger than localStorage's small text quota.
import { getState, setState, subscribe, type Queued } from "./store.ts";

interface Saved { draft: string; images: readonly string[]; queued: readonly Queued[]; editing: string | null; sendId?: string; sendThreadId?: string; }
const record = (v: unknown): Record<string, unknown> | undefined => typeof v === "object" && v !== null ? v as Record<string, unknown> : undefined;
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 8 && v.every(i => typeof i === "string" && i.length <= 14 * 1024 * 1024);

/** A queue restored after a reload waits for Send now, so startup never sends it unexpectedly. */
export function recoverDraft(value: unknown): Saved | undefined {
  const saved = record(value);
  if (!saved || typeof saved["draft"] !== "string" || !strings(saved["images"]) || !Array.isArray(saved["queued"])) return;
  const queued: Queued[] = [];
  for (const item of saved["queued"]) {
    const q = record(item);
    if (!q || typeof q["id"] !== "string" || typeof q["threadId"] !== "string" || typeof q["text"] !== "string" || typeof q["at"] !== "number" || !Number.isFinite(q["at"]) || (q["images"] !== undefined && !strings(q["images"]))) return;
    queued.push({ id: q["id"], threadId: q["threadId"], text: q["text"], at: q["at"], images: q["images"] ?? [], waitFor: "reply", held: true, ...(typeof q["messageId"] === "string" ? { messageId: q["messageId"] } : {}), ...(typeof q["model"] === "string" ? { model: q["model"] } : {}) });
  }
  const editing = typeof saved["editing"] === "string" && queued.some(q => q.id === saved["editing"]) ? saved["editing"] : null;
  return { draft: saved["draft"], images: saved["images"], queued, editing, ...(typeof saved["sendId"] === "string" ? { sendId: saved["sendId"] } : {}), ...(typeof saved["sendThreadId"] === "string" ? { sendThreadId: saved["sendThreadId"] } : {}) };
}

export async function watchDraft(key: string): Promise<() => void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const opening = indexedDB.open("gates-local.composer", 1);
    opening.addEventListener("upgradeneeded", () => opening.result.createObjectStore("drafts"));
    opening.addEventListener("success", () => resolve(opening.result), { once: true });
    opening.addEventListener("error", () => reject(opening.error), { once: true });
  });
  const before = getState();
  const saved = await new Promise<unknown>((resolve, reject) => {
    const request = db.transaction("drafts").objectStore("drafts").get(key);
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error), { once: true });
  });
  const recovered = recoverDraft(saved);
  if (recovered) setState(s => ({
    ...(s.draft === before.draft && s.draftImages === before.draftImages ? { draft: recovered.draft, draftImages: recovered.images, editingQueued: recovered.editing, draftSendId: recovered.sendId ?? null, draftSendThreadId: recovered.sendThreadId ?? null } : {}),
    ...(s.queued === before.queued ? { queued: recovered.queued } : {}),
    ...(recovered.queued.length ? { notice: "Your queued messages were restored on hold. Use Send now when you are ready." } : {}),
  }));
  let last = getState();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failed = false;
  const save = (): Promise<void> => {
    clearTimeout(timer);
    timer = undefined;
    const s = getState();
    return new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("drafts", "readwrite", { durability: "strict" });
      transaction.objectStore("drafts").put({ draft: s.draft, images: s.draftImages, queued: s.queued, editing: s.editingQueued, ...(s.draftSendId ? { sendId: s.draftSendId, sendThreadId: s.draftSendThreadId } : {}) }, key);
      transaction.addEventListener("complete", () => resolve(), { once: true });
      const failure = () => {
        if (!failed) { failed = true; setState({ notice: "This message could not be saved on this device. Keep this window open until you send it." }); }
        reject(transaction.error ?? new Error("The message could not be saved."));
      };
      transaction.addEventListener("error", failure, { once: true });
      transaction.addEventListener("abort", failure, { once: true });
    });
  };
  const backgroundSave = () => { void save().catch(() => undefined); };
  const off = subscribe(() => {
    const s = getState();
    if (last.draft === s.draft && last.draftImages === s.draftImages && last.queued === s.queued && last.draftSendId === s.draftSendId && last.draftSendThreadId === s.draftSendThreadId) return;
    const immediate = last.draftImages !== s.draftImages || last.queued !== s.queued;
    last = s;
    clearTimeout(timer);
    if (immediate) backgroundSave();
    else timer = setTimeout(backgroundSave, 200);
  });
  const flush = () => { if (timer !== undefined) backgroundSave(); };
  window.addEventListener("pagehide", flush);
  return () => { flush(); off(); window.removeEventListener("pagehide", flush); db.close(); };
}
