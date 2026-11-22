---- MODULE Gpu ----
\* Loading against one graphics card: two chats, one picture, a switch of runtime.
\*
\* The lease is NOT written here. It is the table LeaseCode, which model/gpu/table.ts reads from the
\* real createGpuLease() in apps/server/src/gpu/lease.ts on every run. Everything else in this file
\* is written by hand from the code each action names, and model/gpu/covered.json holds the hash of
\* each of those files, so a change to one of them fails the run until the model is read against it.
\*
\* Sizes: the card holds 5. The voice server takes 1 and is never asked for anything, a chat model 2,
\* the picture's models 2. Chat c1 wants model m1, chat c2 wants m2. The runtime starts as the Ollama
\* the person runs (A); a switch goes to the app's own (B), the next one back.
\* Time is steps. A wait with a limit is two actions: what is waited for happens, or the limit passes.
EXTENDS Naturals, Sequences, FiniteSets, LeaseCode

CONSTANTS
  MaxSwitches,
  \* What the world does. FALSE is what the passing run assumes; README.md says why.
  AbandonedLoadGoesOn,       \* Ollama goes on loading a model whose request was dropped
  AForeignEngineStaysStuck,  \* a ComfyUI the app did not start still runs a stopped picture after STUCK_HOLD_MS
  \* Guards that closed a real bug. TRUE is the code today; FALSE is the code before the fix.
  StuckPictureKeepsLease,    \* apps/server/src/image/module.ts heldWhileStuck()
  RefusedSwitchKeepsRecord   \* apps/server/src/runtime/load.ts runtimeKept()

VARIABLES
  pc,          \* where each of the three is
  lease,       \* the lease, as a state of LeaseCode
  gateQ, gateOwner,
  rt, sw, switches, gen,
  myGen, myRt, \* the loader's generation and the runtime a chat took at reserve()
  halted,      \* chats a switch told to end that have not ended
  mem,         \* the truth in each Ollama: out, loading, in
  engine,      \* the truth in ComfyUI: empty, loading, running, holds
  engineOurs,  \* whether the app started that ComfyUI
  ours,        \* the loader's record of what the app loaded
  forgotten,   \* what runtimeChanged() cleared from the record and may put back
  replying,    \* the loader's count of chats a model is answering
  \* The rest only remember what happened, for the rules at the bottom.
  shouldOwn, passed

vars == <<pc, lease, passed, gateQ, gateOwner, rt, sw, switches, gen, myGen, myRt, halted,
          mem, engine, engineOurs, ours, forgotten, shouldOwn, replying>>

Chats == {"c1", "c2"}
Pic == "p"
Actors == Chats \cup {Pic}
Models == {"m1", "m2"}
RTs == {"A", "B"}
Want(c) == IF c = "c1" THEN "m1" ELSE "m2"
Other(r) == IF r = "A" THEN "B" ELSE "A"
Cap == 5

