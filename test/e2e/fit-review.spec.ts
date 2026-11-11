/// <reference lib="dom" />
// Controlled failures at the same wire boundaries used by the real session.
import type { CatalogEntry, GpuOccupant, GpuStatus, ModelInfo } from "@gates-local/contracts";
import type { Page } from "@playwright/test";
import { expect, openGpuMemory, test, waitReady } from "./fixtures.ts";

test.use({ seed: "design", video: "on" });
const soft = expect.configure({ soft: true });

async function traffic(page: Page) {
  const t = {
    fail: new Set<string>(), skip: new Set<string>(), calls: [] as string[],
    catalogTag: undefined as string | undefined, controlPulls: false, refused: 0,
    started: "", gpu: undefined as GpuStatus | undefined, models: [] as readonly ModelInfo[],
    push: (_channel: string, _payload: unknown) => {},
  };
  await page.routeWebSocket(/127\.0\.0\.1:5286/, ws => {
    const server = ws.connectToServer(), methods = new Map<string, string>();
    t.push = (channel, payload) => ws.send(JSON.stringify({ type: "push", channel, payload }));
    ws.onMessage(message => {
      const req = JSON.parse(String(message)) as { id: string; method: string; params: { name?: string } };
      methods.set(req.id, req.method); t.calls.push(req.method);
      const reply = (result: unknown) => ws.send(JSON.stringify({ type: "response", id: req.id, ok: true, result }));
      if (t.fail.has(req.method) || req.method === "models.pull" && t.controlPulls && t.refused++ === 0) {
        ws.send(JSON.stringify({ type: "response", id: req.id, ok: false, error: { code: "internal", message: "Review fixture refused." } }));
      } else if (req.method === "models.pull" && t.controlPulls) {
        t.started = req.params.name ?? "";
        const p = { name: t.catalogTag ?? "qwen3.5:4b", state: "downloading", completedBytes: 8, totalBytes: 16 };
        t.push("models.pull", p); reply(p);
      } else if (req.method === "models.cancelPull" && t.controlPulls) {
        reply({ cancelled: true });
      } else server.send(message);
    });
    server.onMessage(message => {
      const res = JSON.parse(String(message)) as { type: string; id: string; channel: string; result: unknown; payload: unknown };
      if (res.type === "push" && t.skip.has(res.channel)) return;
      const method = methods.get(res.id);
      if (method === "gpu.status") t.gpu = res.result as GpuStatus;
      if (method === "models.list") t.models = res.result as readonly ModelInfo[];
      if (method === "models.catalog" && t.catalogTag) {
        res.result = (res.result as readonly CatalogEntry[]).map(c => c.name === "qwen3.5:4b" ? { ...c, name: t.catalogTag } : c);
        ws.send(JSON.stringify(res));
      } else ws.send(message);
    });
  });
  return t;
}

for (const missing of ["gpu.status", "models.list"]) {
  test(`FR-01: failed ${missing} settles picker preparation without authorizing a pick`, async ({ page, open }) => {
    const t = await traffic(page);
    t.fail.add(missing); t.fail.add("fit.table");
    t.skip.add("gpu.changed"); t.skip.add("fit.changed");
    if (missing === "models.list") { t.fail.add("models.refresh"); t.skip.add("models.changed"); }
    await open(); await waitReady(page);
    await page.locator("#modelBtn").click();
    const picker = page.locator("#picker");
    await expect(picker).toBeVisible();
    await expect(picker.getByRole("button", { name: "Download models", exact: true })).toBeEnabled();
    if (missing === "gpu.status") {
      // With no table yet the fit values stay skeletons, the same size as a value, and no row can be picked yet.
      await expect(picker.locator(".pk-context .pk-cost .fit-skel").first()).toBeVisible();
      const row = picker.locator('[data-m="gemma4:12b"]');
      await expect(row).toHaveAttribute("aria-disabled", "true");
      // Playwright will not click inside an aria-disabled row; a user still can, and nothing may change.
      await row.locator(".pk-select").dispatchEvent("click");
      await expect(picker).toBeVisible();
      await expect(page.locator("#modelBtn")).toContainText("Qwen 3.5 9B");
    } else await expect(picker.getByRole("option")).toHaveCount(0);
    expect(t.calls.filter(method => method === "models.load")).toHaveLength(0);
  });
}

