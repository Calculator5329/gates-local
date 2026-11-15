// What uses a Measure page in its frame (measure-pages.ts runs it): the check's actions done as a
// person would, then what the page showed posted back. It imports nothing of the app, so a browser
// test can run each check's reference page through it as the window does.
import type { PageAction } from "@gates-local/contracts";

const STEP_MS = 40;

/** Runs in the frame after the page's own scripts: does each action, then posts what it saw. */
export function harness(token: string, script: readonly PageAction[], stepMs: number) {
  const seen: string[] = [];
  // Between actions: the step's time, then two animation frames, so a page that draws in
  // requestAnimationFrame has drawn before the next action or read.
  // oxlint-disable-next-line unicorn/consistent-function-scoping
  const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const wait = () => new Promise((resolve) => setTimeout(resolve, stepMs)).then(frame);
  // The frame runs this function from its source text, so every helper it uses lives inside it.
  // oxlint-disable-next-line unicorn/consistent-function-scoping
  const text = (el: Element) => (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement ? el.value : el.textContent ?? "").trim();
  // oxlint-disable-next-line unicorn/consistent-function-scoping
  const onScreen = (el: Element) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
  const run = async () => {
    for (const a of script) {
      if (a.do === "visible") {
        seen.push([...document.querySelectorAll(a.target)].filter(onScreen).map(text).join("|"));
        continue;
      }
      const el = document.querySelector(a.target);
      if (!el) {
        if (a.do === "read") seen.push("");
        continue;
      }
      if (a.do === "read") seen.push(text(el));
      else if (a.do === "click") (el as HTMLElement).click();
      else if (a.do === "fill" && "value" in el) {
        // As a person types it: what is there is cleared first, as select-all and Backspace do
        // (keydown, beforeinput, the value gone, input, keyup); then each character's keydown,
        // keypress, beforeinput, the value, input and keyup, in that order; change once at the end.
        // A page may cancel a key, as it can a person's. No focus moves: the app's window keeps its own.
        const input = el as HTMLInputElement;
        if (input.value !== "") {
          const back = { key: "Backspace", bubbles: true, cancelable: true };
          if (input.dispatchEvent(new KeyboardEvent("keydown", back))
            && input.dispatchEvent(new InputEvent("beforeinput", { inputType: "deleteContentBackward", bubbles: true, cancelable: true }))) {
            input.value = "";
            input.dispatchEvent(new InputEvent("input", { inputType: "deleteContentBackward", bubbles: true }));
          }
          input.dispatchEvent(new KeyboardEvent("keyup", { key: "Backspace", bubbles: true }));
        }
        let typed = input.value;
        for (const key of a.text) {
          const keyed = { key, bubbles: true, cancelable: true };
          if (input.dispatchEvent(new KeyboardEvent("keydown", keyed)) && input.dispatchEvent(new KeyboardEvent("keypress", keyed))
            && input.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertText", data: key, bubbles: true, cancelable: true }))) {
            typed += key;
            input.value = typed;
            input.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: key, bubbles: true }));
          }
          input.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true }));
        }
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
      await wait();
    }
  };
  addEventListener("load", () => {
    void wait().then(run).then(
      () => parent.postMessage({ token, seen }, "*"),
      (e: unknown) => parent.postMessage({ token, seen, error: `The check could not use the page: ${String(e)}` }, "*"),
    );
  });
}

/** The page with the harness last; the frame builder puts its policy first. */
export function framed(page: string, token: string, script: readonly PageAction[], stepMs = STEP_MS): string {
  return `${page}<script>(${harness.toString()})(${JSON.stringify(token)}, ${JSON.stringify(script)}, ${stepMs});</script>`;
}
