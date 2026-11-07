// Child process for the kill-mid-stream test (store.crash.test.ts). Run with
// plain `node` (type stripping): node crash-writer.ts <dbPath> <marker>.
// Writes three completed messages, then streams a partial assistant reply
// into a TurnBuffer forever, printing one JSON "ready" line to stdout once
// the partial is non-empty. The parent SIGKILLs it mid-stream.

import { openThreadStore } from "../store.ts";
import { createTurnBuffer } from "../turn-buffer.ts";

const [dbPath, marker] = process.argv.slice(2);
if (!dbPath || !marker) {
  process.stderr.write("usage: crash-writer.ts <dbPath> <marker>\n");
  process.exit(2);
}

// Never outlive a parent that forgot to kill us.
setTimeout(() => process.exit(3), 30_000).unref();

const store = openThreadStore(dbPath);
const thread = store.createThread({ title: "crash test" });

const completed: string[] = [];
completed.push(store.appendMessage({ threadId: thread.id, role: "user", content: "first question" }).id);

const reply = createTurnBuffer({ threadId: thread.id, model: "fake:1b" });
for (const piece of ["first ", "answer"]) reply.appendDelta(piece);
completed.push(store.appendMessage(reply.finish({ completionTokens: 2 })).id);

completed.push(store.appendMessage({ threadId: thread.id, role: "user", content: "second question" }).id);

const partial = createTurnBuffer({ threadId: thread.id, model: "fake:1b" });
partial.appendThinking(`thinking ${marker}`);
partial.appendDelta(`partial ${marker} `);

process.stdout.write(`${JSON.stringify({ ready: true, threadId: thread.id, completed, partial: partial.partial() })}\n`);

let n = 0;
setInterval(() => {
  partial.appendDelta(`${marker}-${n++} `);
}, 2);
