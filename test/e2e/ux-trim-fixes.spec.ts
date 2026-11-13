/// <reference lib="dom" />
// The trim's first review round: nothing in the composer row moves when typing
// starts while a reply runs; a picker name cut by its row reads in full in a
// tip, and only then; the stop square takes keyboard focus; a note under a
// sent message takes its own clicks; a picker row is announced name first; and
// a stopped reply draws the same row while the stop is on its way and once the
// saved reply takes over.
import type { Locator, Page } from "@playwright/test";
import { decodeRequest } from "@gates-local/contracts";
import type { FakeOllama } from "../fake-ollama/fake-ollama.ts";
import { LONG_NAME } from "../fake-ollama/models.ts";
import { FAKE_URL, SERVER_PORT } from "./env.ts";
import { expect, sendMessage, stack, test, waitReady } from "./fixtures.ts";

test.use({ video: "off" });

const UNSEEN = "Stopped. The model won't see this reply.";
/** The tooltip opens 400 ms after the pointer settles (ui.tsx); twice that leaves no doubt it would have. */
const PAST_TIP_DELAY_MS = 800;

async function release(): Promise<void> {
  const r = await fetch(`${FAKE_URL}/__fake/release`, { method: "POST", body: "{}" });
  expect(r.ok).toBe(true);
}

async function fakeState(): Promise<ReturnType<FakeOllama["state"]>> {
  const r = await fetch(`${FAKE_URL}/__fake/state`);
  expect(r.ok).toBe(true);
  return r.json() as Promise<ReturnType<FakeOllama["state"]>>;
}

const shot = (name: string) => test.info().outputPath(name);

// ------------------------------------------------------------------ 2. the composer row holds still

type Edges = { box: { l: number; r: number }; ctl: { k: string; l: number; r: number }[] };

/** Every control in the composer's button row: its left and right edge, and the composer box's. */
const rowEdges = (page: Page): Promise<Edges> => page.locator(".composer .cf").evaluate((cf) => {
  // edges to a tenth of a pixel, measured in the page
  const box = cf.getBoundingClientRect();
  const ctl = [...cf.querySelectorAll<HTMLElement>(".cf-l > *, .cf-r > *")].filter((e) => e.getClientRects().length > 0);
  return {
    box: { l: Math.round(box.left * 10) / 10, r: Math.round(box.right * 10) / 10 },
    ctl: ctl.map((e) => { const r = e.getBoundingClientRect(); return { k: e.getAttribute("aria-label") ?? (e.id || e.className), l: Math.round(r.left * 10) / 10, r: Math.round(r.right * 10) / 10 }; }),
  };
});

/** Only where each control is, not which one: a control that takes another's place leaves this the same. */
const at = (e: Edges) => e.ctl.map(({ l, r }) => [l, r]);

function inside(edges: Edges, state: string): void {
  for (const c of edges.ctl) {
    expect(c.l, `${c.k} inside the composer, ${state}`).toBeGreaterThanOrEqual(edges.box.l - 0.5);
    expect(c.r, `${c.k} inside the composer, ${state}`).toBeLessThanOrEqual(edges.box.r + 0.5);
  }
}

async function replyRunning(page: Page, touch: boolean): Promise<void> {
  await stack.scenario("slow-drip", { holdAfterTokens: 46 });
  await page.locator("#ta").fill("Keep this reply running");
  const primary = page.locator(".composer button.send");
  if (touch) await primary.tap();
  else await primary.click();
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  await expect(page.locator(".turn.a").last().locator(".md ul li")).toHaveCount(3, { timeout: 15_000 });
}

