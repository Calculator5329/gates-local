import { useEffect, useState } from "react";

/** Use the native API when allowed, otherwise copy a temporary plain-text selection. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Desktop permissions and plain HTTP can make the native API unavailable.
  }
  const active = document.activeElement;
  const field = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement ? active : null;
  const start = field?.selectionStart;
  const end = field?.selectionEnd;
  const direction = field?.selectionDirection;
  const selection = document.getSelection();
  const anchor = selection?.anchorNode;
  const anchorOffset = selection?.anchorOffset ?? 0;
  const focus = selection?.focusNode;
  const focusOffset = selection?.focusOffset ?? 0;
  const ta = document.createElement("textarea");
  try {
    ta.value = text;
    ta.readOnly = true;
    ta.style.cssText = "position:fixed;top:0;left:0;opacity:0";
    document.body.append(ta);
    ta.focus({ preventScroll: true });
    ta.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    ta.remove();
    if (active instanceof HTMLElement) active.focus({ preventScroll: true });
    selection?.removeAllRanges();
    if (anchor && focus) selection?.setBaseAndExtent(anchor, anchorOffset, focus, focusOffset);
    if (start != null && end != null) field?.setSelectionRange(start, end, direction ?? undefined);
  }
}

/** A success flash starts only after copying succeeds; a failure stays until retried. */
export function useCopy(text: string, ms = 1500) {
  const [copied, setCopied] = useState<boolean | null>(null);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(null), ms);
    return () => clearTimeout(timer);
  }, [copied, ms]);
  return [copied, () => {
    setCopied(null);
    void copyText(text).then(setCopied);
  }] as const;
}
