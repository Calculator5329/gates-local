// Structural ambiguity is held briefly; ordinary prose is revealed at the
// steady pace chosen by the owner. Text saved by the server is untouched.
// The last separator cell may still be empty or have just its first dash.
const RULE_PREFIX = /^\s*\|?\s*(?::?-{2,}:?\s*\|\s*)*(?::?-*|:?-{2,}:)\s*$/;

export function reveal(text: string, streaming: boolean): string {
  if (!streaming) return text;
  const lines = text.split("\n");
  let offset = 0;
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const last = i === lines.length - 1;
    // Leading whitespace may still belong to a fence or another marker.
    if (last && /^\s+$/.test(line)) return text.slice(0, offset);
    if (/^\s*```/.test(line)) {
      if (!fence && last) return text.slice(0, offset);
      fence = !fence;
    } else if (fence) {
      if (last && /^\s*`{1,2}$/.test(line)) return text.slice(0, offset);
    } else {
      if (last && /^(#{1,4}|`{1,2}|[-+*]|\d+[.)]?)$/.test(line.trim())) return text.slice(0, offset);
      // A pipe does not disprove prose. Keep the header visible, withholding
      // only a possible delimiter until its newline proves a complete row.
      // Markdown then replaces the paragraph with a table in the same slot.
      if (last && (lines[i - 1] ?? "").includes("|") && RULE_PREFIX.test(line)) return text.slice(0, offset);
    }
    offset += line.length + 1;
  }
  return text;
}
