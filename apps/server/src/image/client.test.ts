import { afterEach, expect, it, vi } from "vitest";
import { createComfyClient } from "./client.ts";

afterEach(() => vi.useRealTimers());

it("cancels its prompt if it moves from pending to running during cancellation, leaving other prompts alone", async () => {
  const calls: string[] = [];
  let polls = 0, interrupted = false;
  const client = createComfyClient("http://fake", { fetch: async (input, init) => {
    const route = new URL(String(input)).pathname; calls.push(route);
    if (route === "/queue") {
      polls++;
      if (polls === 1) return Response.json({ queue_pending: [[1, "ours"]], queue_running: [[0, "other"]] });
      if (polls > 3 && !interrupted) throw new Error("cancellation never interrupted the transitioned prompt");
      return Response.json({ queue_pending: [], queue_running: interrupted ? [[2, "other-next"]] : [[1, "ours"]] });
    }
    if (route === "/interrupt") { expect(JSON.parse(String(init?.body))).toEqual({ prompt_id: "ours" }); interrupted = true; return Response.json({}); }
    throw new Error(`unexpected ${route}`);
  } });
  await client.cancelPrompt("ours");
  expect(calls.filter((route) => route === "/interrupt")).toHaveLength(1);
  const other = createComfyClient("http://fake", { fetch: async (input) => {
    expect(new URL(String(input)).pathname).toBe("/queue");
    return Response.json({ queue_pending: [], queue_running: [[0, "other"]] });
  } });
  await other.cancelPrompt("ours-already-finished");
});

it("throws the named cancellation deadline even if the queue HTTP request hangs", async () => {
  vi.useFakeTimers();
  const client = createComfyClient("http://fake", { requestTimeoutMs: 90_000, fetch: async (_input, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
  }) });
  let failure: unknown;
  const ended = client.cancelPrompt("ours").catch((error: unknown) => { failure = error; });
  await vi.advanceTimersByTimeAsync(29_999); expect(failure).toBeUndefined();
  await vi.advanceTimersByTimeAsync(1); const atDeadline = failure;
  // Allow a mutated 60-second deadline to finish without leaving work behind.
  await vi.advanceTimersByTimeAsync(30_000); await ended;
  expect(atDeadline).toMatchObject({ name: "ComfyCancelTimeoutError", message: "ComfyUI did not release the image job within 30 s" });
});
