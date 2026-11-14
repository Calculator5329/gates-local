import { EventEmitter } from "node:events";
import { afterEach, expect, test, vi } from "vitest";
import { observeServerStages, type ServerStages } from "./server-stages.ts";

afterEach(() => { vi.unstubAllGlobals(); });

test("server stages persist at the first delta with only times and ids, across concurrent requests", async () => {
  const saved: ServerStages[] = [];
  let now = 100;
  class Socket extends EventEmitter {
    send(_data: unknown) { expect(saved.length).toBeGreaterThan(0); }
  }
  vi.stubGlobal("fetch", async () => new Response(new Uint8Array([1, 2])));
  const restore = observeServerStages(Socket.prototype, record => saved.push(record), () => now++);
  try {
    const socket = new Socket();
    const tasks: Promise<void>[] = [];
    socket.on("message", (data: string) => {
      const { params } = JSON.parse(data);
      tasks.push((async () => {
        await Promise.resolve(); // The request's async context must survive admission.
        const response = await fetch(new URL("https://model.invalid/api/chat"), { method: "POST", body: JSON.stringify({ stream: true, messages: [{ role: "user", content: "words that must never be saved" }] }) });
        await response.body!.getReader().read();
        const frame = JSON.stringify({ channel: "chat.event", payload: { threadId: params.threadId, event: { type: "delta", text: "private output" } } });
        socket.send(frame); socket.send(frame);
      })());
    });
    for (const threadId of ["a", "b"]) socket.emit("message", JSON.stringify({ id: `req-${threadId}`, method: "chat.send", params: { threadId, content: "private input" } }));
    await Promise.all(tasks);
    expect(saved).toHaveLength(2);
    expect(saved.map(record => record.requestId)).toEqual(["req-a", "req-b"]);
    for (const record of saved) {
      expect(Object.keys(record).toSorted()).toEqual(["firstBytes", "firstSocketDelta", "modelFetch", "receive", "requestId", "threadId"]);
      expect(record.receive).toBeLessThan(record.modelFetch!);
      expect(record.modelFetch).toBeLessThan(record.firstBytes!);
      expect(record.firstBytes).toBeLessThan(record.firstSocketDelta!);
    }
    expect(JSON.stringify(saved)).not.toMatch(/private|words|invalid/);
  } finally { restore(); }
});