async function downloads(page: Page) {
  await page.keyboard.press("Control+Comma");
  await page.locator(".snav").getByRole("button", { name: "Models", exact: true }).click();
  await page.getByRole("tab", { name: /Download/ }).click();
}

const installed = (t: Awaited<ReturnType<typeof traffic>>, name: string) =>
  t.push("models.changed", [...t.models, { name, digest: "review-installed", sizeBytes: 1_000_000, modifiedAt: "2026-01-01T00:00:00Z", capabilities: ["completion"] }]);

for (const tag of ["qwen3.5:4b", "qwen3.5:latest"]) {
  test(`FR-02: a custom retry shares the catalog attempt for ${tag}`, async ({ page, open }) => {
    const t = await traffic(page);
    t.catalogTag = tag; t.controlPulls = true;
    await open(); await waitReady(page); await downloads(page);
    const row = page.locator(`.dlrow[data-cat="${tag}"]`);
    await row.getByRole("button", { name: "Download", exact: true }).click();
    await expect(row.getByRole("alert")).toContainText("Review fixture refused");
    const input = page.getByRole("textbox", { name: "Model name", exact: true });
    await input.fill(`  ${tag.replace(/:latest$/, "").toUpperCase()}  `);
    await page.locator(".srow").filter({ has: input }).getByRole("button", { name: "Download", exact: true }).click();
    await expect(row.getByRole("progressbar")).toBeVisible();
    await expect.soft(row.getByRole("alert")).toHaveCount(0);
    expect.soft(t.started).toBe(tag);
    await expect(input).toHaveValue("");
    await row.getByRole("button", { name: "Cancel download", exact: true }).click();
    await expect(row.getByRole("button", { name: "Download", exact: true })).toBeVisible();
    t.fail.add("models.pull");
    await row.getByRole("button", { name: "Download", exact: true }).click();
    await expect(row.getByRole("alert")).toContainText("Review fixture refused");
    for (const state of ["cancelled", "error"]) {
      t.push("models.pull", { name: tag, state, completedBytes: 0 });
      await expect(row.getByRole("alert")).toContainText("Review fixture refused");
    }
    installed(t, tag.replace(/:latest$/, "").toUpperCase());
    await expect.soft(row.getByText("Installed", { exact: true })).toBeVisible();
    await expect.soft(row.getByRole("alert")).toHaveCount(0);
  });
}

test("FR-02: external download progress and installation retire an old catalog error", async ({ page, open }) => {
  const t = await traffic(page); t.controlPulls = true;
  await open(); await waitReady(page); await downloads(page);
  const row = page.locator('.dlrow[data-cat="qwen3.5:4b"]');
  await row.getByRole("button", { name: "Download", exact: true }).click();
  await expect(row.getByRole("alert")).toContainText("Review fixture refused");
  t.push("models.pull", { name: "qwen3.5:4b", state: "downloading", completedBytes: 8, totalBytes: 16 });
  await expect(row.getByRole("progressbar")).toBeVisible();
  await expect.soft(row.getByRole("alert")).toHaveCount(0);
  installed(t, "qwen3.5:4b");
  await expect(row.getByText("Installed", { exact: true })).toBeVisible();
  await expect.soft(row.getByRole("alert")).toHaveCount(0);
  // A new custom failure belongs to this attempt, even with an old install.
  const input = page.getByRole("textbox", { name: "Model name", exact: true });
  const custom = page.locator(".srow").filter({ has: input });
  t.fail.add("models.pull");
  await input.fill("QWEN3.5:4B");
  await custom.getByRole("button", { name: "Download", exact: true }).click();
  await expect(custom.getByRole("alert")).toContainText("Review fixture refused");
  installed(t, "qwen3.5:4b");
  await expect(custom.getByRole("alert")).toContainText("Review fixture refused");
});

