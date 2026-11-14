import { createClient, type ModelSpeed } from "@gates-local/contracts";
import { expect, openModels, sendMessage, stack, test, waitReady } from "./fixtures.ts";

// A reply sent from the page becomes that model's measured speed, pushed to
// every other connection (a second window, the phone) without a read of its own.
// Guards the owner's ask for each model's speed (tok/s): a finished reply sets it.
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

// Settings row 4, the owner: "just a number and TPS. maybe an icon", only for a model run here.
// It shows on the model's name line in the picker and in the Models pop-up, at the line's end.
test("a model that has replied shows its TPS in the picker and in Models, the others show none", async ({ page, open }, info) => {
  await stack.reset("models");
  await open(); await waitReady(page);
  await sendMessage(page, "How fast is this model?");
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);

  await page.locator("#modelBtn").click();
  const used = page.locator("#pkList .pk-r.sel");
  const tag = await used.getAttribute("data-m");
  if (!tag) throw new Error("No selected model in the picker");
  const tps = /^\d+(?:\.\d)? tok\/s$/;
  await expect(used.locator(".tps")).toHaveText(tps);
  await expect(page.locator("#pkList .pk-r:not(.sel) .tps"), "a model never run here shows nothing").toHaveCount(0);
  await page.screenshot({ path: info.outputPath("tps-picker.png"), animations: "disabled" });
  await page.keyboard.press("Escape");

  await openModels(page);
  const row = page.locator(`.mp-row[data-dm="${tag}"]`);
  await expect(row.locator(".mp-l1 .tps")).toHaveText(tps);
  await expect(page.locator(`.mp-row:not([data-dm="${tag}"]) .tps`)).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("tps-models.png"), animations: "disabled" });
});
