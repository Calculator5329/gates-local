# Mistakes

Each `.patch` here puts one real past mistake back into today's code.
`node scripts/mistakes.ts` applies them one at a time in a scratch worktree and
says which check stops each one first: typecheck, lint, the model check (once
`scripts/model-check.ts` exists), the unit tests that import the touched files,
then the whole unit suite. A mistake nothing stops got through.

A patch starts with its record, then the diff:

```
Mistake: B044            census row id, or the planted mutant's id
Class: K4                the census class
Fix: b9b43fec            the commit that fixed it, or "planted"
Browser: no              yes when only a browser shows it
Seen: <what a person would see>
Note: <what the patch does, optional>
```

Rows whose `Browser` is `yes` are never counted as caught: the runner lists
them as "not judged here", with any red layer as a note, because the layers it
runs are not the ones that would see them.

A unit red counts as a catch only when its file is red again with the patch
still in and green without it. Anything else is "noise": a flaky or broken
test, not a check that stops the mistake. Lint rules that only object to the
shape a planted mistake leaves behind (a constant condition, unreachable code)
are not catches either; the run goes on to the unit tests.

`through.md` names, for each mistake that got through, the cheapest change that
would stop it: architecture first, then a type, then a lint rule, then a test.

`no-place-left.tsv` lists census rows drawn for this folder that have no patch,
each with one line saying what removed the place for the mistake.

When a patch no longer applies, the run refuses to start and names it. Update
the patch to today's code if the mistake still has a place, or move it to
`no-place-left.tsv` with the reason.
