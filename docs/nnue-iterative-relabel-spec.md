# NNUE Iterative Relabeling Spec

Make the net stronger by improving the **labels** on positions we already have,
not by generating more positions. Each round, re-score the dataset with a search
that uses the *current* net as its leaf evaluator, retrain on the sharper labels,
and repeat. The teacher bootstraps itself: a better eval produces better search
scores, which train a better net, which is a better eval for the next round.

This is the standard path by which NNUE nets pass their bootstrap eval (Stockfish
went from hand-tuned HCE labels to net-labels this way). It is the highest-upside
lever we have *if* the net is teacher-limited rather than data-limited — verify
that first (see "Preconditions").

## The problem it solves

Every training target (`training/nnue/target.py`) is a blend:

    target = λ · sigmoid(search_score / K) + (1 − λ) · outcome     (λ = 0.7)

The `outcome` term is ground truth (who won the self-play game). The
`search_score` term is what carries *positional* judgment — and it is only as
good as the evaluator at the leaves of the search that produced it. Our current
scores come from depth-3 search with a **material+PST** leaf eval. So the net is
being distilled from a weak teacher: it can match depth-3-PST judgment but cannot
exceed it. Adding more positions labeled this way just yields a more confident
imitation of the same weak teacher — which is consistent with the observed
data-scale plateau (see `nnue-pipeline-status` memory).

Relabeling attacks the label directly: same positions, progressively truer
scores.

## The loop

```
net_0  ← train on scores from search(leaf = material+PST)   # where we are today
loop r = 1, 2, 3, ...:
    scores_r ← for each position: search(leaf = net_{r-1}) → white-positive score
    refit K on (scores_r, outcome)
    net_r  ← train on target(scores_r, outcome, λ)
    gate:  ladder_check(net_r)  must still PASS  (else stop, keep net_{r-1})
    match: net_r vs net_{r-1} (or vs material+PST) under fixed post-eca2015 code
    stop when the match delta is within noise for a round (convergence)
```

Only the **score** field is recomputed each round. The **outcome** field is never
touched — it is the ground-truth anchor that keeps the loop from drifting into a
self-reinforcing fantasy (see "Divergence").

## What gets relabeled, and what does not

The on-disk record (`training/nnue/position.py`) stores the *position* plus
`score`, `outcome`, `termination`, and evolution state. Relabeling rewrites
exactly one field:

| Field | Relabel action | Why |
|---|---|---|
| position (fen + rights + progress + charges) | unchanged | same positions, by design |
| `score` (White-positive) | **recomputed** each round via search-with-net | this is the teacher signal |
| `outcome` (White-positive WDL) | **unchanged** | ground-truth anchor; recomputing it would require replaying games under the net, which is a different, costlier project (see "Non-goals") |
| `termination` | unchanged | governs outcome soundness only |

Because only `score` changes, the existing dataset/loader/target machinery is
reused verbatim after relabeling — `build_target` recomputes the blend, `fit_k`
recovers the new scale.

## Score frame — get this exactly right

`searchRoot(game, depth, seed)` in `src/evochess/ai.ts` returns a score in the
**side-to-move** frame. The record stores **White-positive**. The generator
already does this flip (`gen.ts`):

```ts
const { score } = searchRoot(game, cfg.depth, seed);
const whiteScore = game.turn === "w" ? score : -score;
record.score = whiteScore;
```

The relabel tool must apply the identical flip. Storing a side-to-move score into
a White-positive field silently corrupts every target for black-to-move positions
— and it will pass the ladder (whose rungs are curated) while poisoning training.
This is the single most dangerous bug in the whole procedure; assert it with a
parity fixture (a known position whose White-positive score is pinned).

## Using the net as the leaf eval

No new eval path is required — it already exists. When NNUE weights are loaded,
`evaluate()` in `ai.ts` uses the net, so any `searchRoot` call transparently
searches with the net at the leaves. The relabel worker just:

1. loads the round `r−1` weights (`nnue.setNnueWeights(loadWeights(...))`),
2. reconstructs each position from its record,
3. runs `searchRoot(game, depth, seed)`, flips to White-positive, rewrites `score`.

Reuse `training/searchWorkerPool.ts` / `searchWorker.ts` for a hard per-position
timeout — evolved midgames with pawns near promotion can send quiescence into
long searches (documented in `nnue-data-coverage-spec.md`). A timed-out position
keeps its **previous** score rather than being dropped (dropping would shrink the
set each round and bias toward quiet positions).

## Depth and determinism

- **Fixed depth, not fixed time.** Labels must be reproducible and comparable
  across rounds; wall-clock budgets are not. Use `searchRoot` (depth), never
  `searchRootTimed`.
- **Relabel at least as deep as generation (depth ≥ 3); prefer depth 4–5.** The
  teacher improvement per round is (net vs PST leaf gap) × (extra plies). A
  net leaf at depth 4 is meaningfully stronger than a PST leaf at depth 3 — this
  is where the round-over-round gain comes from. Depth 4–5 with a net leaf is the
  sweet spot; deeper costs more per position without the outcome anchor moving.
- **Seed policy:** derive the per-position seed deterministically from the record
  (e.g. a hash of the fen) so a relabel run is reproducible and re-runnable.

## Refit K every round

`fit_k` regresses `outcome` on `sigmoid(score / K)`. The score *distribution*
shifts when the leaf eval changes (a stronger eval spreads scores differently),
so K from round `r−1` is stale for round `r`. Refit it each round before training,
exactly as the first-time pipeline does. Watch the fitted K across rounds: it
should move gently. A large jump signals the score scale changed a lot — worth a
look, not necessarily wrong.

