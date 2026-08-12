# Pondering: letting the engine think on the human's clock

Status: milestones 1–5 implemented; 6 (Elo harness) outstanding
Scope: `src/evochess/evoSearch.ts`, `src/evochess/ai.worker.ts`, `src/App.tsx`, plus a new match harness under `training/`

**Amendments after implementation.** Three sections below were wrong as
originally written, in ways that a faithful implementation reproduced as bugs:
§4.2's abort was incomplete (it left the root pass unguarded), and §5.2/§6.1
had the transposition table carried across an evaluation change on the *search*
path, which is the exact failure §6.1 exists to prevent. Each is corrected in
place and marked **[amended]**, keeping the original reasoning visible — this
document's habit of recording what earlier drafts got wrong is the reason the
remaining decisions can be trusted.

---

## 1. Executive summary

Today the Evochess engine only thinks when it is its turn. On the Fun level it gets an
800 ms budget, plays its move, and then the CPU sits completely idle — often for five or
ten seconds — while the human decides what to do. That idle time is free strength we are
throwing away.

**The proposal:** as soon as the AI has moved, start searching again *from the position
the human is now staring at*, in short interruptible slices. The moment the human plays,
we stop. The work is not wasted, because every position the engine examines gets written
into its transposition table — a cache of "I have already analysed this position, here is
what I found". Whatever the human plays, the engine's real 800 ms search then starts with
a warm cache instead of a cold one, and reaches a deeper, stronger answer in the same
wall-clock time.

Three things make this cheap to build here:

1. The search already runs in a Web Worker, so it is already off the UI thread.
2. The transposition table is already a module-level cache that survives between searches.
3. The cached scores are **position-keyed, not path-keyed** — the engine's draw rule
   (`evoSearch.ts:163`) ignores repetition history — so an entry computed during pondering
   is just as valid during the real search. There is no staleness hazard.

Two things stand in the way, both small and both addressed below: the table currently
*deliberately* discards everything from the previous search (§4.1), and a running search
cannot be interrupted (§4.2).

**Overriding priority: the ponder must stop the instant the human moves.** Pondering is a
strength optimisation, and a strength optimisation that makes the app feel unresponsive is
a net loss however much Elo it buys. Everywhere this spec trades responsiveness against
search efficiency, responsiveness wins. §4.2 is therefore the load-bearing section, not
§4.1.

**Expected payoff:** the effective thinking time for a Fun-level move goes from 800 ms to
800 ms plus however long the human took. Depth in a chess-like search grows roughly with
the logarithm of time, so this is worth on the order of one to two extra plies in typical
play — real, but to be measured, not assumed (§7).

**Non-goals:** predicting the human's specific reply ("ponder hit", the classic engine
technique) is explicitly *out* of scope for this spec — see §8. So is changing the
evaluation, the net, or the search algorithm itself.

---

## 2. Background for the non-specialist

Three terms are used throughout.

**Search.** To choose a move, the engine plays out every legal move, then every reply,
then every reply to that, and so on to some depth, scoring the leaves and backing the
scores up. The deeper it goes, the better it plays. Depth costs time exponentially.

**Transposition table (TT).** Different move orders often reach the *same* board position
("transpositions"). The TT is a big fixed-size cache keyed by a hash of the position: when
the search reaches a position it has analysed before to sufficient depth, it reuses the
stored score instead of re-searching the whole subtree. It also stores the best move found
there, which is used to try the most promising move first — and good move ordering is what
makes alpha-beta pruning cut off early. In this codebase the TT lives at
`evoSearch.ts:328-337`: 2^20 entries in flat typed arrays.

**Pondering.** Thinking during the opponent's turn. Standard in every serious chess
engine. This spec implements the *simplest useful* form of it.

---

## 3. What we are actually building

After the AI plays its move, and while it is the human's turn:

```
AI moves  ─────────────────────────────────────────►  human moves
          │                                        │
          │  ponder: search the current position    │  real search:
          │  in ~60 ms slices, deeper and deeper,   │  800 ms, but the
          │  writing everything into the TT         │  TT is already warm
          │  ◄──── typically 3–10 seconds ─────►    │  ◄─ 800 ms ─►
```

The ponder search analyses the position **with the human to move**. That means it explores
exactly the tree of "human plays X, I reply Y, …" for every legal X. Whichever X the human
actually chooses, the subtree under it has already been partly analysed and is sitting in
the TT.

This is the key property, and it is worth stating plainly: **there is no prediction and
therefore no miss.** A classic ponder guesses the human's reply and gets either a jackpot
or nothing. This design gets partial credit unconditionally. It is a lower ceiling but a
much higher floor, and it needs no new machinery for tracking the principal variation.

---

## 4. The two blockers

### 4.1 The TT is wiped between searches

`negamaxTT` only trusts a cache entry if its generation stamp matches the current one:

```ts
if (ttGen[i] === GEN && ttKey[i] === h) { ... }        // evoSearch.ts:363
```

and both search entry points bump the generation on the way in:

```ts
export function searchEvoTT(...)      { GEN++; ... }   // evoSearch.ts:441
export function searchEvoTTTimed(...) { GEN++; ... }   // evoSearch.ts:469
```

This is an intentional and normally sensible design: it invalidates a whole 2^20-entry
table in one integer increment, with no memory to clear. But it means everything the
ponder computes is discarded by the very next real search. **Without fixing this, the
feature does literally nothing.**

**Fix.** Introduce an explicit continuation flag rather than trying to be clever about
generations:

```ts
export function searchEvoTTTimed(s, timeMs, maxDepth, seed, useNnue, keepTT = false) {
  if (!keepTT) GEN++;
  ...
}
```

