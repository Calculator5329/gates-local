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
next (fourth table under Locked decisions). The round-5 fix list (F61 to
F66) explains every choice and lets everything that waits be withdrawn, and
its consistency sweep gives each idea one name, one shape and one color
(fifth table and the sweep list under Locked decisions). The round-6 fix
list (F62b, F65b, SW5b, F67 to F85) makes **the picture say what the words
say, and draws one idea one way**: the GPU panel names the model it
inspects and its bar and legend agree with its verdict, every wait has the
same download card and an exit, and the last two-ways-of-drawing-one-thing
go (sixth table under Locked decisions).

Open it from disk: `file:///…/docs/design/shell.html?view=thread`.

> **Example data, not measurements.** Every GPU number here is a
> made-up example sized to an RTX 5070 Ti (15.9 GB): VRAM held by whisper,
> media-vault and the chat runner, per-model needs at 16k, 32k and 64k,
> first-token times, tok/s, download speeds and ETAs. Model names, disk sizes,
> paths and thread contents are examples too. The app must read real values
> from Ollama and `nvidia-smi`. Never copy these numbers into code or docs as
> facts. The example parts are chosen so the rounded legend adds up
> (15.9 = 2.1 + 1.8 + 12.0, F48).

## Words used everywhere (round 6)

One word per idea, on every surface:

