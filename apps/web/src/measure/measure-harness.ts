import type { PageAction } from "@gates-local/contracts";

const STEP_MS = 40;

export function harness(token: string, script: readonly PageAction[], stepMs: number) {
  const seen: string[] = [];
  // oxlint-disable-next-line unicorn/consistent-function-scoping, gates/timer-needs-reason -- runs in the page's frame, which has none of the app's helpers; two frames let the page draw
  const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  // oxlint-disable-next-line gates/timer-needs-reason -- runs in the page's frame: the step's time between a person's actions
  const wait = () => new Promise((resolve) => setTimeout(resolve, stepMs)).then(frame);
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- the frame runs this function from its source text, so its helpers live inside it
  const text = (el: Element) => (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement ? el.value : el.textContent ?? "").trim();
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- the frame runs this function from its source text, so its helpers live inside it
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

export function framed(page: string, token: string, script: readonly PageAction[], stepMs = STEP_MS): string {
  return `${page}<script>(${harness.toString()})(${JSON.stringify(token)}, ${JSON.stringify(script)}, ${stepMs});</script>`;
}
