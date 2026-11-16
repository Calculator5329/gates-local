export function insertAtCursor(textarea: HTMLTextAreaElement, text: string, range?: { start: number; end: number }): boolean {
  try {
    if (typeof textarea.ownerDocument.execCommand !== "function") return false;
    const cursor = textarea.selectionStart;
    textarea.blur();
    textarea.focus({ preventScroll: true });
    textarea.setSelectionRange(range?.start ?? cursor, range?.end ?? cursor);
    if (textarea.ownerDocument.activeElement !== textarea) return false;
    return textarea.ownerDocument.execCommand("insertText", false, text);
  } catch { return false; }
}
