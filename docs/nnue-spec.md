# Tier 1: a learned evaluation (NNUE-style) for EvoChess

## Context

The engine's evaluation is material plus piece-square tables (`ai.ts`,
`evaluate()`). That form structurally cannot express EvoChess's central skill,
which is *timing*: when to bank a minor right versus spend it, when to burn a
rook's charges, how to farm the minor-move counter. `rookValue()`'s linear
charge decay is a good hack, but no hand-crafted term can say "this right is
worth more in three moves than it is now".

A learned evaluation can. This spec covers Tier 1 only: replace `evaluate()`
with a small net, keep the existing alpha-beta search. MCTS is a separate,
larger step.

The search work is already done and is the baseline this must beat: the current
engine scores **+18 -0 =2 (95%)** against the previous one at equal depth. It is
also the label generator here, which is why it came first.

## Decisions

| Question | Decision |
|---|---|
| Training pipeline | Python + PyTorch in `training/` in this repo |
| Compute | Rented cloud GPU / Colab — needs checkpoint/resume and one-shot data staging |
| Browser latency | Up to ~1s per AI move (today: ~250ms at depth 3) |
| Training target | Blend of engine search score and game outcome |

## Non-goals

- MCTS, policy heads.
- Beating the engine at fixed *node* counts. The goal is strength per second.
- Incremental accumulator updates (see "Net" — the latency budget buys us out of
  this complexity).

## The bottleneck is data generation, not training

This is the single most important number in this spec, and it falls out of a
measurement, not a guess. The engine takes **~250ms per move at depth 3**
(measured: 217ms from the start position, 255ms midgame). Self-play produces one
labelled position per move played, so:

- **~4 labelled positions/sec/core.**
- A 60-ply game ≈ 15s. 1M positions ≈ 16.7k games ≈ **70 core-hours**.
- On 8 cores: **~9 hours wall-clock for 1M positions.** 10M would be ~3.6 days.

Training a net this size is hours on a rented GPU. Generating its data is days
on CPU. Plan accordingly:

- **Target 1-3M positions for the first net**, not 10M. EvoChess is a small game
  (branching factor ≈ 28, measured over 200 random playouts) and the net is
  small; 1M is enough to prove the approach.
- Generate on CPU (many cores), train on the rented GPU. Never rent a GPU to run
  the TypeScript data generator — it is CPU-bound and single-threaded.
- **`copy()` is the hot path and it is wasteful**: it calls `new Chess(fen())`,
  a full FEN parse, at every node. Replacing it with make/unmake would speed up
  both data generation *and* the shipped engine, probably several-fold. If data
  generation feels too slow, fix that first — it is the highest-leverage work
  available and it benefits the product even if the net never ships.

## Features

Encoded **from the side-to-move's point of view** (mirror ranks, swap colours)
so the net learns one function rather than two. Output is the score from the
side-to-move's perspective.

**Piece-square (sparse, ~32 active of ~1536):**

64 squares × 12 piece classes × 2 colours. The 12 classes are EvoChess-specific
and are where most of the design lives:

| Class | Why it is its own class |
|---|---|
| `p`, `q`, `k` | as in chess |
| `n`, `b` | a minor that may still become a rook |
| `n_locked`, `b_locked` | downgraded from a rook, permanently barred from returning (`rookLocked`) — strictly worse than a normal minor and the net must be able to see that |
| `r1`…`r5` | a rook bucketed by remaining charges (`rookCharges`) — a 1-charge rook is nearly a minor, a 5-charge rook is a real rook |

**Evolution state (dense, ~24 features):** this is the part a material
evaluation cannot express, and the whole reason for the exercise.

- `minorRights` and `rookRights` for both sides, clipped at 4+ (rights accumulate
  without bound; clipping keeps the input finite).
- `pawnMoveProgress` and `minorMoveProgress` for both sides, one-hot over 0..2
  (`N_MINOR` and `M_ROOK` are both 3).
- Whether an evolved en-passant capture is pending (`epEvolved`).

The authoritative list of what constitutes an EvoChess position is already
written down: it is exactly what `stateKey()` in `ai.ts` hashes for the
transposition table. **The feature set must cover the same state.** If the two
disagree, the net is being asked to evaluate a position it cannot see.

## Net

Sparse-input MLP. No incremental accumulator — the ~1s latency budget buys us
out of NNUE's most complex machinery:

```
input (sparse, ~32 active + ~24 dense)
  -> L1: ~1560 x 256, accumulate only active columns   (~8k adds)
  -> clipped ReLU
  -> 256 x 32                                          (~8k MACs)
  -> ReLU
  -> 32 x 1
```

~16k ops per evaluation ≈ 5-15µs in JS with typed arrays — fast enough without
incremental updates, because the first layer only touches the ~32 columns for
pieces actually on the board. That sparse-column trick, not quantization, is
what makes this viable.