test("FR-03: legend identity, text and removal retire stale tips without closing valid tips", async ({ page, open }) => {
  const t = await traffic(page);
  await open(); await waitReady(page);
  const panel = await openGpuMemory(page);
  await panel.locator("summary", { hasText: "Details" }).click();
  await expect.poll(() => t.gpu !== undefined).toBe(true);
  t.skip.add("gpu.changed");
  const whisper: GpuOccupant = { label: "Whisper", bytes: Math.round(2.1 * 1024 ** 3), kind: "whisper", protected: true };
  const other: GpuOccupant = { label: "Other", bytes: Math.round(0.2 * 1024 ** 3), kind: "unknown", protected: true };
  const update = (occupants: readonly GpuOccupant[]) => {
    if (!t.gpu) throw new Error("No GPU snapshot received");
    t.push("gpu.changed", { ...t.gpu, occupants, measuredAt: t.gpu.measuredAt + 1 });
  };
  update([whisper, other]);
  const entry = panel.locator(".lg-r").filter({ hasText: /^Whisper/ });
  await entry.evaluate(el => { (el as HTMLElement).dataset["reviewIdentity"] = "whisper"; });
  await entry.hover();
  const tip = page.locator("#tip");
  await expect(tip).toHaveClass(/open/); await expect(tip).toContainText("never stops it");
  update([{ ...other, bytes: 3 * 1024 ** 3 }, whisper]);
  await expect(panel.locator(".lg-r").first()).toContainText("Other");
  await expect.soft(entry).toHaveAttribute("data-review-identity", "whisper");
  await soft.poll(() => tip.evaluate(el => !el.classList.contains("open") || !el.textContent?.includes("never stops it"))).toBe(true);

  await page.mouse.move(1, 1); await entry.hover();
  await expect(tip).toHaveClass(/open/); await expect(tip).toContainText("never stops it");
  update([{ ...other, bytes: Math.round(3.1 * 1024 ** 3) }, whisper]);
  await expect(panel.locator(".lg-r").first().locator(".v")).toContainText("3.1 GB");
  await expect(tip).toHaveClass(/open/); await expect(tip).toContainText("never stops it");

  await entry.evaluate(el => el.setAttribute("data-tip", "Changed occupant details."));
  await soft.poll(() => tip.evaluate(el => !el.classList.contains("open") || el.textContent === "Changed occupant details.")).toBe(true);
  await page.mouse.move(1, 1); await entry.hover();
  await expect(tip).toContainText("Changed occupant details.");
  update([other]);
  await expect(entry).toHaveCount(0);
  await expect.soft(tip).not.toHaveClass(/open/);
  const python: GpuOccupant = { label: "Python", bytes: 2 * 1024 ** 3, kind: "other-app", protected: true };
  update([python, { ...python, bytes: 1024 ** 3 }, other]);
  const duplicates = panel.locator(".lg-r").filter({ hasText: /Python/ });
  await expect(duplicates).toHaveCount(2);
  await duplicates.evaluateAll(rows => rows.forEach((row, i) => row.setAttribute("data-review-duplicate", String(i))));
  update([{ ...other, bytes: 4 * 1024 ** 3 }, { ...python, bytes: 3 * 1024 ** 3 }, python]);
  await expect(panel.locator(".lg-r").first()).toContainText("Other");
  await expect(duplicates).toHaveCount(2);
  await expect(duplicates.nth(0)).toHaveAttribute("data-review-duplicate", "0");
  await expect(duplicates.nth(1)).toHaveAttribute("data-review-duplicate", "1");
});
