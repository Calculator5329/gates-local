/** Compare complete HTTP URLs, not origins or prefixes. Invalid targets never match. */
export function linkKey(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch { return undefined; }
}

/** URLs supplied as text or Markdown targets; sentence punctuation is not part of a bare URL. */
export function urlsFromText(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/\[[^\]]*\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s<>"'`)\]]+)/gi)) {
    const value = match[1] ?? match[2]?.replace(/[.,;:!?]+$/, "");
    const key = value === undefined ? undefined : linkKey(value);
    if (key !== undefined) found.add(key);
  }
  return [...found];
}