for (const width of [360, 375, 412, 1280]) {
  const touch = width < 640;
  test.describe(`the composer row at ${width} px${touch ? ", touch" : ""}`, () => {
    test.use(touch ? { viewport: { width, height: 800 }, isMobile: true, hasTouch: true } : { viewport: { width, height: 800 } });
    test("holds still when the first character is typed while a reply runs, and stays inside the composer", async ({ page, open }) => {
      await open(); await waitReady(page);
      await replyRunning(page, touch);
      const before = await rowEdges(page);
      await page.locator("#ta").pressSequentially("a");
      await expect(page.locator("#ta")).toHaveValue("a");
      const after = await rowEdges(page);
      console.log(`ROW_EDGES ${width} ${JSON.stringify({ before, after })}`);
      const box = (await page.locator(".composer").boundingBox())!;
      await page.screenshot({ path: shot(`trim2-2-${width}.png`), clip: { x: box.x, y: box.y, width: box.width, height: box.height } });
      inside(before, "before typing");
      inside(after, "after the first character");
      expect(after.ctl, "the first character moves no control in the row").toEqual(before.ctl);
      await release();
    });
  });
}

test("desktop: editing a queued message while the reply runs and ends moves nothing in the row", async ({ page, open }) => {
  await open(); await waitReady(page);
  await replyRunning(page, false);
  await page.locator("#ta").fill("Keep this queued draft");
  await page.locator("#ta").press("Enter");
  const running = await rowEdges(page);
  await page.locator(".qt-r [data-edit-queued]").click();
  await expect(page.locator(".composer button.send")).toHaveAccessibleName("Update queued message");
  const editing = await rowEdges(page);
  await page.locator("#ta").pressSequentially(" more");
  const typed = await rowEdges(page);
  await release();
  await expect(page.locator(".composer .stop-sq")).toHaveCount(0, { timeout: 15_000 });
  const ended = await rowEdges(page);
  console.log(`ROW_EDGES queued-edit ${JSON.stringify({ running, editing, typed, ended })}`);
  for (const [state, e] of [["running", running], ["editing", editing], ["typed", typed], ["ended", ended]] as const) inside(e, state);
  expect(typed.ctl, "typing into the edit moves nothing").toEqual(editing.ctl);
  // Stop takes Dictate's square and gives it back: the names change, the edges do not
  expect(at(editing), "the pencil moves nothing").toEqual(at(running));
  expect(at(ended), "the reply ending moves nothing").toEqual(at(running));
});

// ------------------------------------------------------------------ 3. a cut name's tip

test.describe("a picker name cut by its row", () => {
  test.use({ scenario: "long-name" });
  test("reads in full in a tip on hover and on the keyboard's highlight; a name that fits opens none", async ({ page, open }) => {
    await open(); await waitReady(page);
    await page.locator("#modelBtn").click();
    const picker = page.locator("#picker");
    await expect(picker).toBeVisible();
    await expect(picker.locator(".pk-v").filter({ hasText: "Checking" })).toHaveCount(0);
    const long = picker.locator(`.pk-r[data-m="${LONG_NAME}"]`);
    const short = picker.locator('.pk-r[data-m="gemma4:12b"]');
    const nm = long.locator(".pk-nm");
    expect(await nm.evaluate((el) => el.scrollWidth > el.clientWidth), "the long name is cut").toBe(true);
    expect(await short.locator(".pk-nm").evaluate((el) => el.scrollWidth > el.clientWidth), "the short name fits").toBe(false);
    const name = (await nm.textContent()) ?? "";
    const tip = page.locator("#tip.open");

    await long.locator(".pk-n").hover();
    await page.waitForTimeout(PAST_TIP_DELAY_MS);
    await expect(tip, "the cut name's tip holds only the full name").toHaveText(name);
    const row = (await long.boundingBox())!;
    const t = (await page.locator("#tip").boundingBox()) ?? row;
    // the tip sits outside the picker, on whichever side has room: the shot holds both
    const top = Math.min(row.y, t.y), bottom = Math.max(row.y + row.height, t.y + t.height);
    const left = Math.max(0, Math.min(row.x, t.x) - 8), right = Math.max(row.x + row.width, t.x + t.width) + 8;
    await page.screenshot({ path: shot("trim2-3.png"), clip: { x: left, y: Math.max(0, top - 8), width: right - left, height: bottom - top + 16 } });

    await short.locator(".pk-n").hover();
    await page.waitForTimeout(PAST_TIP_DELAY_MS);
    await expect(tip, "a name that fits opens no tip").toHaveCount(0);

    // the keyboard: focus stays in the search field and the highlight moves through the rows
    await page.mouse.move(1, 1);
    await page.locator("#pkSearch").focus();
    const n = await picker.locator(".pk-r").count();
    const seen: string[] = [];
    for (let i = 0; i < n; i++) {
      await page.keyboard.press("ArrowDown");
      const hl = picker.locator(".pk-r.hl");
      await expect(hl).toHaveCount(1);
      const tag = (await hl.getAttribute("data-m")) ?? "";
      const cut = await hl.locator(".pk-nm").evaluate((el) => el.scrollWidth > el.clientWidth);
      if (cut) await expect(tip, `${tag} highlighted, its name cut`).toHaveText((await hl.locator(".pk-nm").textContent()) ?? "");
      else await expect(tip, `${tag} highlighted, its name fits`).toHaveCount(0);
      seen.push(`${tag}${cut ? " (cut)" : ""}`);
    }
    console.log(`KEYBOARD_TIPS ${JSON.stringify(seen)}`);
    expect(seen.some((s) => s.startsWith(LONG_NAME)), "the highlight reached the long name").toBe(true);
  });
});

