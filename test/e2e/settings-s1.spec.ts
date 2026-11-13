/// <reference lib="dom" />
// Journeys: the Settings sections the S1 council asked for. The Tools switch
// really changes what a chat is offered, the Shortcuts page lists bindings
// that work, Theme and Accent apply at once and persist (Text size is gone), Reset puts the
// settings back, and no section scrolls sideways at 1280 or 360 px.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { type Params, createClient } from "@gates-local/contracts";
import type { Page } from "@playwright/test";
import { CHECKOUT_CACHE, FAKE_URL } from "./env.ts";
import { expect, sendMessage, test, waitReady } from "./fixtures.ts";

const section = async (page: Page, label: string) => {
  await page.keyboard.press("Control+Comma");
  await page.locator(".snav").getByRole("button", { name: label, exact: true }).click();
};

const replied = async (page: Page, count: number) => {
  await expect(page.locator(".turn.a.done")).toHaveCount(count, { timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Stop" })).toHaveCount(0);
};

interface ChatRequest {
  path: string;
  body: { tools?: unknown[]; messages?: { content?: string }[] };
}

/** Whether any chat request carrying this text offered the model tools. */
async function toolsOffered(text: string): Promise<boolean> {
  const state = (await (await fetch(`${FAKE_URL}/__fake/state`)).json()) as { requests: ChatRequest[] };
  const asked = state.requests.filter((r) => r.path === "/api/chat" && r.body.messages?.some((m) => m.content?.includes(text)));
  expect(asked.length).toBeGreaterThan(0);
  return asked.some((r) => (r.body.tools?.length ?? 0) > 0);
}

test("the Tools switch decides whether a chat is offered tools", async ({ page, open }) => {
  const folder = path.join(CHECKOUT_CACHE, "e2e-library", "tools-notes");
  mkdirSync(folder, { recursive: true });
  await open();
  await waitReady(page);
  await section(page, "Library");
  await page.getByRole("button", { name: "Add folder…" }).click();
  await page.getByRole("textbox", { name: "Add a folder path" }).fill(folder);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.locator(".srow .sl b", { hasText: "tools-notes" })).toBeVisible();
  await page.keyboard.press("Escape");
  await waitReady(page);

  await sendMessage(page, "first question with tools on");
  await replied(page, 1);
  expect(await toolsOffered("first question with tools on")).toBe(true);

  await section(page, "Tools");
  const master = page.getByRole("switch", { name: "Let the model use tools" });
  await expect(master).toHaveAttribute("aria-checked", "true");
  await master.click();
  await expect(master).toHaveAttribute("aria-checked", "false");
  await page.keyboard.press("Escape");
  await waitReady(page);

  await sendMessage(page, "second question with tools off");
  await replied(page, 2);
  expect(await toolsOffered("second question with tools off")).toBe(false);
});

test("Tools names only the tools the app has", async ({ page, open }) => {
  await open();
  await waitReady(page);
  await section(page, "Tools");
  const set = page.locator(".set");
  await expect(set.getByRole("heading", { name: "Tools" })).toBeVisible();
  await expect(set.locator(".srow .sl b")).toHaveText(["Let the model use tools", "Read files", "Run commands", "Make images"]);
  await expect(set).not.toContainText(/\bnotes?\b/i);
  // where each permission lives is one click away
  await set.getByRole("button", { name: /^Read files/ }).click();
  await expect(set.getByRole("heading", { name: "Library" })).toBeVisible();
});

test("the Shortcuts page lists the bindings that work, and nothing else", async ({ page, open }) => {
  await open();
  await waitReady(page);
  await section(page, "Shortcuts");
  const set = page.locator(".set");
  const names = (group: string) => set.locator(".grp", { hasText: group }).locator("td:first-child");
  const keys = (what: string) => set.locator("tr", { hasText: what }).locator("kbd");
  await expect(names("Navigation")).toHaveText(["New thread", "Search threads", "Choose a model", "Settings", "Close a menu or Settings", "Open a thread's menu"]);
  await expect(names("Chat")).toHaveText(["Send", "New line", "Start or stop dictation", "Cancel dictation"]);
  await expect(keys("Start or stop dictation")).toHaveText(["Ctrl", "Shift", "Space"]);
  await expect(keys("Cancel dictation")).toHaveText(["Esc"]);
  await expect(keys("New thread")).toHaveText(["Ctrl", "N"]);
  await expect(keys("Choose a model")).toHaveText(["Ctrl", "M"]);
  await expect(set).not.toContainText("Approve a pending note");
  await expect(page.locator(".snav").getByRole("button").last()).toHaveText("Shortcuts");

  // each listed binding does what its row says
  await page.keyboard.press("Escape");
  await expect(page.locator(".set")).toHaveCount(0);
  await page.keyboard.press("Control+m");
  await expect(page.locator("#picker")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#picker")).toBeHidden();
  await page.keyboard.press("Control+k");
  await expect(page.locator("#searchIn")).toBeFocused();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+Comma");
  await expect(page.locator(".set")).toBeVisible();
  await page.keyboard.press("Escape");
  await waitReady(page);

  const ta = page.locator("#ta");
  await ta.fill("one");
  await ta.press("Shift+Enter");
  await ta.pressSequentially("two");
  await expect(ta).toHaveValue("one\ntwo");
  await ta.press("Enter");
  await replied(page, 1);
  await expect(ta).toHaveValue("");

  await page.keyboard.press("Control+n");
  await expect(page.locator(".turn.a")).toHaveCount(0);
  const row = page.locator(".sb-row").first();
  await row.locator(".sb-thread").focus();
  await page.keyboard.press("Shift+F10");
  await expect(page.locator("#threadMenu")).toBeVisible();
});

test("there is no Text size: messages and the message box are 15 px, even after an older app saved Large", async ({ page, open }) => {
  await open();
  await waitReady(page);
  // what an app from before the removal sends; it must not fail, and it changes nothing
  const server = new URL(page.url()).searchParams.get("server");
  if (!server) throw new Error("No test server URL");
  const old = createClient(new WebSocket(server));
  await old.call("settings.update", { textSize: "large" } as Params<"settings.update">);
  old.close();
  await page.reload();
  await waitReady(page);
  await sendMessage(page, "How big is this text?");
  await replied(page, 1);
  const fontSize = (selector: string) => page.locator(selector).first().evaluate((el) => getComputedStyle(el).fontSize);
  expect(await fontSize(".md")).toBe("15px");
  expect(await fontSize("#ta")).toBe("15px");
  expect(await fontSize(".bubble")).toBe("15px");
  await expect(page.locator("html")).not.toHaveAttribute("data-text", /./);

  await section(page, "General");
  await expect(page.getByRole("group", { name: "Theme" })).toBeVisible();
  await expect(page.getByText("Text size", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("group", { name: "Text size" })).toHaveCount(0);
  await page.locator(".snav").getByRole("button", { name: "Advanced", exact: true }).click();
  await page.getByRole("button", { name: "Reset…" }).click();
  await expect(page.getByRole("group", { name: "Confirm reset" })).not.toContainText("text size");
});

test("Theme applies the moment it is picked, and says only what the choice does", async ({ page, open }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await open();
  await waitReady(page);
  await section(page, "General");
  const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const dark = await bg();
  const theme = page.getByRole("group", { name: "Theme" });
  const row = page.locator(".srow", { has: theme });
  await expect(theme.getByRole("button")).toHaveText(["Dark", "Light", "System"]);
  await expect(theme.getByRole("button", { name: "Dark" })).toHaveAttribute("aria-pressed", "true");
  // The choice speaks for itself; what System means is in the label's tooltip.
  await expect(row.locator(".d")).toHaveCount(0);
  // a pointer reaches it here; keyboard focus shows the same tooltip only when focus is visible
  await row.locator(".tipped", { hasText: "Theme" }).hover();
  await expect(page.locator("#tip")).toContainText("System follows your desktop's light or dark setting.");

  await theme.getByRole("button", { name: "Light" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(await bg()).not.toBe(dark);
  await expect(theme.getByRole("button", { name: "Light" })).toHaveAttribute("aria-pressed", "true");

  await theme.getByRole("button", { name: "System" }).click();
  await expect(page.locator("html")).not.toHaveAttribute("data-theme", /./);
  expect(await bg()).toBe(dark);
  await expect(theme.getByRole("button", { name: "System" })).toHaveAttribute("aria-pressed", "true");
});

test("Accent starts Neutral, a pick sets --accent at once in this theme's step, the semantic colours stay, and it survives a reload", async ({ page, open }) => {
  await open();
  await waitReady(page);
  const token = (name: string) => page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);
  const semantic = async () => [await token("--green"), await token("--amber"), await token("--red")];
  await section(page, "General");
  const accent = page.getByRole("group", { name: "Accent" });
  await expect(accent.getByRole("button")).toHaveCount(6);
  for (const [i, name] of ["Neutral", "Green", "Blue", "Violet", "Amber", "Red"].entries()) await expect(accent.getByRole("button").nth(i)).toHaveAccessibleName(name);
  await expect(accent.getByRole("button", { name: "Neutral" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("html")).not.toHaveAttribute("data-accent", /./);
  expect(await token("--accent")).toBe(await token("--foreground"));
  const before = await semantic();

  await accent.getByRole("button", { name: "Blue" }).click();
  await expect(accent.getByRole("button", { name: "Blue" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("html")).toHaveAttribute("data-accent", "blue");
  expect(await token("--accent")).toBe("#3b82f6");
  expect(await semantic()).toEqual(before);
  await page.getByRole("group", { name: "Theme" }).getByRole("button", { name: "Light" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(await token("--accent")).toBe("#2563eb");

  await page.reload();
  await waitReady(page);
  await expect(page.locator("html")).toHaveAttribute("data-accent", "blue");
  await section(page, "General");
  await expect(page.getByRole("group", { name: "Accent" }).getByRole("button", { name: "Blue" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("group", { name: "Accent" }).getByRole("button", { name: "Neutral" }).click();
  await expect(page.locator("html")).not.toHaveAttribute("data-accent", /./);
  expect(await token("--accent")).toBe(await token("--foreground"));
});

test("Reset settings asks first, then puts the settings back and leaves who runs Ollama alone", async ({ page, open }) => {
  await open();
  await waitReady(page);
  await section(page, "General");
  await page.getByRole("group", { name: "Theme" }).getByRole("button", { name: "Light" }).click();
  await page.getByRole("group", { name: "Accent" }).getByRole("button", { name: "Violet" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-accent", "violet");

  await page.locator(".snav").getByRole("button", { name: "Advanced", exact: true }).click();
  await page.getByRole("button", { name: "Reset…" }).click();
  const confirm = page.getByRole("group", { name: "Confirm reset" });
  await expect(confirm).toContainText("Your chats, Library and downloaded models stay.");
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

  await page.getByRole("button", { name: "Reset…" }).click();
  await page.getByRole("group", { name: "Confirm reset" }).getByRole("button", { name: "Reset", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("html")).not.toHaveAttribute("data-accent", /./);
  await expect(page.getByRole("group", { name: "Confirm reset" })).toHaveCount(0);
});

const SECTIONS = ["General", "Library", "Tools", "Image generation", "Runtime", "Advanced", "Shortcuts", "Models", "Instructions"] as const;

for (const width of [1280, 360] as const) {
  test.describe(`at ${width} px`, () => {
    test.use({ viewport: { width, height: 800 } });
    test("no Settings section scrolls sideways", async ({ page, open }) => {
      await open();
      await waitReady(page);
      await page.keyboard.press("Control+Comma");
      for (const label of SECTIONS) {
        if (width === 360) {
          // a phone has no section nav: back to the list, then the section
          await page.getByRole("button", { name: "Back to Settings" }).click();
          await page.locator(".set-list").getByRole("button", { name: label }).click();
        } else {
          await page.locator(".snav").getByRole("button", { name: label, exact: true }).click();
        }
        await expect(page.locator(".set h1").first()).toHaveText(label);
        const over = await page.evaluate(() => {
          const set = document.querySelector(".set");
          const root = document.documentElement;
          return { page: root.scrollWidth - root.clientWidth, set: set === null ? -1 : set.scrollWidth - set.clientWidth };
        });
        expect(over, label).toEqual({ page: 0, set: 0 });
      }
    });
  });
}
