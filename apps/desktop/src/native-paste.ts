export interface PasteResult { paths: string[]; skipped: boolean; failed?: boolean; }

// Main runs both scripts in one private isolated world. The page cannot read
// this captured element or replace it by making another textarea with its id.
export const capturePaste = (id: string): string => `(() => {
  const element = document.activeElement;
  if (!(element instanceof HTMLTextAreaElement) || element.id !== "ta" || element.disabled || element.readOnly || element.dataset.draftVersion === undefined) return false;
  globalThis.gatesNativePaste = { id: ${JSON.stringify(id)}, element, version: element.dataset.draftVersion, href: location.href, value: element.value, start: element.selectionStart, end: element.selectionEnd };
  return true;
})()`;

export const finishPaste = (id: string, result?: PasteResult): string => `(() => {
  const operation = globalThis.gatesNativePaste;
  if (operation?.id !== ${JSON.stringify(id)}) return false;
  delete globalThis.gatesNativePaste;
  const result = ${JSON.stringify(result ?? null)};
  const element = operation.element;
  if (!result || !element.isConnected || document.activeElement !== element || location.href !== operation.href || element.dataset.draftVersion !== operation.version || element.value !== operation.value || element.disabled || element.readOnly) return false;
  if (result.paths.length || result.skipped || result.failed) element.dispatchEvent(new CustomEvent("gates-local:native-paste", { bubbles: true, detail: { ...result, version: Number(operation.version), start: operation.start, end: operation.end } }));
  return true;
})()`;