// ------------------------------------------------------------------ 7. a row is announced name first

test("a picker row is announced by its name first, then its size and fit", async ({ page, open }) => {
  await open(); await waitReady(page);
  await page.locator("#modelBtn").click();
  const row = page.locator('#picker .pk-r[data-m="gemma4:12b"]');
  await expect(row).toBeVisible();
  const order = await row.evaluate((el) => [...el.children].map((c) => c.classList.contains("pk-select") ? "name" : c.classList.contains("vh") ? "facts" : c.className));
  console.log(`ROW_ORDER ${JSON.stringify(order)} ${JSON.stringify(await row.ariaSnapshot())}`);
  expect(order.indexOf("name"), "the name before the facts").toBeLessThan(order.indexOf("facts"));
});

// ------------------------------------------------------------------ 4. the stop square takes focus

test("the stop square takes keyboard focus and says the model won't see the reply", async ({ page, open }) => {
  await open(); await waitReady(page);
  await stack.scenario("models", { tokenDelayMs: 120 });
  await sendMessage(page, "Tell me about cron");
  const reply = page.locator(".turn.a").last();
  await expect.poll(async () => (await reply.locator(".md").innerText()).split(/\s+/).length).toBeGreaterThan(8);
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.locator(".turn.a.interrupted")).toHaveCount(1);
  const mark = reply.getByRole("img", { name: UNSEEN, exact: true });
  await expect(mark).toHaveAttribute("tabindex", "0");
  await page.mouse.move(1, 1);
  await reply.focus();
  for (let i = 0; i < 4 && !(await mark.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press("Tab");
  await expect(mark, "Tab reaches the square").toBeFocused();
  await expect(page.locator("#tip.open")).toHaveText(UNSEEN);
});

// ------------------------------------------------------------------ 6. a note under a sent message

test("a note under a sent message takes its own clicks, and the next turn follows the note", async ({ page, open }) => {
  await open(); await waitReady(page);
  // a reply that fails before its first word while its chat is not on screen: the question gets the note
  await stack.scenario("threads", { errorAfterTokens: 0, firstTokenDelayMs: 1500 });
  // a thinking reply would keep its thoughts and take the note itself
  const thinking = page.getByRole("button", { name: "Thinking", exact: true });
  await thinking.click();
  await expect(thinking).toHaveAttribute("aria-pressed", "false");
  await sendMessage(page, "A question whose reply fails");
  const thread = await page.locator(".sb-row.on").getAttribute("data-thread");
  expect(thread).not.toBeNull();
  await page.getByRole("button", { name: "New thread" }).first().click();
  await expect.poll(async () => (await fakeState()).turns.at(-1)?.outcome, { timeout: 10_000 }).toBe("error");
  await page.locator(`.sb-row[data-thread="${thread}"]`).click();
  const user = page.locator(".turn.u.noted");
  const note = page.locator(".turn.u.noted + .stop-note");
  await expect(note).toBeVisible();
  await page.mouse.move(1, 1);
  const [u, n, copy] = await Promise.all([user.boundingBox(), note.boundingBox(), user.locator(".u-act [data-copy], .u-act button").last().boundingBox()]);
  const hit = await page.evaluate(([x, y]) => {
    const el = document.elementFromPoint(x!, y!);
    return { inActions: el?.closest(".u-act") !== null, inNote: el?.closest(".stop-note") !== null, tag: el?.tagName ?? "" };
  }, [copy!.x + copy!.width / 2, n!.y + 4]);
  console.log(`USER_NOTE ${JSON.stringify({ user: u, note: n, copy, hit })}`);
  expect(hit.inActions, "the unseen Edit and Copy take no click on the note's line").toBe(false);
  expect(n!.y, "the note starts under the message's action row").toBeGreaterThanOrEqual(u!.y + u!.height - 0.5);

  await stack.scenario("models");
  await sendMessage(page, "And another question");
  await expect(page.locator(".turn.a.done").last()).toContainText("You asked: And another question", { timeout: 10_000 });
  const next = await note.evaluate((el) => {
    const after = el.nextElementSibling?.getBoundingClientRect();
    return { noteBottom: el.getBoundingClientRect().bottom, nextTop: after?.top ?? null, next: el.nextElementSibling?.className ?? "" };
  });
  console.log(`USER_NOTE next ${JSON.stringify(next)}`);
  expect(next.nextTop, "the next turn follows the note directly").toBeCloseTo(next.noteBottom, 1);
});

// ------------------------------------------------------------------ 9. the same stopped row, live and saved

/** Hold the client's chat.cancel frames until let go, so the stopped turn's live row can be read. */
async function holdCancel(page: Page): Promise<{ held: () => number; letGo: () => void }> {
  const held: (() => void)[] = [];
  let holding = true;
  await page.routeWebSocket((url) => url.port === String(SERVER_PORT), (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => {
      const request = decodeRequest(message);
      if (holding && request.ok && request.value.method === "chat.cancel") held.push(() => server.send(message));
      else server.send(message);
    });
    server.onMessage((message) => ws.send(message));
  });
  return { held: () => held.length, letGo: () => { holding = false; for (const send of held.splice(0)) send(); } };
}

