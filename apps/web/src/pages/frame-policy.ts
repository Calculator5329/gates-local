// The app's own frame policy, narrowed to the one server this window talks to.
//
// index.html lets a frame load this computer's page route on any port, because
// the port is not known when the client is built. A page a model wrote can
// still move its own frame, and that policy is all that stops it in a browser
// tab, so once the server's address is known a second policy names that one
// address. Two policies both apply: the frame may go only where both allow.
//
// Only in a browser tab. The desktop app's window is guarded by main, which
// knows the server's port even after a restart (apps/desktop/src/links.ts);
// a policy pinned here could not follow a restart onto a new port. The phone
// listener already serves the client with its own address in the policy.

/** The policy for a server at `origin`, or undefined for anything that is not a bare http(s) origin. */
export function pinnedFramePolicy(origin: string): string | undefined {
  // letters, digits, dots, hyphens, brackets and a port: nothing a policy would read as a second directive
  return /^https?:\/\/[a-z0-9.\-[\]:]+$/i.test(origin) ? `frame-src ${origin}/pages/` : undefined;
}

let pinned = false;

/**
 * Adds the narrowed policy to the document, once for the life of the page.
 * It is called while the connection opens, so it never throws: a document
 * that cannot take the tag keeps the build's policy and the connection goes on.
 */
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
  } catch {
    // no head to write to (a document that is not a page yet): try again on the next connection
  }
}
