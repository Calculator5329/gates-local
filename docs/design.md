# Interface rules

Rules every screen follows. The screen designs live in `docs/design/`.

## Whole on the first frame

A surface shows its full shape on its first frame. Nothing arrives later,
nothing moves, nothing pushes other things down, and no words flash and get
replaced, unless the person did something.

How to meet it, in order of preference:

1. **Have it already.** Read what the surface needs before it opens, or
   keep the last answer. Settings reads its cheap data when it is asked
   for and opens when the data is in (at most a second later). A thread
   row read ahead on a mouse or keyboard pause opens with its turns. The
   starter cards remember this browser's last shape.
2. **A static shell with a placeholder in the one spot that waits.** The
   labels, buttons and layout are there; only the value still on its way
   is a placeholder, the size of the line it stands for. The model button
   before the first read is one example.
3. **Placeholder rows only where the shape depends on the data**: the
   thread list before the first read, a conversation's turns, first run
   before it knows whether a model was found.

A wait that is long by nature (a fit check, a download) may show a status
word in a slot of fixed size. The rule is about shape and movement, not
about replacing every "Checking…" with a grey bar.

When nothing moving and only showing what is true pull apart, true wins: a
value may change once to stop a false statement. The Models page's Download
tab groups its rows once per visit, after every row has a fit answer at the
current context or a second has passed (a row with none is then not
Recommended). The one move after that: a row whose verdict becomes "does not
fit" leaves Recommended, and does not come back during the visit. A
group's title follows its rows' live verdicts, so its words change in
place. When Recommended had a place during the visit (its placeholder
header, or rows) and ends up empty, its header's height stays, hidden, so
what is below does not move: space kept, not reserved for something to
come.

Never reserve empty space for something that may never come. Space for a
download's progress appears when the download starts, drawn over what it
replaces.

Before the first read, nothing claims a problem nobody has seen: no
"Reconnecting" banner, no runtime row, no greyed controls. A connection
that drops later still says so, and so does a first read that has not come
in two seconds: it says "Connecting…", once, and nothing about Ollama until
the runtime has answered. A screen that has left its placeholders never
goes back to them, with one exception below.

Every fit answer on screen ("Ready to chat", a verdict, Recommended, a
context row's memory) comes from the server's fit table. When GPU memory
changes, the server's next table replaces those answers in place; nothing
goes back to "Checking". A pick the newer reading rules out is refused, and
the refusal says why. A lost connection withdraws the table: every fit
value goes back to its placeholder until the reconnected server's own
table is in, since a restarted server may see different memory.

## Placeholders

- Mark it `data-skel` and `aria-hidden="true"`, inside a container that says
  `aria-busy="true"` while it shows.
- A flat muted block at the height of the text line it stands for, with
  a slow pulse. No pulse under reduced motion.
- Use `Skel` or the `.skel` class (`apps/web/src/ui.tsx`), so the look
  changes in one place.

`test/e2e/flicker-audit.spec.ts` checks all of this on a slow link; see
`docs/testing.md`.

## Settings text

- A group is a title and a card. No description line under the title.
- A row's grey line is one short sentence that says something new.
- Tooltips: a label, a row or a value has none. An icon-only button keeps a
  name of one to three words. A disabled button may say why, in a few words.
  A sentence that informs goes on the screen as a line, and only when the
  screen is wrong without it; otherwise it goes.
- At most one heading line on a page.
- Sentences about what is sent, changed or deleted stay visible.

## First run and connection screens

- A screen is a status line, a title, and what to act on. A sentence under
  the title stays only when it tells the person something the title and the
  status line do not, and they need it to act: an error's cause, the step to
  take, or a number. Without one there is no paragraph and no space for it.
- The model card is the name, Recommended, and the verdict, with Details
  under it. A download adds its size. The model's purpose phrase belongs to
  the picker and Settings, not this card.
- No footer. "Nothing leaves your own network" is said once, under the
  new-chat heading.

## Look

No gradients, no glass, no rounded-everything, no orphan rows. No footnotes,
and no explanations in tooltips (see Settings text). Check hover states.

A pop-up blurs what is behind it by 8 px only when a GPU draws the page; a
software renderer only dims it, since a blur there costs every frame.