/** What a reply draws under its text: the pill's words, the square, Stop's seconds, its buttons and any words of a stopped line; each with whether it shows. */
const drawn = (reply: Locator) => reply.evaluate((turn) => {
  const shows = (e: Element | null | undefined): boolean => {
    if (!e || e.getClientRects().length === 0) return false;
    for (let x: Element | null = e; x !== null && x !== turn.parentElement; x = x.parentElement) {
      const s = getComputedStyle(x);
      if (s.opacity === "0" || s.visibility === "hidden") return false;
    }
    return true;
  };
  const pill = turn.querySelector("button.think .th-l > span:first-child");
  return {
    pill: pill?.textContent ?? null,
    squares: [...turn.querySelectorAll(".stop-mark > [role=img]")].filter(shows).length,
    secs: [...turn.querySelectorAll(".stop-mark .s")].filter(shows).map((s) => s.textContent),
    buttons: [...turn.querySelectorAll("button:not(.think)")].filter(shows).map((b) => b.getAttribute("aria-label") ?? b.textContent),
    words: [...turn.querySelectorAll(".stopped, .stop-note")].filter(shows).map((e) => e.textContent),
  };
});

async function liveThenSaved(page: Page, reply: Locator, hold: Awaited<ReturnType<typeof holdCancel>>, name: string) {
  await page.mouse.move(1, 1);
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(reply.getByRole("img", { name: UNSEEN, exact: true }).first()).toBeVisible();
  await expect.poll(() => hold.held(), { message: "Stop's cancel is held" }).toBeGreaterThan(0);
  await page.mouse.move(1, 1);
  await page.waitForTimeout(300);
  const live = await drawn(reply);
  const box = (await reply.boundingBox())!;
  const clip = { x: Math.max(0, box.x - 16), y: Math.max(0, box.y + box.height - 140), width: box.width + 32, height: 156 };
  await page.screenshot({ path: shot(`${name}.png`), clip });
  await reply.hover();
  await page.waitForTimeout(300);
  const liveHover = await drawn(reply);
  await page.mouse.move(1, 1);
  hold.letGo();
  // the server has ended the turn: its Regenerate (or the old Retry) is on
  await expect(reply.locator("[data-regen]").last()).toBeEnabled({ timeout: 10_000 });
  await page.waitForTimeout(300);
  const saved = await drawn(reply);
  await reply.hover();
  await page.waitForTimeout(300);
  const savedHover = await drawn(reply);
  console.log(`DRAWN ${name} ${JSON.stringify({ live, saved, liveHover, savedHover })}`);
  return { live, saved, liveHover, savedHover };
}

