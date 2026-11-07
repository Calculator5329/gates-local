# Design council rubric

Gates Local's look is scored in council rounds, a hill climb modeled on Theo's
"Agents Sucked At UI (Until Today)" (t3.gg, published 2026-11-03,
https://www.youtube.com/watch?v=xq0eB8vxeqk). The auto-generated transcript was
fetched on 2026-11-07 and is kept outside the repo at
`~/.cache/gates-local-design/transcript/transcript.txt`.

## What Theo did (from the transcript)

- A council of strong models from different providers scored a set of app
  screenshots "one to 10" for design quality. Each full review pass is one
  round; a fresh review after fixes starts a new round.
- Agents changed the UI, took their own screenshots, and asked the council
  again, until every seat gave 9 or better; later 9.5 in every category; later 10.
- The first loop judged the app alone and went 6 to 9 in three rounds. Judged
  again beside Claude Code and Codex screenshots, the same "9" scored 7.4.
  Lesson he drew: "when you compare it to other things, your scores start to
  change." The reference apps stayed in the panel every round.
- Named categories in his tables include hierarchy, typography, iconography and
  color and contrast. The fixes that moved scores were small and many: fallback
  font, label recession, truncation that keeps the part that matters, card
  radius, inline code without needless borders, consistent labels across
  surfaces, sidebar color and text hierarchy, body contrast.
- After a few rounds the design went "too grayscale"; he asked the loop to
  restore color, and the scores and his own reaction both improved.
- Caveats he gave: the same screenshot can get different scores from the same
  model; telling reviewers the target score may bias them ("I might tell the
  parent agent to not let the sub-agents know that there is a score they're
  trying to hit"); comparison context moves the numbers.

## How Gates Local runs it

- **Seats.** Claude Opus 5.5, GPT-6.1 Sol and Muse Wonder (Personal Cursor,
  `muse-wonder-1.0`), all at high effort, one fresh read-only review task per
  seat per round (council skill). Gemini 4 Argon (Personal Cursor,
  `gemini-4-argon`) sits as the jester: same brief, never told it is the
  jester, its score ignored and kept out of the score tables; anything funny
  it does goes under "Gemini flub" in the round report. Its findings are
  acted on only after the coordinator confirms them in the screenshot.
  Ethan's ruling in chat, 2026-11-07: "we should have both a Gemini Jester
  and Muse through Cursor."
- **Gating.** Round 1 runs every seat for a baseline. After that Sol scores
  every round; Opus and Muse join when Sol's overall for Gates Local reaches
  9 and at least every third round, as Theo did to save quota.
- **Panel.** Every round scores Gates Local's current screenshots and the same
  fixed set of reference screenshots of professional alternatives, in one
  table. References: LM Studio, Jan, Msty, the Ollama app, Open WebUI (local
  model apps), and T3 Code, ChatGPT desktop and Claude desktop (polish bar).
  Reference images live in `~/.cache/gates-local-design/refs/` with their
  source URLs in `refs/SOURCES.md`; they are marketing or documentation
  screenshots, which flatters them, and the reviewers are told so.
- **Blind target.** Reviewers are never told a target score or the stop
  condition. They are told nothing about earlier scores on the first pass of a
  round.
- **Categories, 1 to 10 each, half points allowed:**
  1. Hierarchy: the eye lands on the conversation first; chrome recedes.
  2. Typography: sizes, weights, line length, fallback fonts, mono use.
  3. Color and contrast: black and gray base with green highlights used with
     purpose; body text contrast; no muddy grays; semantic colors stay semantic.
  4. Spacing and layout: one spacing scale, alignment, density with air.
  5. Iconography: one icon family, weight and size; icons only where they help.
  6. Consistency: the same thing is labeled, shaped and colored the same way on
     every surface (radii, chips, indicators, buttons).
  7. Out-of-box clarity: a first-time user reaches a reply from a local model
     without opening settings; local-machine facts are findable, not shouted.
  8. Polish: states (hover, focus, empty, loading, error) look finished; nothing
     clipped, orphaned or placeholder; it reads as a shipped product.
  Plus one overall score per app, which is the reviewer's own judgment, not an
  average.
- **Findings.** Seat-prefixed stable ids (C-R1, G-R1), each tied to a screenshot
  and a region, with severity and a concrete fix. One ledger in
  `docs/design/council-ledger.md` tracks id, seat, severity, status, evidence.
- **Stop.** The coordinator, not the reviewers, decides: stop when both seats
  score Gates Local at or above every reference in every category and at 9 or
  better overall, or when two rounds in a row move the mean by under 0.2, or
  at round 10. Ethan's replies to a round's screenshots outrank any score.

## Ethan's direction for this loop (2026-11-07, in chat)

"I was thinking kind of dark mode, black and gray, with maybe some green
highlights. Sleek and professional. Very easy and simple to use right out of
the box. Connects with local models very simply and easily. And then you can go
into settings and customize further in all the ways that we've discussed. But
you don't necessarily have to to have it working out of the box."
