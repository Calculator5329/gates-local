# Gates Local shell

`shell.html` is the one design harness for the Gates Local chat app. It is a
single file with no network: vanilla HTML, CSS and JS. It started as a copy of
`round-2-t3-faithful.html` (base B), then took the round-1 fix list from
`council-ledger.md` (F01 to F20). Neither round-2 file was changed. The
round-2 fix list (F02b, F07b, F09b, F12b, F16b, F17b, F27 to F33) and the
round-3 fix list (F34 to F52) are applied on top; see the second and third
tables under Locked decisions. Round 3's theme was **one name, one word, one
control per idea**: the same model, fit and context state now reads the same
on every surface. The round-4 fix list (F35b to F60) finishes every state:
nothing a user can reach is a dead end, and every wait says what happens
next (fourth table under Locked decisions).

Open it from disk: `file:///…/docs/design/shell.html?view=thread`.

> **Example data, not measurements.** Every GPU number here is a
> made-up example sized to an RTX 5070 Ti (15.9 GB): VRAM held by whisper,
> media-vault and the chat runner, per-model needs at 16k, 32k and 64k,
> first-token times, tok/s, download speeds and ETAs. Model names, disk sizes,
> paths and thread contents are examples too. The app must read real values
> from Ollama and `nvidia-smi`. Never copy these numbers into code or docs as
> facts. The example parts are chosen so the rounded legend adds up
> (15.9 = 2.1 + 1.8 + 12.0, F48).

## Words used everywhere (round 4)

One word per idea, on every surface:

| Idea | The words | Where else they must match |
|---|---|---|
| A model | Friendly name first ("Qwen 3.5 9B"), the tag after it in secondary mono (`qwen3.5:9b`) | picker, Settings › Models, download rows, GPU legend, first run, footer download, reply meta (F34) |
| Verdict | "Runs on GPU", "Uses system memory · slower", "Not enough memory at 16k", always a dot plus the words in the verdict color | picker group headers, GPU panel, Settings rows, download rows, first-run card (F35) |
| Verdict short forms (composer chip) | "16k · on GPU", "64k · system memory", "64k · not enough memory". Each is the full verdict with its verb dropped; the chip's tooltip carries the full verdict ("Qwen 3.5 9B at 16k: Runs on GPU. Click for GPU memory.") | the chip only. "fits" and "won't fit" appear nowhere in the product (F35b) |
| Estimates | "est." in metadata ("est. 8.2 GB at 16k"), "Estimated" in sentences and captions ("Estimated 8.2 GB of 12.0 GB available", picker caption "Estimated at 16k") | never "Est.", never "free", never "fit" as a noun (F35, F48, F35b) |
| GPU memory left for chat | "12.0 GB available"; a number never wraps away from "GB" | never "free" (F48) |
| Context | "Context for this chat" (GPU panel), "Context window" (Settings default), and one visible line that names the alternative: "How much conversation the model can keep in view. **At 32k:** still runs on GPU; uses 1.9 GB more." (or "runs on GPU; uses 3.2 GB less.", "uses system memory, slower; needs 3.3 GB more.") | (F36b) |
| Context used | "Context 60% used" (composer chip); tooltip "Context used: 9.8k of 16k tokens" | (F37b) |
| Off | "Thinking off", "Image off" at secondary-text contrast, next to a switch with a visible outline | composer, `think=pill`, `+` menu mark (F38b) |
| Approve key | "Ctrl Enter" | General shortcuts, approval hint "Enter requests changes · Ctrl Enter approves", Approve tooltip (F41, F53) |
| Reply to a pending note | placeholder "Describe changes to this note…" | the composer under the approval panel only (F53) |
| A message that waits | placeholder "Type now; it sends when setup finishes" (install) or "Type now; it sends when the download finishes" (first model); a sent message shows a clock and "Sends when setup finishes" / "Sends when the download finishes" under an outlined bubble | composer, the queued user turn, first-run helper "You can type now; replies start when the download finishes." (F43b, F44b) |
| First model | "Download your first model" + "Download and start" before; "Downloading your first model" + "Start chatting" during | first run only; "Setting up Ollama" stays the install headline (F44b) |
| Cancel | "Cancel download" (quiet, in the progress line), then "Download cancelled" with the way on | first-run install and first-model download (F54) |
| Recover a stopped reply | "Stopped after 3 s" · "Retry" | stopped reply only (F56) |
| Download in progress | "Downloading · 34%" | picker row, Settings › Models row, sidebar footer (F46) |
| Trust line | "Runs locally on your computer. Nothing you type leaves it." | new thread, first run (F49) |

## Views

| `view=` | What it shows |
|---|---|
| `thread` | A finished thread. The thought line, a tool step row, markdown, and copy/regenerate/meta on hover. |
| `streaming` | The same thread replaying live: "Thinking" (a counter appears after 1 s), then the tool row spinning, then the reply text with a caret at the stream head. Once text arrives the caret is the only indicator; there is no "Writing…" row (F58). Stop works. |
| `new` | Empty state. The headline, the trust line, the composer at optical centre, and cards only for what works now (F47): Explain and Draft always, "Search my library" once sources exist, "Generate an image" once image generation is on. What still needs setup is a quiet link under the cards ("Set up library search…", "Set up image generation…"). With `queued=1` it shows a message sent during setup, waiting (F43b). |
| `picker` | The thread with the model picker open. The list ends between rows and shows a thin thumb when it scrolls (F55). |
| `fit` | The thread with the fit details open. By default (`fit=panel`) that is the GPU memory panel docked to the right of the thread, which narrows the thread instead of covering it. `fit=side` and `fit=above` show the popover instead. |
| `runtime` | A runtime banner docked directly above the composer. The state comes from `runtime=`. `installing` and `missing` show on a new thread (no chat can have happened yet); `starting` and `wrong` show on the library thread (F22). |
| `memory` | The thread ending in a proposed note edit, with the approval panel above a live composer. |
| `firstrun` | Full-window first run. The state comes from `first=`; `cancelled=1` shows the state after "Cancel download" (F54). |
| `settings` | Settings. The section comes from `section=`. `section=models&add=1` opens the "Download a model" sub-page. Settings has no top bar (F51). |

## URL params