| Idea | The words | Where else they must match |
|---|---|---|
| ~~A model~~ | ~~Friendly name first, the tag after it in secondary mono~~ **Superseded by F62** (next row) | |
| A model | Friendly name first ("Qwen 3.5 9B"), then its purpose phrase ("Fast everyday answers"). The Ollama tag (`qwen3.5:9b`) is in the row's tooltip, in mono, with the bit width and size: "4-bit · 7.6 GB on disk" (download rows: "4-bit · 9.3 GB download"). Quant tags (Q4_K_M, MXFP4) appear nowhere; picker search still matches the tag | picker, Settings › Models, download rows, first-run card; the name alone in the composer chip, GPU legend, footer download and reply meta (F34, F62, F62b) |
| abliterated | Wherever a name shows it, "abliterated" has a dotted underline and one tooltip line: "A version with its refusals removed" | picker, Settings › Models, GPU panel title and legend (F62b) |
| Model purpose | Four words or fewer, the same phrase on every surface: Qwen 3.5 9B "Fast everyday answers", Gemma 4 12B "Careful longer answers", Gemma 3 12B abliterated "Fewer refusals", gpt-oss 20B "Step-by-step reasoning", Gemma 4 26B abliterated "Fewer refusals, stronger", Qwen 3.8 27B abliterated "Fewer refusals, strongest". "abliterated" is glossed by "Fewer refusals", never by a footnote. Catalog models keep the download page's phrases ("Stronger answers on the GPU", "Fastest replies, lighter answers", "Also reads images you attach", "Careful writer") | picker, Settings › Models, download page, first-run card (F62) |
| Not enough memory, the way on | "Memory details" (quiet text action on the row), opening the GPU panel titled "If you switch to Qwen 3.8 27B abliterated" with the verdict "Needs 2.3 GB more at 16k"; the row line reads "… · needs 2.3 GB more" | picker row, Settings › Models row, GPU panel (F63, F67) |
| The model the GPU panel inspects | The chat's own model: its name as the title. Any other model: "If you switch to <name>". The subtitle is always "GPU memory · RTX 5070 Ti · 15.9 GB" | GPU panel (F67) |
| Verdict | "Runs on GPU", "Uses system memory · slower", "Not enough memory at 16k", always a dot plus the words in the verdict color | picker group headers, GPU panel, Settings rows, download rows, first-run card (F35) |
| Verdict short forms (composer chip) | "16k · on GPU", "64k · system memory", "64k · not enough memory". Each is the full verdict with its verb dropped; the chip's tooltip carries the full verdict ("Qwen 3.5 9B at 16k: Runs on GPU. Click for GPU memory.") | the chip only. "fits" and "won't fit" appear nowhere in the product (F35b) |
| Estimates | "est." in metadata ("est. 8.2 GB at 16k"), "Estimated" in sentences and captions ("Estimated 8.2 GB · 12.0 GB free", picker caption "Estimated at 16k") | never "Est.", never "fit" as a noun (F35, F35b, F76) |
| ~~GPU memory left for chat~~ | ~~"12.0 GB available"; never "free"~~ **Superseded by F72 and F76** (next row) | |
| GPU memory left for chat | "12.0 GB free", one fact after a middle dot ("Estimated 8.2 GB · 12.0 GB free"); a number never wraps away from "GB" | GPU panel, picker row tooltip, Settings › Models context line, first-run Details, download-row tooltip (F72, F76). "available" is gone from every number |
| What a model uses | "<name> on GPU 12.0 GB", "From system memory 2.2 GB" (amber, "slower"), "Short 2.3 GB" (dashed red outline, "not enough memory"); the parts sum to the estimate (12.0 + 2.2 = 14.2) | GPU panel legend; the picker row reads "est. 14.6 GB at 16k · 2.6 GB from system memory" (F68, F75) |
| Whisper | "Whisper", secondary "speech-to-text · kept loaded" (no lock icon) | GPU panel legend (F68) |
| Measured | "Measured on last load" (the section), "Measured 6.9 GB on last load" (the panel's numbers) | GPU panel only (SW5b-3) |
| Context | "Context for this chat" (GPU panel on the chat's own model), "Estimate at" (GPU panel on another model; changes only the panel), "Default context" (Settings › Advanced › GPU memory, the one default control; each size's fit is in its tooltip and the line under it says only what the control does), and one visible line under the chat's own control that names the alternative: "How much conversation the model can keep in view. **At 32k:** still runs on GPU; uses 1.9 GB more." (or "runs on GPU; uses 3.2 GB less.", "uses system memory, slower; needs 3.3 GB more."). Under "Estimate at" the line starts "Only changes this estimate." | (F36b, F67) |
| Context used | "Context 60% used" (composer chip); tooltip "Context used: 9.8k of 16k tokens" | (F37b) |
| ~~Off~~ | ~~"Thinking off", "Image off" at secondary-text contrast, next to a switch with a visible outline~~ **Superseded by Ethan's pick, 2026-11-07** (next row) | |
| ~~On and off~~ | ~~Off: `--muted-foreground`, `--border-strong` outline; hover brings the text to foreground~~ **Superseded in part by F70** (next row) | |
| On and off | A pill that always says "Thinking" (or "Image"). On: filled with the raised surface, label and icon at the primary ink. Off: the same label, outline only, label and icon at the muted ink; hover lifts the outline to the muted ink and adds no fill, so a hovered off pill never looks on. Unavailable (during setup): the pill keeps its on or off look at 40%, `cursor: not-allowed`, tooltip "Available when setup finishes". The word "off" appears nowhere; the tooltip says "Thinking on." / "Thinking off." One rule in both themes | composer pills; the `+` menu's Generate image shows a check at its right while on (Ethan's pick, F70) |
| Approve key | "Ctrl Enter" | General shortcuts, approval hint "Enter requests changes · Ctrl Enter approves", Approve tooltip (F41, F53) |
| Reply to a pending note | placeholder "Describe changes to this note…" | the composer under the approval panel only (F53) |
| A message that waits | placeholder "Type now; it sends when setup finishes" (install) or "Type now; it sends when the download finishes" (first model); a sent message shows a clock and "Sends when setup finishes" / "Sends when the download finishes" under an outlined bubble | composer, the queued user turn, first-run helper "You can type now; replies start when the download finishes." (F43b, F44b) |
| First model | "Download your first model" + "Download and start" before; "Downloading your first model" + "Start chatting" during | first run only; "Setting up Ollama" stays the install headline (F44b) |
| ~~Cancel~~ | ~~"Cancel download" in first run only~~ **Superseded by F61 and F64** (next two rows) | |
| Withdraw a download | "Cancel download", a quiet underlined text action, never an ×; then "Download cancelled" with the way on | first-run install and first-model download (F54), the runtime banner's install block, Settings › Models downloading row (F64), the download page's action column (F64) |
| Withdraw a waiting message | "Cancel send", a quiet text action 12 px after "Sends when setup finishes" / "Sends when the download finishes"; the text goes back into the composer and setup carries on | the queued user turn (F61) |
| Messages that wait, as built | **Supersedes the queued bubble and "Cancel send" above; `shell.html` still draws the old form.** One tray above the composer, one row per message with its reason ("Sends when setup finishes", "Sends after this reply", "On hold") and "Send now", "Edit", "Remove". Enter during a reply queues and never stops it; Stop beside Send stops it and holds the queue | the composer's queue tray |
| Recover a stopped reply | "Stopped after 3 s" · "Retry" | stopped reply only (F56) |
| ~~Download in progress~~ | ~~"Downloading · 34%" in the picker row, Settings › Models row, sidebar footer~~ **Superseded by F64** (next row) | |
| ~~Download in progress~~ | ~~Full in Settings and first run; short "Downloading · 34%" in the picker row~~ **Superseded by SW5b-1 and F71** (next row) | |
| Download in progress | One download line: a full-width neutral bar, then "3.2 of 9.3 GB · 48 MB/s · about 3 min left" with a grey "Cancel download" at its end. The picker row (no room for a bar) shows the spinner and "Downloading · 0.9 of 6.6 GB · 48 MB/s · about 2 min left". Short "Downloading · 34%" only in the sidebar footer and "· downloading 23%" in the composer's model chip | Settings › Models, the download page, first run, the chat's first-download card, the install card (SW5b-1, F71, F78) |
| Library | "Library" is the place (Settings › Library, "Add to library…", "Search my library", "Set up library search…"); the folders and databases inside it are "sources" ("Sources added", "No sources yet"). Intro: "Folders and databases the model may read in every chat. Gates Local only reads them, never changes them." Rows say what they hold ("1,284 files", "SQLite · 3 tables"). One book icon for Library on every surface; the folder and cylinder icons only on source rows | Settings nav and H1, the `+` menu, starter card, setup link, drawer (F65, F73, SW5b-5) |
| ollama.com | "Any model from ollama.com", "Type its name as it appears on ollama.com.", "Browse models on ollama.com ↗". "library" never names Ollama's catalog | the download page's last group (F65b) |
| ~~Remove~~ | ~~"Remove" on a Library row~~ **Superseded by F73** (next row) | |
| Remove | "Remove from library", a quiet text action, tooltip "Your files stay where they are"; no read-only badge. The attachment chip keeps its 14 px × with the tooltip "Remove" (a chip's own close mark) | Settings › Library, composer attachment chip (F73) |
| Quiet action | Grey text, a faint underline at rest in the border tone, full ink and underline on hover and focus: "Memory details", "Cancel download", "Cancel send", "Retry", "Remove from library", the Runtime confirm's "Cancel". Bordered buttons only for an action that opens a picker or a confirm, and for a row's one main action (Download) | everywhere (SW5b-2, SW5b-6) |
| First-run secondary link | One label per destination: "Change defaults in Settings" (found and installing, which used to differ); "Choose another model" (no models, before and after a cancel); "Use an existing Ollama" (Ollama cancelled) | first run only (SW5b-4, F69) |
| Trust line | "Runs locally on your computer. Nothing you type leaves it." | new thread, first run (F49) |

## Views

| `view=` | What it shows |
|---|---|
| `thread` | A finished thread. The thought line, a tool step row, markdown, and copy/regenerate/meta on hover. |
| `streaming` | The same thread replaying live: "Thinking" (a counter appears after 1 s), then the tool row spinning, then the reply text with a caret at the stream head. Once text arrives the caret is the only indicator; there is no "Writing…" row (F58). Stop works. |
| `new` | Empty state. The headline, the trust line, the composer at optical centre, and cards only for what works now (F47): Explain and Draft always, "Search my library" once sources exist, "Generate an image" once image generation is on. What still needs setup is a quiet link under the cards ("Set up library search…", "Set up image generation…"); since F82 the links join the grid as one row on the cards' columns, each on a card's inset with the icon its card will have, never a lone centred line (S-155, S-156, S-37). With `queued=1` it shows a message sent during setup, waiting, with "Cancel send" (F43b, F61); `queued=1&unqueue=1` shows the state after Cancel send. |
| `picker` | The thread with the model picker open. The list ends between rows and shows a thin thumb when it scrolls (F55). |
| `fit` | The thread with the GPU memory panel docked to the right of the thread, which narrows the thread instead of covering it. The popovers are gone (Ethan's pick, 2026-11-07). With `model=` it inspects that model as the chat's own (S-126 loaded, S-127 spill, S-129 shortfall); Memory details (or `memdet=<tag>`) inspects a candidate, "If you switch to …" (S-121 from the picker, S-124 from Settings). |
| `runtime` | A runtime banner docked directly above the composer. The state comes from `runtime=`. `installing` and `missing` show on a new thread (no chat can have happened yet); `starting` and `wrong` show on the library thread (F22). |
| `memory` | The thread ending in a proposed note edit, with the approval panel above a live composer. |
| `firstrun` | Full-window first run. The state comes from `first=`; `cancelled=1` shows the state after "Cancel download" (F54), each with its exit (F69). |
| `settings` | Settings. The section comes from `section=`. `section=models&add=1` opens the "Download a model" sub-page. Settings has no top bar (F51). Settings sits beside the docked GPU panel, so Memory details opens the same panel there (F63). |

## URL params

| Param | Values | Default |
|---|---|---|
| `view` | the nine views above | `thread` |
| `runtime` | `installing` `starting` `missing` `wrong` | `installing` (used only in `view=runtime`, or after first run's installing "Start chatting") |
| `first` | `found` `installing` `nomodels` | `found` |
| `section` | `general` `models` `runtime` `memory` `images` `library`. The old `sources` still opens Library (F65) | `general` |
| `ctx` | `16` `32` `64` | `16` |
| `model` | any model id in the list | `qwen3.5:9b` |
| `theme` | `dark` `light` `system` | `dark` |
| `queued` | `1` types a message during setup and sends it, so the thread shows it waiting with "Sends when setup finishes" (F43b). Uses `view=new`, or `view=runtime&runtime=installing` for the banner. Example: `view=runtime&runtime=installing&queued=1` | off |
| `unqueue` | `1` (with `queued=1`) shows the state after "Cancel send": the turn gone, its text back in the composer with the cursor at the end, setup still running. With no turn left, a new thread shows (F61) | off |
| `memdet` | a model tag, for example `qwen3.8-abliterated:27b`: opens Memory details (the docked GPU panel) for that model, in a thread or in Settings › Models (F63). It is titled "If you switch to …" with "Estimate at" in a thread, and has no context row in Settings (F67) | off |
| `cancelled` | `1` opens first run after "Cancel download": with `first=installing`, "Ollama isn't installed" with "Retry download" and "Use an existing Ollama"; with `first=nomodels`, the amber "Download cancelled" status over "Download and start" and "Choose another model" (F54, F69) | off |
| `add` | `1` opens Settings › Models › Download a model (with `view=settings&section=models`) | off |
| `dl` | `1` to `99`: Qwen 3 14B is shown downloading at that percent, held still for review (no timer). Shows in the picker (spinner and the download line), Settings › Models and the download sub-page (bar and the download line, SW5b-1), and the sidebar footer (F46). Example: `view=settings&section=models&add=1&dl=34` | off |
| `sources` | `some` `none` (no sources yet: the library card becomes a setup link and Settings › Library shows only the setup path) | `some` |
| `imageGen` | `1` turns image generation on: the Image pill, "Generate image" in `+`, the "Generate an image" card | off |
| `image` | `1` starts with the Image pill on (needs `imageGen=1`) | off |
| `owner` | `system` `app` (who runs Ollama, shown in Settings › Runtime) | `system` |
| `thread` | `lib` `cron` `icon` `bench` `notes` `whisper` `readme` | `lib` |
| `drawer` | `1` opens the design drawer | closed |
| `shot` | `1` hides the harness-only drawer trigger for review screenshots (F25); `D` still opens the drawer | off |

`fit` and `think` are gone (Ethan's picks, 2026-11-07), as is round 2's
`think=check`. An old link with any of them is ignored: the details dock
and the toggles are pills.

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
  - ~~The full title appears as a tooltip, but only when the title is cut off.~~ **Superseded by F83:** hovering a row shows a tooltip beside it with the full title and, under it, the date ("Yesterday, 4:12 PM"), so a cut-off title is always recoverable (S-157).
  - Clicking the runtime row opens Settings › Runtime.
  - While a model downloads, a "Downloading · 34%" row sits above the runtime row; its tooltip names the model.
  - Settings (or `Ctrl ,`) swaps the sidebar for the settings nav. `Esc` or "Back to chat" returns. The footer Settings entry hides while Settings is open (F33).
- **Composer**
  - `Enter` sends and `Shift Enter` adds a new line.
  - Send is disabled (gray) with no text, while the runtime isn't ready (except during install and the first-model download, below), or when the model doesn't have enough memory.
  - While Ollama installs, or while the first model downloads, Send works and queues: the message becomes a user turn with an outlined bubble, a clock and "Sends when setup finishes" (or "…when the download finishes"). A message sent from a new thread opens a thread for it. When the install reaches ready, or the download completes, the clock line goes and the reply streams (F43b, F44b).
  - "Cancel send", 12 px after the clock line, removes the waiting turn and puts its text back in the composer with the cursor at the end. The install or download carries on. If that was the thread's only turn, the thread goes and a new thread shows (F61).
  - Once a reply starts streaming, the send button becomes Stop. Clicking it ends the reply with "Stopped after N s" and a quiet "Retry" beside it, which regenerates the reply; the reply also gets the normal hover row (F56).
  - The `+` menu (F30, F31):
    - "Attach a file" ("This message only") adds a removable chip.
    - "Add to library…" ("Stays for every chat") opens Settings › Library (F65).
    - Below a separator: while image generation is off, "Set up image generation…" ("Off until you set it up") opens Settings › Image generation. Once it is on, "Generate image" shows a check at its right while the Image pill is on, and it toggles the pill.
  - The Thinking pill toggles. With it off, the thought line is skipped. On, the pill is filled with the raised surface at the primary ink; off, it keeps the same label, outline only, at the muted ink, and hover lifts only the outline. It never says "off". During setup both pills keep their look at 40% with `cursor: not-allowed` and the tooltip "Available when setup finishes", and clicks do nothing. The Image pill works the same way (Ethan's pick, 2026-11-07; F70; S-134 to S-139).
  - The `+` menu and the model picker lay a flat scrim of the window colour (55%, no blur) over the rest of the window; a click on the scrim closes them (F72, S-143, S-146, S-147).
  - The fit chip reads "16k · on GPU", "64k · system memory" or "64k · not enough memory"; its tooltip gives the full verdict (F35b).
  - The send button's tooltip on a model that doesn't have enough memory says how much more it needs, as an estimate.
  - The context meter is a chip in the chip cluster that reads "Context 60% used". It is hidden below 50% use and on a new thread. Its tooltip reads "Context used: 9.8k of 16k tokens". The `bench` thread (60%) shows it (F37b).
  - While Ollama installs, every control dims the same way, the model chip reads "Qwen 3.5 9B · downloads next", and the placeholder reads "Type now; it sends when setup finishes" (F43b). During the first-model download the chip reads "Qwen 3.5 9B · downloading 23%" and the placeholder "Type now; it sends when the download finishes".
  - During the first-model download a chat shows the same download card as the install (title "Downloading your first model", "Messages you send now go out when it finishes.", the model's bar, "1.5 of 6.6 GB · 48 MB/s · about 2 min left" and "Cancel download") docked above the composer, ticking live. Cancel download returns to first run's cancelled state; when the download finishes the card goes and a waiting message sends (F71, S-86, S-140, S-141).
- **Model picker** (click the model chip, or `Ctrl M`)
  - The search box filters by name, purpose or tag; the tag is not on the row but still matches (`gemma3-abl` finds Gemma 3 12B abliterated, S-119). The caption at its right reads "Estimated at 16k"; the picker has no context control (F36, F35b).
  - Groups are the three verdict labels, with equal space above and below each header.
  - The list's height is trimmed to end on the last whole row that fits, with 8 px of padding under the last row. When it overflows, a thin 4 px thumb (drawn by the page, in `--scroll-thumb-hover`) shows its position and moves as it scrolls (F55).
  - Arrow keys move the highlight and Enter picks.
  - Number keys and their badges appear only in keyboard mode, after an arrow key or `Ctrl M`.
  - Models without enough memory can't be picked. Each row's tooltip gives the name, the tag in mono, the quant and a reason (F62).
  - ~~Rows read "Qwen 3.5 9B `qwen3.5:9b`", then "est. 8.2 GB at 16k · 6.6 GB on disk · loaded".~~ **Superseded by F62, and its line layout by F75 (the Rows bullet below):** rows read "Qwen 3.5 9B", then "Fast everyday answers · est. 8.2 GB at 16k · loaded". A model that spills reads "Step-by-step reasoning · est. 2.6 GB in system memory"; one without enough memory reads "Fewer refusals, strongest · needs 2.3 GB more" with a quiet "Memory details" at its right (F63). Every row is one height, so the list still ends between rows (F55). The selected row has a check in a fixed 16 px slot.
  - "Memory details" closes the picker and opens the docked GPU panel for that model (F63).
  - ~~A model that is downloading sits in its group, inert, reading "Downloading · 34%" (the short form).~~ **Superseded by F71 and F78:** a downloading model sits in its group, inert, with the spinner in the check slot and "Downloading · 0.9 of 6.6 GB · 48 MB/s · about 2 min left" as its second line (S-142, S-150). The first model's download shows there too.
  - Rows: the name, then the purpose in secondary text on the same line; the second line is "est. 8.2 GB at 16k · loaded", or "est. 14.6 GB at 16k · 2.6 GB from system memory" for a spill (F75). The picker is 500 px wide so the longest not-enough row stays one line.
  - A row's tooltip is one line above the row, right-aligned inside the picker: "Needs about 9.3 GB · 12.0 GB free · <size> on disk". The hovered row keeps its fill while it shows (F72, S-148, S-149).
  - "+ Download a model…" is pinned under the list, outside its scroll, and opens Settings › Models › Download a model (F72, S-143, S-145).
- **Fit details** (click the fit chip)
  - A 360 px panel docks to the right of the thread. Its title names the model it inspects (the chat's model by name; any other model "If you switch to <name>"), its subtitle "GPU memory · RTX 5070 Ti · 15.9 GB" (F67). The thread and composer narrow to fit beside it; nothing is covered. The chip reads as expanded only while the panel inspects the chat's own model.
  - The panel holds, in order: the verdict, then one fact per line ("Estimated 8.2 GB · 12.0 GB free", then "Measured 6.9 GB on last load", or the system-memory or shortfall line) (F76); "Context for this chat" with its 16k/32k/64k switch and the visible context line; "Where the memory goes" (bar, axis, legend); and "Measured on last load" (left out when the model cannot load).
  - The bar (F68): thin segments that grow by their GB with 2 px surface gaps, a tick at the GPU's end, and the axis under the GPU part only. Whisper and Media Vault vision are two greys a clear step apart; Whisper's legend says "speech-to-text · kept loaded" (the lock icon is gone). A model that spills is split: "<name> on GPU 12.0 GB" in green, then an amber "From system memory 2.2 GB · slower" segment after the tick; the two sum to the 14.2 GB estimate (S-127, S-128). A model without enough memory adds a dashed red-outline "Short 2.3 GB" past the amber, so 12.0 + 4.0 + 2.3 = 18.3 (S-129, S-130, S-41). Legend text stays in text tokens; only the swatches carry segment colours.
  - For a candidate (F67) the panel draws two bars: "Now" (the loaded model in a dimmed green, then unused) and "If you switch". The legend adds the loaded model, "loaded now · unloads when you switch", so the user sees what the switch would replace (S-121 to S-125, S-99, S-101).
  - The chip again, the close button, or `Esc` closes it and returns focus to the chip. It stays open across thread switches. It closes on Settings and first run, and closes on its own if the composer becomes blocked.
  - The context switch recomputes the bar, the legend, the verdict, the sentence and the context line. This switch is the per-chat context control (F36).
  - The measured block shows first token and generation for the loaded model at its loaded context; otherwise it says when it will be measured.
  - ~~Opened from Memory details (F63): "…needs an estimated 18.3 GB. A chat model can use the 12.0 GB unused below plus 4.0 GB of system memory."; in Settings the context row reads "Default context".~~ **Superseded by F67 and F76:** opened from Memory details, the panel is titled "If you switch to Qwen 3.8 27B abliterated" and reads a red "Needs 2.3 GB more at 16k", "Estimated 18.3 GB · 12.0 GB free", "With 4.0 GB of system memory it is still 2.3 GB short.", then "Whisper and Media Vault vision hold 3.9 GB. Closing both makes room; Gates Local never stops them." In a thread its context row reads "Estimate at", and its line starts "Only changes this estimate."; the switch changes the panel alone, never the chat's context or the composer chip (S-123). Opened from Settings › Models the panel has no context row; the page's own "Default context window" is the one control (S-124). The Measured block is left out, since the model cannot load. Closing it, a Settings section change, or the chip returns the panel to the chat's own model.
- **Timeline**
  - The thought line expands to show the reasoning.
  - Clicking a tool row (or pressing Enter or Space on it) expands the command and its output, on the prose column.
  - While a reply streams, the status row ("Thinking", a running tool row) shows only before the first token and during tool phases. Once text arrives the caret at the stream head is the only indicator (F58).
  - Reply and user-turn action icons (copy, regenerate, edit, the copied check) are 16 px glyphs with the same stroke as the other icons, in 24 px targets (F60).
  - Copy flashes a check.
  - Regenerate replays the reply.
  - Edit puts the user's message back in the composer.
  - Every turn is focusable (`tabindex="0"`). Keyboard focus on a turn, or on a button inside it, shows the same actions as hover. A user turn rings its bubble; a reply rings the whole turn. A mouse click shows no ring (F12b).
  - Tab then lands on the turn's own actions (Edit, Copy, Regenerate), each with one ring: 2 px with a 2 px offset, the buttons 6 px apart so a ring never touches its neighbour. The Thought line and tool rows take the same ring (F81, S-153, S-154).
  - Tables in replies right-align numbers on tabular figures, put units in the header ("First token (s)", "Tokens/s"), and draw a rule between rows (F84, S-158).
  - A 24 px fade under the thread header lets text scroll under it softly (F80).
  - A message that contains "remember" runs the note flow; one that mentions books or the library runs the library flow.
- **Memory**
  - Approve, `Ctrl Enter`, or Reject resolves the panel.
  - The tool row then changes to "Saved a note" or "Note edit rejected", and a short reply streams in.
  - The composer stays live while the note is pending. Its placeholder reads "Describe changes to this note…" and the hint above reads "Enter requests changes · Ctrl Enter approves" (F53).
  - Approve has no tooltip (the hint line names the shortcut). The "+1 −1" counts take the diff's own muted green and red (F79, S-161).
- **Runtime**
  - Installing counts up live and updates the two-step block, the sidebar % (from the bytes shown) and the overall ETA.
  - When the install finishes it goes to starting, then to ready.
  - Install and Retry in the banner run the same flow.
  - The installing banner carries the same quiet "Cancel download" as first run; it leads to "Ollama isn't installed" with Install Ollama and Retry (sweep, S-116, S-117).
  - In `wrong`, "Start Gates Local's copy on port 11435" starts the app's copy on that port (the harness goes straight to starting, then ready).
- **First run**
  - Every state has one primary button, named for what it does, and at most one secondary link 16 px after it.
  - found: "Ready to chat", status "Ollama 0.40.4 · 6 local models". "Start chatting" opens a new thread; the link is "Change defaults in Settings".
  - installing: "Setting up Ollama" and the same two-step block as the banner, with a quiet "Cancel download" at the right of the speed line. "Start chatting" opens a new thread with the install still running; the helper reads "You can type now; replies start when setup finishes."
  - ~~installing, cancelled: "Retry or point it at an existing install in Settings › Runtime." with an inline link~~ **Superseded by F69:** amber "Download cancelled", the headline "Ollama isn't installed", the line "Gates Local needs Ollama to chat. Retry the download, or use an Ollama you already have.", then "Retry download" (restarts the install) and the link "Use an existing Ollama" (opens Settings › Runtime) (S-73, S-132).
  - The installing state's secondary link reads "Change defaults in Settings", the same label as found (SW5b-4).
  - nomodels, before: "Download your first model", the subtitle "One model is enough, and this one fits your GPU." on one line (F77), the model card with its 6.6 GB download size, "Download and start" and "Choose another model" (Settings › Models › Download a model).
  - nomodels, downloading: "Downloading your first model", the bar inside the card with "1.5 of 6.6 GB · 48 MB/s · about 2 min left" and a quiet "Cancel download"; "Start chatting" opens a chat to draft in, and the helper reads "You can type now; replies start when the download finishes." When the download completes, a waiting message sends (F44b).
  - ~~nomodels, cancelled: "Download cancelled. You can choose another model in Settings › Models." under the button in place of the link (F54).~~ **Superseded by F69:** the status line reads amber "Download cancelled" over "Download your first model", and "Download and start" keeps "Choose another model" beside it; the note is gone (S-74, S-133).
  - found and nomodels: "Details" (text only, trailing chevron) expands under the model card. It stays open while the download re-renders the card.
- **Settings**
  - The theme switch applies at once.
  - The default model and default context are shared with the composer. The default context lives in Advanced › GPU memory ("Default context"), with the current model's verdict at that size above it and the GB numbers under Details.
  - The image generation switch drives the `+` menu, the Image pill and the image starter card.
  - Models: unselected radios have an outline in the secondary-icon tone (`--muted-foreground`) (F57). ~~A downloading model's radio is a dashed `--faint` ring.~~ **Superseded by F78:** a downloading row shows the tool row's spinner in the radio slot, and a row that cannot be picked dims its radio with its name (S-163, S-18).
  - Status words in lists (Settings › Models, the download page): the dot carries the state colour, the words sit at secondary ink. Light-theme amber is two steps darker for small text, and the install pulse never drops below 0.6 opacity (F74).
  - Models rows read "Qwen 3.5 9B" with its purpose beside it in secondary text and the verdict at the right; the tag is in the row's tooltip (F62). The row that does not have enough memory stays unselectable and offers "Memory details" after its verdict, which opens the docked GPU panel beside Settings (F63).
  - Models › "+ Download another model…" (the last row of the model list) opens the download sub-page. "‹ Models" or `Esc` returns. ~~Each Download button shows a neutral bar, the percent and a × cancel in its row.~~ **Superseded by F64:** a started download shows the name and purpose, then a neutral bar and "3.2 of 9.3 GB · 48 MB/s · about 3 min left", with a quiet "Cancel download" in place of the Download button (download page) or at the end of the detail line (Settings › Models). The picker and the sidebar footer keep "Downloading · 34%". When done, it joins the default-model list.
  - The "Any model from ollama.com" Download stays disabled (faint text and border) until the name field has text (F59). Under its help line "Type its name as it appears on ollama.com." sits the quiet link "Browse models on ollama.com ↗"; the app opens ollama.com/search in the system browser, the harness link is inert (F66, F65b, S-114).
  - On the download page a started download keeps its verdict column, empties the action column, and draws the one download line across the row with "Cancel download" at its end (SW5b-1, S-107, S-162).
  - ~~Library lists the sources, each with a "read-only" badge and a quiet "Remove".~~ **Superseded by F73:** Library's intro says once that Gates Local only reads them. The sources sit under "Folders" and "Databases", each leading with its icon (folder, or the cylinder) and its mono path, then what it holds ("1,284 files", "SQLite · 3 tables"), with a quiet "Remove from library" (tooltip "Your files stay where they are"). Each group ends with its add row: "Add a folder" / "Notes, books or documents." and "Add a database" / "A SQLite file." (S-151, S-152, S-109).
  - ~~Runtime › the switch row's "Switch…" button stays pressed while the confirm is open.~~ **Superseded by F85:** the "Switch…" button opens a full-width confirm block under its row and hides while the confirm is open; focus moves to "Install and switch". Cancel (a quiet text action) or `Esc` closes it and focus returns to "Switch…". "Install and switch" flips who runs Ollama (S-34, S-159, S-160).
- **Escape** closes, in order: an open menu or popover, the drawer, the fit panel, the Runtime confirm, the download sub-page, then Settings itself.
- **Design drawer** (`D` or the swatch icon, harness only)
  - It picks the view, the runtime, first-run and settings states, whether the library has sources ("Library": "Sources added" / "No sources yet") and the theme. ~~and the two open questions~~ (gone since Ethan's picks).
  - It shows live contrast ratios and lists what is locked, round 6's four new lines included.
  - The switchers that remain: **View**, **Runtime state** (only in the runtime view), **First-run state** (only in first run), **Settings section** (only in Settings), **Library** (sources added / none), **Theme**, plus the read-only **Contrast (live)** readout. None is a design choice.

## Locked decisions

Rows marked **Superseded** stay for the record; the later row named in
them (round 3, 4 or 5) is what the harness does now.

| Decision | Fix | Why |
|---|---|---|
| **Black + green only.** The palette, Graphite, Slate, Stone and hue switchers are gone. | F02 | Green means one thing: ready, runs on GPU, send, approve. Stop is a neutral light disc. Reject is a neutral outline. Pending is amber. Not enough memory is red. There is no blue anywhere, including the install banner, which was blue in round 2. |
| **Send states.** Idle is a gray disc with a gray arrow (`#262626` / `#666`). Ready is solid green with a near-black arrow. Stop is `#e6e6e6` with a black square. | F02 | One look per state, so the disc never says "ready" when it isn't. |
| **Adwaita Sans for UI, JetBrainsMono Nerd Font as the one mono.** | F03 | These are the desktop's own fonts, named by family so `local()` lookup finds them with no network. Mono is only for commands, paths, diffs and model tags. Times and sizes use sans with tabular numerals. |
| **Prose column 720 px.** The composer is 752 px, so its text lines up with the prose edge. | F04 | A comfortable line length. Bubbles, tool rows, banners and the approval panel share the same edges. |
| **Spacing 4 / 8 / 12 / 16 / 24 / 32.** Items inside a turn are 8 px apart. ~~24 px from a user message to the reply, about 32 px from reply text to the next user bubble, including the 28 px hover row.~~ **Superseded in part by F40** (one 44 px turn gap). | F05 | One scale ends the ad-hoc gaps. |
| **Secondary text at least `#9a9a9a`** on dark (7.0:1) **and 12–13 px.** `#5e5e5e` is used only for decoration. Light secondary is `#4d4d4d` since F39. | F06 | Above the C1-25 floor of `#8a8a8a`. |
| **Quiet composer:** `+`, the model chip, the fit chip, the Thinking pill, the meter and send. | F07 | The composer is the control centre. ~~The on/off mark is F38's.~~ The pills are Ethan's pick (2026-11-07). |
| ~~**Meter:** a 28 px bar with a percentage, hidden below 50% and on a new thread.~~ **Superseded by F37** ("Context 60%" chip). | F08, F23 | The ring read as a spinner and the pie as the theme icon. F37 drops the bar too: a word and a number read as a gauge without a graphic. |
| ~~**Empty state:** a 2×2 grid of plain cards and an image card reading "Set up image generation".~~ **Superseded by F47** (cards only for what works). The headline "What would you like help with?" and the placeholder "Ask anything…" stay. | F09 | The headline differs from the placeholder, and the ellipsis is a real one. |
| **Tool step row:** status icon, then a plain summary ("Searched your library"), then "Shell · read-only · 42 ms", then a chevron. It wraps and is never cut off. It sits on the prose column (F52). | F10 | The summary says what was done; the details are in the expanded row. |
| ~~**One live status row:** "Thinking · N s", the running tool row, then "Writing · N s".~~ **Superseded by F50** ("Writing…" with no counter, a caret at the stream head). One status row stays. | F11 | No duplicate indicators. |
| **Hover/focus actions:** copy, regenerate and meta on replies; time, edit and copy on user messages. Sizes and spacing are F40's. | F12 | The row space is reserved, so nothing jumps on hover. |
| ~~**Approval dock:** an amber "Pending approval" label, a gray "Ctrl ⏎ approves" hint.~~ **Superseded by F41** ("Waiting for approval", "Ctrl Enter"). The panel inside the composer above a live text box, the file name with its path as a tooltip, the diff, neutral Reject and green Approve stay. | F13 | The user can still type, for example to ask for a change to the note. |
| **Header:** the title, then the `…` menu (tooltip "Thread actions"), with no compose icon and a fade mask under it. | F14 | The gear lives in the sidebar. The swatch icon is the harness-only drawer. |
| ~~**Picker wording:** rows show "Est. X GB at Nk · Y GB on disk" and a verdict column.~~ **Superseded by F34 and F35** (name first with the tag; "est."; the verdict is the group header, not a per-row column). The three verdict words stay. | F15 | Plain words. Number keys appear only in keyboard mode. |
| **Numbers:** GB with one decimal and never MiB. The axis is labelled 0 and 15.9 GB. Estimates and measurements are labelled. ~~"Estimate 8.2 GB · measured 6.9 GB"; a measured tier with runner memory.~~ **Superseded in part by F48** (wording "Estimated X of 12.0 GB available · measured 6.9 GB on last load"; no runner-holds figure; tones 25% apart). | F16 | Estimates and measurements are never mixed silently. |
| ~~**Fit popover:** the height is capped and it scrolls.~~ **Superseded by Ethan's pick, 2026-11-07:** the popover is gone; the details always dock (F17b). | F17 | It never ran off screen. |
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
| ~~**Thinking says on or off with a mark.** `think=check` offered a check that replaces the leading icon and fills the pill.~~ **Superseded by F38**, ~~(`switch` or `pill`). The default switch inside the pill stays.~~ then by Ethan's pick (the pill, greyed when off). | F07b | A filled pill alone did not say whether it was on; F38's pill option adds the word "off" so it does. |
| ~~**The trust line is "Runs locally on your computer" in every state**, with "Reads only the docs and databases you added." on the new thread.~~ **Superseded by F49** (one trust line everywhere). | F09b | Two endings for one promise read as two promises. |
| **User turns show time, Edit and Copy on hover.** Every turn is focusable, and keyboard focus on a turn or a button in it shows the same row as hover. A user turn rings its bubble; a reply rings the whole turn with an 8 px offset. Mouse focus shows no ring. | F12b | Keyboard users get the same actions as mouse users. |
| **Every memory need says it is an estimate, and every size says "on disk" or "download".** ~~"Est." and "free".~~ **Wording superseded by F35 and F48** ("est." in metadata, "Estimated" in sentences, "available"). | F16b | A bare GB number could be disk, download, estimate or measurement. |
| **The fit details open as a 360 px panel docked right of the thread** (what `view=fit` opens). ~~The popover stays as `fit=side` and `fit=above`.~~ **The popover is gone (Ethan's pick, 2026-11-07).** ~~The legend's runner-holds line and "free".~~ **Legend superseded by F48.** | F17b | The popover covered the latest answer and the composer controls. |
| **Settings › Models has a download sub-page** (`section=models&add=1`) with a one-line reason, download size, estimated verdict and Download per model, and "Something else" for any Ollama library name. ~~Four models under one list.~~ **Grouping superseded by F46** (Recommended holds only GPU models). | F27 | First run pointed at Settings for another model, but Settings had no way to get one. |
| ~~**Context is explained in one line:** "…Larger windows use more memory." as visible text in Settings and a tooltip elsewhere.~~ **Superseded by F36** (one visible line under every context control, with the next step's cost). | F28 | A tooltip hid the one line that explains the setting. |
| ~~**Who runs Ollama is a status value**, with "Use Gates Local's copy…" or "Use the system Ollama…" as the action and a "Who runs it" row.~~ **Superseded by F45** (one status row and a switch row). The confirm's content stays: Ollama 0.40.15, 1.5 GB into `~/.local/share/gates-local/ollama`, the same models folder, port 11435 beside the system Ollama, chats pause about a minute, Cancel and "Install and switch". | F29 | Switching owners installs software and changes the port; it must read as an action with its consequences written out. |
| **The `+` menu separates one message from every chat:** "Attach a file" / "This message only", then "Add to library…" / ~~"Stays for every chat · opens Sources"~~ **"Stays for every chat" since F65** (the page is Library; no "opens" hint). | F30 | The second line keeps the two lifetimes apart. |
| **Image wording follows the setting.** While image generation is off, the `+` item and the setup link read "Set up image generation…" and open Settings. Only with it on do they read "Generate image" and "Generate an image". | F31 | The menu promised an action its state could not perform. |
| ~~**The first-run model card leads with "Qwen 3.5 · Recommended" and "Runs on your GPU"**, with a "Model details" disclosure (cpu icon).~~ **Superseded by F44 and F35** ("Qwen 3.5 9B · Recommended", "Runs on GPU", "Details" with no icon). The download size once, details under a disclosure, and "On disk" only once installed all stay. | F32 | Hardware detail was as loud as the one decision, which is to start. |
| **Settings shows one selected row.** The footer Settings entry hides while Settings is open. | F33 | Inside Settings it has no job: "Back to chat" and `Esc` already leave. |

### Round 3 fixes

| Decision | Fix | Why |
|---|---|---|
| **The friendly name leads;** ~~**the tag follows in secondary mono.** "Qwen 3.5 9B `qwen3.5:9b`" in the picker, Settings › Models, download rows~~ **(the tag in the row moved to the row's tooltip, and a purpose phrase took its place, in F62)** and first-run Details; the friendly name alone in the composer chip, fit legend, reply meta and footer. The user's own message may still say a raw tag. | F34 | The same model was "qwen3.5:9b" on one surface and "Qwen 3.5" on another. One name, with the tag where someone might type it. |
| **Exactly three verdict labels**, each a dot plus the words in the verdict color: "Runs on GPU", "Uses system memory · slower", "Not enough memory at 16k". ~~"fits" is the composer chip's word only.~~ **Chip wording superseded by F35b** ("on GPU", "system memory", "not enough memory"; "fits" is gone). Never "RAM". "est." in metadata, "Estimated" in sentences. Picker group headers have equal space above and below, and the check sits in a fixed 16 px slot so names line up. | F35 | Round 3 found five phrasings of one verdict ("fits", "Runs on your GPU", "uses RAM", …). One label set means the user learns it once. |
| **One control per context.** The per-chat context switch lives in the GPU panel ("Context for this chat"); the default lives in Settings › Advanced › GPU memory ("Default context"). The picker has no control; ~~its caption reads "Fit shown at 16k"~~ (**"Estimated at 16k" since F35b**). Under each control is one visible line: ~~"How much conversation the model can keep in view. 32k: runs on GPU, 1.9 GB more."~~ **Line superseded by F36b** (it names the alternative: "At 32k: still runs on GPU; uses 1.9 GB more."). The Settings segments carry no micro-labels. | F36 | The picker, panel and Settings each had a context switch with different effects. Now the chat one changes the chat and the default one changes the default, and the line says what the next step costs. |
| ~~**The meter reads "Context 60%"**~~ **Wording superseded by F37b** ("Context 60% used"). It stays a chip in the chip cluster, with the token count in its tooltip, hidden below 50% and on a new thread. | F37 | The bar was one more graphic to decode. It sits with the other chips because it is the same kind of status. Supersedes F08. |
| ~~**Thinking (and Image) is one control with two treatments:** `switch` (default, a plain switch with the label beside it, no pill border) and `pill` (filled when on; outlined and reading "Thinking off" when off).~~ ~~Label and bulb dim when off in both.~~ **Superseded by F38b, then by Ethan's pick, 2026-11-07:** the pill alone, greyed with the same label when off. | F38 | `check` swapped the icon, which made the bulb mean two things. Both remaining options say on and off in words or a familiar switch. Supersedes F07b's `check`. |
| **Light theme reads apart:** secondary text `#4d4d4d` (about 8.4:1 on the pane), the sidebar `#ededed` against the `#fcfcfc` pane, a selected sidebar row at black 11%, and user bubbles `#e4e4e7`. | F39 | The round-3 light shots had gray-on-gray text, a sidebar that merged with the pane, and an invisible selected row. |
| **Turn rhythm:** every turn ends in the same 44 px gap. After a reply, the action row sits 8 px under the text, is 24 px tall with 24 px buttons that each have a tooltip, and leaves 12 px before the next message. The model, first token and tok/s share one metrics slot. A stopped reply gets the same row. | F40 | Gaps differed after replies and user turns, and the row floated. Supersedes the F05 numbers and F24's 28 px. |
| **The approval panel** reads "Waiting for approval" with an amber dot, then "Note edit" and the file name. The hint is plain text: ~~"Reply below to change the note · Ctrl Enter approves"~~ (**"Enter requests changes · Ctrl Enter approves", with the placeholder "Describe changes to this note…", since F53**). Approve's tooltip is "Approve (Ctrl Enter)". "Ctrl Enter" is the key name everywhere, including General › shortcuts. | F41 | "Pending" in caps read as a badge, and "⏎" and "↵" were two glyphs for one key. Supersedes F13's wording. |
| **The wrong-service banner's button reads "Start Gates Local's copy on port 11435".** | F42 | The old label didn't say a second Ollama would start or where. |
| **Install is two steps with one ETA:** "Ollama 1.0 of 1.5 GB" with a neutral bar, then "Qwen 3.5 9B · 6.6 GB · next" muted, then one line "21 MB/s · about 6 min left" for both. The same block is used in the banner and first run. The model chip reads "Qwen 3.5 9B · downloads next", ~~the placeholder "Type now; it sends when Ollama is ready"~~ (**placeholder and the queued message superseded by F43b**: "Type now; it sends when setup finishes", and a sent message waits as a queued turn). Every composer control dims the same way, starter cards are inert, and the sidebar % is computed from the bytes on screen (1.0 of 1.5 GB is 67%). | F43 | The round-3 install showed two ETAs, a % that did not match the bytes, and controls dimmed by different amounts. |
| **First run:** "Ready to chat" with status "Ollama 0.40.4 · 6 local models"; ~~"Start chatting" is the one button in every state; "You can type now; replies start when setup finishes." under it while installing or downloading~~ (**superseded by F44b**: "Download and start" before the first model, "Downloading your first model" during it with "…when the download finishes"; F54 adds Cancel download); the secondary link sits 16 px after the button; the disclosure is "Details" with no icon. A dotted underline marks only text that opens a tooltip (such as "Recommended"); plain links keep a solid underline. | F44 | Three button labels for one action, a right-aligned link that read as unrelated, and dotted underlines on things that were not tooltips. |
| **Settings › Runtime:** the subtitle "Gates Local finds Ollama on its own."; one status row ("Running · Ollama 0.40.4" / "Started by your system · port 11434. Gates Local won't stop it."); a switch row "Switch to Gates Local's copy" / "A private copy it starts and stops" with a "Switch…" button ~~that is pressed while the confirm is open~~ (**superseded by F85**: it hides while the confirm is open); the confirm spans the full row width; long paths break after slashes. | F45 | Status, owner and the switch were three rows saying one thing. Supersedes F29's layout. |
| **Downloads:** a neutral bar, ~~the percent and a × cancel in the row; "Downloading · 34%" in the picker, Settings › Models and the sidebar footer~~ **(superseded by F64: the full detail line and a quiet "Cancel download" in Settings › Models and the download page; "Downloading · 34%" stays in the picker and the sidebar footer)**. On the download page, Recommended holds only models that run on the GPU; Mistral Small sits under "Also available · uses system memory". Settings › Models ends with "+ Download another model…". `dl=` holds a download still for review. | F46 | A green-ish bar, different words per surface and a spilling model under Recommended. Supersedes F27's grouping. |
| **Starter cards only for what works now.** Setup is a quiet link under the cards. | F47 | A card that only opens Settings looked like a feature. Supersedes F09's grid. |
| **The GPU legend:** the GPU name is a subtitle under "GPU memory"; Whisper and other-app grays are at least 25% lightness apart; "Unused" is an outlined empty segment; ~~sentences say "of 12.0 GB available"~~ (**superseded by F76**: "12.0 GB free" everywhere); the runner-holds figure is gone; every part is rounded once so the legend sums exactly to the axis total (**for spill and shortfall superseded by F68**: the legend sums to the estimate, with the system-memory and short parts past the GPU's end). | F48 | Two grays read as one, "free" disagreed with the picker, and the parts did not add up. Supersedes the F16 and F17b legend. |
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
| **Off stays readable.** Off is at `--muted-foreground`, ~~hover to foreground~~ (**hover superseded by F70**: it lifts the outline only), with a visible 1 px outline. ~~The switch track has a 1 px `--muted-foreground` outline; the word "off" shows in both `switch` and `pill`.~~ **Switch and the word "off" superseded by Ethan's pick, 2026-11-07** (the label always says "Thinking"). | F38b | Dimming the whole label made off read as unavailable. Supersedes F38's dimming. |
| **A message sent during setup waits visibly.** The placeholder reads "Type now; it sends when setup finishes". Send stays enabled; the sent message becomes a user turn with an outlined (not filled) bubble and a clock line "Sends when setup finishes". When the install reaches ready, the line goes and the reply streams. `queued=1` shows it. | F43b | "when Ollama is ready" was wrong (the model downloads after), and a typed draft and a sent-but-waiting message looked the same. Supersedes F43's placeholder. |
| **First run names each step.** Before: "Download your first model" with the 6.6 GB size in the card and the button "Download and start". During: "Downloading your first model"; "Start chatting" opens a chat to draft in, with "You can type now; replies start when the download finishes." A message sent there waits like F43b's, with "Sends when the download finishes", and the model chip reads "· downloading N%". "Setting up Ollama" stays for install. | F44b | "Download a model to start" sat over a "Start chatting" button, and stayed the headline mid-download. Supersedes F44's one-label rule. |
| **The approval composer:** placeholder "Describe changes to this note…", hint "Enter requests changes · Ctrl Enter approves". | F53 | The hint said "Reply below" while the box said "Ask anything…". Supersedes F41's hint. |
| **Cancel download in first run.** A quiet "Cancel download" sits at the right of the progress line in the install block and in the first-model card. ~~Cancelling the model returns to "Download and start" with "Download cancelled. You can choose another model in Settings › Models." Cancelling Ollama shows "Ollama isn't installed", "Gates Local needs Ollama to chat. Retry or point it at an existing install in Settings › Runtime.", and "Retry download".~~ (**Cancelled wording superseded by F69**: each cancelled state has two buttons, "Retry download" / "Use an existing Ollama" and "Download and start" / "Choose another model".) `cancelled=1` shows both. | F54 | A multi-GB first download had no way out; Settings' downloads already had ×. |
| **The picker ends between rows.** The list height is trimmed to the last whole row, with 8 px under it, and a thin page-drawn thumb shows whenever it overflows (S-05, S-06, S-50, S-62, S-79, S-80, S-89). | F55 | Round 4 cut "Qwen 3.8 27B abliterated" at the bottom edge with no scroll cue; headless and overlay scrollbars hide the native one. |
| **A stopped reply offers "Retry"**, a quiet underlined text button beside "Stopped after 3 s", running the same regenerate as the hover row. No "Continue": the harness has no partial-resume. | F56 | The stopped line had no visible recovery. |
| **Radios** use a 1.5 px `--muted-foreground` outline (the secondary-icon tone). ~~The downloading row's radio is a dashed `--faint` ring, so it still reads as not selectable.~~ (**superseded by F78**: the downloading row shows a spinner in the radio slot; a row that cannot be picked dims its radio.) | F57 | Unselected radios were too faint to read as controls. |
| **The status row shows only before the first token and during tool phases.** Once text arrives, the caret is the only indicator; there is no "Writing…" row. The sidebar's live dot is labelled "Reply in progress". | F58 | A spinner and "Writing…" under text that already had a caret was two indicators for one state. Supersedes F50's "Writing…". |
| **The custom-model Download is disabled** (faint text and border) until the name field has text. | F59 | It looked enabled with an empty field. |
| **Reply and user-turn action icons are 16 px**, with the shared stroke, in 24 px targets; the copied check matches. | F60 | Copy and regenerate were 14 px and read finer than every other icon. |
| **Polish found in review:** a number never wraps away from "GB" (non-breaking space in the one formatter); the context lines and Settings descriptions use `text-wrap: pretty`; "Retry" and "Cancel download" have 4 px of focus-ring room. | — | The shots showed "3.3 / GB" split across lines and one-word last lines. |

### Round 5 fixes

From the round-5 report (`rounds/r5/council/G.md`, GPT-6.1 Sol alone, 8.5
against 9 for T3 Code and ChatGPT desktop). The theme: **every choice
explained, everything waiting can be withdrawn**, plus one name, one shape,
one color per idea. Its "Strengths to keep" are unchanged.

| Decision | Fix | Why |
|---|---|---|
| **A waiting message can be withdrawn.** "Cancel send", a quiet underlined text action (the `.qa` style of Retry and Cancel download), sits 12 px after "Sends when setup finishes" / "Sends when the download finishes", always visible. It removes the queued turn and puts its text back in the composer, cursor at the end; the install or download carries on. A thread left with no turns goes, and a new thread shows. `queued=1&unqueue=1` shows the result (S-93 to S-96). | F61 | A sent-but-waiting message had no way back except waiting for setup; the only cancel on screen stopped the install itself. |
| **Each model says why you would pick it.** One purpose phrase of four words or fewer follows the friendly name in the picker, Settings › Models, the download page and the first-run card, the same phrase everywhere (Words used everywhere lists them). "abliterated" is glossed in the phrase ("Fewer refusals"). The mono tag leaves the row for its tooltip; picker search still matches it. The estimate stays as the secondary text after the purpose. Rows keep one height, so F55 holds (S-05, S-06, S-50, S-62, S-79, S-80, S-89, S-97). | F62 | Six rows of names and tags gave no reason to choose one; "abliterated" was jargon with no gloss. Supersedes F34's tag-in-the-row. |
| **Not enough memory has a route.** The row under "Not enough memory at 16k" stays unselectable and gets a quiet "Memory details" (picker and Settings › Models). It opens the docked GPU panel for that model: "Needs 2.3 GB more at 16k", what the model needs against what a chat model can use, then what holds the memory now (Whisper and Media Vault vision, 3.9 GB; Gates Local never stops them) above the panel's own legend. Settings now sits beside the panel, so the same panel opens there. `memdet=<tag>` opens it (S-98 to S-104). The shortfall is worked from the rounded parts on screen, so 18.3 − 12.0 − 4.0 reads 2.3 everywhere (coordinator, round 6). | F63 | The row was a dead end: red words and no next step. |
| **Settings shows a download's detail.** A downloading row in Settings › Models shows its name and purpose, a neutral bar, then "3.2 of 9.3 GB · 48 MB/s · about 3 min left" with a quiet "Cancel download" at its end. The download page shows the same detail under the name, with "Cancel download" in the action column where Download was. No × anywhere. ~~The download page shows the same detail under the name, with "Cancel download" in the action column where Download was.~~ ~~The picker and the sidebar footer keep "Downloading · 34%"~~ (**superseded by SW5b-1**: one full-width line on every surface with the action column empty; the picker shows "Downloading · " plus the same line; F71 adds the chat's card) (S-105 to S-108, S-48, S-49, S-63). | F64 | Settings showed a bare percent and an ×, where first run showed bytes, speed and time left with "Cancel download". Supersedes F46's × and percent. |
| **One name: Library.** Settings › Sources is Settings › Library (nav row, H1, the starter-card link, the drawer). The page's first line says what it holds: "Sources the model may read in every chat: folders, files and databases." (**Intro, badges and Remove superseded by F73.**) The `+` menu reads "Add to library…" / "Stays for every chat". The old `section=sources` still opens it (S-109 to S-113, S-118). | F65 | One place had two names ("library" in the menu, the card and the tool row; "Sources" in Settings). |
| **~~Browse the Ollama library.~~** Under the custom field's help line ~~("Type its name as it appears in the library.") sits a quiet link "Browse the Ollama library ↗". The app opens ollama.com/library~~ (**wording superseded by F65b**: "Type its name as it appears on ollama.com." and "Browse models on ollama.com ↗", opening ollama.com/search) in the system browser; the harness link is inert. The curated recommendations stay first (S-81, S-82, S-114, S-115). | F66 | The field asked for an exact name with no way to find one. |

### Round 5 consistency sweep

Every view, dark and light. Each line: what differed, what it is now.

- **Cancel:** the Settings download row cancelled with an × and the first-run block with "Cancel download". Now every download cancels with the quiet text "Cancel download" (F64), including the runtime banner's install block, which had none.
- **Quiet row actions:** Settings › Library's "Remove" was a ghost button (padded, no underline) where every other row-end action ("Memory details", "Cancel download") is the underlined `.qa` text. It is `.qa` now, 12 px after its badge, like Memory details after its verdict. (**Badge and label superseded by F73:** no badge; "Remove from library".)
- **Section labels:** the sidebar's date groups were 12 px and the GPU panel's "Where the memory goes" 12.5 px, while Settings groups ("Default model") are 13 px. All three are now 13 px, weight 500, `--muted-foreground`.
- **Segmented controls:** the GPU panel's context switch was 24 px tall with 9 px padding and 12.5 px text; the Settings context switch is 28 px, 12 px, 13.5 px. Both are 28 px, 12 px, 13.5 px now, so "16k 32k 64k" looks the same wherever it is set.
- **Radius:** the badge, path chip and segment buttons used a literal 6 px and the large button a literal 10 px. They use `--r-sm` and `--r-lg` (same values, one source).
- **Small metadata:** the badge text and the download page's "est. 11.2 GB at 16k" were 12 px, under the 12.5 px of every other row metadata. Both are 12.5 px.
- **Links:** the starter-card setup links were 13.5 px; every other `.link` is 14 px. They are 14 px.
- **Tag placement:** the tag was mono secondary text inside the row in the picker, Settings and the download page, but only in the Details table on first run's card. Every row now keeps it one step away: the row's tooltip, or first run's Details table (F62).
- **Download rows:** the download page put the purpose under the name, Settings beside it, and the downloading row on the download page beside it. The download page now always stacks name over purpose (and the detail under that), Settings always puts the purpose beside the name.
- **`+` menu second lines:** "Stays for every chat · opens Sources" and "Off · opens Settings" pointed at where they go; "This message only" said what it does. All three now say what the item does: "This message only", "Stays for every chat", "Off until you set it up".
- **Checked and kept:** ~~dialog Cancel buttons (Runtime confirm) stay ghost buttons beside their primary, since they are a button pair, not a row action~~ (**superseded by SW5b-2**: the confirm's Cancel is the quiet action); the attachment chip keeps its × (a chip's own close mark, tooltip "Remove"); panel and drawer close stay ×. Status words were already one case ("Runs on GPU", "Uses system memory · slower", "Not enough memory at 16k"); icons were already 16 px glyphs at one stroke (F60).

### Round 6 fixes

From the round-6 panel (`rounds/r6/council/{C,G,M,J}.md`: Opus 8, Sol 8.5,
Muse 8, mean 8.17, against ChatGPT desktop 9.0 and T3 Code 8.83) and the
ledger's "Fix list (round 6)". The theme: **the picture says what the
words say, and one idea is drawn one way**. Every seat's "Strengths to
keep" are unchanged. Shots are in `lanes/r6-fix/shots` (S-121 to S-164 are
new).

| Decision | Fix | Why |
|---|---|---|
| **"abliterated" has one gloss everywhere:** a dotted underline and the tooltip "A version with its refusals removed" wherever a name shows it (picker, Settings › Models, the GPU panel title and legend). Row tooltips give "4-bit · 7.6 GB on disk" (download rows "4-bit · 9.3 GB download"); Q4_K_M, Q4_0 and MXFP4 appear nowhere (S-164, S-120, S-148). | F62b | The purpose phrase glossed it only beside the name; a reader meeting it in the panel or the legend had no gloss, and Q4_K_M was jargon. Partly supersedes F62's tooltip wording. |
| **The download page names ollama.com by its domain:** "Any model from ollama.com", "Type its name as it appears on ollama.com.", "Browse models on ollama.com ↗" (opens ollama.com/search). "library" means only the app's own Library (S-81, S-82, S-114, S-145). | F65b | F65 made Library the app's place, then the download page reused "the Ollama library" for a different thing. Supersedes F66's link wording. |
| **SW5b-1, one download line:** a full-width neutral bar, then "x of y GB · rate · about t left" with a grey "Cancel download" at its end, in Settings › Models, the download page (the action column stays empty while it runs), first run, the install card and the chat's download card. The picker row has no room for a bar, so it shows the spinner and "Downloading · " plus the same line. | SW5b | The download page put the detail in a column, Settings under the name, the picker a bare percent. Supersedes F64's column placement. |
| **SW5b-2, one quiet-action form:** grey text, a faint underline at rest in the border tone, full ink and underline on hover and focus. Memory details, Cancel download, Cancel send, Retry, Remove from library and the Runtime confirm's Cancel all use it. I kept the faint underline at rest rather than "underlined on hover" only: a grey word with no mark at all reads as a label, and every one of these sits beside plain metadata. | SW5b | The Runtime confirm's Cancel was a ghost button and Library's Remove sat after a badge; one row action drew three ways. |
| **SW5b-3, one name for the measured block:** "Measured on last load", whatever model the panel shows; the numbers line reads "Measured 6.9 GB on last load". | SW5b | The block was "Speed" in one state and "Measured on last load" in another. |
| **SW5b-4, one first-run secondary link per destination:** found and installing both read "Change defaults in Settings". | SW5b | The two states linked to the same place with two labels. |
| **SW5b-5, one book icon for Library** on every surface (Settings nav, `+` menu, starter card, setup link); the folder and cylinder icons only on source rows. | SW5b | Library was a book in one place and a cylinder in another; the cylinder now means a database only. |
| **SW5b-6, bordered buttons only for an action that opens a picker or a confirm** ("Add folder…", "Add database…", "Change…", "Switch…"), plus a row's one main action (Download). Everything else at a row's end is a quiet action. I kept Download bordered: it is the download page's primary action per row, and a text link there would hide the one thing the page is for. | SW5b | Bordered and text actions were mixed with no rule. |
| **The GPU panel says which model it inspects.** For the chat's own model the title is its name and the context row is "Context for this chat"; for any other model the title is "If you switch to <name>", the row is "Estimate at" with "Only changes this estimate." and it changes nothing outside the panel; the bar shows "Now" above "If you switch", and the legend keeps the loaded model ("loaded now · unloads when you switch"). Opened from Settings the panel has no context row. The model chip reads as expanded only for the chat's own model (S-99, S-101, S-121 to S-126). | F67 | Opened from a not-enough row, the panel looked like the chat's own, and its context switch silently changed the chat. Supersedes F63's "Default context" row. |
| **The bar draws what the words say.** Thin segments grow by their GB with 2 px gaps; a tick marks the GPU's end; a spill is split into "<name> on GPU 12.0 GB" and an amber "From system memory 2.2 GB" after the tick (12.0 + 2.2 = 14.2, the estimate); a shortfall adds a dashed red-outline "Short 2.3 GB" past the amber (12.0 + 4.0 + 2.3 = 18.3). Whisper and the other app are two greys a clear step apart in both themes; the lock icon became "kept loaded" in Whisper's secondary text. Legend text is always in text tokens (S-59, S-68, S-41, S-127 to S-131). | F68 | The spill verdict said "uses system memory" while the bar showed the whole model inside the GPU, and the legend summed to the axis, not the estimate. Supersedes F48's legend for spill and shortfall. |
| **Cancelled first-run states keep an exit:** Ollama cancelled offers "Retry download" and "Use an existing Ollama" (Settings › Runtime); model cancelled keeps "Choose another model" beside "Download and start", with an amber "Download cancelled" status (S-73, S-74, S-87, S-88, S-132, S-133). | F69 | The cancelled states had one button and a sentence with an inline link. Supersedes F54's cancelled wording. |
| **Pills read off at a glance,** inside Ethan's pick: off is outline only with label and icon at the muted ink; on is filled with the raised surface at the primary ink; hover on an off pill lifts the outline only and adds no fill (in light theme a fill made off read as on); during setup both are unavailable: 40%, `not-allowed`, tooltip "Available when setup finishes". One rule in both themes (S-39, S-64, S-84, S-85, S-134 to S-139). | F70 | Off and on were one grey step apart, and setup dimmed them like every other control with no reason given. Supersedes F38b's hover. |
| **One download card.** A chat during the first model's download shows the install's own card (`dlCard`, the S-93 block) above the composer: "Downloading your first model", "Messages you send now go out when it finishes.", the bar, the line and "Cancel download". It ticks live, the picker's row carries the same line, and finishing removes it (S-86, S-140 to S-142). | F71 | The only progress was "downloading 14%" in the model chip over a 60% empty thread. |
| **Picker:** "+ Download a model…" pinned under the list, outside its scroll, opening the download page; a flat 55% scrim of the window colour under the picker and the `+` menu, click to close; the row tooltip one line, above the row, right-aligned inside the picker ("Needs about 9.3 GB · 12.0 GB free · … on disk"), the hovered row keeping its fill. The picker is 500 px so the longest not-enough row stays one line (S-143 to S-150). | F72 | The way to more models was missing from the picker, the popover floated on a busy thread, and the tooltip escaped the picker on two lines. Supersedes the 472 px width under "Seat values I changed" and F48's "never free". |
| **Settings › Library:** the intro says once that Gates Local only reads sources, so the read-only badges go; rows say what they hold ("1,284 files", "SQLite · 3 tables"); "Remove from library" with the tooltip "Your files stay where they are"; the add rows say what can be added ("Notes, books or documents.", "A SQLite file.") (S-109, S-151, S-152). | F73 | "read-only" repeated on every row, "Remove" sounded like deleting files, and the rows used tool wording. Supersedes F65's intro and badges. |
| **Status words in lists:** the dot carries the state colour and the words drop to secondary ink (Settings › Models, the download page); light-theme amber is two steps darker for small text (`--amber-fg`); the install pulse never drops below 0.6. The download page's verdict column grows to fit "Uses system memory · slower" on one line. | F74 | Rows of coloured words were louder than the names they described, light amber failed small-text contrast, and the pulse faded the dot to nothing. |
| **System-memory picker rows lead with the total:** "est. 14.6 GB at 16k · 2.6 GB from system memory" (S-05, S-149). | F75 | The row gave the spilled part alone, which read as the model's size. |
| **GPU panel copy is one fact per line:** "Estimated 8.2 GB · 12.0 GB free", then "Measured 6.9 GB on last load" (or the system-memory or shortfall line); no line ends on a separator. "free" is the one word for the GPU memory a chat model can use, on every surface; "available" is gone from numbers (S-07, S-126). | F76 | Two facts shared a wrapped line that ended on "·", and the panel said "free" while Settings said "available". Supersedes F48's wording. |
| **First-run subtitle on one line:** "One model is enough, and this one fits your GPU." (S-16, S-75). | F77 | The old subtitle wrapped to a one-word line. |
| **Radios:** a row that cannot be picked dims its radio with its name; a downloading row shows the tool row's spinner in the radio slot (S-18, S-49, S-163). | F78 | A bright radio on a dimmed row looked pickable; the dashed ring was a fourth radio style. Supersedes F57's dashed ring. |
| **Approval card:** no Approve tooltip (the hint line says "Ctrl Enter approves"); "+1 −1" use the diff's muted green and red (S-13, S-161). | F79 | The tooltip repeated the hint, and bright counts outshouted the diff. |
| **A 24 px fade under the thread header** (a mask, no colour). | F80 | Text cut off hard at the header's edge. |
| **Keyboard focus on a turn's actions:** Tab reaches Edit, Copy and Regenerate with one ring (2 px, 2 px offset); the Thought line and tool rows take the same ring. The action buttons are 6 px apart so a ring never overlaps its neighbour (S-32, S-153, S-154). | F81 | Focus showed the actions but not which one was focused, and at 2 px apart the ring covered the next button. |
| **Setup links join the starter grid** as one quiet row on the cards' columns, each on its card's 16 px inset with the icon its card will have (S-04, S-37, S-155, S-156). | F82 | A lone centred line under a grid read as an orphan. |
| **A sidebar title's tooltip** shows the full title and the date ("Yesterday, 4:12 PM") beside the row (S-157). | F83 | Truncated titles were unrecoverable without opening them. Supersedes "only when cut off". |
| **Tables in replies:** numbers right-aligned on tabular figures, units in the header, a rule between rows (S-158). | F84 | "2.9 s" in cells with a bare header did not align and repeated the unit. |
| **The Runtime switch row's "Switch…" hides while its confirm is open;** focus moves into the confirm and Cancel returns it (S-34, S-159, S-160). | F85 | A pressed "Switch…" beside "Install and switch" was two buttons for one action. Supersedes F45's "stays pressed". |

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
- ~~**The picker is 472 px wide.** At 440 px the keyboard-mode badges cut off
  the longest tag (`gemma3-abliterated:12b-q4`).~~ **Superseded by F72: the
  picker is 500 px**, so a not-enough row's name, purpose and Memory details
  stay on one line.

## Ethan's picks, 2026-11-07

The two drawer switchers left after round 5 are decided and gone. Ethan, in
chat: "1a 2b but just have it greyd out when off don't add "off" to make
thinking off it just says thinking either way".

- **GPU details: the docked panel** (1a). The 360 px panel beside the
  thread is the only form; the `side` and `above` popovers, `placeFit()` and
  the `fit` param are gone (S-07, S-08, S-41, S-42, S-58, S-59, S-68).
- **Toggles: the pill** (2b), with his change: off keeps the same label,
  greyed (secondary text, 1 px outline, no fill), and never says "off". The
  Image pill follows the same rule so the two match (S-01, S-35 off and
  hovered, S-36, S-39 both on, S-64 both off, S-83 and S-84 light, S-85
  Image off). The switch track and `think` param are gone.

These are owner decisions, not council findings: a reviewer may score
them but they are not reopened.

No design switchers remain in the drawer. What is left picks a screen or a
state (View, Runtime state, First-run state, Settings section, Library),
the theme, the live contrast readout and the locked list.

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
| `--amber` / `--amber-fg` | `#f59e0b` / `#fbbf24` | `#d97706` / `#854000` (F74) | pending, not ready, uses system memory |
| `--red` / `--red-fg` | `#ef4444` / `#f87171` | `#dc2626` / `#b91c1c` | not enough memory, wrong service, deletions |
| `--send-off-bg` / `--send-off-fg` | `#262626` / `#666` | `#e4e4e4` / `#a3a3a3` | disabled send |
| `--stop-bg` / `--stop-fg` | `#e6e6e6` / `#0a0a0a` | `#262626` / `#fafafa` | stop |
| `--primary-bg` / `--primary-fg` | `#ededed` / `#0a0a0a` | `#171717` / `#fafafa` | primary buttons (neutral) |
| `--seg-whisper` / `--seg-occupant` | `#c8c8c8` / `#5a5a5a` | `#575757` / `#c4c4c4` | GPU bar: Whisper, other apps (F48, F68: a clear step apart in both themes) |
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

`~/.cache/gates-local-design/lanes/r6-fix/steps.json` drives
`tools/shoot.mjs`. It produces 164 shots, S-01 to S-164, in
`lanes/r6-fix/shots/` (the coordinator moves the set to `rounds/r7/`),
with zero console messages (`shots.json`). Every shot except S-28-drawer
carries `shot=1`. S-01 to S-120 are `rounds/r6/steps.json` unchanged in
name and subject, so they now show the round-6 fixes (S-124 and S-125 add
a hover so no stale tooltip shows); S-121 to S-164 are new (below). The
round-6 review set is in `rounds/r6/shots/` (S-01 to S-120), round 5 in
`rounds/r5/shots/` (S-01 to S-92), round 4 in `rounds/r4/shots/` (S-01
to S-70).

Shots whose subject a round-6 fix changed: S-07 (the panel names the loaded
model, one fact per line, F67, F76); S-41, S-59, S-68, S-99, S-101 (the
split bar, short segment and candidate title, F67, F68); S-73, S-74, S-87,
S-88 (two exits, F69); S-39, S-64, S-83 to S-85 (pills, F70); S-86 (the
download card, F71); S-05, S-06, S-79 (500 px picker, footer, scrim, F72);
S-81, S-82, S-114, S-115 (ollama.com wording, F65b); S-105 to S-108 (one
download line, SW5b-1); S-109 to S-111 (Library, F73); S-34, S-70 (Switch…
hides when the confirm opens, F85).

S-01 to S-92 keep their names so the rounds compare one to one. Where a fix
removed what a shot showed, the shot keeps its name and shows the new state:

- Ethan's picks (round 6 set): S-08 is now `S-08-fit-panel-spill` (the docked panel at 64k, was the `above` popover); S-35 is `S-35-pill-off-hover` (was the `side` popover); S-39 is `S-39-pills-both-on`, S-64 `S-64-pills-both-off`, S-84 `S-84-light-pills-both-off` and S-85 `S-85-image-off-pill` (were `think=pill` and `think=switch` comparisons). S-01, S-36 and S-83 show the pills by default.
- Round 5: every picker and Settings › Models shot shows purpose phrases and no tag in the row (F62); S-05, S-06, S-50, S-62, S-79, S-80 and S-89 still end between rows with the thumb showing (F55), and their not-enough-memory row carries "Memory details" (F63). S-48, S-49 and S-63 show the download detail line and "Cancel download" with no × (F64). S-71, S-72 and S-86 carry "Cancel send" (F61). S-81 and S-82 carry "Browse the Ollama library ↗" (F66). S-54 and S-71 show "Cancel download" in the banner (sweep). S-07, S-41, S-58 and S-59 show the 28 px context switch (sweep). Every Settings shot shows "Library" in the nav (F65).

- S-05 and S-06 (picker) have no context control; S-06 still sets `ctx=32` by URL and shows the caption "Estimated at 32k". Both lists end between rows with the thumb showing (F55).
- S-33 and S-43 (download page) show Recommended and "Also available · uses system memory".
- S-03 and S-55 (streaming) show the caret alone, no "Writing…" row (F58).
- S-16 and S-67 (first run, nomodels) read "Download your first model" / "Downloading your first model"; S-15 and S-67 carry "Cancel download".
- S-65 shows "Retry" beside "Stopped after 3 s".

New in round 3:

| Shot | State |
|---|---|
| S-48-download-page-34 | download sub-page with Qwen 3 14B at 34% (`dl=34`) |
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
| S-64-pills-both-off | Thinking and Image both off: the same labels, greyed (was `think=pill`) |
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
| S-82-custom-model-filled | the same with "phi4:14b" typed: Download enabled | F59 |
| S-83-light-think-off | light, Thinking off: the greyed pill | Ethan's pick |
| S-84-light-pills-both-off | light, both pills off | Ethan's pick |
| S-85-image-off-pill | the Image pill off (greyed) next to Thinking on | Ethan's pick |
| S-86-chat-during-first-download | a chat opened from "Start chatting" mid-download, with a waiting message ("Sends when the download finishes") and the chip "· downloading 14%" | F44b |
| S-87-light-firstrun-ollama-cancelled | S-73 light, by URL (`first=installing&cancelled=1`) | F54 |
| S-88-light-firstrun-model-cancelled | S-74 light, by URL (`first=nomodels&cancelled=1`) | F54 |
| S-89-light-picker-scrolled-end | S-79 light | F55 |
| S-90-light-settings-models | light Settings › Models: radio outlines, context line | F57, F36b |
| S-91-stopped-retry-hover | stopped reply with "Retry" focused (ring and hover row) | F56 |
| S-92-light-approval-composer | S-77 light | F53 |

New in round 5:

| Shot | State | Fix |
|---|---|---|
| S-93-queued-cancel-send | a message waiting during install, "Cancel send" hovered | F61 |
| S-94-light-queued-cancel-send | the same, light | F61 |
| S-95-after-cancel-send | after Cancel send, by URL (`queued=1&unqueue=1`): text back in the composer, install still running | F61 |
| S-96-after-cancel-send-click | the same reached by clicking Cancel send | F61 |
| S-97-light-picker-purpose-end | light picker scrolled to its end: purpose lines, Memory details on the last row | F62, F55 |
| S-98-picker-memory-details-hover | the picker with "Memory details" hovered | F63 |
| S-99-picker-memory-details-open | the GPU panel opened from the picker for Qwen 3.8 27B abliterated: "Needs 2.3 GB more at 16k" | F63 |
| S-100-light-picker-memory-details-open | the same, light | F63 |
| S-101-settings-models-memory-details | Settings › Models with the GPU panel opened from the not-enough-memory row | F63 |
| S-102-light-settings-models-memory-details | the same, light | F63 |
| S-103-settings-models-memdet-hover | Settings › Models with "Memory details" hovered | F63 |
| S-104-thread-memdet-param | `memdet=qwen3.8-abliterated:27b` on a thread | F63 |
| S-105-settings-models-download-detail | Settings › Models downloading row: bar, "3.2 of 9.3 GB · 48 MB/s · about 3 min left", "Cancel download" | F64 |
| S-106-light-settings-models-download-detail | the same, light | F64 |
| S-107-download-page-detail | download page with the detail under the name and "Cancel download" in the action column | F64, F66 |
| S-108-light-download-page-detail | the same, light | F64, F66 |
| S-109-settings-library | Settings › Library with sources, quiet "Remove" | F65, sweep |
| S-110-light-settings-library | the same, light | F65 |
| S-111-light-settings-library-empty | light Library with no sources yet (`sources=none`) | F65 |
| S-112-plus-menu-library-hover | the `+` menu with "Add to library…" / "Stays for every chat" hovered | F65 |
| S-113-plus-menu-to-library | Settings › Library reached from the `+` menu | F65 |
| S-114-custom-model-browse-hover | "Browse the Ollama library ↗" hovered | F66 |
| S-115-light-custom-model-browse-hover | the same, light | F66 |
| S-116-banner-cancel-setup-hover | the installing banner with "Cancel download" hovered | sweep |
| S-117-banner-after-cancel-setup | the banner after it: "Ollama isn't installed" | sweep |
| S-118-light-new-no-library | light new thread with no sources: "Set up library search…" hovered | F65 |
| S-119-picker-search-tag | picker search `gemma3-abl` matching by tag | F62 |
| S-120-picker-row-tooltip | a picker row's tooltip with the mono tag | F62 |

New in round 6 (lane r6-fix):

| Shot | State | Fix |
|---|---|---|
| S-121-panel-candidate-from-picker | "Memory details" from the picker: "If you switch to Qwen 3.8 27B abliterated", Now and If you switch bars, "Estimate at" | F67, F68 |
| S-122-light-panel-candidate-from-picker | the same, light | F67 |
| S-123-panel-candidate-estimate-at-32k | the candidate panel at 32k; the chat's chip unchanged | F67 |
| S-124-panel-candidate-from-settings | the candidate panel from Settings › Models: no context row | F67 |
| S-125-light-panel-candidate-from-settings | the same, light | F67 |
| S-126-panel-loaded-model | the panel for the chat's own model: its name, "Context for this chat", one fact per line | F67, F76 |
| S-127-panel-spill-bar-legend | Gemma 4 12B at 64k: "on GPU 12.0 GB" and amber "From system memory 2.2 GB" past the tick | F68 |
| S-128-light-panel-spill-bar-legend | the same, light | F68 |
| S-129-panel-shortfall | the shortfall: dashed red-outline "Short 2.3 GB" past the amber | F68 |
| S-130-light-panel-shortfall | the same, light | F68 |
| S-131-panel-whisper-tooltip | Whisper's legend row hovered: its tooltip, and "kept loaded" in its secondary text (no lock icon) | F68 |
| S-132-firstrun-ollama-cancelled-exit | after cancelling the install: "Retry download" and "Use an existing Ollama" | F69 |
| S-133-firstrun-model-cancelled-exit | after cancelling the model: "Download and start" and "Choose another model" | F69 |
| S-134-pills-on | Thinking and Image on: filled, primary ink | F70 |
| S-135-pills-off | both off: outline only, muted ink | F70 |
| S-136-pills-unavailable | during setup: 40%, tooltip "Available when setup finishes" | F70 |
| S-137-light-pills-on | S-134 light | F70 |
| S-138-light-pills-off | S-135 light | F70 |
| S-139-light-pills-unavailable | S-136 light | F70 |
| S-140-first-download-card | a chat during the first download: the install's card above the composer | F71 |
| S-141-light-first-download-card | the same, light | F71 |
| S-142-first-download-picker-row | the picker during it: the downloading row carries the same line | F71, SW5b-1 |
| S-143-picker-footer-scrim | the picker with its pinned footer and the flat scrim | F72 |
| S-144-light-picker-footer-scrim | the same, light | F72 |
| S-145-picker-footer-to-download | the footer clicked: the download page | F72, F65b |
| S-146-plus-menu-scrim | the `+` menu over the scrim (light) | F72 |
| S-147-scrim-click-closes | after clicking the scrim: the picker closed | F72 |
| S-148-picker-row-tooltip-one-line | a row tooltip on one line inside the picker | F72, F62b |
| S-149-picker-spill-row-tooltip | a system-memory row: "est. 14.6 GB at 16k · 2.6 GB from system memory" | F75, F72 |
| S-150-picker-downloading-row | the picker's downloading row: spinner, "Downloading · " and the line | SW5b-1, F78 |
| S-151-settings-library | Library after F73: row counts, "Remove from library", no badges | F73, SW5b-5 |
| S-152-light-settings-library | the same, light | F73 |
| S-153-keyboard-focus-edit | Tab to Edit: one ring, 6 px clear of Copy | F81 |
| S-154-keyboard-focus-thought | Tab to the Thought line | F81 |
| S-155-starter-grid-setup-links | setup links as one quiet row on the card columns | F82 |
| S-156-light-starter-grid-setup-links | the same, light | F82 |
| S-157-sidebar-title-tooltip | a sidebar title's tooltip with the full title and date | F83 |
| S-158-benchmark-table | a reply table: right-aligned tabular numbers, units in the header | F84 |
| S-159-runtime-confirm-after-f85 | the runtime confirm open: "Switch…" hidden, focus inside, Cancel quiet | F85, SW5b-2 |
| S-160-light-runtime-confirm-after-f85 | the same, light | F85 |
| S-161-approval-diff-counts | the approval card: "+1 −1" muted, no Approve tooltip | F79 |
| S-162-download-page-line | the download page mid-download: one full-width line, action column empty | SW5b-1, F74 |
| S-163-light-settings-models-downloading | light Settings › Models downloading: spinner radio, the line | SW5b-1, F78, F74 |
| S-164-abliterated-tooltip | "abliterated" hovered in Settings › Models: "A version with its refusals removed" | F62b |

Chip and line wording (F35b, F36b, F37b) shows in S-01, S-07, S-18, S-30,
S-58 and S-59; the 16 px action icons (F60) in S-23, S-31 and S-57.
