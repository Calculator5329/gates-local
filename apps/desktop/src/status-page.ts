// The small local page main shows while the server is starting, after it
// crashed, or when the web client failed to load. Plain and unstyled on
// purpose: the visual direction is not picked yet. Its buttons call the
// preload bridge (window.gatesLocal), so it works with the sandbox on.

import { describeCrash, type BridgeState } from "./bridge.ts";

export type StatusView =
  | { readonly kind: "server"; readonly state: BridgeState }
  | { readonly kind: "client-load-failed"; readonly url: string; readonly error: string };

export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'">
<title>${escapeHtml(title)}</title>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
${body}
<script>
for (const button of document.querySelectorAll("button[data-action]")) {
  button.addEventListener("click", async () => {
    button.disabled = true;
    const status = document.getElementById("action-status");
    try {
      const result = await window.gatesLocal[button.dataset.action]();
      if (result && result.ok === false && status) {
        status.textContent = result.reason === "rate-limited"
          ? "Restarted too often; try again in " + Math.ceil(result.retryAfterMs / 1000) + " s."
          : "Restart refused: " + result.reason + ".";
        button.disabled = false;
      }
    } catch (error) {
      if (status) status.textContent = String(error);
      button.disabled = false;
    }
  });
}
</script>
</body>
</html>`;
}

export function renderStatusPage(view: StatusView): string {
  if (view.kind === "client-load-failed") {
    return page(
      "The app window could not load",
      `<p>Loading <code>${escapeHtml(view.url)}</code> failed: ${escapeHtml(view.error)}</p>
<p><button data-action="reloadClient">Try again</button></p>
<p id="action-status" role="status"></p>`,
    );
  }
  const { state } = view;
  if (state.status === "crashed") {
    const tail = state.stderrTail.length > 0
      ? `<p>Last server output:</p>\n<pre>${escapeHtml(state.stderrTail.join("\n"))}</pre>`
      : "<p>The server printed nothing on stderr.</p>";
    const blocked = state.restartBlockedUntil !== null
      ? `<p>It has been restarted several times in the last minute; Restart opens again at ${escapeHtml(new Date(state.restartBlockedUntil).toLocaleTimeString())}.</p>`
      : "";
    return page(
      "The Gates Local server stopped",
      `<p>${escapeHtml(describeCrash(state.reason))}</p>
${tail}
${blocked}
<p><button data-action="restart">Restart</button></p>
<p id="action-status" role="status"></p>`,
    );
  }
  if (state.status === "starting" || state.status === "restarting") {
    return page(state.status === "starting" ? "Starting the server" : "Restarting the server", "<p>Waiting for the server to report ready.</p>");
  }
  return page("Gates Local", `<p>Server state: ${escapeHtml(state.status)}.</p>`);
}

export function dataUrl(html: string): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}