The ponder loop passes `keepTT: true` on every slice after the first; the real search
passes `keepTT: true` when it is continuing from a ponder on the same game. Everything
else — a new game, a takeback, a level change — leaves the default and gets the current
wipe-by-increment behaviour.

Why an explicit flag and not "accept `GEN` or `GEN-1`"? Because the ponder is not one
search but a chain of dozens of slices, so "one generation back" is the wrong window, and
a wider window would silently keep entries alive across takebacks and new games. An
explicit flag makes the retention decision visible at the call site.

**Correctness argument for retaining entries across searches.** A TT entry maps *position
hash → score, depth, bound, best move*. It would be unsafe to carry across searches only
if a stored score depended on how the position was reached. It does not: `isDraw`
(`evoSearch.ts:163`) checks only board state and the half-move counter, and the half-move
counter is itself part of the Zobrist hash (`evoSearch.ts:322`). Repetition history is
explicitly a game-driver concern, per the comment at `evoSearch.ts:160`. So entries are
path-independent and remain valid indefinitely.

The one genuine hazard here would be **mate scores**, whose value *is* path-dependent: they
are stored as `MATE - ply`, so the same mate reached at a different distance from the root
carries a different number, and the ponder's root sits one ply before the real search's.
This is already handled — `negamaxTT` refuses to cache any score outside `±MATE_THRESHOLD`
(`evoSearch.ts:390-392`, with a comment saying exactly why). Verified against the code, not
assumed; it is the reason cross-search retention is safe rather than merely plausible. Retention across a *takeback* would be
harmless for the same reason; we wipe there anyway, purely to keep the policy simple.

### 4.2 A running search cannot be interrupted

The time budget is only checked *between* iterative-deepening passes:

```ts
for (let d = 1; d <= maxDepth; d++) {
  const r = rootSearch(s, d, best, rng);
  ...
  if (Date.now() >= deadline) break;                   // evoSearch.ts:479
}
```

A single deep pass is one synchronous call that runs to completion. Worse, while it runs,
the worker's JavaScript thread is busy, so `self.onmessage` cannot fire — the worker
literally cannot hear "stop, the human moved" until it is already done.

**Slicing alone does not fix this.** The obvious design — run the ponder as a chain of
short searches, yielding to the event loop between them — is necessary but *not
sufficient*, and it is worth being precise about why, because it is easy to talk oneself
into believing a `SLICE_MS` constant bounds anything:

```
ponder slice 1 (60 ms?) → yield → slice 2 (60 ms?) → yield → …
```

A slice is a call to the timed search, whose deadline is only consulted *between*
iterative-deepening passes. With a warm TT the slice blows through depths 1..d in
microseconds, then enters the depth-(d+1) pass — one synchronous call that runs to
completion regardless of the clock. **`SLICE_MS` sets a floor on slice duration, not a
ceiling.** Worst-case added latency is the cost of one full iteration at the current
ponder depth, which grows as the chain deepens: the longer the human thought, the longer
they wait after moving. The feature would be at its most irritating exactly when it is
doing the most good. During that window the worker cannot process `reset` either, so
takeback stalls too.

**Fix: a hard deadline check inside the search, arming it for ponder slices only.**

`negamaxTT` and `quiesce` poll a slice deadline every 2048 nodes (`NODES` is already a
module-level counter, `evoSearch.ts:166`) and set a module-level `ABORT` flag:

```ts
// Checked cheaply; PONDER_DEADLINE is Infinity for every non-ponder search,
// so the real search's timing is bit-identical to today's.
if ((NODES & 2047) === 0 && Date.now() >= PONDER_DEADLINE) ABORT = true;
if (ABORT) return 0;
```

On abort the move loop `break`s normally, so `undoEvoTurn` still runs on every applied
turn and the position and accumulator unwind cleanly. The TT store is guarded by
`if (!ABORT)`: a node whose children were not all searched must not be cached. Subtrees
that *completed* before the abort are already stored and remain valid — that is the work
the ponder exists to produce, and it is kept.

**[amended] The guard is needed in four places, not two.** As written above this
section named only `negamaxTT` and `quiesce`, and the implementation followed it. That
is not enough, because an aborting node returns a *placeholder* — `0` from the entry
check, or `-Infinity` if it aborted before scoring even its first move — and every
caller that scores such a return treats the placeholder as a real evaluation:

- `rootSearch`'s move loop needs the same `if (ABORT) break`. Without it, a child that
  returned `-Infinity` arrives at the root as `+Infinity` and becomes the best move.
- Both iterative-deepening loops (`searchEvoTT`, `searchEvoTTTimed`) need `if (ABORT)
  break` *before* accepting the pass's result, so an aborted pass is discarded and the
  last completed one is returned.

Measured on 60 ms slices before the fix: `depth=5 score=Infinity`, routinely. The
`Infinity` then tripped `searchEvoTTTimed`'s `score >= MATE_THRESHOLD` check, so the
slice reported a found mate, and the reported `depth` counted an unfinished pass — the
same number `MAX_PONDER_DEPTH` and §7's mean-depth metric read. After the fix, the same
slices report finite scores at completed depths.

**The root guard and the loop guards are coupled; neither works alone.** With only the
loop guards, the aborted pass is discarded, so the root's garbage never escapes and the
bug is invisible. With only the root guard, `rootSearch` breaks before setting
`bestTurn` and the search returns a *null move* on a legal position. Verified by
removing each in turn. Do not remove one on the grounds that the other covers it.

Today `ABORT` can only be set by an armed ponder deadline, so none of this is reachable
from the move-playing path — but the note at the end of this section contemplates arming
the real search too, and that change would make it reachable immediately.

This was rejected in an earlier draft of this spec on the grounds that "the flag can only
be set by a message, and messages cannot arrive while the search is running". That is true
of a *message*-triggered abort and irrelevant to a *time*-triggered one: a slice ends
itself, needing nothing from outside. Stop-latency becomes slice-remainder plus poll
granularity — bounded, and independent of ponder depth.

