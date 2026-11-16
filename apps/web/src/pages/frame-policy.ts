export function pinnedFramePolicy(origin: string): string | undefined {
  return /^https?:\/\/[a-z0-9.\-[\]:]+$/i.test(origin) ? `frame-src ${origin}/pages/` : undefined;
}

let pinned = false;

export function pinFramePolicy(origin: string, doc: Document = document): void {
  if (pinned) return;
  const policy = pinnedFramePolicy(origin);
  if (policy === undefined) return;
  try {
    const meta = doc.createElement("meta");
    meta.httpEquiv = "Content-Security-Policy";
    meta.content = policy;
    doc.head.append(meta);
    pinned = true;
  } catch {}
}
