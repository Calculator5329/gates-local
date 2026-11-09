/** A fit update can replace a focused option. Keep the open phone sheet modal between key presses too. */
export function keepSheetFocus(sheet: HTMLElement): () => void {
  const restore = () => {
    if (!sheet.contains(document.activeElement)) [...sheet.querySelectorAll<HTMLElement>(".sh-h .ibtn, .pk-close, .pk-back")].find(el => el.getClientRects().length > 0)?.focus({ preventScroll: true });
  };
  restore();
  const observer = new MutationObserver(restore);
  observer.observe(sheet, { childList: true, subtree: true });
  return () => observer.disconnect();
}
