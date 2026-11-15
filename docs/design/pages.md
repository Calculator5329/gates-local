# Pages: what a model-written page can and cannot do

A page is HTML a local model wrote, possibly steered by a document the
person fed in. The app treats it as hostile. It runs script, in a frame.

## How it is held

- The server serves the page once, from an address with no token in it
  (`apps/server/src/pages/route.ts`). The limits travel with it as
  response headers, so the page cannot take them off.
- No network: nothing loads from or goes out to anywhere but `data:`
  addresses. No child frames, no forms, no popups, no storage, an opaque
  origin.
- The WebRTC constructors are removed before the page's own script runs.
- Every script element gets a one-time code from the server as the page
  is served. A `javascript:` address carries no code, so the page cannot
  swap its document for a fresh one (which would have WebRTC back). The
  code is not a secret from the page: its own script can read it. All it
  does is tell a script element from a `javascript:` address.
- A second policy travels beside the first, and a script must pass
  both. It allows only script written in the page, so a script element
  with an address is never fetched, whatever code it carries.
- In a chat the app's window does not listen to the frame. While
  Measure runs a page check, the window takes the check's results from
  its own page frame as plain text; the page under test can read the
  check's code, so a page could report results it did not earn. They
  go into the score and nowhere else.
- A frame cannot be moved to an address outside the page route: the
  desktop app refuses the move and the frame stays as it was; in a
  browser the frame may only load the page route, where any address but
  an unused page's answers with an empty page.
- A link or text dragged out of the page onto the app's window is
  refused anywhere a person could not type: a checkbox, a slider, a
  button and a disabled or read-only field count as such.

`test/e2e/pages-lockdown.spec.ts` runs a probe page against these in
Chromium.

## What a page can still do

Chromium (the desktop app, and Chrome or Edge on a phone):

- **Ask the browser to look up or connect to a host.** A
  `<link rel="dns-prefetch">` or `<link rel="preconnect">` is not
  governed by the content policy. The server sends
  `X-DNS-Prefetch-Control: off`; whether a lookup or a bare connection
  still leaves has not been proven either way in a test. No page content
  travels on such a connection, but the host name itself can carry a few
  characters.
- **Write the clipboard when the person clicks inside the page**, through
  the old `document.execCommand("copy")`. The app never pastes into
  itself; a person who then pastes somewhere else would paste the page's
  text. Nothing known closes this for a frame that may run script.
- **Use the processor and memory** until the page is closed.
- **Show anything inside its own frame**, including something that looks
  like the app. A page only ever shows in the page panel, and the app
  never asks for anything inside it.

Not available in any shipped browser: a content-policy rule that turns
WebRTC off outright (`webrtc 'block'` is in the draft standard only), so
the constructors are removed by script instead.

Safari and Firefox (a phone or another computer opening the app in a
browser): none of the above has been probed there. The headers are
standard, but treat the list as unknown rather than closed.

## What changed for ordinary pages

A link written as `href="javascript:..."` no longer runs. Handlers
written on elements (`onclick="..."`) and script elements run as before.