## Divergence — the real risk, and the guardrails

Putting the net inside its own training loop means a systematic error can
compound: the net over-values a bad pattern → its search scores that pattern high
→ the next net learns to love it more. Three defenses, in order of importance:

1. **The outcome anchor (λ < 1).** Because `(1 − λ)·outcome` pulls every target
   toward ground-truth game results, a purely imaginary evaluation can't run away
   — reality keeps voting. **Do not set λ = 1 (score-only) for relabeling**, even
   though it's tempting once you "trust" the net; that removes the only anchor.
   λ = 0.7 (default) or lower is appropriate; consider *lowering* λ in later
   rounds to lean harder on outcomes as scores get self-referential.
2. **The ladder gate.** Run `training/ladder.ts` after every round. It checks
   monotonicity (pawn < minor < rook < queen), queen magnitude, and the
   black-queen sign. If any check regresses versus the previous round, **stop and
   keep the previous net** — that's divergence showing up. The ladder is untimed,
   so it's unaffected by the search-timing caveats elsewhere in this project.
3. **Round-over-round match, not just-vs-baseline.** Match `net_r` against
   `net_{r-1}` (as well as against material+PST) under current post-`eca2015`
   code. Convergence = the improvement per round shrinks into the noise band
   (±35 Elo at 100 games); that's the natural stopping point. A *negative* round
   delta with a still-passing ladder means you've overshot — revert to `r−1`.

## Preconditions — do the cheap check first

Relabeling pays off in proportion to how much better the net is than the current
leaf eval. Today that gap is small: the best net is ~+17±35 Elo over material+PST
and searches to nearly the same depth (2.67 vs 2.83). So round 1's teacher upgrade
may be modest; the gains compound but off a small base.

Before committing to the loop, run the **data-scale subset check** (train on
130k/260k/520k of existing data, match all under fixed code). It disambiguates:

- curve still climbing → **data-limited** → generate more data first;
- curve flat → **teacher-limited** → relabeling is the right lever.

## Procedure (per round)

Every JS-side tool (`relabel.ts`, `ladder.ts`, `match.ts`) loads weights with
`loadWeights(JSON.parse(...))`, so `--weights` always takes the **exported JSON**,
never the `.pt` checkpoint. `.pt` appears exactly once below, as `train.py`'s
output. Export after every round.

```bash
# 0. Export round r-1's checkpoint to the JSON the JS side loads.
python -m training.nnue.export \
  --checkpoint training/checkpoints/net-relabel-r0.pt \
  --out training/checkpoints/net-relabel-r0-weights.json

# 1. Relabel existing shards with round r-1 weights as the leaf eval.
#    relabel_batch.sh fans out across cores; a bare `node relabel.bundle.mjs`
#    needs --shard-index too, and processes only that one shard.
training/relabel_batch.sh training/data training/data-relabel-r1 4 8 \
  training/checkpoints/net-relabel-r0-weights.json

# 2. Refit K + retrain on the relabeled set (unchanged pipeline).
python -m training.nnue.train \
  --data training/data-relabel-r1 --epochs 20 \
  --out training/checkpoints/net-relabel-r1.pt

# 3. Export the new round's weights for the JS-side gate and match.
python -m training.nnue.export \
  --checkpoint training/checkpoints/net-relabel-r1.pt \
  --out training/checkpoints/net-relabel-r1-weights.json

# 4. Gate: ladder must still pass.
node training/ladder.bundle.mjs --weights training/checkpoints/net-relabel-r1-weights.json

# 5. Compare: r vs r-1, and r vs material+PST, under current code.
node training/match.bundle.mjs \
  --weights training/checkpoints/net-relabel-r1-weights.json   # vs material+PST
node training/match.bundle.mjs \
  --weights training/checkpoints/net-relabel-r1-weights.json \
  --opponent-weights training/checkpoints/net-relabel-r0-weights.json   # vs r-1

# Promote net-relabel-r1 only if ladder passes AND the match improves; else stop.
```

Keep every round's checkpoint (`net-relabel-r{0,1,2,...}.*`) so a regression can
roll back one round, matching the existing checkpoint-archive discipline.

## Cost

One round = one search per position (≈ the per-position cost of generation, minus
game bookkeeping) + one train + one ladder + one match. At the documented
~0.5 pos/sec/shard × 8 shards, relabeling 520k positions is on the order of a
generation batch (several hours) — but it replaces *all* labels at once, versus
generation which only adds ~100k/7h. It is the cheaper way to raise label quality
across the whole set.

## Non-goals

- **Regenerating outcomes.** Replaying self-play games with the net as the mover
  (so `outcome` reflects net-vs-net play, not the original random/PST games) is a
  strictly larger project — new games, not relabeled positions — and removes the
  independent ground-truth anchor. Out of scope here; revisit only after
  score-relabeling converges.
- **Architecture or feature changes.** This spec holds the model
  (`training/nnue/model.py`) and feature set (`nnueFeatures.ts`) fixed. Mixing an
  architecture change into a relabel round makes the result uninterpretable.
- **Timed-search labels.** Covered above: fixed depth only.

## Success criterion

A monotone (or at least non-regressing) sequence of round-over-round match
improvements under current code, with the ladder passing every round, converging
when the per-round delta falls inside the ±35 Elo noise band. If round 1 shows no
improvement with a passing ladder, the net is not yet a better teacher than PST at
the relabel depth — fall back to the data lever and revisit later.