Ship **float32 first** (~1.6MB of weights). Quantize to int8 later (~400KB) —
the driver for quantization here is *bundle size on GitHub Pages*, not speed.
Do not do it until the float net is proven.

## Target

Standard NNUE practice, and the reason for the blend: the engine's search score
is a dense, low-variance signal that converges fast, while the game outcome
stops the net inheriting the engine's blind spots.

```
target = λ · sigmoid(search_score / K) + (1 - λ) · wdl_outcome
loss   = MSE(sigmoid(net_output / K), target)
```

- `λ ≈ 0.7` to start.
- `wdl_outcome` ∈ {0, 0.5, 1} from the side-to-move's perspective.
- **`K` must be fitted, not assumed.** Our scores are in *pawn units* (pawn =
  1.0), not the centipawns every NNUE reference uses, so the familiar `K=400` is
  meaningless here. Fit `K` by regressing observed outcome against search score
  over the generated data before training anything.
- The net outputs a pawn-unit score, so it drops straight into `evaluate()` and
  the existing mate scores (±100000) still dominate correctly.

## Data generation

`training/gen.ts` (run under `tsx`/`vite-node`), reusing the real engine so the
labels come from the same code that will consume them.

**Per position, record:** FEN, the full evolution state (rights, both progress
counters, `rookCharges`, `rookLocked`, `epEvolved`), the root search score, and
— backfilled at game end — the outcome.

Store the *position*, not the extracted features, so the feature set can be
revised without regenerating the dataset. ~100 bytes/position → 1M ≈ 100MB,
gzips to roughly 20MB. Stage it to the cloud box as one file.

**Diversity is a real problem here.** The engine is deterministic given a seed,
and its jitter only breaks ties between *equal* moves, so naive self-play would
produce near-identical games. Force exploration:

- Random opening: first 4-8 plies uniformly random.
- ~10% random moves thereafter.
- Deduplicate by `stateKey()`.

**Termination — do not skip this.** Under weak/random play, games do not end:
measured, random playouts ran past **195 plies** without terminating. A move cap
plus material adjudication is mandatory, or the dataset fills with timeout draws
and the outcome signal never bootstraps. Engine-vs-engine games are far shorter
(33-120 plies observed in the 20-game match), but the generator plays weaker,
randomised moves and will drift long.

**Draw labels are partly unsound and must be treated as such.** `chess.js`
judges repetition on the chess position alone, but two identical boards with
different `minorRights`/`pawnMoveProgress` are *not* the same EvoChess position.
So `isThreefoldRepetition()` can declare a draw that isn't one. Either exclude
repetition-terminated games from the outcome signal, or fix repetition detection
to key on `stateKey()` first. Do not quietly train on the bad labels.

## Integration

- `src/evochess/nnue.ts` — loads weights, exposes `evaluateNNUE(game): number`.
  The net is side-to-move-relative; `evaluate()` is White-positive, so negate for
  Black at the boundary.
- `ai.ts` — `evaluate()` calls the net when weights are loaded, else falls back
  to today's material + PST.
- `material()` stays exactly as-is: the rook-charge decay tests depend on it, and
  it remains the sanity anchor when the net misbehaves.

## Milestones

1. **Generator + format.** 100k positions. Verify termination, diversity, and
   the score/outcome distributions before scaling up.
2. **Feature extractor, twice** — in TS and in Python.
3. **Parity test (the critical one).** Golden vectors: identical positions must
   produce byte-identical feature vectors in TS and Python. Feature-extraction
   skew between trainer and inference is the number-one cause of silently
   worthless NNUE nets, and it fails *quietly* — the net trains fine and plays
   badly. Do not skip or defer this.
4. **Fit `K`**, then train. Confirm loss decreases and the net beats `material()`
   as a static evaluator on held-out positions.
5. **TS inference + parity test** against Python outputs within epsilon.
6. **Strength match.** The real gate — see below.
7. **Quantize to int8** for bundle size, re-run the match to confirm no
   regression.

## Verification

The only measurement that counts is a head-to-head match against the current
engine at **equal time**, not equal depth — the net costs time per node and must
earn it back with better play. Reuse the harness from the search work (preserved
in the session scratchpad; ~50 lines): N games, alternating colours, move cap,
material adjudication, reporting +W -L =D and an Elo estimate.

Ship only if it clearly wins. Note that a 20-game sample gives wide error bars —
treat a result under roughly +100 Elo as unproven rather than positive, and run
more games before believing it.

## Risks

- **Data generation is days of CPU, not hours.** The headline risk. See above.
- **Feature parity between TS and Python.** Fails silently. Milestone 3 exists
  solely for this.
- **The baseline is now decent.** The engine got a large jump from search work
  and from a draw-scoring fix. A small net trained on modest data may simply lose
  to it. That is an acceptable outcome of the experiment, but it should be
  expected rather than a surprise.
- **`copy()` cost may mask the win.** The FEN-parse-per-node dominates the node
  cost today, so a faster evaluation may not translate into more depth until
  make/unmake lands.
