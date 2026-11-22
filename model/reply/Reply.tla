---- MODULE Reply ----
\* The messages of one chat: typed, waiting, starting, asked, ended.
\*
\* What a single record does with one call or one event is NOT written here. It is the
\* table ReplyCode, which model/reply/table.ts reads from the real move() in
\* apps/server/src/chat/reply.ts on every run. This file holds only what move() does not:
\* which calls and events can happen when, and what happens to the other records of the chat.
\* Every action names the code it stands for. One action is one synchronous step of the code.
\* reply.ts and replies.ts are in apps/server/src/chat/; queue-pump.ts, admit.ts and drawing.ts are
\* in apps/server/src/app/. model/reply/covered.json holds the hash of each file written here by hand.
EXTENDS Naturals, FiniteSets, ReplyCode

CONSTANTS
  Msgs,         \* the messages of the chat
  Wins,         \* the windows that can open a message in their composer, a subset of {1, 2}
  Nobody,
  MaxTurns,     \* how many times one message may be started
  MaxRestarts,
  Off           \* "none", or the one rule of reply.ts `Rules` that is switched off

VARIABLES
  rec,          \* each message's record, as the kind model/reply/table.ts kindOf() gives it
  turns,        \* how many turns were made for each message; the newest is the record's own
  work,         \* the turns of each message whose start has not ended: nothing stored, not refused, not left
  savedBy,      \* the turns that stored the message's question in the chat
  file,         \* what the saved waiting list would bring each message back as
  late,         \* the message whose reply ended while a window still shows it running
  \* The rest only remember what happened, for the rules at the bottom.
  mustWait, dropped, removedOk, afterRestart, restarts, sentOpen

vars == <<rec, turns, work, savedBy, file, late, mustWait, dropped, removedOk, afterRestart, restarts, sentOpen>>

\* ---- the code's table --------------------------------------------------------------

\* reply.ts move(record, input, rules), with the rules the run switched off.
Move(k, i) ==
  IF Off \in DOMAIN Diff /\ k \in DOMAIN Diff[Off] /\ i \in DOMAIN Diff[Off][k] THEN Diff[Off][k][i] ELSE Sound[k][i]

\* reply.ts stillStarting(record, turnId, attempt, rules): may this turn still store its question.
Still(k, own) ==
  LET s == IF Off \in DOMAIN StillDiff THEN StillDiff[Off] ELSE StillSound
  IN k \in (IF own THEN s.same ELSE s.other)

\* ---- replies.ts, the part around move() ----------------------------------------------

\* replies.ts commit(): a removed record is kept so a second send finds it, unless that rule is off.
Kept(k) == IF k = "removed_removed" /\ Off = "removalIsRemembered" THEN "none" ELSE k

\* replies.ts tell(threadId, what, not): every other record of the chat hears what happened ahead of it.
Tell(r, what, not) ==
  IF what = "none" THEN r
  ELSE [x \in Msgs |-> IF x = not THEN r[x] ELSE Move(r[x], AheadInput[what]).next]

\* replies.ts apply(rec, input): move the record, tell the others, and on Send now stop the reply going in the chat.
Applied(r, m, i) ==
  LET mv == Move(r[m], i)
      r1 == Tell([r EXCEPT ![m] = Kept(mv.next)], mv.ahead, m)
      going == {x \in Msgs \ {m} : r1[x] \in InFlight}
  IN IF mv.stop /\ going # {}
       THEN LET g == CHOOSE x \in going : TRUE
                sv == Move(r1[g], "stop")
            IN Tell([r1 EXCEPT ![g] = sv.next], sv.ahead, g)
       ELSE r1

\* replies.ts goes(r, rules): "next", "queued", "retry", or "no" for a record that does not go by itself.
GoesAs(k, skipsEditing) ==
  LET at == IF k \in Editing THEN (IF skipsEditing THEN "none" ELSE At[k]) ELSE k
  IN IF at = "next" THEN "next"
     ELSE IF at \in QueuedKinds THEN (IF at = "queued_retry" THEN "retry" ELSE "queued")
     ELSE "no"
