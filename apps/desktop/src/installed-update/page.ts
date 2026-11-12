// The pages an installed update shows in a window with no server behind it:
// the watcher's failure pages, the token launch's "finishing" page, and the
// launch routing's refusals (section 8's sentences). No script runs here: the
// release page and the one action are links, and main catches the navigation
// (an action) or opens it in the system browser (the release page).
import { escapeHtml } from "../status-page.ts";
import type { Words } from "./words.ts";

const ACTION_SCHEME = "gates-local-update:";
export type PageAction = "continue";
const LABELS: Record<PageAction, string> = { continue: "Start Gates Local" };

export interface UpdatePage {
  readonly words: Words;
  /** The release page, for words that send the person there. */
  readonly releasePage: string | null;
  readonly actions: readonly PageAction[];
}

export function renderUpdatePage(p: UpdatePage): string {
  const link = p.words.link === true && p.releasePage !== null ? `<p><a href="${escapeHtml(p.releasePage)}">Release page</a></p>` : "";
  const actions = p.actions.map(a => `<p><a class="action" href="${ACTION_SCHEME}${a}">${LABELS[a]}</a></p>`).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>Gates Local</title>
<style>
body{margin:0}
.titlebar{box-sizing:border-box;height:max(52px,env(titlebar-area-height,52px));display:flex;align-items:center;overflow:hidden;white-space:nowrap;-webkit-app-region:drag;padding-left:max(16px,calc(env(titlebar-area-x,0px) + 16px));padding-right:calc(100vw - env(titlebar-area-width,calc(100vw - 138px)) - env(titlebar-area-x,0px) + 16px)}
main{padding:24px;max-width:720px}
</style>
</head>
<body>
<header class="titlebar">Gates Local</header>
<main>
<p>${escapeHtml(p.words.text)}</p>
${p.words.detail === undefined ? "" : `<p>${escapeHtml(p.words.detail)}</p>`}
${link}
${actions}
</main>
</body>
</html>`;
}

/** The action a navigation names, or null for any other address. */
export function pageAction(url: string): PageAction | null {
  if (!url.startsWith(ACTION_SCHEME)) return null;
  const name = url.slice(ACTION_SCHEME.length);
  return Object.hasOwn(LABELS, name) ? (name as PageAction) : null;
}
