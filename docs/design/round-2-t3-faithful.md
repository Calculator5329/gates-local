# Gates Local, design round 2: T3-faithful

Harness: [`round-2-t3-faithful.html`](round-2-t3-faithful.html). It is one file that you open by double-click; there is no network access and no build step.

**Drawer:**
- Open it with the sliders icon in the header, the Settings row at the bottom of the sidebar, or the `D` key.
- `?drawer=1` opens it on load.

**URL parameters:** any setting can be preloaded with one, for example `?view=fit&theme=light&ctx=64`. Use the keys in the table under "Switchers" below.

This variant stays as close to T3 Code's stock look as it can: the same neutral ladder, blue primary, radius scale, system font stack, spacing and density. Gates Local differs only in content:
- local models
- the fit chip and the GPU budget popover
- runtime banners in the ProviderStatusBanner slot
- the memory diff card in the pending-approval slot
- the four tools

Machine facts live in the composer row and in popovers, never in permanent strips.

## Screens

| View | What it shows |
|---|---|
| Thread | "Library: Effect Schema books": the user's question, a collapsed `Thought for 4s` line, a Shell step row (`read-only · 42 ms`, which expands to the command and 3 result rows), the markdown answer, then a second short exchange. |
| Streaming | The same thread mid-reply. The status line reads `Thinking` → `Running shell` → `Writing` with an elapsed-time counter, and the send button becomes stop. While a tool runs, the row carries no status text of its own; the status line is the only indicator. |
| New thread | The hero line, the composer in the middle of the screen, and four suggestion cards, one per tool. The cards sit 4 across, or 2×2 below 1100px. There is no icon over the empty state. |
| Model picker | A search field with a 16k/32k/64k segment in its header. Models are grouped "Fits in VRAM / Spills to RAM / Won't fit at Nk". Each row shows disk size, the need at that context and the verdict. Won't-fit rows are disabled, and a tooltip names the shortfall. |
| Fit popover | "GPU budget": one thin stacked bar (whisper, occupant, chat model; the unused tail stays empty track) and an itemized legend (whisper with a lock, media-vault vision as an occupant, the chat model, Free). Below that come the RAM spill line, a 16k/32k/64k choice and the need and verdict. When the model is loaded, a footer gives the measured runner size and first-token time. |
| Runtime banner | The drawer sub-switch picks Installing (live progress 1.02 → 1.54 GB), Wrong service on 11434 (Retry, Use port 11435), Starting, or Missing (Install, Retry). The sidebar runtime row changes with it, and send is disabled until the runtime is ready. |
| Memory diff | "Remember that I'm halfway through…" makes the Note row wait for approval. The composer becomes a PENDING APPROVAL panel holding a diff of `~/.gates/notes/reading.md`. The footer turns into Reject / Approve. Either button resolves the row and streams a one-line reply. |

## Interactions that work

**Navigation and views**
- Sidebar thread switching (seven threads, grouped Today / Yesterday / Previous 7 days / Older).
- New thread from the sidebar, the pen icon or Ctrl+N.
- The drawer's view switcher.

**Popovers**
- The model picker opens from the composer. Arrow keys and Enter pick a model; Escape or a click outside closes it.
- The fit popover opens from the fit chip, and also from the sidebar meter when that switcher is on.
- Picking 16k/32k/64k in either popover updates the chip text, the verdict dot, the bar, the sidebar meter and the context ring.

**Composer**
- Thinking and Image toggles.
- Enter sends; Shift+Enter makes a newline.
- Sending appends a user bubble and fake-streams a reply. The reply is built from text nodes that grow in place; the turn is never rebuilt per token.
- Stop interrupts the reply and leaves "Stopped after Ns".
- A message containing "remember" goes through the memory approval flow.
- On the new-thread screen, clicking a suggestion card fills the composer.

**Message details**
- The thinking line and the tool step rows expand and collapse; rows also respond to keyboard Enter and Space.
- Hovering a message reveals its time or model meta line and a copy button. The button shows a check after copying.
- The context ring with its percentage shows a hover card: "Context window / Total processed".
- Hover tooltips carry every note; there are no footnotes.

**Theme**
- Light and dark from the drawer, with a live accent hue slider and WCAG contrast readouts.

## Switchers (default first, and why)

