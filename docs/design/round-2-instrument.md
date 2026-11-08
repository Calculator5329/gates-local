# Round 2, instrument variant

File: `round-2-instrument.html` (one file, vanilla HTML/CSS/JS, no network, system fonts only).
Open it by double-click. The gear at the bottom right opens the design drawer.
Query parameters set any switcher on load, for example `?view=fit&theme=light&gpuWhere=header`, or `?drawer=1` to open the drawer.

The idea: T3 Code's skeleton unchanged (sidebar, 44px header, centred timeline, composer as control centre, banner slot, pending-approval slot), finished like a measuring instrument. Numbers use a mono face with tabular figures. Rules are hairlines and 1px inset shadows, not filled cards. One warm accent is used only as a status colour. Machine facts live in the composer row and in popovers, never in permanent strips.

## Screens (drawer → Screen)

| Screen | What it shows |
|---|---|
| Thread | Library thread finished: user bubble, "Thought for 4s", shell step `read-only · 42 ms` (expands to 3 rows), markdown answer, second exchange |
| Streaming | Same thread, new turn streaming: status line goes Waiting → Thinking line → Running shell → Reading results → Writing (elapsed s and tok/s); send button is stop; sidebar thread gets an accent dot |
| New thread | "Ask your machine" empty state, composer, four suggestion cards (shell, read, note, image) |
| Model picker | Picker open: search, groups Fits on the GPU / Spills to RAM / Won't fit at the chosen window, disk size, need or shortfall, digit jump keys, 16k/32k/64k in the footer |
| GPU fit | Fit popover: 6px stacked bar (whisper, media-vault vision, chat model, free track), ticks 0/4/8/12/15.92, legend with GB and MiB columns, RAM spill against the 4 GB cap, 16k/32k/64k with a verdict each, measured runner/first token/tok/s |
| Runtime banner | ProviderStatusBanner position: Installing Ollama 0.40.15 with live progress (then starting, then ready); the Runtime state switch also shows Missing (Install) and Wrong service (Retry, Use port 11435) |
| Memory diff | Note step "waiting for approval" plus a diff of `reading.md` in the composer's pending-panel slot, Approve (Ctrl ↵) / Reject |

Interactions: sidebar thread switching; view switcher; picker, fit and context popovers (click toggles, Escape and click outside close, they reposition on resize); 16k/32k/64k updates the chip, the meter, both bars and the picker grouping; thinking line and step rows expand and collapse; Enter sends, appends a bubble and streams the reply into the same nodes (text nodes grow, the turn is never rebuilt); Stop halts and marks "Stopped."; copy on hover with a "Copied" toast; Ctrl K palette (commands and threads), Ctrl M picker, Ctrl N new thread; a refused model shows its shortfall and is not selected; light/dark.

## Switchers, defaults and why

| Switcher | Options (default first) | Why the default |
|---|---|---|
| Theme | Dark / Light | Settled taste: dark default |
| Palette preset | Graphite + amber / Ink + cyan / Charcoal + vermilion / T3 stock + blue | Graphite keeps the chrome neutral so amber reads as status only; not green, since green is semantic "fits" here and the showcase drift colour |
| Accent H/S/L (per theme) | sliders, live WCAG readout | Skill accent system; deep, soft, ring, on-accent derive from it |
| Numeric face | Mono tabular / Sans tabular | The instrument idea: every GB, ms, tok/s and token count lines up in one column |
| Sans face | Adwaita Sans / T3 stack / Fira Sans / Open Sans | Adwaita Sans is Inter-derived and installed (Inter is not); T3's own stack resolves to Noto Sans here |
| Mono face | JetBrainsMono Nerd Font / Adwaita Mono / T3 stack / DejaVu Sans Mono | Best tabular digits installed; T3's ui-monospace stack lands on Liberation Mono on this machine |
| Radius | 4px / 2px / 8px | Precise without being sharp; bubble = 3× (cap 16px), composer = 2× + 4px (cap 20px), send button stays round |
| Density | Linear-plus / T3 stock / Compact | Brief: denser than T3, roomier than Linear. 44px header, 28px rows, 13px UI, 15px messages, 880px column, 820px prose |
| Surface | Hairline + inset / Soft filled | Ethan's 1px inset at about 10% instead of filled cards |
| Tool step row | Terminal mono / T3 work log | Terminal row shows the exact command and a ✓/•/○/× mark; work log is T3's sans row with a tool icon |
| GPU fit location | Composer chip / Chip + sidebar-footer meter / Header pill | Composer is the control centre; the other two test whether an always-visible meter earns its place |
| Runtime state (example data, not taste) | Ready / Starting / Installing / Missing / Wrong service | Drives the sidebar status row and the banner |

## Token contract

All colour goes through custom properties on `:root`, overridden under `@media (prefers-color-scheme: dark) :root:not([data-theme="light"])` and `:root[data-theme="dark"]`. Components never hardcode a colour. Palette presets set only the neutral keys below as inline properties and clear them for graphite.