Used == 1 + 2 * Cardinality({x \in RTs \X Models : mem[x[1]][x[2]] # "out"}) + (IF engine = "empty" THEN 0 ELSE 2)
Free == Cap - Used

Without(q, a) == SelectSeq(q, LAMBDA x : x # a)
InSeq(q, a) == \E i \in 1..Len(q) : q[i] = a
Ahead(q, a, b) == \E i \in 1..Len(q), j \in 1..Len(q) : q[i] = a /\ q[j] = b /\ i < j

SwitchVars == <<rt, sw, switches, gen>>
Record == <<ours, forgotten, shouldOwn>>
Claims == <<lease, passed, gateQ, gateOwner>>

Init ==
  /\ pc = [a \in Actors |-> "idle"]
  /\ lease = LeaseFree /\ passed = FALSE
  /\ gateQ = <<>> /\ gateOwner = "none"
  /\ rt = "A" /\ sw = "idle" /\ switches = 0 /\ gen = 0
  /\ myGen = [c \in Chats |-> 0] /\ myRt = [c \in Chats |-> "A"]
  /\ halted = {}
  /\ mem = [r \in RTs |-> [m \in Models |-> "out"]]
  /\ engine = "empty" /\ engineOurs \in BOOLEAN
  /\ ours = {} /\ forgotten = {} /\ shouldOwn = {}
  /\ replying = {}

\* ---- the lease (apps/server/src/gpu/lease.ts, through LeaseCode) and the gate ------------------

\* A chat was granted the lease although the picture was waiting for it and the chat was not ahead of it.
Jumped(from, to) ==
  \E c \in Chats :
    /\ c \in LeaseHolds[to] \ LeaseHolds[from]
    /\ InSeq(LeaseWaits[from], Pic) /\ InSeq(LeaseWaits[to], Pic)
    /\ ~Ahead(LeaseWaits[from], c, Pic)

LeaseMoves(to) == lease' = to /\ passed' = (passed \/ Jumped(lease, to))

\* lease.ts: the release function acquire() resolved with, or the abort of a claim still waiting.
LeaseLetGo(a) ==
  IF a \in LeaseHolds[lease] THEN LeaseStep[lease].release[a]
  ELSE IF InSeq(LeaseWaits[lease], a) THEN LeaseStep[lease].abort[a]
  ELSE lease

\* Everything an actor holds or waits for is given up. For a chat: apps/server/src/app/admit.ts
\* admitTurn(), `load?.end(); ending()`, and apps/server/src/runtime/load.ts end().
\* For a picture: the end of lease.run("image", ...) in apps/server/src/image/module.ts.
Drop(a) ==
  /\ LeaseMoves(LeaseLetGo(a))
  /\ gateQ' = Without(gateQ, a)
  /\ gateOwner' = IF gateOwner = a THEN "none" ELSE gateOwner

\* ---- a chat sends ----------------------------------------------------------------------------------

\* apps/server/src/runtime/load.ts reserve() (refused while a switch is under way), then
\* apps/server/src/app/admit.ts admitTurn(): deps.lease.acquire("chat", turnSignal).
ChatSends(c) ==
  /\ pc[c] = "idle" /\ sw = "idle"
  /\ myGen' = [myGen EXCEPT ![c] = gen]
  /\ myRt' = [myRt EXCEPT ![c] = rt]
  /\ pc' = [pc EXCEPT ![c] = "lease?"]
  /\ LeaseMoves(LeaseStep[lease].ask[c])
  /\ UNCHANGED <<gateQ, gateOwner, SwitchVars, halted, mem, engine, engineOurs, Record, replying>>

\* apps/server/src/image/module.ts claimed(): deps.lease.run("image", signal, job).
PictureAsked ==
  /\ pc[Pic] = "idle"
  /\ pc' = [pc EXCEPT ![Pic] = "lease?"]
  /\ LeaseMoves(LeaseStep[lease].ask[Pic])
  /\ UNCHANGED <<gateQ, gateOwner, SwitchVars, myGen, myRt, halted, mem, engine, engineOurs, Record, replying>>

\* The claim was granted (inside acquire() or a release's drain()), so the holder goes on to the gate:
\* load.ts admit() calls gate(...) for a chat; module.ts fit() calls memory.gate(...) for a picture.
EntersGate(a) ==
  /\ pc[a] = "lease?" /\ a \in LeaseHolds[lease] /\ a \notin halted
  /\ pc' = [pc EXCEPT ![a] = "gate?"]
  /\ gateQ' = Append(gateQ, a)
  /\ UNCHANGED <<lease, passed, gateOwner, SwitchVars, myGen, myRt, halted, mem, engine, engineOurs, Record, replying>>

\* apps/server/src/gpu/gate.ts createFifoGate(): one at a time, in the order they came.
GateGranted(a) ==
  /\ pc[a] = "gate?" /\ gateOwner = "none" /\ Len(gateQ) > 0 /\ Head(gateQ) = a
  /\ gateOwner' = a /\ gateQ' = Tail(gateQ)
  /\ pc' = [pc EXCEPT ![a] = "leaving"]
  /\ UNCHANGED <<lease, passed, SwitchVars, myGen, myRt, halted, mem, engine, engineOurs, Record, replying>>

\* ---- the handoff: the others are asked to leave ---------------------------------------------------

Busy(m) == \E c \in replying : Want(c) = m

\* apps/server/src/gpu/memory.ts chatLeaves(): of the models Ollama lists, not the wanted one, not one
\* a reply runs on (deps.replying()), and only one the app loaded (mayAsk). While a switch is under way
\* apps/server/src/runtime/switch.ts baseUrl() is undefined and nothing is asked.
Askable(a) ==
  IF sw = "draining" THEN {}
  ELSE {m \in Models : mem[rt][m] = "in" /\ (a \in Chats => m # Want(a)) /\ ~Busy(m) /\ m \in ours}

\* memory.ts handoff(): chatLeaves(), then engineLeaves(). Each asked model leaves, or is still there
\* when the wait ends. A model that left is taken off the record (load.ts unloaded()).
\* An idle engine the app started frees its memory for a chat; one it did not start is asked nothing.
OthersLeave(a) ==
  /\ pc[a] = "leaving" /\ a \notin halted
  /\ \E L \in SUBSET Askable(a) :
       /\ mem' = [mem EXCEPT ![rt] = [m \in Models |-> IF m \in L THEN "out" ELSE mem[rt][m]]]
       /\ ours' = ours \ L /\ forgotten' = forgotten \ L /\ shouldOwn' = shouldOwn \ L
  /\ engine' = IF engine = "holds" /\ a \in Chats /\ engineOurs THEN "empty" ELSE engine
  /\ pc' = [pc EXCEPT ![a] = "measuring"]
  /\ UNCHANGED <<Claims, SwitchVars, myGen, myRt, halted, engineOurs, replying>>

\* ---- measure, then load or refuse -------------------------------------------------------------------

\* load.ts admit(), inside the gate after the handoff: residency(), the fit, then one of three ends.
\* Resident already: the reply is counted and the gate is given back (handed(true)).
\* It fits: the reply is counted, memory.stage("loading"), and the gate is kept until the first word.
\* Refused: reservation.end() and admit.ts ending() give back the gate and the lease.
ChatMeasures(c) ==
  /\ pc[c] = "measuring" /\ c \notin halted
  /\ LET want == Want(c) IN
     IF mem[rt][want] = "in"
     THEN /\ pc' = [pc EXCEPT ![c] = "replying"]
          /\ replying' = replying \cup {c}
          /\ gateOwner' = "none"
          /\ UNCHANGED <<lease, passed, gateQ, mem>>
     ELSE IF mem[rt][want] = "loading" \/ Free >= 2
     THEN /\ pc' = [pc EXCEPT ![c] = "loading"]
          /\ replying' = replying \cup {c}
          /\ mem' = [mem EXCEPT ![rt][want] = "loading"]
          /\ UNCHANGED Claims
     ELSE /\ pc' = [pc EXCEPT ![c] = "idle"]
          /\ Drop(c)
          /\ UNCHANGED <<mem, replying>>
  /\ UNCHANGED <<SwitchVars, myGen, myRt, halted, engine, engineOurs, Record>>

\* module.ts fit(), inside memory.gate(): decide(), then memory.stage(want, "loading"); the gate is
\* given back and ComfyUI loads under the lease alone. An engine still at an earlier stopped picture
\* refuses the new one as "image-busy" and nothing new is loaded.
PictureMeasures ==
  /\ pc[Pic] = "measuring"
  /\ IF engine = "holds"
     THEN /\ engine' = "running" /\ pc' = [pc EXCEPT ![Pic] = "working"]
          /\ gateOwner' = "none"
          /\ UNCHANGED <<lease, passed, gateQ>>
     ELSE IF engine = "empty" /\ Free >= 2
     THEN /\ engine' = "loading" /\ pc' = [pc EXCEPT ![Pic] = "working"]
          /\ gateOwner' = "none"
          /\ UNCHANGED <<lease, passed, gateQ>>
     ELSE /\ pc' = [pc EXCEPT ![Pic] = "idle"]
          /\ Drop(Pic)
          /\ UNCHANGED engine
  /\ UNCHANGED <<SwitchVars, myGen, myRt, halted, mem, engineOurs, Record, replying>>

\* ---- the world ------------------------------------------------------------------------------------------

\* No code: Ollama finishes loading a model it was asked for.
OllamaFinishesLoading(r, m) ==
  /\ mem[r][m] = "loading"
  /\ mem' = [mem EXCEPT ![r][m] = "in"]
  /\ UNCHANGED <<pc, Claims, SwitchVars, myGen, myRt, halted, engine, engineOurs, Record, replying>>

\* No code: ComfyUI finishes loading the picture's models and starts drawing.
ComfyFinishesLoading ==
  /\ engine = "loading" /\ engine' = "running"
  /\ UNCHANGED <<pc, Claims, SwitchVars, myGen, myRt, halted, mem, engineOurs, Record, replying>>

\* No code: a run nobody waits for any more ends by itself.
ComfyFinishesAlone ==
  /\ engine = "running" /\ pc[Pic] # "working" /\ engine' = "holds"
  /\ UNCHANGED <<pc, Claims, SwitchVars, myGen, myRt, halted, mem, engineOurs, Record, replying>>

\* ---- a reply's life after the load -------------------------------------------------------------------

\* apps/server/src/app/run-turn.ts calls load.ts firstToken() at the reply's first word: the gate is
\* given back, and the load is recorded only by the generation that began it.
FirstWord(c) ==
  /\ pc[c] = "loading" /\ c \notin halted /\ mem[myRt[c]][Want(c)] = "in"
  /\ pc' = [pc EXCEPT ![c] = "replying"]
  /\ gateOwner' = IF gateOwner = c THEN "none" ELSE gateOwner
  /\ ours' = IF myGen[c] = gen THEN ours \cup {Want(c)} ELSE ours
  /\ shouldOwn' = IF myGen[c] = gen THEN shouldOwn \cup {Want(c)} ELSE shouldOwn
  /\ UNCHANGED <<lease, passed, gateQ, SwitchVars, myGen, myRt, halted, mem, engine, engineOurs, forgotten, replying>>

\* apps/server/src/app/run-turn.ts, the reply's end: load.end() and the lease's release.
ReplyEnds(c) ==
  /\ pc[c] = "replying" /\ c \notin halted
  /\ pc' = [pc EXCEPT ![c] = "idle"]
  /\ replying' = replying \ {c}
  /\ Drop(c)
  /\ UNCHANGED <<SwitchVars, myGen, myRt, halted, mem, engine, engineOurs, Record>>

\* A turn ends early. load.ts end() gives back the gate and admit.ts ending() the lease at once,
\* whatever Ollama is still doing with a load the turn began.
TurnEndsEarly(c) ==
  /\ pc[c] # "idle"
  /\ halted' = halted \ {c}
  /\ replying' = replying \ {c}
  /\ pc' = [pc EXCEPT ![c] = "idle"]
  /\ Drop(c)
  /\ mem' = IF pc[c] = "loading" /\ mem[myRt[c]][Want(c)] = "loading" /\ ~AbandonedLoadGoesOn
            THEN [mem EXCEPT ![myRt[c]][Want(c)] = "out"] ELSE mem
  /\ UNCHANGED <<SwitchVars, myGen, myRt, engine, engineOurs, Record>>

\* The person presses Stop on a reply: the turn's signal is aborted and admitTurn() ends it.
PersonStopsChat(c) == c \notin halted /\ TurnEndsEarly(c)
\* admit.ts runtimeGone(): the turn a switch told to end ends.
HaltedTurnEnds(c) == c \in halted /\ TurnEndsEarly(c)

\* ---- the picture's end ---------------------------------------------------------------------------------

\* module.ts: the render came back; memory.settled(want) and the lease is given back.
PictureDone ==
  /\ pc[Pic] = "working" /\ engine = "running"
  /\ engine' = "holds" /\ pc' = [pc EXCEPT ![Pic] = "idle"] /\ Drop(Pic)
  /\ UNCHANGED <<SwitchVars, myGen, myRt, halted, mem, engineOurs, Record, replying>>

\* Stop before the engine was given anything, or a Stop ComfyUI obeys in time.
PersonStopsPicture ==
  /\ pc[Pic] \notin {"idle", "unwinding"}
  /\ pc[Pic] = "working" => engine = "running"
  /\ engine' = IF pc[Pic] = "working" THEN "holds" ELSE engine
  /\ pc' = [pc EXCEPT ![Pic] = "idle"] /\ Drop(Pic)
  /\ UNCHANGED <<SwitchVars, myGen, myRt, halted, mem, engineOurs, Record, replying>>

\* apps/server/src/image/client.ts cancelPrompt() waited its time and ComfyUI is still at it.
\* module.ts heldWhileStuck(): the job keeps the lease while the stuck prompt is on the card.
PictureStopTimesOut ==
  /\ pc[Pic] = "working"
  /\ IF StuckPictureKeepsLease
     THEN pc' = [pc EXCEPT ![Pic] = "unwinding"] /\ UNCHANGED Claims
     ELSE pc' = [pc EXCEPT ![Pic] = "idle"] /\ Drop(Pic)
  /\ UNCHANGED <<SwitchVars, myGen, myRt, halted, mem, engine, engineOurs, Record, replying>>

\* heldWhileStuck(): ComfyUI let go of the stopped picture ("left").
StuckPictureSettles ==
  /\ pc[Pic] = "unwinding" /\ engine \notin {"loading", "running"}
  /\ pc' = [pc EXCEPT ![Pic] = "idle"] /\ Drop(Pic)
  /\ UNCHANGED <<SwitchVars, myGen, myRt, halted, mem, engine, engineOurs, Record, replying>>

\* heldWhileStuck(), "limit": STUCK_HOLD_MS passed. An engine the app started is stopped
\* (service.stop(), memory.engineGone()). One it did not start is never stopped, and the lease is
\* given back with ComfyUI still at it.
StuckHoldRunsOut ==
  /\ pc[Pic] = "unwinding" /\ engine \in {"loading", "running"}
  /\ IF engineOurs THEN engine' = "empty" ELSE AForeignEngineStaysStuck /\ engine' = engine
  /\ pc' = [pc EXCEPT ![Pic] = "idle"] /\ Drop(Pic)
  /\ UNCHANGED <<SwitchVars, myGen, myRt, halted, mem, engineOurs, Record, replying>>

\* ---- the switch of runtime -----------------------------------------------------------------------------

\* apps/server/src/runtime/switch.ts setMode() calls beforeSwitch, which is
\* apps/server/src/runtime/services.ts endTurnsForSwitch(): loader.runtimeChanged() first.
\* load.ts runtimeChanged(): generation up, the record cleared and kept aside, every turn told to end.
SwitchBegins ==
  /\ sw = "idle" /\ switches < MaxSwitches
  /\ sw' = "draining" /\ switches' = switches + 1 /\ gen' = gen + 1
  /\ forgotten' = ours /\ ours' = {}
  /\ halted' = {c \in Chats : pc[c] # "idle"}
  /\ UNCHANGED <<pc, Claims, rt, myGen, myRt, mem, engine, engineOurs, shouldOwn, replying>>

\* Every turn ended within TURN_DRAIN_MS: switch.ts stopIfStartedHere() stops the old runtime only if
\* the app started it, the new one is up, and afterSwitch calls load.ts runtimeSettled().
SwitchGoesAhead ==
  /\ sw = "draining" /\ \A c \in Chats : pc[c] = "idle"
  /\ rt' = Other(rt) /\ sw' = "idle"
  /\ mem' = IF rt = "B" THEN [mem EXCEPT ![rt] = [m \in Models |-> "out"]] ELSE mem
  /\ forgotten' = {} /\ shouldOwn' = {}
  /\ UNCHANGED <<pc, Claims, switches, gen, myGen, myRt, halted, engine, engineOurs, ours, replying>>

\* A turn was still running when TURN_DRAIN_MS ran out: endTurnsForSwitch() calls
\* loader.runtimeKept() and throws, setMode() keeps the old runtime, then runtimeSettled().
SwitchIsRefused ==
  /\ sw = "draining" /\ \E c \in Chats : pc[c] # "idle"
  /\ sw' = "idle"
  /\ ours' = IF RefusedSwitchKeepsRecord THEN ours \cup forgotten ELSE ours
  /\ forgotten' = {}
  /\ UNCHANGED <<pc, Claims, rt, switches, gen, myGen, myRt, halted, mem, engine, engineOurs, shouldOwn, replying>>

Next ==
  \/ \E c \in Chats : ChatSends(c) \/ ChatMeasures(c) \/ FirstWord(c) \/ ReplyEnds(c)
                      \/ PersonStopsChat(c) \/ HaltedTurnEnds(c)
  \/ \E a \in Actors : EntersGate(a) \/ GateGranted(a) \/ OthersLeave(a)
  \/ PictureAsked \/ PictureMeasures \/ PictureDone \/ PersonStopsPicture
  \/ PictureStopTimesOut \/ StuckPictureSettles \/ StuckHoldRunsOut
  \/ \E r \in RTs, m \in Models : OllamaFinishesLoading(r, m)
  \/ ComfyFinishesLoading \/ ComfyFinishesAlone
  \/ SwitchBegins \/ SwitchGoesAhead \/ SwitchIsRefused

Spec == Init /\ [][Next]_vars

Stages == {"idle", "lease?", "gate?", "leaving", "measuring", "loading", "replying", "working", "unwinding"}
TypeOK ==
  /\ pc \in [Actors -> Stages]
  /\ lease \in LeaseStates
  /\ gateOwner \in Actors \cup {"none"}
  /\ rt \in RTs /\ sw \in {"idle", "draining"} /\ switches \in 0..MaxSwitches /\ gen \in 0..MaxSwitches
  /\ halted \subseteq Chats /\ replying \subseteq Chats
  /\ mem \in [RTs -> [Models -> {"out", "loading", "in"}]]
  /\ engine \in {"empty", "loading", "running", "holds"}
  /\ ours \subseteq Models /\ forgotten \subseteq Models /\ shouldOwn \subseteq Models

\* ---- the rules, in the owner's words ---------------------------------------------------------------------

\* Never two things loading at once.
NowLoading == Cardinality({x \in RTs \X Models : mem[x[1]][x[2]] = "loading"}) + (IF engine = "loading" THEN 1 ELSE 0)
NeverTwoLoadingAtOnce == NowLoading <= 1

\* A running reply's model is never asked to leave: while a reply runs, its model stays in memory.
ARunningReplysModelStaysLoaded == \A c \in Chats : pc[c] = "replying" => mem[myRt[c]][Want(c)] = "in"

\* Once a switch has settled either way, the record names nothing that is not in the runtime in use...
NoStaleRecordAfterASwitch == sw = "idle" => \A m \in ours : mem[rt][m] = "in"
\* ...and has forgotten nothing the app loaded there.
ARefusedSwitchForgetsNothing == sw = "idle" => shouldOwn \subseteq ours

\* An exclusive claim does not wait for ever: nothing is granted past a waiting picture,
\* and nobody holds what the other waits for.
NothingPassesAWaitingPicture == ~passed
NoTwoWaitOnEachOther ==
  ~\E a \in Actors, b \in Actors :
      a # b /\ a \in LeaseHolds[lease] /\ InSeq(gateQ, a) /\ gateOwner = b /\ InSeq(LeaseWaits[lease], b)
====
