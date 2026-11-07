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

Reference apps, round 1 (mean overall of the three seats): ChatGPT desktop
8.7, Ollama 8.7, T3 Code 8.5, Claude desktop 8.2, Jan 8.0, LM Studio 7.8,
Open WebUI 6.8, Msty Studio 6.5.

Category means, round 1:

| | Hier. | Type | Color | Spacing | Icons | Consist. | Out-of-box | Polish |
|---|---|---|---|---|---|---|---|---|
| A | 7.2 | 6.7 | 6.3 | 7.2 | 5.8 | 6.8 | 6.0 | 6.3 |
| B | 7.3 | 6.5 | 6.5 | 6.8 | 7.2 | 6.8 | 7.2 | 6.8 |
| Best ref | 9.2 Ollama | 8.7 ChatGPT, Claude | 8.5 T3 | 8.8 ChatGPT, Ollama | 8.3 ChatGPT | 8.7 ChatGPT, Ollama | 9.2 Ollama | 8.8 T3, ChatGPT |

## Round 1 decision

Base: **B**, two seats to one (Sol and Muse for B, Opus for A). Opus's case
against B is its foundations: a fallback font, a 1,000 px prose column,
uneven vertical rhythm and a blue install banner. All four are fixed in the
round-1 fix list below, and A's strongest parts carry over. B continues as
`docs/design/shell.html`; both round-2 files stay as the record.

## Fix list (round 1)

Each fix names the findings it closes. Status: open until the next round's
seats stop raising it.

| Fix | What | Closes | Status |
|---|---|---|---|
| F01 | Install state: drafting stays possible, send is a gray disabled disc, placeholder says chat starts when Ollama finishes (with ETA), model and fit chips dim | C1-01 G1-03 M1-01 | open |
| F02 | Green means ready, fits, send and approve only. Stop is a neutral light disc; pending is amber; Reject is neutral; no blue anywhere; idle send gray, ready send solid green with a black arrow | C1-02 C1-09 C1-10 C1-28 G1-12 G1-13 M1-02 M1-17 | open |
| F03 | Adwaita Sans for UI, one mono (JetBrainsMono Nerd Font) everywhere; sans with tabular numerals for times and sizes; mono only for commands, paths, diffs and model tags | C1-06 C1-15 | open |
| F04 | Prose column about 720 px; user bubbles align to it; composer the same width or slightly wider | C1-07 G1-04 M1-16 | open |
| F05 | One spacing scale (4/8/12/16/24/32): 32 between turns, 8-12 inside a turn, no dead bands | C1-08 G1-10 | open |
| F06 | Secondary text at least about #8a8a8a and 12-13 px; the dimmest gray only for decoration | C1-25 G1-06 M1-03 | open |
| F07 | Quiet composer: model chip, Thinking pill toggle, a `+` menu (Attach file, Generate image), "16k · fits" chip, context meter. Pills show on and off plainly and have hover states | C1-03 C1-14 G1-02 G1-05 G1-11 M1-04 | open |
| F08 | Context meter: a static arc on a visible track, hidden at low use, tooltip "Context used: 3.1k of 16k tokens"; nothing that reads as a spinner | C1-04 G1-14 M1-05 | open |
| F09 | Empty state: a general headline, B's trust subtitle, general prompts first and library prompts only once a source exists, 2×2 plain-language cards, image card as "Set up image generation", composer at optical center, placeholder differs from the headline, real ellipsis | C1-12 C1-13 C1-30 G1-01 G1-11 M1-11 M1-12 | open |
| F10 | Tool step row: status icon at left, plain summary ("Searched your library"), read-only and timing beside it inside the column; command and rows in the expanded details; never truncate the tool name | C1-18 C1-24 G1-08 M1-10 | open |
| F11 | Streaming: one status row at the end of the thread ("Running shell · 3 s", then "Writing"), spinner in place of the check, no duplicate status | C1-18 M1-13 | open |
| F12 | Message actions: copy, regenerate and edit on hover or focus | M1-09 | open |
| F13 | Approval docks above a live composer (A's placement) with B's diff type, full path in a tooltip, neutral Reject, green Approve with "Ctrl ⏎" as gray hint text outside the button, amber pending label | C1-11 C1-31 M1-18 G1-12 | open |
| F14 | Header: thread title only; one `…` menu with a tooltip; no duplicate compose icon; gear for Settings; a fade mask under the header | C1-23 C1-26 C1-29 G1-15 M1-14 | open |
| F15 | Picker words: "Runs on GPU", "Uses system memory · slower", "Not enough memory at 16k"; rows lead with name, size and verdict; quantization in a tooltip; the context switch labeled with a tooltip; number shortcuts only on keyboard focus | C1-22 G1-09 M1-06 | open |
| F16 | Numbers: GB with one decimal everywhere, no MiB; "Estimate 8.2 GB · measured 6.9 GB on last load"; bar axis at 0 and total; other apps in two clearly different grays; A's measured tier (first token, tokens per second) in the popover | C1-19 C1-20 C1-21 M1-07 M1-08 | open |
| F17 | Fit popover keeps the thread readable: capped height, beside the chip when width allows | M1-20 | open |
| F18 | Sidebar: selected row clearly brighter, one time format per age band, full-title tooltip, plain "Ctrl N" text, streaming dot in the time slot, install percentage in the runtime footer, Settings with a gear and space above it | C1-16 C1-17 M1-15 M1-19 | open |
| F19 | A small monochrome app mark before "Gates Local" | C1-30 | open |
| F20 | Coordinator addition for out-of-box clarity (no seat asked): a first-run screen (found Ollama / installing / no models yet, each with one primary action) and a real Settings screen | owner brief | open |
| F21 | Memory proposals: the diff holds only what the user asked; the assistant says in one line what it proposes before the approval tray | J1-01 | open |
| F22 | Runtime banners sit on a new or empty thread, never above a finished conversation; send disabled with a tooltip while the runtime is not ready | J1-02 | open |
| F23 | The context meter is hidden on a new thread until the first turn | J1-05 | open |
| F24 | Hover actions never reserve space in the turn flow and never collide with the next turn; one disclosure convention (chevron at the left, like "Thought for 4s"); no trailing check when the status text already says done | J1-09 J1-10 | open |
| F25 | Review screenshots hide the design-drawer trigger (the `D` key still opens it); it is not product chrome | J1-13 | open |
| F26 | Example data stays plausible: a model's need at 16k exceeds its size on disk; diff gutters number correctly; a loaded model's popover plots its measured size | J1-07 J1-15 | open |

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
