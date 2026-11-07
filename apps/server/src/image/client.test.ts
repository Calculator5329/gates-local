import { expect, it } from "vitest";
import { createComfyClient } from "./client.ts";

it("cancels its prompt if it moves from pending to running during cancellation, leaving other prompts alone", async () => {
  const calls: string[] = [];
  let polls = 0, interrupted = false;
  const client = createComfyClient("http://fake", { fetch: async (input) => {
    const route = new URL(String(input)).pathname; calls.push(route);
    if (route === "/queue") {
      polls++;
      if (polls === 1) return Response.json({ queue_pending: [[1, "ours"]], queue_running: [[0, "other"]] });
      if (polls > 3 && !interrupted) throw new Error("cancellation never interrupted the transitioned prompt");
      return Response.json({ queue_pending: [], queue_running: interrupted ? [[2, "other-next"]] : [[1, "ours"]] });
    }
    if (route === "/interrupt") { interrupted = true; return Response.json({}); }
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
