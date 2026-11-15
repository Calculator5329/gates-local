import { callRule } from "./rule.ts";

export default callRule(
  "A browser test waits for a condition, never for a time.",
  call => call.name === "waitForTimeout" && call.on !== undefined,
  "A fixed wait passes on a fast machine and fails on a slow one. Wait for the thing itself: "
    + "a locator (`await expect(locator).toBeVisible()`), a response (`page.waitForResponse`), "
    + "or a state the page reports (`page.waitForFunction`). "
    + "If the time itself is what the test measures, say so on the line above: "
    + "`// oxlint-disable-next-line gates/no-wait-for-timeout -- <why a time and not a condition>`.",
);
