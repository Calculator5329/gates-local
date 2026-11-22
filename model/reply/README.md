# Reply

The messages of one chat, from typed to ended: what the person can do to them (send, stop, send now,
hold, remove, open and close an edit), what the server does (take the next one, store its question,
refuse it, end it), and a restart.

## The rules

| Rule | In plain words | The harm when it breaks |
| --- | --- | --- |
| `StopHoldsTheQueue` | What waited behind a reply when Stop was pressed goes only on Send now, also when the reply's last word reached the app before the Stop. | A message goes out after the person pressed Stop. |
| `ARemovedMessageIsNeverAsked` | A message the window was told is removed is never asked. | A deleted message is answered. |
| `AskedOnce` | A message's question is stored once. | The same question twice in the chat. |
| `ARestartHoldsEverything` | After a restart nothing that had not been asked goes by itself. | The app starts answering old messages when it opens. |
| `NothingSavedForAStoppedStart` | Nothing is stored for a start that was stopped, refused or lost before it was asked. | A stopped message's question is in the chat and gets answered. |
| `EditingIsNeverSent` | A message open in a composer is never sent. | Half-edited words are sent. |
| `AWaitingMessageWasNotAsked` | A message that shows as waiting has not been asked. | A row that vanishes on Send now, or a second answer. |
| `StartingHasItsWork`, `OneReplyAtATime` | Shape checks: a starting message has its start under way, and a chat has one reply at a time. | The model itself is wrong. |

## Bounds

Two messages (`A`, `B`), one window, two starts for each message, one restart. Printed on every run.

## Tied to the code

`table.ts` reads `apps/server/src/chat/reply.ts` on every run:

- `move()`: every kind of record the code can reach (30) is given every input the model uses (30), under
  the product's rules and again with each of the 9 rules of `Rules` switched off. That is the module
  `ReplyCode`. The model holds no transition of its own for a single record.
- `stillStarting()`: which records may still store their question.
- `toQueued()` and `fromQueued()`: what each record comes back as from the saved list.

The table holds a record as its kind (`kindOf()` in `table.ts`). If two records of one kind ever answer
an input differently, the run fails and names the kind and the input.

`USED` in `table.ts` lists every call and event `move()` takes. A new one fails the typecheck until it
is given a place.

## Written by hand

Listed in `model/models.ts` with the functions each stands for; hashes in `covered.json`.

- `apps/server/src/chat/replies.ts`: when each call can happen, `tell()`, `apply()`, `commit()`, `settle()`, `goes()`, the restart
- `apps/server/src/app/queue-pump.ts`: `startNext()`, `start()`
- `apps/server/src/app/admit.ts` and `apps/server/src/app/drawing.ts`: the three lines that store a question
- `apps/server/src/app.ts`: which chat is busy, and the turn's end

## Replays

| Replay | Rule it must break | Past bug |
| --- | --- | --- |
| `saveChecksStage` | `NothingSavedForAStoppedStart` | Stop during a file save lost the hold; fixed in 960ed105 by `stillStarting()` |
| `lateStopHolds` | `StopHoldsTheQueue` | the code's own switch |
| `removeAnswersHonestly` | `ARemovedMessageIsNeverAsked` | the code's own switch |
| `sendChecksSaved` | `AWaitingMessageWasNotAsked` | the code's own switch |
| `restartHolds` | `ARestartHoldsEverything` | the code's own switch |
| `pickSkipsEditing` | `EditingIsNeverSent` | the code's own switch |
| `restartReconciles` | `AWaitingMessageWasNotAsked` | the code's own switch |
| `removalIsRemembered` | `ARemovedMessageIsNeverAsked` | the code's own switch |

The seven without a commit are the rules `reply.ts` already lets a test switch off. Each replay reads
the real `move()` with that rule off, so these are the code's behaviour without the guard, not a guess.

## Coarser than the code

- `Take` lets any message that may go be taken. The code takes the oldest. The model checks more orders
  than the code has.
- A reply that is being written is one stage. The events `load`, `think`, `word`, `tool` and `retry` are
  not given to `move()`.
- `Send` does not look inside the caller's own `busy`: it tries both answers.

## Not covered

- `change` (the words of a message) and `chat-deleted`. The ninth rule of `Rules`, `editAnswersHonestly`,
  is about `change`, so it has no replay.
- More than one window, and the numbered sync between windows.
- Retries, a Retry send, drawing as its own path, waits for setup or a download.
- The order the code picks in.
- What an answer says. The model checks the ten rules over `move()`'s answers; it does not say what each
  answer should be. `apps/server/src/chat/reply-table.test.ts` does that.
- That the real `replies.ts` keeps the rules. The model has that file by hand;
  `apps/server/src/chat/reply-rules.test.ts` switches each rule off in the real store.

## Confirm again after a change to a hand-modelled file

Read the change against `Reply.tla`, change the model if it no longer describes the code, then:

```
node scripts/model-check.ts --confirm reply
```
