# Council ledger

The method is in [`council-rubric.md`](council-rubric.md). Raw seat reports
live in each round's delegate thread; a copy of the scores is under
`~/.cache/gates-local-design/rounds/r<N>/council/`. The jester's score is
never in these tables.

## Scores, overall

| Round | Snapshot | Opus 5.5 | GPT-6.1 Sol | Muse Wonder | Mean |
|---|---|---|---|---|---|
| 1 | A: `round-2-instrument.html` @ 229d293 | 6.5 | 7 | 6 | 6.5 |
| 1 | B: `round-2-t3-faithful.html` @ 229d293 | 6 | 7.5 | 7 | 6.8 |
| 2 | `shell.html` @ 3d60c2c | not seated | 8 | not seated | 8 (Sol alone) |
| 3 | `shell.html` @ 4434f72 | 8 | 8.5 | 8 | 8.17 |

Reference apps, round 1 (mean overall of the three seats): ChatGPT desktop
8.7, Ollama 8.7, T3 Code 8.5, Claude desktop 8.2, Jan 8.0, LM Studio 7.8,
Open WebUI 6.8, Msty Studio 6.5.

Reference apps, round 2 (Sol alone, same images as round 1): Ollama 8.5,
T3 Code 8.5, ChatGPT desktop 8.5, Claude desktop 8.5, LM Studio 8, Jan 8,
Open WebUI 7.5, Msty Studio 7.

Reference apps, round 3 (mean overall of the three seats): T3 Code 8.67,
ChatGPT desktop 8.67, Claude desktop 8.33, Ollama 8.17, Jan 7.83, LM Studio
7.67, Open WebUI 6.83, Msty Studio 6.5. Gates Local 8.17: level with Ollama,
0.5 behind the best (round 1: 1.9 behind). Opus: ahead of every local-model
app. Each seat's best reference: Opus 8.5 vs 8, Sol 9 vs 8.5, Muse 9 vs 8.

Read the gap, not the raw score. Sol scored the same reference images half
a point lower in round 2 than in round 1 (Ollama, T3 Code and ChatGPT 9 to
8.5). Against the best reference on Sol's own scale, Gates Local went from
1.5 behind (7.5 vs 9) to 0.5 behind (8 vs 8.5).

Category means, round 1:

| | Hier. | Type | Color | Spacing | Icons | Consist. | Out-of-box | Polish |
|---|---|---|---|---|---|---|---|---|
| A | 7.2 | 6.7 | 6.3 | 7.2 | 5.8 | 6.8 | 6.0 | 6.3 |
| B | 7.3 | 6.5 | 6.5 | 6.8 | 7.2 | 6.8 | 7.2 | 6.8 |
| Best ref | 9.2 Ollama | 8.7 ChatGPT, Claude | 8.5 T3 | 8.8 ChatGPT, Ollama | 8.3 ChatGPT | 8.7 ChatGPT, Ollama | 9.2 Ollama | 8.8 T3, ChatGPT |

Category scores, round 2 (Sol alone):

| | Hier. | Type | Color | Spacing | Icons | Consist. | Out-of-box | Polish |
|---|---|---|---|---|---|---|---|---|
| shell r2 | 9 | 8 | 8.5 | 8.5 | 8 | 7.5 | 8 | 8 |
| Best ref | 9.5 Ollama | 9 Claude | 8.5 five apps | 9 Ollama, T3, ChatGPT | 8.5 five apps | 9 Ollama | 8.5 ChatGPT | 9 T3, ChatGPT |
| Gap | −0.5 | −1 | 0 | −0.5 | −0.5 | −1.5 | −0.5 | −1 |

Category means, round 3 (Opus, Sol, Muse):

