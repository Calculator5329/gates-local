# Decisions

The rulings before 2026-11-07 live in
`~/projects/planning/incubator/local-ai-app/decisions.md` (D1 to D8 and the
media-vault ruling). New decisions are appended here.

## 2026-11-07 · Promotion

**Decided:** promoted on Ethan's start in chat ("start dispatching
sub-agents for putting together the foundation", with Opus 5.5 high
sub-agents). Agent calls, with a veto: home `ai/gates-local`, manifest
category `ai`, agents fence `full`, a local git repository with no remote.
Toolchain pinned by the first install: pnpm 11.10, TypeScript 7.0, Vitest
5.1, oxlint 1.92, Effect 4.1, Electron 45.2 (Node 24.22).
**Why:** `ai/` holds the sibling GatesAI and local-ai-lab repos; `full`
because Ethan asked for agents on the foundation; no remote because a public
repository needs his explicit go.

## 2026-11-07 · Visual direction by GPT-image rounds

**Decided:** the look is chosen from generated mockups, not prose. Round 1 is
twelve divergent directions of one hero screen
(`~/.cache/gates-local-mockups/round-1/`); Ethan narrows them; round 2 shows
many screens under each kept direction. `apps/web` stays unstyled until a
pick lands.
**Owner text (voice-to-text, in chat):** “We can have a bunch of different
options and then once we narrow in on options we can show many different
screens under that option to even more narrow in on exactly how that entire
option feel.”

## 2026-11-07 · Round 1 rejected; round 2 is T3 Code-shaped HTML

**Decided:** all twelve round-1 looks are dropped. The layout follows T3
Code: sidebar, header, timeline, and the composer as the control centre. Fit,
GPU and runtime facts live in composer chips, popovers and banners, not in
permanent strips. Round 2 is two HTML design harnesses
(`docs/design/round-2-t3-faithful.html`, `docs/design/round-2-instrument.html`)
built from T3 Forge's real tokens and components (MIT). Each has switchers for
the open taste choices and covers seven screens.
**Why HTML, not images:** the polish Ethan found missing is exact spacing, type
and restraint. Image generation invents those every time, and an HTML harness
holds them. The images also failed because the prompts crammed every feature
onto one screen as chrome. A GPT-image round anchored on a T3 Code screenshot
is still available if he wants to compare.
**Owner text (voice-to-text, in chat):** “None of those look exactly right.
Like the layout is too basic and too messy and think more T 3 code-like and I
don't know, they just don't look polished at all.”

## 2026-11-07 · Black and gray with green; a council hill climb picks the polish

**Decided:** the look is dark mode, black and gray, with green highlights. It
must work out of the box: a first-time user reaches a reply from a local model
without opening settings, and settings hold the further customization. This
overrides the round-2 brief's default accents (T3 blue, graphite and amber)
and its "avoid dark green" note; the generic-tells review still applies.
Polish is decided by a design council hill climb modeled on Theo's 2026-11-03
video: Claude Opus 5.5 and GPT-6.1 Sol score screenshots per category beside
professional alternatives each round, an implementer fixes the findings, and
the loop repeats until Gates Local scores at or above every reference
(`docs/design/council-rubric.md`). Ethan's replies to round screenshots
outrank any score.
**Owner text (voice-to-text, in chat):** “have the council evaluate the
overall design, professionalness, UI UX, in the same way as T3.GG did in a
recent video… comparing it to the scores and ratings of professional
alternatives to the app and then just autonomously iterating over and over to
improve.” And: “I was thinking kind of dark mode, black and gray, with maybe
some green highlights. Sleek and professional. Very easy and simple to use
right out of the box. Connects with local models very simply and easily. And
then you can go into settings and customize further in all the ways that
we've discussed. But you don't necessarily have to to have it working out of
the box.”
