# NNUE Depth-5 PST Relabeling Spec

Improve the labels on positions we already have by re-scoring them with a
**deeper search using the existing material+PST leaf eval** — depth 5 instead of
the depth 3 the data was generated at. Same eval, more plies: the search sees more
tactics, so the `score` label is sharper. One-shot, no iteration, no
self-reference.

This is the **safe, non-bootstrapping** counterpart to
`nnue-iterative-relabel-spec.md`. That spec swaps the leaf eval for the current
net (higher ceiling, but a self-referential loop with divergence risk); this one
keeps the leaf eval fixed and only deepens the search (lower ceiling, but zero
divergence risk and nothing to tune). It is the natural **first** relabel to try —
and a good round-0 teacher for the iterative loop afterward.

## Why deeper PST beats shallow PST as a teacher

Our targets (`training/nnue/target.py`) blend a search score with the game
outcome:

    target = λ · sigmoid(search_score / K) + (1 − λ) · outcome     (λ = 0.7)

The `search_score` carries positional judgment, and its quality is a function of
*both* the leaf eval *and* the search depth. Generation used depth 3 with a
material+PST leaf. Re-running the same PST search at depth 5 doesn't change what
the evaluator "believes" about a static position, but it lets tactics resolve two
plies further before the eval is applied — hanging pieces, forced recaptures, and
short combinations that depth 3 mis-scores get corrected. The label moves closer
to the true value of the position without any change to the eval or the model.

Unlike the net-as-leaf approach, there is **no teacher-improvement ceiling tied to
the net's current strength** and **no feedback loop** — deeper PST is
unconditionally a better teacher than shallow PST, so this pays off even while the
net is only at parity with material+PST.

## One-shot, not a loop

Because the leaf eval is fixed (material+PST, never the net), there is nothing to
bootstrap: re-running depth 5 a second time gives the identical labels. So this is
a single relabel pass, not the iterate-to-convergence loop of the other spec:

```
scores' ← for each position: searchRoot(game, depth=5) → white-positive score
refit K on (scores', outcome)
net'    ← train on target(scores', outcome, λ)
gate:   ladder_check(net')  must PASS
match:  net' vs material+PST, and net' vs the current depth-3-trained net,
        under current post-eca2015 code
```

Done. No round management, no per-round checkpoints, no divergence watch.

## What gets relabeled

Identical to the iterative spec — only the `score` field is rewritten:

| Field | Action | Why |
|---|---|---|
| position (fen + rights + progress + charges) | unchanged | same positions |
| `score` (White-positive) | **recomputed** at depth 5, PST leaf | the sharper teacher signal |
| `outcome` (White-positive WDL) | **unchanged** | ground-truth anchor |
| `termination` | unchanged | outcome soundness only |

The existing dataset/loader/target pipeline is reused verbatim after the pass;
`build_target` recomputes the blend and `fit_k` recovers the new scale.

## Score frame — same trap as the net relabel

`searchRoot(game, depth, seed)` returns a **side-to-move** score; the record
stores **White-positive**. Apply the exact flip `gen.ts` uses:

```ts
const { score } = searchRoot(game, 5, seed);
const whiteScore = game.turn === "w" ? score : -score;
record.score = whiteScore;
```

Storing a side-to-move score into a White-positive field silently corrupts every
black-to-move target and still passes the ladder. Pin it with a parity fixture (a
known position whose White-positive depth-5 score is fixed).

## No net loading

The distinguishing simplification from the iterative spec: **do not load any NNUE
weights.** With no weights set, `evaluate()` in `ai.ts` uses material+PST, which
is exactly the leaf eval we want. The relabel worker just reconstructs each
position and calls `searchRoot(game, 5, seed)`. This also means the relabel run is
independent of whatever net happens to be current — reproducible from the data
alone.

## Cost — the real tradeoff

Depth 5 is materially more expensive per position than depth 3. Evochess midgames
have wide branching once rooks/queens evolve, and the documented generation
throughput is already only ~0.5 pos/sec/shard at depth 3 on the 8-core box. Depth
5 will be several times slower per position — plan for a multi-hour pass over 520k
positions, comparable to or longer than a fresh generation batch, and use the
worker pool.

Mitigations, in order of preference:

- **Worker-pool timeout, keep-old-score on timeout.** Reuse
  `training/searchWorkerPool.ts` with a hard per-position budget. A position that
  blows past the budget keeps its **existing depth-3 score** rather than being
  dropped (dropping shrinks the set and biases toward quiet positions). Expect a
  higher timeout rate than the depth-3 augmentation's ~25-30% under 8-way
  contention — that's acceptable; those positions simply retain the older label.