**Conservatism: this changes nothing about the move-playing path.** `PONDER_DEADLINE` is
`Infinity` outside a ponder slice, so the real 800 ms search retains its current
between-iterations behaviour exactly. (That search can overshoot its budget for the same
structural reason, and the same mechanism would fix it — but that is a separate change
with its own re-baselining cost, and is deliberately not bundled here.)

> **[Amended — that separate change has since been made, and the parenthesis above was
> understating it.]** The overshoot it contemplates was measured at **4552ms for a
> nominally 800ms Fun search** in the browser, and 2.9-3.1s across the corpus — a budget
> checked between iterations bounds nothing, because the iteration that blows it is the one
> already running. `searchLevel` now arms this same abort on the move-playing path, at a
> `TIMED_HARD_MS` ceiling (1200ms) rather than at the budget, so an iteration in flight can
> still finish and count while a runaway one is cut off. Consequences, all of them
> deliberate:
>
> - `PONDER_DEADLINE` is renamed `SEARCH_DEADLINE`, and `armPonderDeadline` /
>   `disarmPonderDeadline` to `armSearchDeadline` / `disarmSearchDeadline`. It is no longer
>   a ponder mechanism.
> - The move-playing path is **no longer bit-identical** to pre-ponder behaviour, which
>   several notes in this document promise. Those promises were about not perturbing the
>   real search *as a side effect of adding pondering*; this perturbs it on purpose, to fix
>   a user-visible latency bug. An unarmed search is still bit-identical, and that is what
>   §9 milestone 1's guard actually tests.
> - The null-move hazard §4.2 warns about above becomes reachable, exactly as predicted.
>   `searchEvoTTTimed` now falls back to the first statically-ordered turn if the ceiling
>   fires before any iteration completes: a poor move beats a stalled game.
> - The budget drops 800ms → 400ms, measured free (`bench/bench11_move_latency.ts`):
>   stopping at 280/400/560/800ms reaches identical depth, because an iteration started
>   after ~400ms cannot finish before the ceiling and is discarded when it fires.
>
> Result over 8 corpus positions × PST/NNUE: max 3120ms → **1037ms**, mean 1654ms →
> **728ms**, at a cost of about one ply (typically 6→5 for NNUE). Guard:
> `src/evochess/__tests__/moveLatency.test.ts`.

Slicing is still needed *on top* of the abort, to yield the event loop: each slice ends,
`setTimeout(0)` lets the worker drain its message queue, and the next slice starts. Each
slice restarts iterative deepening from depth 1, which sounds wasteful but is not — the
shallow passes hit the warm TT and cost microseconds. The chain deepens on its own as the
table fills; no explicit depth ratchet is required (§5.2).

**Alternative considered and rejected.** *A second dedicated ponder worker plus a
`SharedArrayBuffer` stop flag.* True mid-search abort, and `terminate()` on a separate
worker would be an unconditional kill. But the two workers would have separate module
state, so the search worker would gain nothing from the ponder worker's TT — which is the
entire benefit of the feature. It also requires cross-origin-isolation headers (COOP/COEP)
for `SharedArrayBuffer`, awkward on GitHub Pages, where this app is deployed.

---

## 5. Design

### 5.1 Worker protocol

The worker currently accepts exactly one message shape and answers with one
(`ai.worker.ts:51-64`). It grows a small tagged protocol.

```ts
type WorkerRequest =
  | { kind: "search"; id: number; game: SerializedGame; level: AiLevel; seed: number }
  | { kind: "ponder"; game: SerializedGame }
  | { kind: "stop" }      // human moved: end the ponder chain, keep the warm TT
  | { kind: "reset" };    // new game / takeback: end the chain and invalidate the TT
```

`AiSearchResponse` is unchanged. Ponder produces no response message; it is
fire-and-forget.

The worker holds three pieces of state:

```ts
let ponderSeq = 0;              // bumped by every ponder/stop/reset; stale chains see the change and exit
let ttWarm = false;             // has anything been pondered or searched since the last reset?
let ttEvalWasNnue: boolean | null = null;  // [amended] which evaluator filled it — see §6.1
```

**[amended]** `ttWarm` alone is not a sufficient condition for retention, and the
original two-flag design is what made §6.1's bug possible. A TT entry stores a bare
number with no record of what produced it, so retention needs to know *which evaluator*
the table holds, not merely that it holds something. Hence:

```ts
// Mirrors searchLevel's own derivation exactly: Fun defaults useNnue to
// hasNnueWeights(); Easy/Zen pass false outright.
const evalIsNnue = (level) => level === "fun" && hasNnueWeights();

const mayKeepTT = (level) =>
  level === "fun" &&                        // §5.5: Easy/Zen never continue from a warm table
  ttWarm &&
  ttEvalWasNnue === evalIsNnue(level);      // §6.1: same evaluator, or the scores are not comparable
```

Every search and every ponder slice sets both `ttWarm = true` and
`ttEvalWasNnue = evalIsNnue(level)` after running; `reset` clears both.

**Simplification versus an earlier draft.** That draft gave each ponder a `token` minted on
the main thread and echoed back on the next search as `continueFromPonder`, so the main
thread could assert the search continued from the *matching* ponder. This is unnecessary:
the worker already knows whether it has pondered since the last `reset` — that is exactly
what `ttWarm` records — and the main thread has no information the worker lacks. Superseding
a stale ponder chain needs only a worker-local counter. Dropping the tokens removes a field
from two message types, a piece of main-thread ref state, and the assertion itself.

### 5.2 Worker pseudocode