| | Hier. | Type | Color | Spacing | Icons | Consist. | Out-of-box | Polish |
|---|---|---|---|---|---|---|---|---|
| shell r3 | 8.33 | 8.17 | 8.17 | 8.33 | 7.83 | 7.5 | 8.17 | 8.0 |
| Best ref | 9.17 Ollama | 8.83 Claude | 8.67 T3 | 8.83 ChatGPT | 8.5 T3, ChatGPT | 8.83 T3 | 8.5 ChatGPT | 9.0 T3, ChatGPT |
| Gap | −0.84 | −0.66 | −0.5 | −0.5 | −0.67 | −1.33 | −0.33 | −1.0 |

Categories where a seat put Gates Local at or above every reference: Opus,
color; Sol, spacing and out-of-box; Muse, none.

## Round 1 decision

Base: **B**, two seats to one (Sol and Muse for B, Opus for A). Opus's case
against B is its foundations: a fallback font, a 1,000 px prose column,
uneven vertical rhythm and a blue install banner. All four are fixed in the
round-1 fix list below, and A's strongest parts carry over. B continues as
`docs/design/shell.html`; both round-2 files stay as the record.

## Fix list (round 1)

Each fix names the findings it closes. Status: open until the next round's
seats stop raising it. Round 2 seated Sol alone, so "fixed (G2)" means one
seat checked it; round 3 seats all three.