| Key | Options | Default | Why |
|---|---|---|---|
| `view` | thread, streaming, new, picker, fit, runtime, memory | thread | The finished thread is the screen Ethan judges first. |
| `runtime` | installing, wrong, starting, missing | installing | It is the state with motion, and the one the brief names first. |
| `theme` | dark, light | dark | Ethan's settled taste: dark by default. |
| `palette` | T3 stock (zinc/neutral + blue), Graphite + amber, Slate + indigo, Stone + copper | T3 stock | This variant's job is fidelity to T3. The others are deltas to compare against it, and none of them is dark green. |
| accent hue (slider) | 0–359°, moves both themes | 223° / 224° | T3's primary, `oklch(0.571 0.21 264)` dark / `oklch(0.488 0.217 264)` light. |
| `density` | T3 stock, Compact, Roomy | T3 stock | It matches T3's h-7 rows and px-4 composer padding. Roomy is the "slightly more breathing room" alternative. |
| `radius` | T3 0.625rem (composer 22px, bubble 18px, controls 8px), 6px, 3px | T3 | Fidelity. 6px and 3px test the "rounded-everything" blacklist line. |
| `font` | T3 system stack, Adwaita Sans, Fira Sans | T3 system | It is T3's own stack (`system-ui` resolves to Noto Sans here). Adwaita Sans is the Inter-derived GNOME face; Fira Sans is a humanist alternative. `fc-list` confirmed both are installed. Inter is not installed. |
| `prose` | T3 stock (fills the column), Book (820px) | T3 stock | Fidelity. Book width is the readable-line alternative from Ethan's chat rules. |
| `tool` | T3 work log (12px row, chevron, check), Bordered step card | T3 work log | It matches T3's PlainWorkEntryRow. The card is the louder alternative. |
| `gpu` | Composer chip only, Chip + quiet sidebar-footer meter | Chip only | The brief says facts live in the composer and in popovers, not in permanent chrome. The meter option tests whether a 4px always-on bar is worth it. |

## Token contract

All color goes through custom properties on `:root`. Light is the base. Dark overrides live under `@media (prefers-color-scheme: dark) :root:not([data-theme="light"])` and `:root[data-theme="dark"]`, so the in-app toggle wins in both directions. Components never use a raw hex. The semantic hexes (success, warning, error, info) live only in the token block.

**Neutrals are `hsl(var(--nh) var(--ns) L%)`.**
- A palette preset moves only hue (`--nh`) and saturation (`--nsl` light, `--nsd` dark). The lightness ladder stays T3's.
- Light ladder:
  - background 98.8 (zinc-25)
  - foreground 16 (zinc-800)
  - card and popover 100
  - accent 95.7 (zinc-100)
  - border 90 (zinc-200)
  - input 84 (zinc-300)
  - muted-foreground 46 (zinc-500)
  - sidebar 98
- Dark ladder:
  - background 3.9 (neutral-950)
  - foreground 96
  - card 6.8
  - popover 9.7
  - composer 7.8
  - muted-foreground 50.6
  - sidebar 0, pure black as in T3's `[data-app-sidebar]`
  - borders and surfaces as white at 4–8%

**Accent.** `--primary` is set from per-theme `{h,s,l}` in JS. From it the code derives `--primary-hover`, `--primary-soft` and `--primary-ring`, and `--primary-foreground` by auto-contrast (white, or a near-black of the same hue). The readout shows send-text-on-accent, accent-on-background and accent-on-sidebar ratios with an AAA / AA / AA-large / Fail grade.

**Semantic tokens** are separate from the accent:
- `--success` emerald, `--warning` amber, `--error` red, `--info` blue.
- Each has a `-fg` (700 in light, 400 in dark) and a surface tint.

**GPU segments:**
- `--seg-whisper` is foreground at 46%.
- `--seg-occupant` is foreground at 24%.
- The chat model uses `--primary`.
- Spill uses `--warning`.
- `--seg-track` is the empty tail.
- No hatching and no gradients.

**Geometry:**
- `--radius` with sm (−4), md (−2), lg and xl (+4).
- `--r-ctl` 8px, `--r-composer` 22px, `--r-bubble` 18px.
- `--header-h` 52px, `--row-h` 28px, `--sb-w` 256px.
- `--col-w` 1040px, `--prose-w`.
- Density and radius switchers rewrite these through `data-density` and `data-radius` on `<html>`.

## What was lifted from which T3 file

All from `~/projects/ai/t3-forge/apps/web/src/` (MIT, Copyright 2026 T3 Tools Inc.). Layout and craft only; no T3 name, logo, provider icons or copy.

- **`index.css`:**
  - Font stacks (`--font-sans`, `--font-mono`) and the radius scale (`--radius: 0.625rem` with sm/md/lg/xl offsets).
  - Control radius 0.5rem, the 52px topbar height, and the full light and dark token sets (converted from oklch to HSL and hex with a node script).
  - The dark `[data-app-sidebar]` overrides: black sidebar, white-8% border, row hover, active and selected tints.
  - The 6px scrollbar with transparent track and thumb colors.
  - The `.chat-composer-glass-shell` outline and shadow values.
  - The `.chat-markdown` margins (0.65rem blocks, 1.25rem list indent, 0.25rem li gap) and the 80%-foreground prose color.