```
on message m:
  switch m.kind:

    case "reset":
      ponderSeq++            // kills any live chain
      ttWarm = false         // next search wipes the TT via the normal GEN++ path
      ttEvalWasNnue = null

    case "stop":
      ponderSeq++
      // ttWarm deliberately left alone: the work is still valid and reusable

    case "ponder":
      if not nnueSettled: return               // §6.1
      const mine = ++ponderSeq
      pos = deserialize(m.game)
      until = now() + PONDER_BUDGET_MS
      loop:
        if ponderSeq != mine: return           // superseded, stopped, or reset
        r = searchLevel(pos, "fun", PONDER_SEED,
                        { timeMs: SLICE_MS, keepTT: mayKeepTT("fun") })
        ttWarm = true; ttEvalWasNnue = evalIsNnue("fun")
        if r.depth >= MAX_PONDER_DEPTH: return // saturated; stop burning CPU
        if now() >= until: return              // [amended] wall-clock backstop
        yield to event loop (setTimeout 0)     // <- lets "stop"/"reset"/"search" arrive
      end loop

    case "search":
      ponderSeq++                              // a search always ends pondering
      result = searchLevel(deserialize(m.game), m.level, m.seed,
                           { keepTT: mayKeepTT(m.level) })
      ttWarm = true; ttEvalWasNnue = evalIsNnue(m.level)
      postMessage({ id: m.id, ...result })
```

Notes on the ponder loop:

- **The ponder calls `searchLevel`, not `searchEvoTTTimed`, and this is deliberate.** The
  two layers have opposite `useNnue` defaults: `searchRoot` defaults to `hasNnueWeights()`
  (`ai.ts:554`) while `searchEvoTTTimed` defaults to `false` (`evoSearch.ts:466`). Calling
  the lower layer directly means an omitted argument silently gives a PST ponder feeding a
  NNUE search — mixed scores in one table, no crash, weaker play. Routing through
  `searchLevel` makes the ponder and the real search derive `useNnue` from the same
  expression *by construction*, so they cannot diverge. See §6.1.
- `PONDER_SEED` is a fixed constant, not a fresh random seed. Root tie-break randomisation
  exists to vary games (`evoSearch.ts:117`); during pondering we only want cache fill, and
  a deterministic ordering makes slices reproducible for testing. (An earlier draft passed
  `seed: undefined`, which `searchLevel`'s signature — `seed: number`, `ai.ts:674` — does
  not accept. Making the parameter optional would work equally well; a constant is less
  churn.)
- **No explicit depth ratchet.** An earlier draft passed an increasing `maxDepth` per slice
  to force monotonic progress. It is not needed: each slice re-runs iterative deepening
  from depth 1, the shallow passes are TT-instant, and the chain deepens on its own. The
  saturation cap reads the `depth` already returned in `EvoSearchTimedResult`. This removes
  `maxDepth` from the options bag entirely (§5.4).
- `MAX_PONDER_DEPTH` (start at 12) caps the burn. Past some depth the human has been
  thinking long enough that further slices buy almost nothing, and we should stop heating
  their laptop.
- **[amended] The depth cap does not bind, so a wall-clock backstop does the capping.**
  Measured on the implementation: a chain plateaus around depth 7 and never approaches
  12, so the "saturated; stop burning CPU" exit is effectively dead code and the chain
  would otherwise run for as long as the human thinks. `PONDER_BUDGET_MS` (start at
  10 s) is what actually mitigates the battery risk in §10; the depth cap stays as a
  cheap second condition. Both are milestone-5 tuning knobs.
- `SLICE_MS = 60`. Tunable, and *meaningful only because of the in-search abort* (§4.2) —
  without it this constant bounds nothing. The trade-off is stop-latency versus per-slice
  re-search overhead; with TT-instant shallow passes the overhead is small, so err low.

### 5.3 Main-thread integration (`App.tsx`)

`maybeAiMove` (`App.tsx:199-223`) already knows exactly when the AI's move lands and it
becomes the human's turn. That is the one place that needs to start a ponder:

```
maybeAiMove():
  ...existing...
  game.applyMove(candidate.from, candidate.to, candidate.options)
  setAiThinking(false); rerender()
  if mode == "human-ai" and level == "fun" and ponderEnabled and not game.isGameOver():
      worker.postMessage({ kind: "ponder", game: serializeGame(game) })
```

`searchInWorker` is unchanged apart from the `kind: "search"` tag — with the tokens gone
(§5.1) it has nothing to report about ponder continuity.

Everything that discards or rewrites game state must send `reset`: new game, takeback, mode
change, level change, side change, loading a save. The existing call sites are the
`setTimeout(maybeAiMove, ...)` points at `App.tsx:222, 242, 274, 402`; each needs an audit.

`applyAndAdvance` (`App.tsx:225-243`) is the human's move landing, and per the priority in
§1 it **must** send `stop` there — synchronously, at the top of the function, before the
`historyRef` push and well before the 30 ms UI-paint delay at `App.tsx:211`. The later
`search` message would imply a stop, but only after that 30 ms wait, and the whole point is
to get the worker off the CPU at the earliest instant we know the human has committed.

**[amended] Two consequences of stopping that early.** Sending `stop` before the move is
validated means the illegal-move path (`applyMove` throws, the function returns early)
has stopped a chain for a move that never happened: the position is unchanged and it is
still the human's turn, so that path must restart the ponder rather than leave the rest
of their thinking time idle. And because `stop` is the only thing that ends a chain,
the `ponderEnabled` checkbox must send it when unchecked — the label promises control
over battery use, and suppressing only the *next* chain leaves the current one burning
CPU until the human's next move. Both want a shared `maybeStartPonder(game, overrides)`
helper; the overrides bag exists because the checkbox handler holds a value React state
has not caught up to, the same reason `maybeAiMove` has one.

### 5.4 `searchLevel` / `searchRoot` signature

