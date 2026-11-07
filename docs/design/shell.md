# Gates Local shell

`shell.html` is the one design harness for the Gates Local chat app. It is a
single file with no network: vanilla HTML, CSS and JS. It started as a copy of
`round-2-t3-faithful.html` (base B), then took the round-1 fix list from
`council-ledger.md` (F01 to F20). Neither round-2 file was changed.

Open it from disk: `file:///…/docs/design/shell.html?view=thread`.

> **Example data, not measurements.** Every GPU number here is a
> made-up example sized to an RTX 5070 Ti (15.9 GB): VRAM held by whisper,
> media-vault and the chat runner, per-model needs at 16k, 32k and 64k,
> first-token times, tok/s, download speeds and ETAs. Model names, disk sizes,
> paths and thread contents are examples too. The app must read real values
> from Ollama and `nvidia-smi`. Never copy these numbers into code or docs as
> facts.

## Views

| `view=` | What it shows |
|---|---|
| `thread` | A finished thread. The thought line, a tool step row, markdown, and copy/regenerate/meta on hover. |
| `streaming` | The same thread replaying live: Thinking, then the tool row spinning, then Writing. Stop works. |
| `new` | Empty state. The headline, a trust subtitle and the composer at optical centre, with four cards below. |
| `picker` | The thread with the model picker open. |
| `fit` | The thread with the fit (GPU memory) popover open. |
| `runtime` | A runtime banner docked directly above the composer. The state comes from `runtime=`. `installing` and `missing` show on a new thread (no chat can have happened yet); `starting` and `wrong` show on the library thread (F22). |
| `memory` | The thread ending in a proposed note edit, with the approval dock above a live composer. |
| `firstrun` | Full-window first run. The state comes from `first=`. |
| `settings` | Settings. The section comes from `section=`. |

## URL params