test.describe("a reply the person stopped draws the same row", () => {
  test("while the stop is on its way and once its saved reply takes over, stopped while writing", async ({ page, open }) => {
    const hold = await holdCancel(page);
    await open(); await waitReady(page);
    await stack.scenario("slow-drip", { holdAfterTokens: 46 });
    await sendMessage(page, "How do I check disk space before a download?");
    const reply = page.locator(".turn.a").last();
    await expect(reply.locator(".md ul li")).toHaveCount(3, { timeout: 15_000 });
    const d = await liveThenSaved(page, reply, hold, "trim2-9-writing");
    await expect(page.locator(".turn.a.interrupted")).toHaveCount(1);
    expect(d.live.squares, "the square shows from Stop").toBe(1);
    expect(d.saved, "at rest, the saved row draws what the live row drew").toEqual(d.live);
    expect(d.savedHover, "on hover too").toEqual(d.liveHover);
    expect(d.liveHover.secs, "Stop's seconds, on hover as on a finished reply's facts").toEqual([expect.stringMatching(/^\d+ s$/)]);
  });

  test("while the stop is on its way and once the turn has ended, stopped while thinking, with the seconds once", async ({ page, open }) => {
    const hold = await holdCancel(page);
    await open(); await waitReady(page);
    await stack.scenario("slow-drip", { holdThinkingAfterTokens: 6 });
    await sendMessage(page, "Check disk space");
    const reply = page.locator(".turn.a").last();
    await expect(reply.locator("button.think")).toContainText("Thinking");
    const d = await liveThenSaved(page, reply, hold, "trim2-9-thinking");
    expect(d.live.squares).toBe(1);
    expect(d.saved).toEqual(d.live);
    expect(d.savedHover).toEqual(d.liveHover);
    for (const state of [d.live, d.liveHover, d.saved, d.savedHover]) {
      // one place says how long: the thought's pill, never the pill and the square side by side
      expect(state.pill).toMatch(/^Thought for \d+ s$/);
      expect(state.secs).toEqual([]);
    }
  });
});

// ------------------------------------------------------------------ 8. Ctrl K from a screen ends in the Search field

for (const width of [1280, 800]) {
  test.describe(`Ctrl K from a screen at ${width} px`, () => {
    test.use({ viewport: { width, height: 800 } });
    for (const screen of width === 1280 ? ["Settings", "Usage"] : ["Settings"]) {
      test(`leaves ${screen} with the Search field focused, after the composer's and the drawer's own focus`, async ({ page, open }) => {
        await open(); await waitReady(page);
        if (screen === "Settings") {
          await page.keyboard.press("Control+Comma");
          await expect(page.locator(".set")).toBeVisible();
        } else {
          await page.getByRole("button", { name: "Usage", exact: true }).click();
          await expect(page.getByRole("dialog", { name: "Usage" })).toBeVisible();
        }
        await page.keyboard.press("Control+k");
        await expect(page.locator("#searchIn")).toBeFocused();
        // every focus queued for that frame has run: the field still has it
        await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 200)))));
        const focused = await page.evaluate(() => document.activeElement?.id || document.activeElement?.className || "");
        console.log(`CTRL_K ${width} ${screen} ${focused}`);
        await expect(page.locator("#searchIn")).toBeFocused();
        await expect(page.locator(".set")).toHaveCount(0);
      });
    }
  });
}