- Surfaces: `--bg` page, `--sidebar`, `--surface` (popovers, composer, cards), `--surface-2` (filled variant), `--bubble` (user message).
- Ink: `--ink`, `--ink-2` (secondary), `--ink-3` (meta, labels; ≥4.4:1 on page in both themes).
- Rules and states: `--line` (hairline, 7.5% white / 9% black), `--line-strong` (13% / 16%), `--hover`, `--active`, `--selected`, `--hi` (1px top highlight), `--track` (empty bar).
- Bars: `--seg-1` whisper, `--seg-2` occupant, `--seg-3` notes. The chat model's segment is `--acc`, or `--err` when it won't fit.
- Action: `--action`/`--on-action`. The send button and primary button are neutral ink, except the T3 preset, where `--action` = accent.
- Accent: `--acc --acc-deep --acc-soft --acc-ring --on-acc`, from H/S/L per theme. Graphite: light 30/90/34, dark 32/92/60.
- Semantic: `--ok --warn --err` plus `-soft` mixes. Never derived from the accent. Charcoal moves `--err` to hue 345 so it stays apart from vermilion.
- Shape and type: `--r` (radius base) with `--r-sm --r-lg --r-bubble --r-comp`; `--sans --mono --num --num-scale`; density `--side-w --top-h --row-h --fs-ui --fs-msg --lh-msg --turn-gap --col --prose`.

Where the accent appears (and nowhere else): streaming spinner and sidebar live dot, the chat model's bar segment, the selected context-window marker, Think/Image on-squares, the "Pending approval" tag, the focus ring, install progress.

Known tension: amber accent and `--warn` sit close. Warn is kept yellower (hue 42–46 against 30–32) and always comes with a word ("spills"). If Ethan picks graphite + amber, consider moving warn toward yellow-green or adding a glyph.

## Lifted from T3 Code (MIT, Copyright 2026 T3 Tools Inc., `apps/web/src/`)

Full notice in `LICENSES/T3-Code-MIT.txt`; source commit in `THIRD_PARTY_NOTICES.md`.

| T3 file | What was lifted |
|---|---|
| `index.css` | Token structure (bg/card/popover/border/input/muted), dark neutral-950 and #000 sidebar (T3 stock preset), 6px transparent-track scrollbar, font stacks (T3 stack options), radius scale idea (one base, sm/lg derived), 52px topbar (T3 stock density) |
| `components/ui/sidebar.tsx`, `Sidebar.tsx` | 16rem sidebar, row height 32/28, row inset 10px, group labels at 11–12px muted, truncated title plus tabular time column, selected row treatment |
| `chat/ChatHeader.tsx`, `NoActiveThreadState.tsx` | Topbar with bottom rule, title left and actions right; centred empty title |
| `chat/MessagesTimeline.tsx` | Centred column; user bubble right-aligned at about 80% width with rounded bg-message; assistant as plain block; meta and copy row that appears on hover; work-log row (12px, 20px icon slot, chevron) for the "T3 work log" option; ✓ ● ○ step marks |
| `chat/MessageCopyButton.tsx` | Copy icon swaps to a check and shows an anchored "Copied" for about 1 s |
| `chat/ChatComposer.tsx`, `ComposerPrimaryActions.tsx`, `composerFooterLayout.ts` | Rounded composer frame on a card surface with a faint outline; footer `px-3 py-2` with controls left and meter plus round send right; send scales 1.05 on hover and becomes stop |
| `chat/ComposerPendingApprovalPanel.tsx` | Pending panel in the composer's top slot with a bottom rule, uppercase tracked label, summary, 1/N count, inset detail box in mono |
| `chat/ComposerControl.tsx` | 28px ghost controls, gap 6px, secondary label colour that goes to foreground on hover |
| `chat/ContextWindowMeter.tsx` | Context use as a compact control that opens a breakdown popover; percentage plus used/max in tabular figures; thin bar |
| `chat/ModelPickerContent.tsx`, `ModelListRow.tsx` | Search row with a bottom rule, grouped list, row padding, name plus muted subline, kbd jump labels |
| `chat/ProviderStatusBanner.tsx` | Centred banner under the header, `w-fit` with max width, 12px inset, tinted 32% border for warning/error, title plus muted message, dismiss X at the top right |
| `ui/popover.tsx`, `ui/kbd.tsx`, `ui/button.tsx` | Popover inset top highlight plus deep soft shadow; kbd chip proportions; outline and ghost button states |

No T3 name, logo, provider icons or copy are used.

## Checked

- `node --check` on the extracted script: passes.
- Headless Chromium (`/usr/bin/chromium --headless --screenshot`, 1440×900, nothing installed) for every screen in dark, plus light fit, light drawer, T3-stock + header pill, wrong-service banner, work-log rows with 8px radius, and streaming at two moments.
- A scratchpad driver page iframes the harness (`--allow-file-access-from-files --dump-dom`) and checks 40 interactions; all pass.
