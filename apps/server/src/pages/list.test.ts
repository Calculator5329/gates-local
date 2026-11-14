// threads.pages from the thread store: a long thread's pages before the messages a window loaded.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openThreadStore, type ThreadStore } from "../threads/store.ts";
import { threadPages } from "./list.ts";

const page = (n: number) => `<!doctype html>\n<html><head><title>P${n}</title></head><body>${n}</body></html>`;
const reply = (...codes: string[]) => codes.map((c) => `Here.\n\n\`\`\`html\n${c}\n\`\`\``).join("\n\n");

let store: ThreadStore | undefined;
afterEach(() => store?.close());

describe("a thread's pages", () => {
  it("every page its saved replies wrote, oldest first, each code once; with before, only the replies before that message", () => {
    let now = 1000;
    store = openThreadStore(join(mkdtempSync(join(tmpdir(), "gates-pages-")), "threads.sqlite"), { now: () => now++ });
    const t = store.createThread();
    const add = (role: "user" | "assistant", content: string) => store!.appendMessage({ threadId: t.id, role, content, createdAt: now++ }).id;
    add("user", "make it");
    const first = add("assistant", reply(page(1)));
    add("user", `\`\`\`html\n${page(9)}\n\`\`\``); // a question is never a page
    add("assistant", reply(page(2), page(1)));
    add("assistant", "```sh\nls\n```"); // a fence, no page
    const cut = add("user", "again");
    add("assistant", `\`\`\`html\n${page(3)}`); // a block never closed
    const later = add("assistant", reply(page(4)));
    expect(threadPages(store, t.id).map((p) => [p.messageId, p.code])).toEqual([[first, page(1)], [expect.any(String), page(2)], [later, page(4)]]);
    expect(threadPages(store, t.id, cut).map((p) => p.code)).toEqual([page(1), page(2)]);
    // the reply being written is the window's live turn
    expect(threadPages(store, t.id, undefined, later).map((p) => p.code)).toEqual([page(1), page(2)]);
    expect(threadPages(store, t.id, first)).toEqual([]);
    expect(threadPages(store, t.id, "not-a-message")).toEqual([]);
  });
});
