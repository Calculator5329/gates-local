/** Insert one native editing transaction so the textarea's normal undo/redo
 * works. Keep selected words: callers insert at the start of the selection.
 * React's existing onChange receives the native input event and owns the draft.
 * False means the browser could not make an undoable edit; do not replace value.
 */
export function insertAtCursor(textarea: HTMLTextAreaElement, text: string): boolean {
  try {
    if (typeof textarea.ownerDocument.execCommand !== "function") return false;
    const cursor = textarea.selectionStart;
    // End any preceding typing group so one undo removes just this insertion.
    textarea.blur();
    textarea.focus({ preventScroll: true });
    textarea.setSelectionRange(cursor, cursor);
    // Focus can fail for an inert composer, or a focus handler can move it.
    if (textarea.ownerDocument.activeElement !== textarea) return false;
    return textarea.ownerDocument.execCommand("insertText", false, text);
  } catch { return false; }
}