| Param | Values | Default |
|---|---|---|
| `view` | the nine views above | `thread` |
| `runtime` | `installing` `starting` `missing` `wrong` | `installing` (used only in `view=runtime`, or after first run's "Start writing") |
| `first` | `found` `installing` `nomodels` | `found` |
| `section` | `general` `models` `runtime` `memory` `images` `sources` | `general` |
| `ctx` | `16` `32` `64` | `16` |
| `model` | any model id in the list | `qwen3.5:9b` |
| `theme` | `dark` `light` `system` | `dark` |
| `fit` | `side` `above` | `side` |
| `thread` | `lib` `cron` `icon` `bench` `notes` `whisper` `readme` | `lib` |
| `drawer` | `1` opens the design drawer | closed |
| `shot` | `1` hides the harness-only drawer trigger for review screenshots (F25); `D` still opens the drawer | off |

`window.__gl` exposes `state`, `renderView`, `toggleDrawer`, `syncDrawer`,
`openSettings`, `openPicker` and `openFit` for scripted screenshots.

## Working interactions

- **Sidebar**
  - Click a thread to open it.
  - `Ctrl N` starts a new thread.
  - `Ctrl K` or Search opens an inline filter. `Esc` or blur with no text closes it.
  - A thread that is streaming shows a pulsing dot in place of its time.
  - The full title appears as a tooltip, but only when the title is cut off.
  - Clicking the runtime row opens Settings › Runtime.
  - Settings (or `Ctrl ,`) swaps the sidebar for the settings nav. `Esc` or "Back to chat" returns.
- **Composer**
  - `Enter` sends and `Shift Enter` adds a new line.
  - Send is disabled (gray) with no text, while the runtime isn't ready, or when the model won't fit.
  - Once a reply starts streaming, the send button becomes Stop. Clicking it ends the reply with "Stopped after N s".
  - The `+` menu:
    - Attach file adds a removable chip.
    - Generate image opens Settings › Image generation while generation is off. Once it's on, the item toggles an Image pill.
  - The Thinking pill toggles. With it off, the thought line is skipped.
  - The context meter is a short bar plus a percentage. It is hidden below 50% use and on a new thread, and turns amber above 85%. Its tooltip reads "Context used: 9.8k of 16k tokens". The `bench` thread (60%) shows it.
- **Model picker** (click the model chip, or `Ctrl M`)
  - The search box filters the list.
  - The 16k/32k/64k switch regroups the list live.
  - Arrow keys move the highlight and Enter picks.
  - Number keys and their badges appear only in keyboard mode, after an arrow key or `Ctrl M`.
  - Models that won't fit can't be clicked. Each row's tooltip gives the family, quant and a reason.
- **Fit popover** (click the fit chip)
  - The context switch inside it recomputes the bar, the legend, the verdict and the numbers.
  - The measured tier shows only for the loaded model at its loaded context.
- **Timeline**
  - The thought line expands to show the reasoning.
  - Clicking a tool row (or pressing Enter or Space on it) expands the command and its output.
  - Copy flashes a check.
  - Regenerate replays the reply.
  - Edit puts the user's message back in the composer.
  - A message that contains "remember" runs the note flow; one that mentions books or the library runs the library flow.
- **Memory**
  - Approve, `Ctrl ⏎`, or Reject resolves the dock.
  - The tool row then changes to "Saved a note" or "Note edit rejected", and a short reply streams in.
  - The composer stays live while the note is pending.
- **Runtime**
  - Installing counts up live and updates the banner, the sidebar % and the placeholder ETA.
  - When the install finishes it goes to starting, then to ready.
  - Install and Retry in the banner run the same flow.
- **First run**
  - found: "Start chatting" opens a new thread.
  - installing: "Start writing" opens a new thread with the install still running, so the first message can be drafted early.
  - nomodels: Download shows progress in place, then changes to "Start chatting".
  - Every state has a quiet Settings link.
- **Settings**
  - The theme switch applies at once.
  - The default model and default context are shared with the composer.
  - The image generation switch drives the `+` menu.
- **Design drawer** (`D` or the swatch icon, harness only)
  - It picks the view, the runtime, first-run and settings states, the theme, and the one open question.
  - It shows live contrast ratios and lists what is locked.

## Locked decisions

| Decision | Fix | Why |
|---|---|---|
| **Black + green only.** The palette, Graphite, Slate, Stone and hue switchers are gone. | F02 | Green means one thing: ready, fits, send, approve. Stop is a neutral light disc. Reject is a neutral outline. Pending is amber. Won't fit is red. There is no blue anywhere, including the install banner, which was blue in round 2. |
| **Send states.** Idle is a gray disc with a gray arrow (`#262626` / `#666`). Ready is solid green with a near-black arrow. Stop is `#e6e6e6` with a black square. | F02 | One look per state, so the disc never says "ready" when it isn't. |
| **Adwaita Sans for UI, JetBrainsMono Nerd Font as the one mono.** | F03 | These are the desktop's own fonts, named by family so `local()` lookup finds them with no network. Mono is only for commands, paths, diffs and model tags in code. Times and sizes use sans with tabular numerals. |
| **Prose column 720 px.** The composer is 752 px, so its text lines up with the prose edge. | F04 | A comfortable line length. Bubbles, tool rows, banners and the dock share the same edges. |
| **Spacing 4 / 8 / 12 / 16 / 24 / 32.** There is 24 px from a user message to the reply, and about 32 px from reply text to the next user bubble, which includes the 28 px hover action row. Items inside a turn are 8 px apart. | F05 | One scale ends the ad-hoc gaps. |
| **Secondary text at least `#9a9a9a`** on dark (7.0:1) **and 12–13 px.** `#5e5e5e` is used only for decoration. | F06 | Above the C1-25 floor of `#8a8a8a`. |
| **Quiet composer:** `+`, the model chip, the fit chip, the Thinking pill, the meter and send. | F07 | The composer is the control centre. Pills show on (filled, foreground text) and off (outlined, gray) plainly. |
| **Meter:** a 28 px bar with a percentage, hidden below 50% and on a new thread. | F08, F23 | The lane's ring still read as a spinner next to Stop, and a filled pie read as the theme icon. A bar and a number read as a gauge and nothing else. |
| **Empty state:** "What would you like help with?", a trust subtitle, a 2×2 grid of plain cards with general ones first, and an image card reading "Set up image generation". The placeholder is "Ask anything…". | F09 | The headline differs from the placeholder, and the ellipsis is a real one. |
| **Tool step row:** status icon, then a plain summary ("Searched your library"), then "Shell · read-only · 42 ms", then a chevron. It wraps and is never cut off. | F10 | The summary says what was done; the details are in the expanded row. |
| **One live status row** at the end of a streaming turn. "Thinking · N s" becomes the running tool row (its spinner is the only status), then "Writing · N s". | F11 | No duplicate indicators. Elapsed time is counted per phase. |
| **Hover/focus actions:** copy, regenerate and meta on replies; time, edit and copy on user messages. | F12 | The row space is reserved, so nothing jumps on hover. |
| **Approval dock inside the composer**, above a live text box: an amber "Pending approval" label, the file name with its full path as a tooltip, a diff, a gray "Ctrl ⏎ approves" hint, a neutral Reject and a green Approve. | F13 | The user can still type, for example to ask for a change to the note. |
| **Header:** the title, then the `…` menu (tooltip "Thread actions"), with no compose icon and a fade mask under it. | F14 | The gear lives in the sidebar. The swatch icon is the harness-only drawer. |
| **Picker wording:** "Runs on GPU", "Uses system memory · slower", "Not enough memory at Nk". Rows show name, disk size and a verdict; the quant is in the tooltip. | F15 | Plain words. Number keys appear only in keyboard mode. |
| **Numbers:** GB with one decimal and never MiB. "Estimate 8.2 GB · measured 6.9 GB on last load". The axis is labelled 0 and 15.9 GB. Whisper and other apps use two clearly different grays. There is a measured tier for first token, tok/s and runner memory. | F16 | Estimates and measurements are never mixed silently. |
| **Fit popover:** the height is capped and it scrolls. | F17 | It never runs off screen. |
| **Sidebar:** a brighter selected row. One time format per age band: Today is relative (2m, 3h), Yesterday a clock time, the last 7 days a weekday, older a date. "Ctrl N" is written plainly. The install % shows in the footer. Settings has a gear and space above it. | F18 | |
| **Monochrome mark:** a gate glyph drawn in `currentColor`. | F19 | It follows the theme. |
| **Dark is the default.** Light ships through the same tokens. | brief | |
| **Memory proposals:** the reply first says in one line what it will save ("I'll add Effect Schema in Practice to your reading note, marked halfway"), then the pending tool row, then the tray. The diff holds only what was asked: one line out, one line in. | F21 | Round 1's diff also added a "next:" line nobody asked for. |
| **Runtime banners dock above the composer**, like approvals. Installing and missing show on a new thread. | F22 | A banner above a finished conversation implied a chat that could not have happened. |
| **One disclosure convention:** thought and tool rows both lead with an icon (bulb, or the tool status) and end with a chevron that turns over when open. Durations read "4 s", like "42 ms". | F24 | Round 1 had a left chevron on one and a right chevron plus check on the other. |
| **Hover actions sit in the turn gap.** The 28 px action row is the space between a reply and the next message, not extra space added to it. | F24 | The jester's complaint was dead space added under every turn. Here the gap is the row, so nothing jumps and nothing collides. |
| **Example data stays consistent:** a model that will not fit says "needs 2.3 GB more" (its 18.3 GB need, minus 12.0 GB of free GPU memory and the 4.0 GB spill limit). | F26 | "short 2.3 GB" did not say short of what. |

### Seat values I changed

- **C1-14 (Thinking pill on = `#1a2a20` fill with green text): changed to a
  neutral fill with foreground text.** Green on a pill that is only "on" breaks
  F02.
- **Primary buttons ("Install Ollama", "Start chatting", "Download …") are
  neutral light, not green.** F02 keeps green for send and approve, and the
  first-run CTA is neither.
- **The install progress bar stays green.** The brief asks for the F01 look,
  and progress toward "ready" is the one non-control use of green that keeps
  its meaning.
- **"Found Ollama 0.40.4 with 6 models", not 14.** The harness lists six
  models. Saying 14 would contradict the picker and Settings on the next
  screen. The real app fills in the real count.
- **The picker's loaded row shows "Needs 8.2 GB" (the estimate), not 6.9.**
  The measured value lives in the fit popover, labelled as measured (F16), so
  the picker never shows two kinds of number side by side.
- **The meter is a bar, not C1-04's ring.** The lane's ring and a pie
  tried after it both misread at 16-18 px (spinner, theme icon).

## Still open (kept as a drawer switch)

- **Where the fit popover opens** (`fit=side|above`).
  - `side` places it to the right of the chip, bottom-aligned with the
    composer and capped in height. It covers the Thinking pill and send while
    open.
  - `above` places it above the composer, left-aligned to the chip.
  - Both are capped and scroll (F17).

## Token contract

Every color is a custom property on `:root`. The light values are the base.
Dark overrides live under
`@media (prefers-color-scheme:dark){:root:not([data-theme="light"])}` and
under `:root[data-theme="dark"]`. The `<html>` element starts with
`data-theme="dark"`.

| Token | Dark | Light | Use |
|---|---|---|---|
| `--background` | `#0a0a0a` | `#fcfcfc` | main pane |
| `--sidebar` | `#000` | `#f4f4f4` | sidebar |
| `--card` / `--popover` / `--composer-surface` | `#111` / `#161616` / `#141414` | `#fff` | raised surfaces |
| `--foreground` / `--prose` | `#f2f2f2` / `#dadada` | `#171717` / `#262626` | text |
| `--muted-foreground` | `#9a9a9a` | `#5c5c5c` | secondary text |
| `--placeholder` / `--faint` | `#858585` / `#5e5e5e` | `#7a7a7a` / `#a6a6a6` | placeholder / decoration only |
| `--hover` / `--selected` | white 6% / 12% | black 5% / 9% | row states |
| `--border` / `--border-strong` | white 8% / 14% | black 9% / 15% | hairlines |
| `--message-surface` / `--code-bg` / `--track` | `#1d1d1d` / `#1a1a1a` / `#2e2e2e` | `#ededed` / `#f1f1f1` / `#e2e2e2` | bubbles, code, bars |
| `--green` / `--green-fg` / `--on-green` | `hsl(150 58% 48%)` / `hsl(150 62% 58%)` / `#03140b` | `hsl(150 62% 38%)` / `hsl(152 72% 26%)` / `#03140b` | ready, fits, send, approve |
| `--amber` / `--amber-fg` | `#f59e0b` / `#fbbf24` | `#d97706` / `#9a4d00` | pending, not ready, uses RAM |
| `--red` / `--red-fg` | `#ef4444` / `#f87171` | `#dc2626` / `#b91c1c` | won't fit, wrong service, deletions |
| `--send-off-bg` / `--send-off-fg` | `#262626` / `#666` | `#e4e4e4` / `#a3a3a3` | disabled send |
| `--stop-bg` / `--stop-fg` | `#e6e6e6` / `#0a0a0a` | `#262626` / `#fafafa` | stop |
| `--primary-bg` / `--primary-fg` | `#ededed` / `#0a0a0a` | `#171717` / `#fafafa` | primary buttons (neutral) |
| `--seg-whisper` / `--seg-occupant` | `#a3a3a3` / `#525252` | `#7a7a7a` / `#c2c2c2` | GPU bar, other apps |
| `--font-sans` | `"Adwaita Sans", system-ui, sans-serif` | | UI |
| `--font-mono` | `"JetBrainsMono Nerd Font", "JetBrainsMono NF", "JetBrains Mono", ui-monospace, monospace` | | code, paths, diffs |
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

`~/.cache/gates-local-design/rounds/r2/steps.json` drives
`tools/shoot.mjs`. It produces 30 shots, S-01 to S-30, in
`rounds/r2/shots/`, with zero console errors. Every shot except the drawer
one carries `shot=1`. They cover thread,
streaming (tool phase and writing phase), new, picker (mouse and keyboard at
32k), fit (side, and above while spilling), the four runtime states, memory,
the three first-run states, all six settings sections, a hover action row, an
expanded tool row, the `+` menu, light thread, light memory, the drawer, a new thread drafted while installing,
and the `bench` thread with the meter at 60%.