`searchLevel` (`ai.ts:674`) gains a trailing options bag, defaulted so no existing caller
changes:

```ts
export function searchLevel(
  game: EvoChessGame,
  level: AiLevel,
  seed: number,
  opts: { timeMs?: number; keepTT?: boolean } = {}
): RootSearch & { depth: number }
```

- `timeMs` overrides `FUN_TIME_MS` — this is what lets the ponder run 60 ms slices through
  the same function the real 800 ms search uses, which is the whole point of §5.2. When
  present it also arms the in-search abort deadline of §4.2; when absent, `PONDER_DEADLINE`
  stays `Infinity` and the real search is untouched.
- `keepTT` threads down to `searchEvoTT{,Timed}` to suppress `GEN++` (§4.1).

Critically, `useNnue` is **not** in the bag. It stays derived inside `searchLevel` exactly
as it is today, so no caller — ponder included — can set it independently. That is what
makes the mixed-evaluation bug unrepresentable rather than merely discouraged.

The `"chessjs"` backend ignores `keepTT`: it builds a fresh `Map`-based TT per search
(`ai.ts:575`) and is not on the UI path.

### 5.5 Setting

A `ponderEnabled` boolean, persisted alongside the other UI settings in
`persistence.ts`, default **on**, surfaced as a checkbox near the level selector, labelled
in plain language — e.g. *"Let the AI think while it's your turn (uses more battery)"*.
Forced off when `level !== "fun"`: Easy and Zen are fixed shallow depths and deliberately
weak, so a warm TT there would only make them stronger than intended.

**[amended] Not pondering at Easy/Zen is not the same as not *retaining* at Easy/Zen,
and this section originally conflated them.** Suppressing the ponder leaves the search
path free to retain: the worker sets `ttWarm` after every search, so from the second
move on, an Easy game runs on a table its own previous search left warm — stronger than
intended, with no ponder involved, and in violation of §6.4's requirement that
`ponderEnabled = false` be bit-identical to pre-ponder behaviour. The `level === "fun"`
condition in `mayKeepTT` (§5.2) is what actually enforces this section.

---

## 6. Correctness requirements

1. **Evaluation consistency.** A TT entry stores a bare number, with no record of which
   evaluation produced it. PST scores and NNUE scores are not interchangeable. If a ponder
   fills the table with PST scores and the real search then reads them as net scores, the
   engine plays worse — silently, with no crash and nothing in the logs.

   Structurally this is handled by routing the ponder through `searchLevel` (§5.2), so both
   derive `useNnue` from one expression and cannot disagree. That leaves exactly one way
   for them to diverge: **the weights fetch resolving mid-ponder.** The fetch is async and
   best-effort (`ai.worker.ts:43-49`), so if the AI moves first as White its opening search
   may run PST, the ponder chain starts PST, the fetch lands a few slices in, and later
   slices plus the real search run NNUE — one table, two evaluations. The window is the
   first few seconds of page life, but it is reachable in normal play.

   **Fix: gate, don't invalidate.** Hold the fetch promise in a module-level
   `nnueSettled` flag set by both `.then` and `.catch`, and simply do not start a ponder
   chain until it is set (§5.2). An earlier draft instead had the fetch tear down a live
   chain and null the TT-ownership state; gating is strictly simpler — no cross-cutting
   invalidation path, no mid-chain state mutation — and it is the better answer on the
   merits too: every ponder CPU-second then goes into NNUE entries rather than into PST
   entries that are about to be discarded. The cost is at most a few hundred milliseconds
   of not pondering, once per page load, on the opening move only.

   **[amended] "Exactly one way to diverge" was wrong, and the gate does not close it.**
   The claim above reasons about the *ponder* and forgets that the search path retains
   too. The reachable sequence involves no ponder at all:

   1. Page loads; the weights fetch is in flight.
   2. The AI's opening search runs — PST, correctly — and the worker sets `ttWarm = true`.
   3. The fetch lands.
   4. The next real search runs with the net **and `keepTT: ttWarm`**, reading every one
      of those PST entries as net scores.

   `nnueSettled` gates only `ponder`, so it is not on this path. Measured at identical
   position and depth: a clean net search scores 0 cp where a PST-warmed one scores
   100 cp — same move in that instance, with nothing guaranteeing that in general.

   **The real fix is provenance, not gating.** Record which evaluator filled the table
   (`ttEvalWasNnue`, §5.2) and refuse to retain across a mismatch. This is strictly
   stronger than any call-site gate: it closes the fetch race, the Easy/Zen retention gap
   (§5.5), and any future path that changes the evaluator, without each of those having
   to be anticipated. The `nnueSettled` gate is kept on top, for its original and still
   valid reason — not *wasting* ponder CPU on entries about to become unusable — but it
   is no longer load-bearing for correctness.

   The general lesson, which generalises past this feature: **a cache whose entries are
   only valid under some assumption must record the assumption, not rely on every call
   site remembering it.** "Route both through one expression so they cannot disagree"
   protects the two call sites you thought of.

2. **No TT reuse across a state discontinuity.** New game, takeback, position load →
   `reset`. Positions remain individually valid, but keeping the cache across a takeback
   would make the engine replay its old analysis, which is bad for the *variety* the seed
   randomisation exists to provide.

3. **Pondering must never change the move actually played** except through depth. It uses
   no seed, writes only to the TT, and returns nothing. There is no path by which a ponder
   result becomes a move.

4. **Determinism for tests.** With `ponderEnabled = false` the engine must be
   bit-identical to today's. That is the regression guard.

---

## 7. Measurement

**Priority note.** The full Elo harness below is deferred (milestone 6). The go/no-go for
this feature is responsiveness, not a precise strength number, and the secondary metrics at
the end of this section are enough to confirm the TT continuity is actually working. The
harness design is retained here because if the measurement is ever done, it must be done
this way — this repo has already been burned once by an unfair-timing comparison.