- **Depth 4 as a cheaper middle option.** If depth 5 proves too slow to be
  practical, depth 4 still strictly improves on depth 3 at roughly a third of the
  cost. Treat the depth as a knob; the spec's logic holds for any depth > 3.
- **Relabel a subset.** Deepening even a fraction of the set (e.g. the
  rook/queen-rich positions where depth-3 tactics matter most) and leaving the
  rest at depth 3 is a valid partial win.

## Determinism

Derive each position's search seed from the record (e.g. a hash of the fen) so the
pass is reproducible and re-runnable, matching the iterative spec's seed policy.

## Refit K

The depth-5 score distribution differs from depth 3 (deeper search sharpens and
re-scales scores), so K must be refitted before training — the same `fit_k` step
the first-time pipeline runs. No special handling beyond that.

## Gate and evaluation

- **Ladder as a sanity gate**, not a divergence detector. There is no feedback
  loop here, so the ladder can't "diverge"; but it still catches a broken relabel
  (e.g. a score-frame bug) — run `training/ladder.ts` on `net'` and require the
  four checks to pass, same as any trained net.
- **Match under current code.** Play `net'` vs material+PST, and `net'` vs the
  current depth-3-trained net, under post-`eca2015` `ai.ts` (the timed-search fix)
  at 100 games / ±35 Elo noise. The question this answers: does a
  depth-5-PST-labeled net beat a depth-3-PST-labeled one? If yes, promote it.

## λ note

The outcome-anchor reasoning from the iterative spec is **weaker** here because
there's no self-reference to run away from — a depth-5 PST score is not a fantasy
the net fed itself. So λ = 0.7 (default) is fine, and there's no
special argument against a higher λ (leaning more on the now-sharper score). Still,
keep λ < 1: game outcomes remain useful ground truth for positions where even
depth-5 PST mis-judges long-term structure.

## Relationship to the iterative net relabel

These compose. The clean sequence is:

1. **Depth-5 PST relabel (this spec)** → a net trained on stronger, safe labels.
   Low risk, establishes whether deeper labels help at all.
2. **Iterative net relabel (`nnue-iterative-relabel-spec.md`)** using that net as
   the round-0 teacher. A depth-5-PST-trained net is a stronger starting teacher
   than the depth-3 one, so the bootstrap loop starts from a better base and its
   first round is more likely to show a real gain.

Doing PST-depth-5 first also cheaply de-risks the whole relabel program: if even
unconditionally-better depth-5 labels don't move the match, the net is data- or
architecture-limited, not teacher-limited, and the iterative loop won't help
either — fall back to the data-scale lever.

## Procedure

```bash
# 1. Relabel existing shards at depth 5 with the PST leaf (no weights loaded).
node training/relabel.bundle.mjs \
  --in  training/data \
  --out training/data-relabel-pst5 \
  --depth 5 --shards 8            # note: NO --weights flag → PST leaf eval

# 2. Refit K + retrain on the relabeled set (unchanged pipeline).
python -m training.nnue.train \
  --data training/data-relabel-pst5 --epochs 20 \
  --out training/checkpoints/net-relabel-pst5.pt

# 3. Gate: ladder must pass.
node training/ladder.bundle.mjs --weights training/checkpoints/net-relabel-pst5.pt

# 4. Match under current code: vs material+PST, and vs the depth-3-trained net.
node training/match.bundle.mjs --weights training/checkpoints/net-relabel-pst5.pt

# Promote net-relabel-pst5 if the ladder passes AND it beats the depth-3 net.
```

The `training/relabel.bundle.mjs` wrapper is shared with the iterative spec: the
**presence of `--weights` selects net-as-leaf, its absence selects PST-as-leaf**,
and `--depth` is the search depth. This spec is the `--depth 5` / no-`--weights`
invocation; the iterative spec is the `--weights <net>` invocation looped.

## Non-goals

- **Regenerating outcomes.** Same as the iterative spec: `outcome` is not
  recomputed; that would mean new games, not relabeled positions.
- **Changing the eval, model, or feature set.** Only the search depth changes.
- **Iteration.** Deterministic given the data; running it twice is a no-op.

## Success criterion

A depth-5-PST-labeled net that beats the depth-3-PST-labeled net under current
code, with the ladder passing. That single positive result both ships an
improvement and green-lights the iterative net relabel on top of it. A null result
(no match improvement, ladder passing) is itself decisive: labels aren't the
binding constraint, so redirect to data scale or architecture rather than the
iterative loop.