| Fix | What | Closes | Status |
|---|---|---|---|
| F01 | Install state: drafting stays possible, send is a gray disabled disc, placeholder says chat starts when Ollama finishes (with ETA), model and fit chips dim | C1-01 G1-03 M1-01 | fixed (G2) |
| F02 | Green means ready, fits, send and approve only. Stop is a neutral light disc; pending is amber; Reject is neutral; no blue anywhere; idle send gray, ready send solid green with a black arrow | C1-02 C1-09 C1-10 C1-28 G1-12 G1-13 M1-02 M1-17 | partly (G2): install bar still green beside an amber status |
| F03 | Adwaita Sans for UI, one mono (JetBrainsMono Nerd Font) everywhere; sans with tabular numerals for times and sizes; mono only for commands, paths, diffs and model tags | C1-06 C1-15 | fixed (G2) |
| F04 | Prose column about 720 px; user bubbles align to it; composer the same width or slightly wider | C1-07 G1-04 M1-16 | fixed (G2) |
| F05 | One spacing scale (4/8/12/16/24/32): 32 between turns, 8-12 inside a turn, no dead bands | C1-08 G1-10 | fixed (G2) |
| F06 | Secondary text at least about #8a8a8a and 12-13 px; the dimmest gray only for decoration | C1-25 G1-06 M1-03 | fixed (G2) |
| F07 | Quiet composer: model chip, Thinking pill toggle, a `+` menu (Attach file, Generate image), "16k · fits" chip, context meter. Pills show on and off plainly and have hover states | C1-03 C1-14 G1-02 G1-05 G1-11 M1-04 | partly (G2): Thinking pill has no plain on/off mark |
| F08 | Context meter: a static arc on a visible track, hidden at low use, tooltip "Context used: 3.1k of 16k tokens"; nothing that reads as a spinner | C1-04 G1-14 M1-05 | fixed (G2) |
| F09 | Empty state: a general headline, B's trust subtitle, general prompts first and library prompts only once a source exists, 2×2 plain-language cards, image card as "Set up image generation", composer at optical center, placeholder differs from the headline, real ellipsis | C1-12 C1-13 C1-30 G1-01 G1-11 M1-11 M1-12 | partly (G2): "Runs on your GPU" is wrong while installing and for RAM models |
| F10 | Tool step row: status icon at left, plain summary ("Searched your library"), read-only and timing beside it inside the column; command and rows in the expanded details; never truncate the tool name | C1-18 C1-24 G1-08 M1-10 | fixed (G2) |
| F11 | Streaming: one status row at the end of the thread ("Running shell · 3 s", then "Writing"), spinner in place of the check, no duplicate status | C1-18 M1-13 | fixed (G2) |
| F12 | Message actions: copy, regenerate and edit on hover or focus | M1-09 | partly (G2): user-message Edit and keyboard focus not shown |
| F13 | Approval docks above a live composer (A's placement) with B's diff type, full path in a tooltip, neutral Reject, green Approve with "Ctrl ⏎" as gray hint text outside the button, amber pending label | C1-11 C1-31 M1-18 G1-12 | fixed (G2) |
| F14 | Header: thread title only; one `…` menu with a tooltip; no duplicate compose icon; gear for Settings; a fade mask under the header | C1-23 C1-26 C1-29 G1-15 M1-14 | fixed (G2) |
| F15 | Picker words: "Runs on GPU", "Uses system memory · slower", "Not enough memory at 16k"; rows lead with name, size and verdict; quantization in a tooltip; the context switch labeled with a tooltip; number shortcuts only on keyboard focus | C1-22 G1-09 M1-06 | fixed (G2) |
| F16 | Numbers: GB with one decimal everywhere, no MiB; "Estimate 8.2 GB · measured 6.9 GB on last load"; bar axis at 0 and total; other apps in two clearly different grays; A's measured tier (first token, tokens per second) in the popover | C1-19 C1-20 C1-21 M1-07 M1-08 | partly (G2): "estimated" and "download" labels missing outside the fit popover |
| F17 | Fit popover keeps the thread readable: capped height, beside the chip when width allows | M1-20 | not fixed (G2): popover covers the last turn and the composer |
| F18 | Sidebar: selected row clearly brighter, one time format per age band, full-title tooltip, plain "Ctrl N" text, streaming dot in the time slot, install percentage in the runtime footer, Settings with a gear and space above it | C1-16 C1-17 M1-15 M1-19 | fixed (G2) |
| F19 | A small monochrome app mark before "Gates Local" | C1-30 | fixed (G2) |
| F20 | Coordinator addition for out-of-box clarity (no seat asked): a first-run screen (found Ollama / installing / no models yet, each with one primary action) and a real Settings screen | owner brief | fixed (G2) |
| F21 | Memory proposals: the diff holds only what the user asked; the assistant says in one line what it proposes before the approval tray | J1-01 | fixed (G2) |
| F22 | Runtime banners sit on a new or empty thread, never above a finished conversation; send disabled with a tooltip while the runtime is not ready | J1-02 | fixed (G2) |
| F23 | The context meter is hidden on a new thread until the first turn | J1-05 | fixed (G2) |
| F24 | Hover actions never reserve space in the turn flow and never collide with the next turn; one disclosure convention (chevron at the left, like "Thought for 4s"); no trailing check when the status text already says done | J1-09 J1-10 | fixed (G2) |
| F25 | Review screenshots hide the design-drawer trigger (the `D` key still opens it); it is not product chrome | J1-13 | fixed (G2) |
| F26 | Example data stays plausible: a model's need at 16k exceeds its size on disk; diff gutters number correctly; a loaded model's popover plots its measured size | J1-07 J1-15 | minor regression (C3): S-07 legend sums to 16.0 GB under a 15.9 GB header; S-09 shows 68% beside 1.0 of 1.5 GB; F43, F48 |

## Fix list (round 2)

The six partly fixed items above carry over with the round-2 detail, and
Sol's seven new findings become F27-F33. Raw report:
`rounds/r2/council/G.md`.

| Fix | What | Closes | Status |
|---|---|---|---|
| F02b | Install progress is neutral gray, not green; amber stays the pending/attention color | F02 (G2) | fixed (C3 G3 M3) |
| F07b | Thinking shows plainly whether it is on or off (a switch or a checked state), the same convention as every other toggle | F07 (G2) | partly (M3; C3-15 two controls for one setting) |
| F09b | One trust line that is true in every state: "Runs locally on your computer"; GPU or RAM is the fit chip's job | F09 (G2) | partly (C3: endings differ; S-37 contradicts itself) |
| F12b | User turns show Edit on hover; keyboard focus on a turn shows its actions; both get a review shot | F12 (G2) | fixed (C3 G3 M3) |
| F16b | Every memory need says "estimated" (or "est.") until measured; every model size says "download" or "on disk" | F16 (G2) | fixed (C3 G3 M3) |
| F17b | The fit details open as a panel docked beside the thread that narrows it, never over the last turn or the composer; the chip's first view stays a compact summary | F17 (G2) | fixed (C3 G3 M3) |
| F27 | Settings → Models has "Download a model": a short recommended list with download size and fit; first-run "Choose another model" opens it directly | G2-01 | fixed (C3 G3 M3); no download progress state, F46 |
| F28 | Context gets one plain line: "How much conversation the model can keep in view. Larger windows use more memory." Visible in Settings, a tooltip in the picker and fit panel | G2-02 | partly (C3 G3 M3): picker and panel controls lack the visible line |
| F29 | Runtime owner is a status value, not a segmented control; switching is an explicit action ("Use Gates Local's copy…") that states what happens | G2-03 | fixed (C3 G3 M3) |
| F30 | The `+` menu has "Add to library…" with a line saying it stays for every chat; the library starter leads to setup when no source exists | G2-04 | fixed (C3 G3 M3) |
| F31 | "Set up image generation…" in both the starter and the `+` menu while it is off; "Generate image" only after setup | G2-05 | fixed (C3 G3 M3) |
| F32 | First-run model card leads with "Qwen 3.5 · Recommended" and "Runs on your GPU"; download size beside the button; parameters, context and memory math under "Model details" | G2-06 | fixed (C3 G3 M3) |
| F33 | Settings has one selected row: the bottom Settings entry loses its fill (or hides) while Settings is open | G2-07 | fixed (C3 G3 M3) |

## Fix list (round 3)

The three partly fixed items fold into F36, F38 and F49. The four seats
raised 52 findings; with duplicates merged they become F34-F52. Raw
reports: `rounds/r3/council/{C,G,M,J}.md`. Consistency (−1.33) and polish
(−1.0) are the widest gaps, so F34-F36 and F40 come first.

| Fix | What | Closes | Status |
|---|---|---|---|
| F34 | One model name: "Qwen 3.5 9B" (friendly name with size) leads on the first-run card, composer chip, picker, Settings and download rows; the tag `qwen3.5:9b` is secondary, in mono | C3-02 G3-02 J3-04 M3-13 (naming) | open |
| F35 | One fit vocabulary: the F15 labels "Runs on GPU", "Uses system memory · slower", "Not enough memory at 16k", always dot plus label in its color; "fits" only in the composer chip; "system memory" everywhere, never "RAM"; "est." in metadata, "Estimated" in sentences; picker group labels are real headers with equal spacing; a fixed 16 px check slot on every row | C3-03 C3-11 M3-03 G3-03 (label) | open |
| F36 | One per-chat context control (GPU panel) plus the Settings default; the picker header loses its segmented control for a caption ("Fit shown at 16k"); the F28 line visible under each control with the selected choice's consequence; Settings segments lose their micro-labels | F28 C3-04 M3-08 (control) M3-11 (labels) | open |
| F37 | The meter says what it measures: "Context 60%" with the token tooltip, in the chip cluster, away from send | M3-02 C3-16 | open |
| F38 | Thinking is one control: the switch alone with its label (no pill border), or a pill alone that reads "Thinking off" when off; the `think` drawer switcher keeps these two, default switch; label and bulb dim when off | F07b C3-15 | open |
| F39 | Light theme: secondary text one step darker; sidebar background distinct from the pane; a visible selected row; user bubble #e4e4e7 or a 1 px border | M3-06 C3-22 | open |
| F40 | Turn rhythm: reply actions 8-10 px under the reply, the rest of the gap below them; equal gaps after every turn; 24 px hit targets with tooltips; the same hover and focus row on every finished reply; metrics in one slot | C3-12 M3-07 J3-02 | open |
| F41 | Approval: the panel's "Reply to change the note…" becomes plain hint text, so the composer is the one input; "Waiting for approval" in sentence case with an amber dot; "Ctrl Enter" spelled the same everywhere | M3-04 C3-14 C3-19 | open |
| F42 | The runtime-wrong action says what it does ("Look on port 11435 instead" or "Start Gates Local's copy on port 11435") | M3-05 | open |
| F43 | Install: two steps with one ETA (Ollama 1.5 GB, then Qwen 3.5 9B 6.6 GB); the composer chip reads "downloads next"; placeholder "Type now; it sends when Ollama is ready"; every composer control dims equally; starter cards inert; the sidebar percentage computed from the shown bytes | C3-01 C3-07 C3-08 M3-09 J3-05 F26 (percent) | open |
| F44 | First run: headline "Ready to chat", the Ollama version and model count on the status line; "Start chatting" in every state, with the helper "You can type now; replies start when setup finishes."; the secondary link always 16 px after the button; "Details" disclosure without the chip icon; no dotted underline on a label that is not interactive | G3-01 C3-17 C3-18 C3-21 M3-10 M3-13 (underlines) | open |
| F45 | Runtime settings: one status row ("Running · Ollama 0.40.4", "Started by your system · port 11434. Gates Local won't stop it."); subtitle "Gates Local finds Ollama on its own."; switch row "Switch to Gates Local's copy" / "A private copy it starts and stops" / button "Switch…", hidden while its confirm is open; confirm list full width; paths break after slashes | G3-05 C3-05 C3-20 M3-12 | open |
| F46 | Downloads: the row button becomes a neutral progress bar with percent and ×; the picker and sidebar footer show "Downloading · 34%"; Recommended holds only GPU-fit models, the system-memory one under "Also available · uses system memory"; the Settings card becomes a "+ Download another model…" footer row in the Default model card; review shots for each state | C3-06 G3-03 M3-11 (card) J3-03 | open |
| F47 | Starter cards only for what works now; library and image setup become quieter links beneath | G3-04 | open |
| F48 | GPU panel: legend tones at least 25% apart, Free as an outlined "Unused" segment; "of 12.0 GB available" in Settings and first run; no duplicate "runner holds" stat; legend sums equal the header; GPU name as a subtitle | C3-09 C3-10 M3-08 (tones) J3-06 F26 (legend) | open |
| F49 | One trust line everywhere: "Runs locally on your computer. Nothing you type leaves it." | F09b J (F09) | open |
| F50 | Streaming: a caret at the stream head until the turn ends; one working-dot color; "Writing…" counted from the turn start, or no counter | M3-01 C3-23 | open |
| F51 | Settings has no "Settings" top bar above the section H1 or breadcrumb | J3-01 | open |
| F52 | Polish batch: the expanded tool card symmetric with the column; sidebar footer "Ctrl ," legible or dropped; tool output order matches the answer | C3-13 M3-14 | open |

## Gemini flub

The jester's notes go here, one line each, after the coordinator checks them
against the screenshots.

Round 1 (jester score kept out; 15 findings, of which 6 add something new and
were confirmed in the screenshots as F21-F26; the rest duplicate F01-F19,
one is dismissed and one is not confirmed):

- Called a harness-only keyboard shortcut in the losing direction a blocker
  (J1-03): typing a digit in A's empty picker search switches models.
- Read the harness HTML source when the brief gave it only screenshots, then
  graded `syncSend()` and CSS line numbers. Out of brief, but it found why
  B's turns have dead space (24 px of hover row reserved in flow).
- Said B's picker search field is squeezed to about 180 px; the screenshot
  shows the full placeholder with room to spare.

Round 3 (jester scored 8.5, kept out; 6 new findings, all confirmed and
merged into F40, F43, F46, F48 and F51; its two regression claims checked):

- Read the harness HTML source again, outside its brief, and cited
  `.a-act`, opacity 0.42 and `.fpn-h gap 8px`.
- Called F05 regressed; the gap it measured is F24's designed placement,
  and Sol checked F05 one by one as still fixed. The real spacing issue is
  C3-12 (F40).
- Said S-32 shows the reply action row flush against the next user turn.
  S-32 shows no reply action row; the row it measured against is the next
  user turn's own hover row, invisible unless hovered.
- Called F28 fixed; Opus, Sol and Muse all call it partly fixed.
