import { linkKey, urlsFromText, type Message, type ToolStep } from "@gates-local/contracts";

/** Undefined preserves ordinary and pre-provenance replies. Queued image turns with metadata check exact URLs. */
export function imageTurnLinks(messages: readonly Message[], steps: readonly ToolStep[]): ReadonlySet<string> | undefined {
  if (!steps.some(step => step.name === "image" && step.state === "done") || !steps.some(step => step.links !== undefined)) return undefined;
  const allowed = new Set<string>();
  const fromTools = (tools: readonly ToolStep[]) => {
    for (const step of tools) if (step.state === "done") for (const value of step.links ?? []) {
      const key = linkKey(value);
      if (key !== undefined) allowed.add(key);
    }
  };
  for (const message of messages) {
    if (message.role === "user") for (const url of urlsFromText(message.content)) allowed.add(url);
  }
  fromTools(steps);
  return allowed;
}
