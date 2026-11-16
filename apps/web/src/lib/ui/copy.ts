import { useRef } from "react";
import { useFlash } from "./kit/flash.ts";

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // external: browsers refuse navigator.clipboard over plain HTTP or without permission
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
  const caret = anchor === focus && anchorOffset === focusOffset;
  const inField = field != null && (!anchor || (caret && (anchor === field || anchor.contains(field))));
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
    if (inField) {
      if (start != null && end != null) field?.setSelectionRange(start, end, direction ?? undefined);
    } else {
      selection?.removeAllRanges();
      if (anchor && focus) selection?.setBaseAndExtent(anchor, anchorOffset, focus, focusOffset);
    }
  }
}

export function useCopy(text: string, ms = 1500) {
  const [copied, setCopied] = useFlash<boolean>(ms, (ok) => !ok);
  const attempt = useRef(0);
  return [copied, () => {
    const current = ++attempt.current;
    setCopied(null);
    void copyText(text).then((ok) => {
      if (current === attempt.current) setCopied(ok);
    });
  }] as const;
}
