// IndexedDB can hold image drafts larger than localStorage's small text quota.
import { getState, setState, subscribe, type Queued } from "./store.ts";

interface Saved { draft: string; images: readonly string[]; queued: readonly Queued[]; editing: string | null; sendId?: string; sendThreadId?: string; }
const record = (v: unknown): Record<string, unknown> | undefined => typeof v === "object" && v !== null ? v as Record<string, unknown> : undefined;
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 8 && v.every(i => typeof i === "string" && i.length <= 14 * 1024 * 1024);
const attachmentRevision = (value: unknown): string | undefined => {
  const saved = record(value);
  return saved?.["format"] === 2 && typeof saved["attachmentsRevision"] === "string" ? saved["attachmentsRevision"] : undefined;
};

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

/** Format 2 keeps large strings under a separate compound key in the same store.
 * Legacy combined records remain readable and migrate atomically on an edit. */
function recoverStored(value: unknown, attachments: unknown): Saved | undefined {
  const saved = record(value);
  if (saved?.["format"] !== 2) return recoverDraft(value);
  const payload = record(attachments);
  const queuedImages = record(payload?.["queued"]);
  if (!payload || !strings(payload["images"]) || !queuedImages || !Object.values(queuedImages).every(strings) || !Array.isArray(saved["queued"])) return;
  return recoverDraft({ ...saved, images: payload["images"], queued: saved["queued"].map(item => {
    const q = record(item);
    return q ? { ...q, images: typeof q["id"] === "string" && Object.hasOwn(queuedImages, q["id"]) ? queuedImages[q["id"]] : [] } : item;
  }) });
}

const sameImages = (a: readonly string[] | undefined, b: readonly string[] | undefined) =>
  a === b || (a?.length ?? 0) === (b?.length ?? 0) && (a ?? []).every((image, i) => image === b?.[i]);

function sameAttachments(a: Saved | undefined, b: Saved): boolean {
  if (!a || !sameImages(a.images, b.images)) return false;
  if (a.queued === b.queued) return true;
  const before = new Map(a.queued.filter(q => q.images?.length).map(q => [q.id, q.images]));
  const after = b.queued.filter(q => q.images?.length);
  return before.size === after.length && after.every(q => before.has(q.id) && sameImages(before.get(q.id), q.images));
}

export async function watchDraft(key: string): Promise<() => void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const opening = indexedDB.open("gates-local.composer", 1);
    opening.addEventListener("upgradeneeded", () => opening.result.createObjectStore("drafts"));
    opening.addEventListener("success", () => resolve(opening.result), { once: true });
    opening.addEventListener("error", () => reject(opening.error), { once: true });
  });
  const before = getState();
  const readStore = db.transaction("drafts").objectStore("drafts");
  const read = (at: IDBValidKey) => new Promise<unknown>((resolve, reject) => {
    const request = readStore.get(at);
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error), { once: true });
  });
  const [saved, attachments] = await Promise.all([read(key), read([key, "attachments"])]);
  const recovered = recoverStored(saved, attachments);
  if (recovered) setState(s => ({
    ...(s.draft === before.draft && s.draftImages === before.draftImages ? { draft: recovered.draft, draftImages: recovered.images, editingQueued: recovered.editing, draftSendId: recovered.sendId ?? null, draftSendThreadId: recovered.sendThreadId ?? null } : {}),
    ...(s.queued === before.queued ? { queued: recovered.queued } : {}),
    ...(recovered.queued.length ? { notice: "Your queued messages were restored on hold. Use Send now when you are ready." } : {}),
  }));
  let last = getState();
  let committed = record(saved)?.["format"] === 2 ? recovered : undefined;
  let committedRevision = attachmentRevision(saved);
  let pending: Saved | undefined;
  let active: IDBTransaction | undefined;
  let requestCommit: (() => void) | undefined;
  let closing = false;
  let failed = false;
  const save = (snapshot: Saved): Promise<string> => {
    return new Promise<string>((resolve, reject) => {
      const transaction = db.transaction("drafts", "readwrite", { durability: "strict" });
      active = transaction;
      let revision: string = crypto.randomUUID();
      let writesQueued = false;
      let commitRequested = false;
      requestCommit = () => {
        commitRequested = true;
        // A metadata read may still need to enqueue its writes. Committing
        // before its success callback would prevent those puts from running.
        if (writesQueued) { try { transaction.commit(); } catch { /* Already committing or finished. */ } }
      };
      transaction.addEventListener("complete", () => resolve(revision), { once: true });
      transaction.addEventListener("abort", () => reject(transaction.error ?? new Error("The message could not be saved.")), { once: true });
      try {
        const store = transaction.objectStore("drafts");
        const cachedRevision = committedRevision;
        const submit = (reuse: boolean) => {
          try {
            if (reuse && cachedRevision !== undefined) revision = cachedRevision;
            else store.put({ images: snapshot.images, queued: Object.fromEntries(snapshot.queued.filter(q => q.images?.length).map(q => [q.id, q.images])) }, [key, "attachments"]);
            const { images: _images, queued, ...text } = snapshot;
            store.put({ format: 2, attachmentsRevision: revision, ...text, queued: queued.map(({ images: _queuedImages, ...q }) => q) }, key);
            writesQueued = true;
            if (commitRequested) requestCommit?.();
          } catch { transaction.abort(); }
        };
        if (cachedRevision !== undefined && sameAttachments(committed, snapshot)) {
          // Other tabs can replace this scope's payload. Confirm the cache in
          // this serialized transaction, reading only the small metadata row.
          const request = store.get(key);
          request.addEventListener("success", () => submit(attachmentRevision(request.result) === cachedRevision), { once: true });
        } else submit(false);
      } catch {
        // Wait for abort before allowing the next transaction to start.
        transaction.abort();
      }
    });
  };
  const pump = () => {
    if (active) return;
    if (!pending) { if (closing) db.close(); return; }
    const snapshot = pending;
    pending = undefined;
    void save(snapshot).then((revision) => { committed = snapshot; committedRevision = revision; }, () => {
      if (!failed) { failed = true; setState({ notice: "This message could not be saved on this device. Keep this window open until you send it." }); }
    }).finally(() => { active = undefined; requestCommit = undefined; pump(); });
  };
  const off = subscribe(() => {
    const s = getState();
    if (last.draft === s.draft && last.draftImages === s.draftImages && last.queued === s.queued && last.editingQueued === s.editingQueued && last.draftSendId === s.draftSendId && last.draftSendThreadId === s.draftSendThreadId) return;
    last = s;
    pending = { draft: s.draft, images: s.draftImages, queued: s.queued, editing: s.editingQueued, ...(s.draftSendId ? { sendId: s.draftSendId, sendThreadId: s.draftSendThreadId ?? undefined } : {}) };
    pump();
  });
  // Request an early commit, without a parallel write. Unload can still abort
  // this transaction or discard the pending snapshot; only completed writes
  // are durable. Neither lifecycle event can guarantee an immediate reload.
  const commit = () => requestCommit?.();
  const hidden = () => { if (document.visibilityState === "hidden") commit(); };
  window.addEventListener("pagehide", commit);
  document.addEventListener("visibilitychange", hidden);
  return () => {
    off();
    window.removeEventListener("pagehide", commit);
    document.removeEventListener("visibilitychange", hidden);
    closing = true;
    pump();
  };
}