- **`components/ui/sidebar.tsx`:** the 16rem sidebar width, h-8 menu buttons, h-7 rows, and the 0.5rem content inset.
- **`components/Sidebar.tsx`:** the compact thread row (truncated title plus a `text-xs` tabular time at 55–70% muted), the active, idle and hover treatment, and recency groups.
- **`components/chat/ChatHeader.tsx`, `NoActiveThreadState.tsx`:** the header with border-bottom and a `text-sm font-medium` truncated title; the muted title on an empty thread.
- **`components/chat/MessagesTimeline.tsx`:**
  - The user bubble: right-aligned, max-width 80%, rounded-2xl, message surface, with a hover meta row at opacity 0 → 100 beneath it.
  - The assistant as a plain block with a hover meta line.
  - The PlainWorkEntryRow anatomy: 20px icon box, 12px/20px text, medium heading plus truncated preview, a size-3 chevron that rotates 180°, a size-3 check mark, and an expanded body indented with a left border.
  - The working row of three pulsing dots plus "· step".
- **`components/chat/ChatComposer.tsx`:**
  - The outer radius of 22px and padding of px-4 pt-4 pb-4.
  - A footer that is `justify-between`, with the left group at gap-1, `h-4` separators, and the model trigger pulled −10px to align with the text.
  - The pending-panel slot above the editor (rounded top, border-bottom, muted/20), with the footer becoming right-aligned approval actions.
- **`components/chat/ComposerControl.tsx`:** h-7, px-2.5, gap-1.5, secondary-label text with hover to foreground, and a 14px chevron.
- **`components/chat/ComposerPrimaryActions.tsx`:** the 32px round send button on the action color with an inset white-16% top highlight, hover scale 1.05, disabled opacity 0.3, and the exact 14×14 arrow path at stroke 1.8.
- **`components/chat/ContextWindowMeter.tsx`:** the 20px ring rotated −90° with a 24%-muted track at stroke 3 with a round cap, and the w-64 hover card ("Context window", a thin bar, "Total processed").
- **`components/chat/ProviderModelPicker.tsx`, `ModelPickerContent.tsx`, `ModelListRow.tsx`:**
  - The popover at 360px width, rounded-lg, with the T3 drop shadow (`0 16px 40px -18px` light / `0 18px 44px -18px` dark).
  - A search row with a border-bottom and xs group labels.
  - Rows at rounded-md and px-2 py-2, with a hover mix of 90% popover and 10% foreground and a selected tint of foreground at 8%.
  - A 12px medium name with a 12px muted sub line and a check on the selected model.
- **`components/chat/ProviderStatusBanner.tsx`:** the position (centered, w-fit, pt-3 above the timeline) and the box (rounded-xl, 1px border at tone/32%, py-3 ps-3.5 pe-10, a size-4 leading icon, a medium title, a muted message, and the dismiss X absolute at top-2 right-2).
- **`components/chat/ComposerPendingApprovalPanel.tsx`, `ComposerPendingApprovalActions.tsx`:**
  - The uppercase tracked "Pending approval" label followed by the summary.
  - The detail box: rounded-lg, border at 65%, background at 70%, mono xs content.
  - Actions in destructive-outline + default variants. The text is Reject / Approve instead of Decline / Approve once.
- **`components/ui/button.tsx`:** sm size (h-7, px-2.5, control radius, medium weight); the default variant with an inset highlight; outline, ghost and destructive-outline variants.

## Deliberate deviations from T3 stock

- **Solid surfaces instead of `alert-glass` / `dropdown-glass` blur.** Glassmorphism is on Ethan's blacklist.
- **15px prose and composer text instead of T3's 14px.** Ethan's chat rule sets 15px or larger.
- **A 1040px column instead of `max-w-3xl` (768px).** Ethan's rule asks for a wide column; the Book switcher restores a reading width.
- **No icon on sidebar thread rows.** Decorative icons are out.
- **A percentage label beside the context ring.** In screenshots, the bare partial ring read as a loading spinner.
- **A step row while a tool runs carries no status text or spinner.** The status line under it names the phase, so only one indicator shows (Ethan's "never two indicators" rule).

## Invented example data (not measured)

- **Needs at 32k and 64k for every model, and every number for models other than qwen3.5:9b at 16k.** These are invented, but tuned so qwen3.5:9b at 64k spills exactly 1.4 GB and qwen3.8-abliterated:27b at 16k is short exactly 2.3 GB, matching the brief's verdict strings.
- **The spill ceiling of 4.0 GB of system RAM.** It is a placeholder for whatever the real fit check allows.
- **Free for the chat model is 16303 − 2202 − 1822 MiB = 11.99 GB.** Free when loaded is 11.99 − 6.9 = 5.09 GB.
- **Disk sizes for gpt-oss, the abliterated models and gemma3-q4; the library rows; the benchmark numbers; the install speed (21 MB/s).**