| Param | Values | Default |
|---|---|---|
| `view` | the nine views above | `thread` |
| `runtime` | `installing` `starting` `missing` `wrong` | `installing` (used only in `view=runtime`, or after first run's installing "Start chatting") |
| `first` | `found` `installing` `nomodels` | `found` |
| `section` | `general` `models` `runtime` `memory` `images` `sources` | `general` |
| `ctx` | `16` `32` `64` | `16` |
| `model` | any model id in the list | `qwen3.5:9b` |
| `theme` | `dark` `light` `system` | `dark` |
| `fit` | `panel` (docked beside the thread) `side` (popover beside the chip) `above` (popover above the chip) | `panel` |
| `think` | `switch` (a plain switch with the label beside it, no pill border, for Thinking and Image; off reads "Thinking off") `pill` (the pill alone: filled when on; outlined and reading "Thinking off" when off). Off keeps secondary-text contrast in both (F38b) | `switch` |
| `queued` | `1` types a message during setup and sends it, so the thread shows it waiting with "Sends when setup finishes" (F43b). Uses `view=new`, or `view=runtime&runtime=installing` for the banner. Example: `view=runtime&runtime=installing&queued=1` | off |
| `cancelled` | `1` opens first run after "Cancel download": with `first=installing`, "Ollama isn't installed" with Retry and Settings › Runtime; with `first=nomodels`, the model card with "Download cancelled. You can choose another model in Settings › Models." (F54) | off |
| `add` | `1` opens Settings › Models › Download a model (with `view=settings&section=models`) | off |
| `dl` | `1` to `99`: Qwen 3.5 14B is shown downloading at that percent, held still for review (no timer). Shows in the picker, Settings › Models, the download sub-page and the sidebar footer (F46). Example: `view=settings&section=models&add=1&dl=34` | off |
| `sources` | `some` `none` (no library yet: the library card becomes a setup link and Settings › Sources shows only the setup path) | `some` |
| `imageGen` | `1` turns image generation on: the Image pill, "Generate image" in `+`, the "Generate an image" card | off |
| `image` | `1` starts with the Image pill on (needs `imageGen=1`) | off |
| `owner` | `system` `app` (who runs Ollama, shown in Settings › Runtime) | `system` |
| `thread` | `lib` `cron` `icon` `bench` `notes` `whisper` `readme` | `lib` |
| `drawer` | `1` opens the design drawer | closed |
| `shot` | `1` hides the harness-only drawer trigger for review screenshots (F25); `D` still opens the drawer | off |

`think=check` from round 2 is gone; an old link with it falls back to
`switch`.

`window.__gl` exposes `state`, `renderView`, `toggleDrawer`, `syncDrawer`,
`openSettings`, `openPicker`, `openFit`, `closeFitPanel` and
`renderComposerState` for scripted screenshots. For example, S-36 sets
`state.thinking = false` and calls `renderComposerState()`.

## Working interactions

- **Sidebar**
  - Click a thread to open it.
  - `Ctrl N` starts a new thread.
  - `Ctrl K` or Search opens an inline filter. `Esc` or blur with no text closes it.
  - A thread that is streaming shows a pulsing dot in place of its time.
  - The full title appears as a tooltip, but only when the title is cut off.
  - Clicking the runtime row opens Settings › Runtime.
  - While a model downloads, a "Downloading · 34%" row sits above the runtime row; its tooltip names the model.
  - Settings (or `Ctrl ,`) swaps the sidebar for the settings nav. `Esc` or "Back to chat" returns. The footer Settings entry hides while Settings is open (F33).
- **Composer**
  - `Enter` sends and `Shift Enter` adds a new line.
  - Send is disabled (gray) with no text, while the runtime isn't ready (except during install and the first-model download, below), or when the model doesn't have enough memory.
  - While Ollama installs, or while the first model downloads, Send works and queues: the message becomes a user turn with an outlined bubble, a clock and "Sends when setup finishes" (or "…when the download finishes"). A message sent from a new thread opens a thread for it. When the install reaches ready, or the download completes, the clock line goes and the reply streams (F43b, F44b).
  - Once a reply starts streaming, the send button becomes Stop. Clicking it ends the reply with "Stopped after N s" and a quiet "Retry" beside it, which regenerates the reply; the reply also gets the normal hover row (F56).
  - The `+` menu (F30, F31):
    - "Attach a file" ("This message only") adds a removable chip.
    - "Add to library…" ("Stays for every chat · opens Sources") opens Settings › Sources.
    - Below a separator: while image generation is off, "Set up image generation…" ("Off · opens Settings") opens Settings › Image generation. Once it is on, "Generate image" has the same on/off mark as the pills, and it toggles the Image pill.
  - The Thinking pill toggles. With it off, the thought line is skipped. `think=switch` shows a plain switch with the label beside it; `think=pill` shows the pill alone, filled when on and outlined with "Thinking off" when off. Off keeps the label at secondary-text contrast, and the switch track has a visible outline, so it reads as a control that is off, not one that is unavailable. The Image pill uses the same convention (F38b).
  - The fit chip reads "16k · on GPU", "64k · system memory" or "64k · not enough memory"; its tooltip gives the full verdict (F35b).
  - The send button's tooltip on a model that doesn't have enough memory says how much more it needs, as an estimate.
  - The context meter is a chip in the chip cluster that reads "Context 60% used". It is hidden below 50% use and on a new thread. Its tooltip reads "Context used: 9.8k of 16k tokens". The `bench` thread (60%) shows it (F37b).
  - While Ollama installs, every control dims the same way, the model chip reads "Qwen 3.5 9B · downloads next", and the placeholder reads "Type now; it sends when setup finishes" (F43b). During the first-model download the chip reads "Qwen 3.5 9B · downloading 14%" and the placeholder "Type now; it sends when the download finishes".
- **Model picker** (click the model chip, or `Ctrl M`)
  - The search box filters by name or tag. The caption at its right reads "Estimated at 16k"; the picker has no context control (F36, F35b).
  - Groups are the three verdict labels, with equal space above and below each header.
  - The list's height is trimmed to end on the last whole row that fits, with 8 px of padding under the last row. When it overflows, a thin 4 px thumb (drawn by the page, in `--scroll-thumb-hover`) shows its position and moves as it scrolls (F55).
  - Arrow keys move the highlight and Enter picks.
  - Number keys and their badges appear only in keyboard mode, after an arrow key or `Ctrl M`.
  - Models without enough memory can't be clicked. Each row's tooltip gives the tag, quant and a reason.
  - Rows read "Qwen 3.5 9B `qwen3.5:9b`", then "est. 8.2 GB at 16k · 6.6 GB on disk · loaded". A model that spills reads "… · 2.6 GB in system memory"; one without enough memory reads "… · needs 0.8 GB more". The selected row has a check in a fixed 16 px slot.
  - A model that is downloading sits in its group, inert, reading "Downloading · 34%".
- **Fit details** (click the fit chip)
  - Default `fit=panel`: a 360 px "GPU memory" panel docks to the right of the thread, with the GPU name as its subtitle. The thread and composer narrow to fit beside it; nothing is covered. The chip stays expanded while the panel is open.
  - The panel holds, in order: the verdict and the estimate sentence, "Context for this chat" with its 16k/32k/64k switch and the visible context line, "Where the memory goes" (bar, axis, legend), and "Measured on last load".
  - The chip again, the close button, or `Esc` closes it and returns focus to the chip. It stays open across thread switches. It closes on Settings and first run, and closes on its own if the composer becomes blocked.
  - `fit=side` and `fit=above` show the same content as a popover instead.
  - The context switch recomputes the bar, the legend, the verdict, the sentence and the context line. This switch is the per-chat context control (F36).
  - The measured block shows first token and generation for the loaded model at its loaded context; otherwise it says when it will be measured.
- **Timeline**
  - The thought line expands to show the reasoning.
  - Clicking a tool row (or pressing Enter or Space on it) expands the command and its output, on the prose column.
  - While a reply streams, the status row ("Thinking", a running tool row) shows only before the first token and during tool phases. Once text arrives the caret at the stream head is the only indicator (F58).
  - Reply and user-turn action icons (copy, regenerate, edit, the copied check) are 16 px glyphs with the same stroke as the other icons, in 24 px targets (F60).
  - Copy flashes a check.
  - Regenerate replays the reply.
  - Edit puts the user's message back in the composer.
  - Every turn is focusable (`tabindex="0"`). Keyboard focus on a turn, or on a button inside it, shows the same actions as hover. A user turn rings its bubble; a reply rings the whole turn. A mouse click shows no ring (F12b).
  - A message that contains "remember" runs the note flow; one that mentions books or the library runs the library flow.
- **Memory**
  - Approve, `Ctrl Enter`, or Reject resolves the panel.
  - The tool row then changes to "Saved a note" or "Note edit rejected", and a short reply streams in.
  - The composer stays live while the note is pending. Its placeholder reads "Describe changes to this note…" and the hint above reads "Enter requests changes · Ctrl Enter approves" (F53).
- **Runtime**
  - Installing counts up live and updates the two-step block, the sidebar % (from the bytes shown) and the overall ETA.
  - When the install finishes it goes to starting, then to ready.
  - Install and Retry in the banner run the same flow.
  - In `wrong`, "Start Gates Local's copy on port 11435" starts the app's copy on that port (the harness goes straight to starting, then ready).
- **First run**
  - Every state has one primary button, named for what it does, and at most one secondary link 16 px after it.
  - found: "Ready to chat", status "Ollama 0.40.4 · 6 local models". "Start chatting" opens a new thread; the link is "Change defaults in Settings".
  - installing: "Setting up Ollama" and the same two-step block as the banner, with a quiet "Cancel download" at the right of the speed line. "Start chatting" opens a new thread with the install still running; the helper reads "You can type now; replies start when setup finishes."
  - installing, cancelled: amber "Download cancelled", the headline "Ollama isn't installed", the line "Gates Local needs Ollama to chat. Retry or point it at an existing install in Settings › Runtime." ("Settings › Runtime" is a link that opens it), and "Retry download", which restarts the install (F54).
  - nomodels, before: "Download your first model", the model card with its 6.6 GB download size, "Download and start" and "Choose another model" (Settings › Models › Download a model).
  - nomodels, downloading: "Downloading your first model", the bar inside the card with "1.5 of 6.6 GB · 48 MB/s · about 2 min left" and a quiet "Cancel download"; "Start chatting" opens a chat to draft in, and the helper reads "You can type now; replies start when the download finishes." When the download completes, a waiting message sends (F44b).
  - nomodels, cancelled: back to "Download your first model" and "Download and start", with "Download cancelled. You can choose another model in Settings › Models." under the button in place of the link (F54).
  - found and nomodels: "Details" (text only, trailing chevron) expands under the model card. It stays open while the download re-renders the card.
- **Settings**
  - The theme switch applies at once.
  - The default model and default context are shared with the composer. The default context lives in Models › Default context window, with the visible context line and the current model's verdict at that context.
  - The image generation switch drives the `+` menu, the Image pill and the image starter card.
  - Models: unselected radios have an outline in the secondary-icon tone (`--muted-foreground`); a downloading model's radio is a dashed `--faint` ring, so it reads as not yet selectable (F57).
  - Models › "+ Download another model…" (the last row of the model list) opens the download sub-page. "‹ Models" or `Esc` returns. Each Download button shows a neutral bar, the percent and a × cancel in its row; the model also shows in the model list and the picker as "Downloading · N%". When done, it joins the default-model list.
  - The "Any model from the Ollama library" Download stays disabled (faint text and border) until the name field has text (F59).
  - Runtime › the switch row's "Switch…" button opens a full-width confirm block under it and stays pressed while the confirm is open. Cancel or `Esc` closes it. "Install and switch" flips who runs Ollama.
- **Escape** closes, in order: an open menu or popover, the drawer, the fit panel, the Runtime confirm, the download sub-page, then Settings itself.
- **Design drawer** (`D` or the swatch icon, harness only)
  - It picks the view, the runtime, first-run and settings states, whether sources exist, the theme, and the two open questions.
  - It shows live contrast ratios and lists what is locked.

## Locked decisions

Rows marked **Superseded** stay for the record; the later row named in
them (round 3 or round 4) is what the harness does now.

| Decision | Fix | Why |
|---|---|---|
| **Black + green only.** The palette, Graphite, Slate, Stone and hue switchers are gone. | F02 | Green means one thing: ready, runs on GPU, send, approve. Stop is a neutral light disc. Reject is a neutral outline. Pending is amber. Not enough memory is red. There is no blue anywhere, including the install banner, which was blue in round 2. |
| **Send states.** Idle is a gray disc with a gray arrow (`#262626` / `#666`). Ready is solid green with a near-black arrow. Stop is `#e6e6e6` with a black square. | F02 | One look per state, so the disc never says "ready" when it isn't. |
| **Adwaita Sans for UI, JetBrainsMono Nerd Font as the one mono.** | F03 | These are the desktop's own fonts, named by family so `local()` lookup finds them with no network. Mono is only for commands, paths, diffs and model tags. Times and sizes use sans with tabular numerals. |
| **Prose column 720 px.** The composer is 752 px, so its text lines up with the prose edge. | F04 | A comfortable line length. Bubbles, tool rows, banners and the approval panel share the same edges. |
| **Spacing 4 / 8 / 12 / 16 / 24 / 32.** Items inside a turn are 8 px apart. ~~24 px from a user message to the reply, about 32 px from reply text to the next user bubble, including the 28 px hover row.~~ **Superseded in part by F40** (one 44 px turn gap). | F05 | One scale ends the ad-hoc gaps. |
| **Secondary text at least `#9a9a9a`** on dark (7.0:1) **and 12–13 px.** `#5e5e5e` is used only for decoration. Light secondary is `#4d4d4d` since F39. | F06 | Above the C1-25 floor of `#8a8a8a`. |
| **Quiet composer:** `+`, the model chip, the fit chip, the Thinking pill, the meter and send. | F07 | The composer is the control centre. The on/off mark is F38's. |
| ~~**Meter:** a 28 px bar with a percentage, hidden below 50% and on a new thread.~~ **Superseded by F37** ("Context 60%" chip). | F08, F23 | The ring read as a spinner and the pie as the theme icon. F37 drops the bar too: a word and a number read as a gauge without a graphic. |
| ~~**Empty state:** a 2×2 grid of plain cards and an image card reading "Set up image generation".~~ **Superseded by F47** (cards only for what works). The headline "What would you like help with?" and the placeholder "Ask anything…" stay. | F09 | The headline differs from the placeholder, and the ellipsis is a real one. |
| **Tool step row:** status icon, then a plain summary ("Searched your library"), then "Shell · read-only · 42 ms", then a chevron. It wraps and is never cut off. It sits on the prose column (F52). | F10 | The summary says what was done; the details are in the expanded row. |
| ~~**One live status row:** "Thinking · N s", the running tool row, then "Writing · N s".~~ **Superseded by F50** ("Writing…" with no counter, a caret at the stream head). One status row stays. | F11 | No duplicate indicators. |
| **Hover/focus actions:** copy, regenerate and meta on replies; time, edit and copy on user messages. Sizes and spacing are F40's. | F12 | The row space is reserved, so nothing jumps on hover. |
| ~~**Approval dock:** an amber "Pending approval" label, a gray "Ctrl ⏎ approves" hint.~~ **Superseded by F41** ("Waiting for approval", "Ctrl Enter"). The panel inside the composer above a live text box, the file name with its path as a tooltip, the diff, neutral Reject and green Approve stay. | F13 | The user can still type, for example to ask for a change to the note. |
| **Header:** the title, then the `…` menu (tooltip "Thread actions"), with no compose icon and a fade mask under it. | F14 | The gear lives in the sidebar. The swatch icon is the harness-only drawer. |
| ~~**Picker wording:** rows show "Est. X GB at Nk · Y GB on disk" and a verdict column.~~ **Superseded by F34 and F35** (name first with the tag; "est."; the verdict is the group header, not a per-row column). The three verdict words stay. | F15 | Plain words. Number keys appear only in keyboard mode. |
| **Numbers:** GB with one decimal and never MiB. The axis is labelled 0 and 15.9 GB. Estimates and measurements are labelled. ~~"Estimate 8.2 GB · measured 6.9 GB"; a measured tier with runner memory.~~ **Superseded in part by F48** (wording "Estimated X of 12.0 GB available · measured 6.9 GB on last load"; no runner-holds figure; tones 25% apart). | F16 | Estimates and measurements are never mixed silently. |
| **Fit popover:** the height is capped and it scrolls. | F17 | It never runs off screen. Since F17b the popover is the non-default `fit` option. |
| **Sidebar:** a brighter selected row. One time format per age band: Today is relative (2m, 3h), Yesterday a clock time, the last 7 days a weekday, older a date. "Ctrl N" is written plainly. The install % shows in the footer. Settings has a gear and space above it. Light values are F39's. | F18 | |
| **Monochrome mark:** a gate glyph drawn in `currentColor`. | F19 | It follows the theme. |
| **Dark is the default.** Light ships through the same tokens. | brief | |
| **Memory proposals:** the reply first says in one line what it will save ("I'll add Effect Schema in Practice to your reading note, marked halfway"), then the pending tool row, then the panel. The diff holds only what was asked: one line out, one line in. | F21 | Round 1's diff also added a "next:" line nobody asked for. |
| **Runtime banners dock above the composer**, like approvals. Installing and missing show on a new thread. | F22 | A banner above a finished conversation implied a chat that could not have happened. |
| **One disclosure convention:** thought and tool rows both lead with an icon (bulb, or the tool status) and end with a chevron that turns over when open. Durations read "4 s", like "42 ms". | F24 | Round 1 had a left chevron on one and a right chevron plus check on the other. |
| **Hover actions sit in the turn gap.** The action row is the first part of the gap after a reply, not extra space added to it. ~~28 px row~~ (24 px since F40). | F24 | Here the gap is the row, so nothing jumps and nothing collides. |
| **Example data stays consistent:** a model that will not fit says "needs 2.3 GB more" (its 18.3 GB need, minus 12.0 GB of GPU memory available and the 4.0 GB spill limit). | F26 | "short 2.3 GB" did not say short of what. |

### Round 2 fixes

| Decision | Fix | Why |
|---|---|---|
| **Install and download progress is neutral gray.** The bar fill is `--muted-foreground` on `--track` in the runtime banner, first run and the download rows. The sidebar footer keeps its amber "installing" dot and a plain percentage. | F02b | Progress is not "ready" yet. F02 keeps green for ready, runs on GPU, send and approve. |
| ~~**Thinking says on or off with a mark.** `think=check` offered a check that replaces the leading icon and fills the pill.~~ **Superseded by F38** (`switch` or `pill`). The default switch inside the pill stays. | F07b | A filled pill alone did not say whether it was on; F38's pill option adds the word "off" so it does. |
| ~~**The trust line is "Runs locally on your computer" in every state**, with "Reads only the docs and databases you added." on the new thread.~~ **Superseded by F49** (one trust line everywhere). | F09b | Two endings for one promise read as two promises. |
| **User turns show time, Edit and Copy on hover.** Every turn is focusable, and keyboard focus on a turn or a button in it shows the same row as hover. A user turn rings its bubble; a reply rings the whole turn with an 8 px offset. Mouse focus shows no ring. | F12b | Keyboard users get the same actions as mouse users. |
| **Every memory need says it is an estimate, and every size says "on disk" or "download".** ~~"Est." and "free".~~ **Wording superseded by F35 and F48** ("est." in metadata, "Estimated" in sentences, "available"). | F16b | A bare GB number could be disk, download, estimate or measurement. |
| **The fit details open as a 360 px panel docked right of the thread** (`fit=panel`, the default, and what `view=fit` opens). The popover stays as `fit=side` and `fit=above`. ~~The legend's runner-holds line and "free".~~ **Legend superseded by F48.** | F17b | The popover covered the latest answer and the composer controls. |
| **Settings › Models has a download sub-page** (`section=models&add=1`) with a one-line reason, download size, estimated verdict and Download per model, and "Something else" for any Ollama library name. ~~Four models under one list.~~ **Grouping superseded by F46** (Recommended holds only GPU models). | F27 | First run pointed at Settings for another model, but Settings had no way to get one. |
| ~~**Context is explained in one line:** "…Larger windows use more memory." as visible text in Settings and a tooltip elsewhere.~~ **Superseded by F36** (one visible line under every context control, with the next step's cost). | F28 | A tooltip hid the one line that explains the setting. |
| ~~**Who runs Ollama is a status value**, with "Use Gates Local's copy…" or "Use the system Ollama…" as the action and a "Who runs it" row.~~ **Superseded by F45** (one status row and a switch row). The confirm's content stays: Ollama 0.40.15, 1.5 GB into `~/.local/share/gates-local/ollama`, the same models folder, port 11435 beside the system Ollama, chats pause about a minute, Cancel and "Install and switch". | F29 | Switching owners installs software and changes the port; it must read as an action with its consequences written out. |
| **The `+` menu separates one message from every chat:** "Attach a file" / "This message only", then "Add to library…" / "Stays for every chat · opens Sources". | F30 | The second line keeps the two lifetimes apart. |
| **Image wording follows the setting.** While image generation is off, the `+` item and the setup link read "Set up image generation…" and open Settings. Only with it on do they read "Generate image" and "Generate an image". | F31 | The menu promised an action its state could not perform. |
| ~~**The first-run model card leads with "Qwen 3.5 · Recommended" and "Runs on your GPU"**, with a "Model details" disclosure (cpu icon).~~ **Superseded by F44 and F35** ("Qwen 3.5 9B · Recommended", "Runs on GPU", "Details" with no icon). The download size once, details under a disclosure, and "On disk" only once installed all stay. | F32 | Hardware detail was as loud as the one decision, which is to start. |
| **Settings shows one selected row.** The footer Settings entry hides while Settings is open. | F33 | Inside Settings it has no job: "Back to chat" and `Esc` already leave. |

### Round 3 fixes

| Decision | Fix | Why |
|---|---|---|
| **The friendly name leads; the tag follows in secondary mono.** "Qwen 3.5 9B `qwen3.5:9b`" in the picker, Settings › Models, download rows and first-run Details; the friendly name alone in the composer chip, fit legend, reply meta and footer. The user's own message may still say a raw tag. | F34 | The same model was "qwen3.5:9b" on one surface and "Qwen 3.5" on another. One name, with the tag where someone might type it. |
| **Exactly three verdict labels**, each a dot plus the words in the verdict color: "Runs on GPU", "Uses system memory · slower", "Not enough memory at 16k". ~~"fits" is the composer chip's word only.~~ **Chip wording superseded by F35b** ("on GPU", "system memory", "not enough memory"; "fits" is gone). Never "RAM". "est." in metadata, "Estimated" in sentences. Picker group headers have equal space above and below, and the check sits in a fixed 16 px slot so names line up. | F35 | Round 3 found five phrasings of one verdict ("fits", "Runs on your GPU", "uses RAM", …). One label set means the user learns it once. |
| **One control per context.** The per-chat context switch lives in the GPU panel ("Context for this chat"); the default lives in Settings › Models ("Context window"). The picker has no control; ~~its caption reads "Fit shown at 16k"~~ (**"Estimated at 16k" since F35b**). Under each control is one visible line: ~~"How much conversation the model can keep in view. 32k: runs on GPU, 1.9 GB more."~~ **Line superseded by F36b** (it names the alternative: "At 32k: still runs on GPU; uses 1.9 GB more."). The Settings segments carry no micro-labels. | F36 | The picker, panel and Settings each had a context switch with different effects. Now the chat one changes the chat and the default one changes the default, and the line says what the next step costs. |
| ~~**The meter reads "Context 60%"**~~ **Wording superseded by F37b** ("Context 60% used"). It stays a chip in the chip cluster, with the token count in its tooltip, hidden below 50% and on a new thread. | F37 | The bar was one more graphic to decode. It sits with the other chips because it is the same kind of status. Supersedes F08. |
| **Thinking (and Image) is one control with two treatments:** `switch` (default, a plain switch with the label beside it, no pill border) and `pill` (filled when on; outlined and reading "Thinking off" when off). ~~Label and bulb dim when off in both.~~ **Superseded by F38b** (off stays at secondary-text contrast with an outlined switch track and says "off"). The `+` menu's Generate image uses the same mark. | F38 | `check` swapped the icon, which made the bulb mean two things. Both remaining options say on and off in words or a familiar switch. Supersedes F07b's `check`. |
| **Light theme reads apart:** secondary text `#4d4d4d` (about 8.4:1 on the pane), the sidebar `#ededed` against the `#fcfcfc` pane, a selected sidebar row at black 11%, and user bubbles `#e4e4e7`. | F39 | The round-3 light shots had gray-on-gray text, a sidebar that merged with the pane, and an invisible selected row. |
| **Turn rhythm:** every turn ends in the same 44 px gap. After a reply, the action row sits 8 px under the text, is 24 px tall with 24 px buttons that each have a tooltip, and leaves 12 px before the next message. The model, first token and tok/s share one metrics slot. A stopped reply gets the same row. | F40 | Gaps differed after replies and user turns, and the row floated. Supersedes the F05 numbers and F24's 28 px. |
| **The approval panel** reads "Waiting for approval" with an amber dot, then "Note edit" and the file name. The hint is plain text: ~~"Reply below to change the note · Ctrl Enter approves"~~ (**"Enter requests changes · Ctrl Enter approves", with the placeholder "Describe changes to this note…", since F53**). Approve's tooltip is "Approve (Ctrl Enter)". "Ctrl Enter" is the key name everywhere, including General › shortcuts. | F41 | "Pending" in caps read as a badge, and "⏎" and "↵" were two glyphs for one key. Supersedes F13's wording. |
| **The wrong-service banner's button reads "Start Gates Local's copy on port 11435".** | F42 | The old label didn't say a second Ollama would start or where. |
| **Install is two steps with one ETA:** "Ollama 1.0 of 1.5 GB" with a neutral bar, then "Qwen 3.5 9B · 6.6 GB · next" muted, then one line "21 MB/s · about 6 min left" for both. The same block is used in the banner and first run. The model chip reads "Qwen 3.5 9B · downloads next", ~~the placeholder "Type now; it sends when Ollama is ready"~~ (**placeholder and the queued message superseded by F43b**: "Type now; it sends when setup finishes", and a sent message waits as a queued turn). Every composer control dims the same way, starter cards are inert, and the sidebar % is computed from the bytes on screen (1.0 of 1.5 GB is 67%). | F43 | The round-3 install showed two ETAs, a % that did not match the bytes, and controls dimmed by different amounts. |
| **First run:** "Ready to chat" with status "Ollama 0.40.4 · 6 local models"; ~~"Start chatting" is the one button in every state; "You can type now; replies start when setup finishes." under it while installing or downloading~~ (**superseded by F44b**: "Download and start" before the first model, "Downloading your first model" during it with "…when the download finishes"; F54 adds Cancel download); the secondary link sits 16 px after the button; the disclosure is "Details" with no icon. A dotted underline marks only text that opens a tooltip (such as "Recommended"); plain links keep a solid underline. | F44 | Three button labels for one action, a right-aligned link that read as unrelated, and dotted underlines on things that were not tooltips. |
| **Settings › Runtime:** the subtitle "Gates Local finds Ollama on its own."; one status row ("Running · Ollama 0.40.4" / "Started by your system · port 11434. Gates Local won't stop it."); a switch row "Switch to Gates Local's copy" / "A private copy it starts and stops" with a "Switch…" button that is pressed while the confirm is open; the confirm spans the full row width; long paths break after slashes. | F45 | Status, owner and the switch were three rows saying one thing. Supersedes F29's layout. |
| **Downloads:** a neutral bar, the percent and a × cancel in the row; "Downloading · 34%" in the picker, Settings › Models and the sidebar footer. On the download page, Recommended holds only models that run on the GPU; Mistral Small sits under "Also available · uses system memory". Settings › Models ends with "+ Download another model…". `dl=` holds a download still for review. | F46 | A green-ish bar, different words per surface and a spilling model under Recommended. Supersedes F27's grouping. |
| **Starter cards only for what works now.** Setup is a quiet link under the cards. | F47 | A card that only opens Settings looked like a feature. Supersedes F09's grid. |
| **The GPU legend:** the GPU name is a subtitle under "GPU memory"; Whisper and other-app grays are at least 25% lightness apart; "Unused" is an outlined empty segment; sentences say "of 12.0 GB available"; the runner-holds figure is gone; every part is rounded once so the legend sums exactly to the axis total. | F48 | Two grays read as one, "free" disagreed with the picker, and the parts did not add up. Supersedes the F16 and F17b legend. |
| **One trust line:** "Runs locally on your computer. Nothing you type leaves it." on the new thread and in the first-run footer. | F49 | Supersedes F09b's two endings. |
| **Streaming:** a caret at the stream head while writing; one dot color for the streaming sidebar row; "Thinking" shows a counter only after 1 s; ~~"Writing…" has no counter~~ (**superseded by F58**: no "Writing…" row at all; once text arrives the caret is the only indicator). | F50 | The counter ticked beside moving text, which read as two progress signals. Supersedes F11's "Writing · N s". |
| **Settings has no top bar.** The section H1 (or the Models breadcrumb) is the header. | F51 | The empty bar above the H1 was a second header saying nothing. |
| **Polish:** the tool row and its expanded card sit exactly on the prose column; the footer "Ctrl ," shows the comma as a legible key; the library tool output lists 2026, 2025, 2024, the order the answer cites them in. | F52 | Small misalignments read as unfinished. |

### Round 4 fixes

From seat G's round-4 review (`rounds/r4/council/G.md`). G4-01 was dismissed
at full resolution, so the Storage row is unchanged. G4-02 to G4-09 became
F53 to F60.

| Decision | Fix | Why |
|---|---|---|
| **The chip uses the verdict's short forms:** "16k · on GPU", "64k · system memory", "64k · not enough memory". The tooltip carries the full verdict. "fits" and "won't fit" are gone from the product, and "fit" is no longer a visible noun: the picker caption reads "Estimated at 16k", the download page "Estimated at your default context, 16k." The short forms are defined in Words used everywhere. | F35b | "fits" was a fourth phrasing of the verdict. Each short form is now the same verdict with its verb dropped, so it maps one to one. Supersedes F35's chip wording. |
| **The context line names the alternative:** "**At 32k:** still runs on GPU; uses 1.9 GB more." and "**At 32k:** runs on GPU; uses 3.2 GB less." "still" appears when the verdict does not change; a spill or no-fit step reads "uses system memory, slower; needs 3.3 GB more." | F36b | "32k: runs on GPU" with 16k selected read as a statement about the current setting. Supersedes F36's line. |
| **The meter reads "Context 60% used".** | F37b | "Context 60%" left used and remaining unstated. Supersedes F37's wording. |
| **Off stays readable.** "Thinking off" (and "Image off") at `--muted-foreground`, hover to foreground; the switch track has a 1 px `--muted-foreground` outline; the word "off" shows in both `switch` and `pill`. | F38b | Dimming the whole label made off read as unavailable. Supersedes F38's dimming. |
| **A message sent during setup waits visibly.** The placeholder reads "Type now; it sends when setup finishes". Send stays enabled; the sent message becomes a user turn with an outlined (not filled) bubble and a clock line "Sends when setup finishes". When the install reaches ready, the line goes and the reply streams. `queued=1` shows it. | F43b | "when Ollama is ready" was wrong (the model downloads after), and a typed draft and a sent-but-waiting message looked the same. Supersedes F43's placeholder. |
| **First run names each step.** Before: "Download your first model" with the 6.6 GB size in the card and the button "Download and start". During: "Downloading your first model"; "Start chatting" opens a chat to draft in, with "You can type now; replies start when the download finishes." A message sent there waits like F43b's, with "Sends when the download finishes", and the model chip reads "· downloading N%". "Setting up Ollama" stays for install. | F44b | "Download a model to start" sat over a "Start chatting" button, and stayed the headline mid-download. Supersedes F44's one-label rule. |
| **The approval composer:** placeholder "Describe changes to this note…", hint "Enter requests changes · Ctrl Enter approves". | F53 | The hint said "Reply below" while the box said "Ask anything…". Supersedes F41's hint. |
| **Cancel download in first run.** A quiet "Cancel download" sits at the right of the progress line in the install block and in the first-model card. Cancelling the model returns to "Download and start" with "Download cancelled. You can choose another model in Settings › Models." Cancelling Ollama shows "Ollama isn't installed", "Gates Local needs Ollama to chat. Retry or point it at an existing install in Settings › Runtime.", and "Retry download". `cancelled=1` shows both. | F54 | A multi-GB first download had no way out; Settings' downloads already had ×. |
| **The picker ends between rows.** The list height is trimmed to the last whole row, with 8 px under it, and a thin page-drawn thumb shows whenever it overflows (S-05, S-06, S-50, S-62, S-79, S-80, S-89). | F55 | Round 4 cut "Qwen 3.8 27B abliterated" at the bottom edge with no scroll cue; headless and overlay scrollbars hide the native one. |
| **A stopped reply offers "Retry"**, a quiet underlined text button beside "Stopped after 3 s", running the same regenerate as the hover row. No "Continue": the harness has no partial-resume. | F56 | The stopped line had no visible recovery. |
| **Radios** use a 1.5 px `--muted-foreground` outline (the secondary-icon tone). The downloading row's radio is a dashed `--faint` ring, so it still reads as not selectable. | F57 | Unselected radios were too faint to read as controls. |
| **The status row shows only before the first token and during tool phases.** Once text arrives, the caret is the only indicator; there is no "Writing…" row. The sidebar's live dot is labelled "Reply in progress". | F58 | A spinner and "Writing…" under text that already had a caret was two indicators for one state. Supersedes F50's "Writing…". |
| **The custom-model Download is disabled** (faint text and border) until the name field has text. | F59 | It looked enabled with an empty field. |
| **Reply and user-turn action icons are 16 px**, with the shared stroke, in 24 px targets; the copied check matches. | F60 | Copy and regenerate were 14 px and read finer than every other icon. |
| **Polish found in review:** a number never wraps away from "GB" (non-breaking space in the one formatter); the context lines and Settings descriptions use `text-wrap: pretty`; "Retry" and "Cancel download" have 4 px of focus-ring room. | — | The shots showed "3.3 / GB" split across lines and one-word last lines. |

### Seat values I changed

- **C1-14 (Thinking pill on = `#1a2a20` fill with green text): changed to a
  neutral fill with foreground text.** Green on a pill that is only "on" breaks
  F02.
- **Primary buttons ("Install Ollama", "Start chatting", "Download …") are
  neutral light, not green.** F02 keeps green for send and approve, and the
  first-run CTA is neither.
- **The install progress bar was green in round 2; F02b made it neutral
  gray.**
- **"6 local models", not 14.** The harness lists six models. Saying 14 would
  contradict the picker and Settings on the next screen. The real app fills in
  the real count.
- **The picker's loaded row shows "est. 8.2 GB" (the estimate), not 6.9.**
  The measured value lives in the fit details, labelled as measured (F16), so
  the picker never shows two kinds of number side by side.
- **Whisper is 2.1 GB in the example, not 2.0.** With 2.0 the rounded legend
  (2.0 + 1.8 + 12.0) did not add up to 15.9, which F48 forbids.
- **The picker is 472 px wide.** At 440 px the keyboard-mode badges cut off
  the longest tag (`gemma3-abliterated:12b-q4`).

## Still open (kept as drawer switches)

Two drawer switchers remain after round 4: `fit` and `think`. Everything
else in the drawer picks a screen or a state, not a design.

- **Where the fit details open** (`fit=panel|side|above`, default `panel`).
  - `panel` docks a 360 px panel right of the thread and narrows the thread.
    Nothing is covered (S-07, S-41, S-42, S-58, S-59, S-68).
  - `side` is the popover to the right of the chip, bottom-aligned with the
    composer. It covers the latest answer and part of the composer while open
    (S-35).
  - `above` places the popover above the composer, left-aligned to the chip
    (S-08).
  - Why still open: the brief asks to keep the popover so Ethan can compare.
    The panel costs about 360 px of thread width on smaller windows, and a
    panel for a status check may feel heavier than the job.
- **How a toggle shows on and off** (`think=switch|pill`, default `switch`).
  - `switch` is a plain switch with the label beside it and no pill border,
    the same mark as the Settings switches (S-01, S-36 off, S-38, S-83 light
    off, S-85 Image off).
  - `pill` is the pill alone: filled when on; outlined and reading
    "Thinking off" at secondary-text contrast when off (S-39 with Image off,
    S-64 Thinking off, S-84 light off).
  - Why still open: both say on and off plainly. The switch matches
    Settings; the pill is quieter and closer to T3 Code's chips. This is a
    taste call.

## Token contract

Every color is a custom property on `:root`. The light values are the base.
Dark overrides live under
`@media (prefers-color-scheme:dark){:root:not([data-theme="light"])}` and
under `:root[data-theme="dark"]`. The `<html>` element starts with
`data-theme="dark"`.

| Token | Dark | Light | Use |
|---|---|---|---|
| `--background` | `#0a0a0a` | `#fcfcfc` | main pane |
| `--sidebar` | `#000` | `#ededed` (F39) | sidebar |
| `--card` / `--popover` / `--composer-surface` | `#111` / `#161616` / `#141414` | `#fff` | raised surfaces |
| `--foreground` / `--prose` | `#f2f2f2` / `#dadada` | `#171717` / `#262626` | text |
| `--muted-foreground` | `#9a9a9a` | `#4d4d4d` (F39) | secondary text |
| `--placeholder` / `--faint` | `#858585` / `#5e5e5e` | `#737373` / `#a6a6a6` | placeholder / decoration only |
| `--hover` / `--selected` | white 6% / 12% | black 5% / 10% | row states |
| `--sb-selected` | white 12% | black 11% (F39) | selected sidebar row |
| `--border` / `--border-strong` | white 8% / 14% | black 9% / 15% | hairlines |
| `--message-surface` / `--code-bg` / `--track` | `#1d1d1d` / `#1a1a1a` / `#2e2e2e` | `#e4e4e7` (F39) / `#f1f1f1` / `#e2e2e2` | bubbles, code, bars |
| `--green` / `--green-fg` / `--on-green` | `hsl(150 58% 48%)` / `hsl(150 62% 58%)` / `#03140b` | `hsl(150 62% 38%)` / `hsl(152 72% 26%)` / `#03140b` | ready, runs on GPU, send, approve |
| `--amber` / `--amber-fg` | `#f59e0b` / `#fbbf24` | `#d97706` / `#9a4d00` | pending, not ready, uses system memory |
| `--red` / `--red-fg` | `#ef4444` / `#f87171` | `#dc2626` / `#b91c1c` | not enough memory, wrong service, deletions |
| `--send-off-bg` / `--send-off-fg` | `#262626` / `#666` | `#e4e4e4` / `#a3a3a3` | disabled send |
| `--stop-bg` / `--stop-fg` | `#e6e6e6` / `#0a0a0a` | `#262626` / `#fafafa` | stop |
| `--primary-bg` / `--primary-fg` | `#ededed` / `#0a0a0a` | `#171717` / `#fafafa` | primary buttons (neutral) |
| `--seg-whisper` / `--seg-occupant` | `#b3b3b3` / `#575757` | `#666` / `#bdbdbd` | GPU bar: Whisper, other apps (F48: at least 25% apart) |
| `--turn-gap` | 44 px | | the gap after every turn (F40) |
| `--font-sans` | `"Adwaita Sans", system-ui, sans-serif` | | UI |
| `--font-mono` | `"JetBrainsMono Nerd Font", "JetBrainsMono NF", "JetBrains Mono", ui-monospace, monospace` | | code, paths, diffs, tags |
| `--s1`…`--s6` | 4 8 12 16 24 32 px | | spacing |
| `--col` / `--composer-w` | 720 px / 752 px | | widths |

Contrast in dark, as shown in the drawer's live readout:

| Pair | Ratio |
|---|---|
| secondary text on background | 7.0:1 |
| secondary text on sidebar | 7.5:1 |
| green text on background | 10.7:1 |
| arrow on green send | 8.2:1 |

## Screenshots

`~/.cache/gates-local-design/rounds/r5/steps.json` drives
`tools/shoot.mjs`. It produces 92 shots, S-01 to S-92, in
`rounds/r5/shots/`, with zero console messages (`shots.json`). Every shot
except S-28-drawer carries `shot=1`. The round-4 review set is in
`rounds/r4/shots/` (S-01 to S-70); the lane's own set is in
`lanes/r4-fix/shots/`.

S-01 to S-70 keep their names so the rounds compare one to one. Where a fix
removed what a shot showed, the shot keeps its name and shows the new state:

- S-05 and S-06 (picker) have no context control; S-06 still sets `ctx=32` by URL and shows the caption "Estimated at 32k". Both lists end between rows with the thumb showing (F55).
- S-39-think-check-option now shows `think=pill` with the Image pill off.
- S-33 and S-43 (download page) show Recommended and "Also available · uses system memory".
- S-03 and S-55 (streaming) show the caret alone, no "Writing…" row (F58).
- S-16 and S-67 (first run, nomodels) read "Download your first model" / "Downloading your first model"; S-15 and S-67 carry "Cancel download".
- S-65 shows "Retry" beside "Stopped after 3 s".

New in round 3:

| Shot | State |
|---|---|
| S-48-download-page-34 | download sub-page with Qwen 3.5 14B at 34% (`dl=34`) |
| S-49-settings-models-downloading | Settings › Models: the downloading row and "+ Download another model…" |
| S-50-picker-downloading | the picker with the downloading model inert in its group |
| S-51-footer-downloading | sidebar footer "Downloading · 34%" with its tooltip |
| S-52-light-thread-row-hover | light thread: selected row plus a hovered row |
| S-53-light-firstrun-installing | light first run, two-step install |
| S-54-light-banner-installing | light new thread with the two-step banner and dimmed composer |
| S-55-streaming-caret-early | writing phase with the caret (no "Writing…" row since F58) |
| S-56-streaming-caret-late | the same stream once finished: caret gone, sidebar time back |
| S-57-hover-row-next-turn | a finished reply's hover row with the next turn below (F40 spacing) |
| S-58-fit-panel-32k-line | GPU panel at 32k with the context line and Unused |
| S-59-fit-panel-spill | GPU panel for a model that spills at 64k |
| S-60-light-settings-runtime | light Settings › Runtime, the new status and switch rows |
| S-61-approval-hover-approve | approval panel with Approve hovered (tooltip) |
| S-62-light-picker | light picker |
| S-63-light-settings-models-dl | light Settings › Models with a download in progress |
| S-64-think-off-pill | `think=pill` with Thinking off |
| S-65-stopped-reply | a reply stopped mid-stream ("Stopped after N s") |
| S-66-light-firstrun-found | light first run, found |
| S-67-firstrun-nomodels-downloading | nomodels after "Start chatting": download in the card and the helper line |
| S-68-light-fit-spill | light GPU panel for a model that spills |
| S-69-light-memory-approval | light approval panel with Approve hovered |
| S-70-settings-runtime-switch-hover | Settings › Runtime with "Switch…" hovered |

New in round 4:

| Shot | State | Fix |
|---|---|---|
| S-71-queued-during-setup | a message sent during install, waiting under the banner: outlined bubble, clock, "Sends when setup finishes" (`queued=1`) | F43b |
| S-72-light-queued-during-setup | the same, light | F43b |
| S-73-firstrun-ollama-cancelled | first run after "Cancel download" during install: "Ollama isn't installed", Retry, Settings › Runtime | F54 |
| S-74-firstrun-model-cancelled | first run after cancelling the first model: "Download and start" plus the Settings › Models line | F54 |
| S-75-firstrun-nomodels-before | "Download your first model" with "Download and start" | F44b |
| S-76-light-firstrun-nomodels-before | the same, light | F44b |
| S-77-approval-composer | the composer under a pending note: "Describe changes to this note…", hint "Enter requests changes · Ctrl Enter approves" | F53 |
| S-78-light-stopped-reply | light stopped reply with "Retry" | F56 |
| S-79-picker-scrolled-end | the picker scrolled to its end: last row whole, padding under it, thumb at the bottom | F55 |
| S-80-picker-downloading-scrolled-end | the same with a download in its group | F55 |
| S-81-custom-model-empty | "Any model from the Ollama library" with an empty field: Download disabled | F59 |
| S-82-custom-model-filled | the same with "phi5:14b" typed: Download enabled | F59 |
| S-83-light-think-off | light `think=switch`, "Thinking off" | F38b |
| S-84-light-think-off-pill | light `think=pill`, "Thinking off" | F38b |
| S-85-image-off-switch | "Image off" next to Thinking on, `think=switch` | F38b |
| S-86-chat-during-first-download | a chat opened from "Start chatting" mid-download, with a waiting message ("Sends when the download finishes") and the chip "· downloading 14%" | F44b |
| S-87-light-firstrun-ollama-cancelled | S-73 light, by URL (`first=installing&cancelled=1`) | F54 |
| S-88-light-firstrun-model-cancelled | S-74 light, by URL (`first=nomodels&cancelled=1`) | F54 |
| S-89-light-picker-scrolled-end | S-79 light | F55 |
| S-90-light-settings-models | light Settings › Models: radio outlines, context line | F57, F36b |
| S-91-stopped-retry-hover | stopped reply with "Retry" focused (ring and hover row) | F56 |
| S-92-light-approval-composer | S-77 light | F53 |

Chip and line wording (F35b, F36b, F37b) shows in S-01, S-07, S-18, S-30,
S-58 and S-59; the 16 px action icons (F60) in S-23, S-31 and S-57.
