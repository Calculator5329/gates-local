import { vi } from "vitest";

/** Controllable transactions exercise the real watcher while commits are held. */
export function draftDatabase() {
  const records = new Map<string, unknown>();
  const writes: { key: unknown; value: unknown; bytes: number }[] = [];
  const reads: { key: unknown; mode: string | undefined }[] = [];
  const pending: { finish: () => void; abort: () => void; commit: ReturnType<typeof vi.fn> }[] = [];
  let maximum = 0;
  const bytes = (v: unknown): number => {
    if (typeof v === "string") return Buffer.byteLength(v);
    if (Array.isArray(v)) return v.reduce<number>((n, item) => n + bytes(item), 0);
    if (v && typeof v === "object") return Object.entries(v).reduce((n, [key, value]) => n + Buffer.byteLength(key) + bytes(value), 0);
    return 0;
  };
  const db = {
    close: vi.fn(),
    transaction(_store: string, mode?: string) {
      const transaction = new EventTarget();
      const changes: { key: string; value: unknown }[] = [];
      const commit = vi.fn();
      const result = Object.assign(transaction, {
        error: null,
        commit,
        objectStore: () => ({
          get(key: unknown) {
            reads.push({ key, mode });
            const request = Object.assign(new EventTarget(), { result: undefined as unknown });
            queueMicrotask(() => {
              request.result = structuredClone(records.get(JSON.stringify(key)));
              request.dispatchEvent(new Event("success"));
            });
            return request;
          },
          put(value: unknown, key: unknown) {
            // Retain references instead of cloning the stress fixture again in this fake.
            writes.push({ key, value, bytes: bytes(value) });
            changes.push({ key: JSON.stringify(key), value });
          },
        }),
      });
      if (mode === "readwrite") {
        const item = {
          commit,
          finish() {
            // Requests already queued in this transaction finish before commit.
            queueMicrotask(() => {
              pending.splice(pending.indexOf(item), 1);
              for (const change of changes) records.set(change.key, change.value);
              transaction.dispatchEvent(new Event("complete"));
            });
          },
          abort() {
            pending.splice(pending.indexOf(item), 1);
            transaction.dispatchEvent(new Event("abort"));
          },
        };
        pending.push(item);
        maximum = Math.max(maximum, pending.length);
      }
      return result;
    },
  };
  const document = Object.assign(new EventTarget(), { visibilityState: "visible" });
  const window = new EventTarget();
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", window);
  vi.stubGlobal("indexedDB", { open() {
    const request = Object.assign(new EventTarget(), { result: db });
    queueMicrotask(() => request.dispatchEvent(new Event("success")));
    return request;
  } });
  return { records, reads, writes, pending, db, document, window, get maximum() { return maximum; } };
}
