import { createClient, type ModelSpeed } from "@gates-local/contracts";
import { expect, sendMessage, stack, test, waitReady } from "./fixtures.ts";

// A reply sent from the page becomes that model's measured speed, pushed to
// every other connection (a second window, the phone) without a read of its own.
test("a finished reply sets its model's measured speed for every connection", async ({ page, open }) => {
  await stack.reset("models");
  await open(); await waitReady(page);
  const server = new URL(page.url()).searchParams.get("server");
  if (!server) throw new Error("No test server");
  const other = createClient(new WebSocket(server));
  try {
    const pushes: (readonly ModelSpeed[])[] = [];
    other.subscribe("models.speed", (list) => { pushes.push(list); });
    expect(await other.call("models.speed", {}), "a fresh store has no measured speeds").toEqual([]);

    await sendMessage(page, "How fast is this model?");
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
    await expect.poll(() => pushes.length, { message: "the finished reply pushed models.speed" }).toBeGreaterThan(0);

    const [thread] = await other.call("threads.list", {});
    if (!thread) throw new Error("No thread was saved");
    const reply = (await other.call("threads.get", { threadId: thread.id })).messages.findLast(m => m.role === "assistant");
    const tokens = reply?.stats?.completionTokens, ms = reply?.stats?.evalDurationMs;
    if (!reply?.model || tokens === undefined || ms === undefined) throw new Error("The reply has no decode stats");
    expect(tokens, "the fake's reply clears the 50-token floor").toBeGreaterThanOrEqual(50);

    const pushed = pushes.at(-1)!;
    expect(pushed).toHaveLength(1);
    expect(pushed[0]!.model).toBe(reply.model.replace(/:latest$/, ""));
    expect(pushed[0]!.replies).toBe(1);
    expect(pushed[0]!.tokensPerSecond).toBeCloseTo(tokens / (ms / 1000), 6);
    expect(await other.call("models.speed", {}), "a read agrees with the push").toEqual(pushed);
  } finally { other.close(); }
});