**Harness.** A new script under `training/` playing engine-vs-engine matches where:

- Both sides run **identical code** with identical time budgets. The only difference is
  `ponderEnabled`.
- The pondering side is given a simulated human think-time between moves — the wall-clock
  interval it is allowed to ponder for. Model it as a fixed value per match (test 2 s, 5 s,
  10 s) rather than a distribution, so results are interpretable.
- The non-pondering side gets that same wall-clock gap as pure idle. Do not let it use the
  time in any way.
- Alternate colours, use the standard opening-diversity seeding already used by the
  existing self-play tooling, and report Elo with error bars.

**Anti-patterns to avoid, explicitly:**

- Self-play with *both* sides pondering measures nothing at all; it will read as 0 Elo.
- Comparing against a previously recorded baseline number from an older commit. Per the
  standing lesson in this project: re-run both arms on the same code, at the same time.
- Reporting a raw depth increase as if it were strength. Extra depth from a warm TT is
  real, but the honest headline number is the match result.

**Secondary metrics**, useful for tuning and for sanity-checking that the mechanism is
actually working:

- Mean depth reached by the real search, pondering vs. not. If this does not move, the
  TT continuity is broken — that is the first thing to check.
- TT hit rate in the first iteration of the real search. Should jump sharply.
- Ponder CPU seconds per game, for the battery conversation.

**Recorded measurement (mean-depth metric).** Taken after milestones 1–4 and after the
§4.2/§6.1 amendments, so it reflects current code:

| | depth | nodes |
|---|---|---|
| cold TT | 6 | 76,705 |
| after a ponder chain | 7 | 253,312 |

Conditions, stated because a number without them is not re-comparable: 800 ms real
search; position three plies into the opening (`e4 e5 d4`); PST evaluation; ponder chain
of 50 × 60 ms slices; bitboard backend; single run, not averaged.

**This is an upper bound, and must not be quoted as the feature's value.** The chain
pondered the *same root* the real search then used, whereas in play the ponder's root is
one ply earlier and only the subtree under the human's actual move carries over. It
establishes that the TT continuity works — which is all §7 claims this metric is for.
The honest strength number is a match result and remains unmeasured (milestone 6).
Per the standing lesson in this project: do not compare a future measurement against
this row unless both arms are re-run on the same code at the same time.

**Recorded measurement (milestone 5 tuning).** A chained-slice benchmark (`searchEvoTTTimed`
called repeatedly with `keepTT: true`, mirroring the ponder loop, not committed as a
script — reproducible from this description) against two positions (the opening, and a
position 6 plies in), sweeping `SLICE_MS` over 20/40/60/100/150ms for up to 400 chained
slices (~30s):

| `SLICE_MS` | max per-slice overshoot past its own deadline | depth at plateau | wall-clock to first reach it |
|---|---|---|---|
| 20 | ~32ms | 5 | ~1.6s |
| 40 | ~59ms | 6 | ~3.8s |
| 60 | ~35–47ms | 6–7 | ~3.8–5.0s |
| 100 | ~38ms | 7 | ~5.0s |
| 150 | ~35–43ms | 7 | ~5.0s |

Two findings drove the tuning:

- **Overshoot is a roughly constant ~30–60ms floor, independent of `SLICE_MS`.** It is set
  by the abort's 2048-node poll granularity (§4.2), not by the slice length. So shortening
  `SLICE_MS` does not trade away search efficiency for latency — it's close to free. What it
  *does* buy: the worst-case pause the human feels after moving is bounded by one in-flight
  slice, i.e. `SLICE_MS` + overshoot, so a shorter slice directly lowers that bound. Depth
  growth vs. wall-clock was statistically indistinguishable across 20/40/60ms in the same
  benchmark, confirming there's no meaningful throughput cost to paying for. `SLICE_MS: 60 →
  40`.
- **Depth plateaus within ~4–6s in both benchmarked positions and does not move for the
  next ~25s of chained slices.** `MAX_PONDER_DEPTH = 12` is never approached (max observed:
  7), reconfirming the §5.2 amendment that this cap does not bind — left unchanged, as a
  cheap and harmless second condition. `PONDER_BUDGET_MS`, the cap that actually matters,
  was spending roughly half of its original 10s on an already-plateaued table with zero
  further depth gained; `PONDER_BUDGET_MS: 10s → 7s` keeps 1–3s of margin past the observed
  plateau (for slower devices or higher-branching positions) while cutting most of the
  measured idle-CPU tail.

**[Amended] What the plateau is, and is not.** The reading above left the *cause* of the
plateau open, and the obvious suspect was the chain restarting its deepening ladder at
`d=1` in every slice: once a `d=n` root pass no longer fits in `SLICE_MS` it aborts, its
result is discarded (§4.2), and the next slice starts over — so, on that theory, the chain
re-walks the same ladder forever and can never complete anything deeper. Measured
(`bench/bench8_ponder_resume.ts`), **that theory is wrong**, and two numbers say so:

- Carrying the ladder position across slices instead of restarting it (`startDepth` on
  `searchEvoTTTimed`, `ai.worker.ts` `ponderSlice`) moves the plateau by **zero to one ply**
  across 4 positions × 2 evaluations. The repeated shallow iterations were nearly free —
  against a warm TT they are answered mostly out of the table, so they were never where a
  slice's time went.
- **One uninterrupted 7s search reaches depth 8–9 where 7s of 40ms slices reaches 7–8.**
  So slicing costs about a ply, but resuming recovers almost none of it: the lost work is
  work no table holds. Quiescence is never TT-cached (`evoSearch.ts` `quiesce` neither
  probes nor stores), and the TT is always-replace with no depth preference, so deep
  entries are evicted by the shallow ones above them. Each aborted attempt at `d=n` redoes
  most of what the last one did.

The plateau is therefore mostly intrinsic to the search at this branching factor, not an
artifact of the chain's shape. Resuming is kept — it is strictly less wasted work and
makes the ladder position explicit — but it is not the lever. Regression guard:
`src/evochess/__tests__/evoSearchResume.test.ts`, which asserts the contract — resuming
never costs depth, and never leaks its root-ordering state into a cold search — rather than
a strength claim it cannot support.

**[Amended again] A longer `SLICE_MS` does not buy the missing ply either.** The obvious
follow-up to the paragraph above — if slicing costs a ply, slice less often — was measured
and does not hold (`bench/bench10_slice_ms.ts`, sweeping 40/60/90/150ms through the real
two-phase chain over 3 corpus positions × PST/NNUE):

| `SLICE_MS` | depth reached (unchanged across the sweep) | worst slice, i.e. the stop-latency bound |
|---:|---|---:|
| 40 | phase 1 `6/7/7`, phase 2 `8/6/7` (PST) | 65–84ms |
| 60 | identical | 86–100ms |
| 90 | identical | 115–129ms |
| 150 | identical but for one position a ply *worse* | 177–198ms |

Depth is flat from 40 to 90ms while the worst-case pause after the human moves grows by
~50ms — a strictly losing trade, so `SLICE_MS` stays at 40. The sliced-vs-continuous gap is
real (the same benchmark's uninterrupted 7s searches reach `8/8/9` PST, `8/8/8` NNUE) but
it does not close at any slice length short enough to keep the UI responsive. What is left,
then, is the work the abort discards being unrecoverable in the first place: TT-ing
quiescence, or a depth-aware replacement policy so an aborted attempt accumulates instead
of being re-derived. Beyond that the honest answer is that raising ponder depth means
raising search depth generally — null-move pruning, late-move reductions — which would pay
off in the real 800ms search too, not only while pondering.

This is not an Elo measurement — per §7's own priority note, milestone 5 is judged on
stop-latency, not strength, and the regression guard for it is
`src/evochess/__tests__/ponderTuning.test.ts`, which chains slices past the depth plateau at
the tuned `SLICE_MS` and asserts the per-slice wall-clock bound holds against a deep, fully
warm TT — not just a cold first slice (already covered by milestone 1's test).

---

## 8. Explicitly out of scope

**Classic ponder-hit.** Predict the human's reply from the principal variation, search
*that* position, and answer instantly on a correct guess. Higher payoff per hit, zero on a
miss, and it needs a real PV — which `rootSearch` (`evoSearch.ts:405-418`) does not
currently produce; it returns only the root move. Everything built here (the worker
protocol, slicing, TT continuity) is a prerequisite for it, so this is a natural follow-up,
not a competing design.

> **[Amended — implemented, in the half that does not need a PV.]** The *instant answer* is
> still out of scope and still needs a PV. The TT-warming half does not: predicting the
> reply needs only the root move `rootSearch` already returns, and "search that position"
> means nothing more than pointing the next slice at it, because the payoff arrives through
> the shared table like every other part of this feature. `ponderSlice` now spends
> `PONDER_PREDICT_MS` (3.5s of the 7s budget) on the position the human is looking at, then
> plays the move that search likes best there and spends the rest on the position it leads
> to. The budget is split rather than handed over wholesale because the two halves warm
> different things and only one of them can be wrong: phase 1 deepens every reply at once,
> so it pays off however the human moves, while phase 2 concentrates on one line and pays
> only on a hit.
>
> **Measured** (`bench/bench9_ponder_hit.ts`, 4 corpus positions × PST/NNUE, reporting the
> depth a real 800ms search reaches after each chain):
>
> - **On a hit: +1 ply in 3 of 8 cases, −1 in 1, unchanged in 4.** Modest, and in the same
>   range as everything else here — a chain's product is one warm table, and depth 8 in 800ms
>   is close to what this search can do at any warmth (see §9's amendment).
> - **On a miss: identical in 8 of 8 cases.** This is the number that made the split safe to
>   ship. Phase 2 costs a miss nothing, because the 3.5s it takes from phase 1 is 3.5s phase 1
>   was measured not to be using — the breadth chain has already plateaued by then.
>
> Not tuned against a hit rate: the opponent is a human, so the rate that decides the real
> value of this cannot be measured from self-play, and a hit-rate figure derived from the
> engine predicting itself would be a number about the engine, not about the feature. The
> split is the conservative choice given that, and `PONDER_PREDICT_MS` is where to turn if
> that assumption ever gets evidence. Guard:
> `src/evochess/__tests__/aiWorkerPonder.test.ts`, which asserts the handover happens and
> lands on a legal successor of the pondered position.
>
> **[Further amended — the hit rate is now observable.]** The paragraph above is right that
> the rate cannot be measured *from self-play*, but it can be measured from real play, which
> is where it matters. On the first real search after a chain committed, the worker compares
> that search's root against the position phase 2 pondered and posts a `ponder-prediction`
> verdict; `App.tsx` logs it as `predicted? True/False`. Compared by resulting position, not
> by move — what phase 2 warmed is a subtree, so two routes into it are a hit. The verdict is
> posted before the search runs (so a slow search cannot swallow it) and exactly once per
> prediction; `reset` drops an unsettled one, since the position it was made from is gone.
> This is instrumentation only — nothing reads it back — but it is the evidence
> `PONDER_PREDICT_MS` was explicitly left waiting for. Guard: the same test file, which drives
> a chain past handover and then plays both into and away from the predicted line.

**NNUE-specific precomputation.** Worth stating because it is the intuitive guess: there is
no meaningful win in precomputing accumulator state. The accumulator is refreshed once per
search entry (`beginNnueSearch`, `evoSearch.ts:422-429`) and that refresh is negligible
against an 800 ms budget. Network *outputs* are effectively already cached — as TT scores.
The entire benefit of this feature flows through the TT.

**Multi-worker / parallel search.** Separate concern, needs cross-origin isolation, much
larger change.

---

## 9. Implementation milestones

| # | Status | Deliverable | Verification |
|---|---|---|---|
| 1 | done | In-search abort (§4.2): `PONDER_DEADLINE` + `ABORT` in `negamaxTT`/`quiesce` **and `rootSearch` and both iterative-deepening loops** [amended], guarded TT store | Unit test: a search with a 50 ms armed deadline from a position that takes seconds returns within ~60 ms; a search with the deadline unarmed is **bit-identical** to today's (same move, same score, same node count); **[amended]** an aborted search returns a finite score and a completed depth — the regression guard for the placeholder leak |
| 2 | done | `keepTT` threaded through `searchEvoTT`, `searchEvoTTTimed`, `searchRoot`, `searchRootTimed`, `searchLevel` | Existing suite unchanged and green; new unit test asserting a second search with `keepTT: true` visits strictly fewer nodes than with `false`, from the same position |
| 3 | done | Worker tagged protocol + slicing loop + NNUE gate + **evaluator provenance** [amended], no UI wiring | Unit test: post `ponder`, let it run to a deep slice, then post `search` and assert the response arrives within one slice budget — this is the priority-#1 regression guard. **[amended]** Plus: retention is refused across an evaluator change and at Easy/Zen (§5.5, §6.1) |
| 4 | done | `App.tsx` wiring, `stop` on the human's move, `reset` on every discontinuity, `ponderEnabled` setting + persistence | Manual play; e2e test that takeback during a deep ponder yields a legal move promptly and no console errors |
| 5 | done | Tune `SLICE_MS` (60→40ms), `PONDER_BUDGET_MS` (10s→7s); `MAX_PONDER_DEPTH` left at 12, confirmed non-binding | Measured stop-latency, not Elo — see below |
| 6 | todo | *(optional, deferred)* Match harness under `training/`, asymmetric by design | Elo with error bars at 2 s / 5 s / 10 s simulated think-time |

**[amended] A note on writing the milestone-1 and -3 tests.** Both regressions here were
ones a plausible-looking test still passed on. The abort test passes with the root guard
removed (the loop guard hides it) and the retention test passes whenever the environment
happens to have one evaluator available. Confirm each new test *fails* against the
un-fixed code before trusting it — the same lesson the NNUE wiring tests taught earlier
in this project.

**Ordering note.** The abort is milestone 1, ahead of the TT work, deliberately: it is what
makes the feature safe to have running at all, and it is independently testable with no
other part of the design in place. An earlier draft ordered `keepTT` first on the grounds
that it is the piece that makes the feature *do* anything — true, but a ponder that cannot
be stopped is worse than no ponder, so responsiveness lands first and strength second.

If the node-count test in milestone 2 does not show a clear drop, stop and diagnose before
building anything on top of it.

Milestone 6 is marked optional because measuring the strength gain precisely is not what
this change is being judged on; milestones 1 and 3 are. The secondary metrics in §7 (mean
depth of the real search, TT hit rate in its first iteration) are cheap and sufficient to
confirm the mechanism works.

---

## 10. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Mixed PST/NNUE scores in the TT | High — silently weakens play, invisibly | **[amended]** Record which evaluator filled the table and refuse retention across a mismatch (`ttEvalWasNnue`, §5.2/§6.1) — this is the load-bearing mitigation. Routing the ponder through `searchLevel` (§5.2) and gating on `nnueSettled` both still apply but are *not* sufficient: neither covers the search path, which is where the reachable bug was. (This row previously said "invalidate the TT when the weights fetch resolves", contradicting §6.1's own "gate, don't invalidate" — both are superseded.) Do not rely on remembering to pass `useNnue` at the `evoSearch` layer, where it defaults to `false` |
| Battery / fan noise on laptops and phones | Medium — a UX regression, not a bug | **[amended]** `PONDER_BUDGET_MS` wall-clock cap — the `MAX_PONDER_DEPTH` cap named here originally does not bind in practice (§5.2); user-visible setting, which must stop a *running* chain and not merely suppress the next one; consider auto-disabling on `navigator.getBattery()` saver state |
| Stop-latency makes the AI feel sluggish after a human move | **High if unmitigated** — this is the failure mode the design is most exposed to, and it scales with how long the human thought (§4.2) | In-search abort deadline (§4.2, milestone 1) — *not* `SLICE_MS` alone, which bounds nothing; `stop` sent synchronously on the human's move (§5.3); `MAX_PONDER_DEPTH` cap. Measure the gap between move and `aiThinking` in practice |
| Abort leaves corrupt TT entries or an unbalanced accumulator | Medium | Abort `break`s the move loop rather than throwing, so `undoEvoTurn` runs on every applied turn; the TT store is guarded by `if (!ABORT)` so partially-searched nodes are never cached. Milestone 1's bit-identity test covers the unarmed path; add an assertion that a position is unchanged after an aborted search |
| Abort mechanism itself is buggy and wedges the worker | Low | Last-resort escape hatch available and cheap: `worker.terminate()` plus recreate on the main thread is unconditional. Costs the TT and a weights re-fetch, nothing else. Not wired by default — noted so it exists if needed |
| TT thrash: pondering evicts entries the real search wanted | Low | Same table, same position, mostly overlapping subtrees — but watch the §7 mean-depth metric, which would catch it |
| Gain is smaller than the complexity cost | Medium | The §7 secondary metrics are the cheap check that the mechanism works at all; be willing to delete the feature if mean depth does not move |
