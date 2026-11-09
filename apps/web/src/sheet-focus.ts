/** A fit update can replace a focused option. Keep the open phone sheet modal between key presses too. */
export function keepSheetFocus(sheet: HTMLElement): () => void {
  const restore = () => {
    if (!sheet.contains(document.activeElement)) sheet.querySelector<HTMLElement>(".sh-h .ibtn")?.focus({ preventScroll: true });
  };
  restore();
  const observer = new MutationObserver(restore);
  observer.observe(sheet, { childList: true, subtree: true });
  return () => observer.disconnect();
}