Goes(k) == GoesAs(k, Off # "pickSkipsEditing")

\* app.ts byThread: a turn of this chat is registered, from its start until it has ended.
ChatBusy == \E x \in Msgs : work[x] # {} \/ rec[x] \in Asked

GoesOnItsOwn(k) == At[k] \in QueuedKinds
Held(k) == At[k] \in HeldKinds \/ k \in Removed

\* What every step does to the records, the saved list and the memory of dropped starts.
\* replies.ts settle(quiet): a quiet step leaves the saved list as it was; keep() writes every row otherwise.
Step(r2, quiet) ==
  /\ rec' = r2
  /\ dropped' = dropped \cup {<<x, turns[x]>> : x \in {y \in Msgs : rec[y] \in Starting /\ r2[y] \notin Starting \cup Asked}}
  /\ file' = IF quiet THEN file ELSE [x \in Msgs |-> IF r2[x] \in Removed THEN r2[x] ELSE RowOf[r2[x]]]

Goers(not) == {x \in Msgs \ {not} : GoesOnItsOwn(rec[x]) \/ rec[x] \in Starting}

Init ==
  /\ rec = [x \in Msgs |-> "none"] /\ turns = [x \in Msgs |-> 0] /\ work = [x \in Msgs |-> {}]
  /\ savedBy = [x \in Msgs |-> {}] /\ file = [x \in Msgs |-> "none"] /\ late = Nobody
  /\ mustWait = {} /\ dropped = {} /\ removedOk = {} /\ afterRestart = {} /\ restarts = 0 /\ sentOpen = FALSE

\* ---- the person ---------------------------------------------------------------------

\* replies.ts send(): one call. The server decides whether it starts now or waits behind what is there.
\* `outside` is the caller's own `busy`, which the model does not look inside.
Send(m) ==
  /\ rec[m] = "none"
  /\ \E outside \in BOOLEAN :
       LET waits == outside \/ \E x \in Msgs : rec[x] \in InFlight \/ GoesAs(rec[x], FALSE) # "no"
           i == IF savedBy[m] # {} THEN (IF waits THEN "send_saved_wait" ELSE "send_saved_start")
                                   ELSE (IF waits THEN "send_wait" ELSE "send_start")
           starts == Move("none", i).next \in Starting
       IN /\ Move("none", i).next # "none"
          /\ starts => turns[m] < MaxTurns
          /\ Step(Applied(rec, m, i), FALSE)
          /\ turns' = IF starts THEN [turns EXCEPT ![m] = @ + 1] ELSE turns
          /\ work' = IF starts THEN [work EXCEPT ![m] = @ \cup {turns[m] + 1}] ELSE work
  /\ UNCHANGED <<savedBy, late, mustWait, removedOk, afterRestart, restarts, sentOpen>>

\* replies.ts stop(), on a reply that is starting or being written, or one a window still shows running.
Stop(m) ==
  /\ rec[m] \in InFlight \ Stopping \/ late = m
  /\ Step(Applied(rec, m, "stop"), FALSE)
  /\ mustWait' = mustWait \cup Goers(Nobody)
  /\ late' = IF late = m THEN Nobody ELSE late
  /\ UNCHANGED <<turns, work, savedBy, removedOk, afterRestart, restarts, sentOpen>>

\* replies.ts stop(), the branch for a turn id the record has moved on from: tell(threadId, "late-stop").
StopOldTurn(m) ==
  /\ rec[m] \in InFlight /\ turns[m] > 1
  /\ Step(IF Off = "lateStopHolds" THEN rec ELSE Tell(rec, "late_stop", Nobody), FALSE)
  /\ mustWait' = mustWait \cup Goers(Nobody)
  /\ UNCHANGED <<turns, work, savedBy, late, removedOk, afterRestart, restarts, sentOpen>>

\* replies.ts now(): Send now. `stops` is going(threadId, id) # undefined.
Now(m) ==
  /\ rec[m] \in Waiting
  /\ LET stops == \E x \in Msgs \ {m} : rec[x] \in InFlight
         holds == \E x \in Msgs \ {m} : rec[x] \in InFlight \ Stopping
     IN /\ Step(Applied(rec, m, IF stops THEN "now_stops" ELSE "now"), FALSE)
        /\ mustWait' = (mustWait \ {m}) \cup (IF holds THEN Goers(m) ELSE {})
  /\ afterRestart' = afterRestart \ {m}
  /\ UNCHANGED <<turns, work, savedBy, late, removedOk, restarts, sentOpen>>

\* replies.ts hold()
Hold(m) ==
  /\ rec[m] \in Waiting /\ ~Held(rec[m])
  /\ Step(Applied(rec, m, "hold"), FALSE)
  /\ UNCHANGED <<turns, work, savedBy, late, mustWait, removedOk, afterRestart, restarts, sentOpen>>

\* replies.ts remove(): the window is told "done" only by the table's answer.
Remove(m) ==
  /\ rec[m] \in Waiting \cup InFlight /\ m \notin removedOk
  /\ removedOk' = IF Move(rec[m], "remove").ans = "done" THEN removedOk \cup {m} ELSE removedOk
  /\ Step(Applied(rec, m, "remove"), FALSE)
  /\ UNCHANGED <<turns, work, savedBy, late, mustWait, afterRestart, restarts, sentOpen>>

\* replies.ts edit(), open and close
OpenEdit(m, w) ==
  /\ rec[m] \in Waiting \ Editing
  /\ Step(Applied(rec, m, IF w = 1 THEN "edit_open_1" ELSE "edit_open_2"), FALSE)
  /\ UNCHANGED <<turns, work, savedBy, late, mustWait, removedOk, afterRestart, restarts, sentOpen>>
CloseEdit(m, w) ==
  /\ rec[m] \in Editing
  /\ Step(Applied(rec, m, IF w = 1 THEN "edit_close_1" ELSE "edit_close_2"), FALSE)
  /\ UNCHANGED <<turns, work, savedBy, late, mustWait, removedOk, afterRestart, restarts, sentOpen>>

\* ---- the server ---------------------------------------------------------------------

\* apps/server/src/app/queue-pump.ts startNext(): replies.pick(), then replies.sent() when the
\* question is in the chat already, else replies.take(). The code takes the oldest that goes;
\* the model lets any of them go, so it checks more orders than the code has.
Take(m) ==
  /\ ~ChatBusy
  /\ Goes(rec[m]) = "next" \/ (Goes(rec[m]) = "queued" /\ \A x \in Msgs : Goes(rec[x]) # "next")
  /\ IF savedBy[m] # {}
       THEN /\ Step(Applied(rec, m, "saved"), FALSE)
            /\ UNCHANGED <<turns, work, sentOpen>>
       ELSE /\ turns[m] < MaxTurns
            /\ Move(rec[m], "take").next \in Starting
            /\ Step(Applied(rec, m, "take"), FALSE)
            /\ turns' = [turns EXCEPT ![m] = @ + 1]
            /\ work' = [work EXCEPT ![m] = @ \cup {turns[m] + 1}]
            /\ sentOpen' = (sentOpen \/ rec[m] \in Editing)
  /\ UNCHANGED <<savedBy, late, mustWait, removedOk, afterRestart, restarts>>

\* apps/server/src/app/admit.ts append() (and drawing.ts, the same three lines): replies.starting(),
\* store.appendMessage(), replies.started(), with no await between them.
Append(m, a) ==
  /\ a \in work[m]
  /\ Still(rec[m], a = turns[m])
  /\ Cardinality(savedBy[m]) < 2
  /\ savedBy' = [savedBy EXCEPT ![m] = @ \cup {a}]
  /\ work' = [work EXCEPT ![m] = @ \ {a}]
  /\ Step(Applied(rec, m, IF a = turns[m] THEN "start_same" ELSE "start_other"), TRUE)
  /\ UNCHANGED <<turns, late, mustWait, removedOk, afterRestart, restarts, sentOpen>>

\* queue-pump.ts start(), the catch: replies.refused()
Refuse(m, a) ==
  /\ a \in work[m]
  /\ work' = [work EXCEPT ![m] = @ \ {a}]
  /\ Step(Applied(rec, m, IF a = turns[m] THEN "refuse_same" ELSE "refuse_other"), TRUE)
  /\ UNCHANGED <<turns, savedBy, late, mustWait, removedOk, afterRestart, restarts, sentOpen>>

\* apps/server/src/app.ts, the turn's end: replies.left(). This is how the work of a stopped start ends.
Left(m, a) ==
  /\ a \in work[m]
  /\ work' = [work EXCEPT ![m] = @ \ {a}]
  /\ Step(Applied(rec, m, IF a = turns[m] THEN "left_same" ELSE "left_other"), ~(rec[m] \in InFlight /\ a = turns[m]))
  /\ UNCHANGED <<turns, savedBy, late, mustWait, removedOk, afterRestart, restarts, sentOpen>>

\* replies.ts ended(), from the reply's own turn
End(m, i) ==
  /\ rec[m] \in Asked
  /\ Step(Applied(rec, m, i), TRUE)
  /\ late' = m
  /\ UNCHANGED <<turns, work, savedBy, mustWait, removedOk, afterRestart, restarts, sentOpen>>

\* No code: the window that still showed the ended reply as running has heard that it ended.
ScreenCatchesUp ==
  /\ late # Nobody
  /\ late' = Nobody
  /\ UNCHANGED <<rec, turns, work, savedBy, file, mustWait, dropped, removedOk, afterRestart, restarts, sentOpen>>

\* replies.ts createReplies(), reading the saved list: fromQueued(), then "saved" for a question
\* the chat already holds, else "restart". Work in memory is gone.
Restart ==
  /\ restarts < MaxRestarts
  /\ restarts' = restarts + 1
  /\ LET r2 == [x \in Msgs |->
                 IF file[x] = "none" \/ file[x] \in Removed THEN file[x]
                 ELSE Move(file[x], IF savedBy[x] # {} /\ Off # "restartReconciles" THEN "saved" ELSE "restart").next]
     IN /\ rec' = r2
        /\ afterRestart' = {x \in Msgs : r2[x] \in Waiting}
  /\ work' = [x \in Msgs |-> {}]
  /\ late' = Nobody
  /\ dropped' = dropped \cup {<<x, turns[x]>> : x \in {y \in Msgs : rec[y] \in Starting}}
  /\ UNCHANGED <<turns, savedBy, file, mustWait, removedOk, sentOpen>>

Next ==
  \/ \E m \in Msgs : Send(m) \/ Stop(m) \/ StopOldTurn(m) \/ Now(m) \/ Hold(m) \/ Remove(m) \/ Take(m)
  \/ \E m \in Msgs, w \in Wins : OpenEdit(m, w) \/ CloseEdit(m, w)
  \/ \E m \in Msgs, a \in 1..MaxTurns : Append(m, a) \/ Refuse(m, a) \/ Left(m, a)
  \/ \E m \in Msgs, i \in {"end_done_same", "end_failed_same"} : End(m, i)
  \/ ScreenCatchesUp \/ Restart

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ rec \in [Msgs -> Kinds] /\ file \in [Msgs -> Kinds]
  /\ turns \in [Msgs -> 0..MaxTurns]
  /\ \A x \in Msgs : work[x] \subseteq 1..MaxTurns /\ savedBy[x] \subseteq 1..MaxTurns

\* ---- the rules, in the owner's words ---------------------------------------------------

\* Stop holds the queue: what waited behind a reply when Stop was pressed goes only on Send now,
\* also when the reply's last word reached the app before the Stop.
StopHoldsTheQueue == \A x \in mustWait : Held(rec[x])

\* A removed message is never asked.
ARemovedMessageIsNeverAsked == \A x \in removedOk : savedBy[x] = {}

\* A message is asked once.
AskedOnce == \A x \in Msgs : Cardinality(savedBy[x]) <= 1

\* A restart holds everything: nothing that had not been asked goes on its own afterwards.
ARestartHoldsEverything == \A x \in afterRestart : Held(rec[x])

\* Nothing is saved for a start that was stopped, refused or lost before it was asked.
NothingSavedForAStoppedStart == \A p \in dropped : p[2] \notin savedBy[p[1]]

\* A message open in a composer is never sent.
EditingIsNeverSent == ~sentOpen

\* A message that shows as waiting has not been asked: no row that vanishes on Send now.
AWaitingMessageWasNotAsked == \A x \in Msgs : rec[x] \in Waiting => savedBy[x] = {}

\* (shape) A message that is starting has its start work.
StartingHasItsWork == \A x \in Msgs : rec[x] \in Starting => turns[x] \in work[x]

\* (shape) One reply at a time in a chat: replies.ts going() takes the first and expects no second.
OneReplyAtATime == Cardinality({x \in Msgs : rec[x] \in InFlight}) <= 1
====
