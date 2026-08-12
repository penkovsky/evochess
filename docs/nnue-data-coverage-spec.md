# Fixing NNUE data coverage: seeded starts + material augmentation

Follows `nnue-spec.md`, whose Tier-1 net is built (milestones 1-6 done) but
**lost its strength match** for a specific, measured reason this spec addresses.

## The problem, measured

The first net (40k depth-3 self-play positions) lost the equal-time match
**~1-12-5 (~19%, ~-250 Elo)** against material+PST. It was not a bug. Evaluating
a material ladder with the trained net shows exactly where it fails:

| Position (White to move) | Net (side-to-move) | Truth |
|---|---|---|
| +1 pawn | +2.19 | +1 |
| +1 knight | +3.01 | +3 |
| +1 rook (full charges) | +2.97 | +5 |
| **+1 queen** | **+0.02** | +9 |
| **+2 queens** | **+0.41** | +18 |
| **Black +1 queen** | **+0.46 for White** | wrong sign |

The net is sane on pawns, knights and bishops and **blind on rooks and queens**.
The cause is the data distribution: Evochess starts with only pawns and kings
(`START_FEN`), earns minors slowly (every 3 pawn moves), earns rooks slower
still (every 3 minor moves), and only makes queens via a rare 8th-rank
promotion. In 40k *short, randomised* games, rook positions are scarce and queen
positions almost absent, so the net never learned their value.

The trap is that this **hid in validation**: held-out positions came from the
same queen-poor distribution, so val loss looked excellent (0.009 vs the
baseline's 0.023) while play was terrible. **Train distribution ≠ play
distribution.** In a real game the search wins a rook or promotes, the net sees
nothing, and throws the game.

## Goal and non-goals

Make the training set cover the material the *search* actually reaches, so the
net values rooks and queens correctly. Two complementary mechanisms:

1. **Seeded self-play** — start a fraction of games from positions that already
   contain evolved material, and play them out. Gives coverage *plus* sound
   game outcomes *plus* realistic trajectories.
2. **Material augmentation** — synthesize isolated positions spanning the
   material spectrum and label them with the engine's search score only. Cheap
   (one search each, no full game) and aimed straight at the eval-scaling gap.

Non-goals: changing the net architecture, features, K-fit, or search. This is a
data problem; everything downstream of the dataset is already proven and
parity-tested. Do not touch it.

## Success criteria (test these, do not assume)

- **The material ladder above becomes monotonic and correctly signed**: +1 queen
  clearly beats +1 rook beats +1 minor; a side up a queen evaluates strongly in
  its own favour. This is the direct diagnostic and the fastest signal.
- **The dataset actually contains the material** it was missing: report the
  fraction of positions with ≥1 rook and with ≥1 queen, per side. If those are
  still near zero, the generation change did not work — stop and fix it before
  spending GPU.
- **The equal-time match improves.** The bar remains the spec's: under ~+100 Elo
  is unproven. A first pass that merely stops losing (≈ parity) is real progress
  and worth reporting; do not overclaim from a 40-game sample.

## Mechanism 1: seeded self-play

`gen.ts` today always does `new EvoChessGame()` — every game starts from
`START_FEN`. Add a **position source**: with probability `--seed-frac`, start the
game from a sampled material-rich position instead, then run self-play exactly
as now (search-labelled every ply, outcome backfilled at game end).

`EvoChessGame` can already represent an arbitrary position — `persistence.ts`
loads one by setting `chess.load(fen)` plus `minorRights`, `rookRights`,
`pawnMoveProgress`, `minorMoveProgress`, `rookCharges`, `rookLocked`,
`epEvolved`. A seeded start is the same construction, so no engine change is
needed, only a builder.

**Sampling a legal seed position:**

1. Place both kings on non-adjacent squares.
2. Draw a material multiset for each side from a distribution that *deliberately
   over-samples rooks and queens* relative to natural play (that is the whole
   point). Keep counts realistic — 0-2 rooks, 0-1 queen per side typically, a
   handful of minors and pawns — so the net learns positions near ones it will
   actually see, not 8-queen monstrosities.
3. Place pieces on random empty squares; pawns only on ranks 2-7.
4. Sample evolution state: `rookCharges` per rook (1-5), a few `rookLocked`
   minors, small `minorRights`/`rookRights`, progress counters in range.
5. **Validate by construction and by trial**: both kings present, side-to-move's
   opponent not in check, the position is not already game-over, and it has at
   least one legal `EvoChessGame` move. Reject and resample otherwise.

**Balance.** Sample material imbalance from a controlled distribution (roughly:
often balanced, sometimes ±1 piece, occasionally larger) so labels span the
score range rather than piling up at "one side is crushing". A dataset of only
lopsided positions teaches the sigmoid tails, not the decision boundary.

**Cost.** A seeded game is as expensive as a normal one (~0.5 pos/sec/core at
depth 3, see [[nnue-data-generation]]). Its value is *both* material coverage
and sound outcomes on rook/queen endgames — the outcome signal the score-only
augmentation below cannot provide.

## Mechanism 2: material augmentation

Synthesize isolated positions across the material spectrum and label each with
one search — no game played out. This is the cheap, high-yield attack on the
exact failure: it directly shows the net "here is a queen, it is worth ~9".

- Reuse the mechanism-1 sampler for a legal position, then call `searchRoot` once
  for the White-positive score. Emit a record with the score and **no outcome**.
- **Outcome handling is already correct.** In `position.py`, a record with
  `outcome=None`/`termination=None` has `outcome_is_sound == False`; in
  `target.py`, `build_target` then collapses to effective λ=1 (search-score
  only), and `is_trainable` keeps it because it has a (non-mate) score. So these
  records train on the score signal and never pollute the outcome signal or the
  K-fit — no code change required, but add a test pinning that behaviour.
- Optionally tag them (`termination="synthetic"` or a new `source` field) purely
  for dataset inspection; not required for correctness.

**Coverage targeting.** Explicitly enumerate the gaps and sample to fill them:
positions with a rook advantage, a queen advantage (both signs), two queens, a
queen vs rook trade, etc. The generator should be able to report a histogram of
material imbalance so we can confirm the tails are populated.

## Mixing

One dataset, three sources, tunable fractions. A reasonable first split:

- ~60% natural self-play from `START_FEN` (the true play distribution — keep it
  the majority so the net stays calibrated on positions that actually occur).
- ~25% seeded self-play (coverage + outcomes).
- ~15% material augmentation (score-only, direct piece-value teaching).

These are starting knobs, not doctrine. If the ladder still fails, raise
augmentation; if play on common positions regresses, raise the natural fraction.

## Risks

- **Synthetic positions are off-distribution.** Randomly-placed pieces produce
  positions that never arise in real Evochess, and over-training on them can
  distort eval of the positions the search *does* reach. Mitigations: keep
  natural self-play the majority; bias the sampler toward realistic piece counts
  and pawn structures; treat augmentation as a minority corrective, not the bulk.
- **Legality/rejection cost.** A naive sampler may reject often. Construct
  legal-by-design where possible (kings first, avoid leaving the opponent in
  check) rather than sample-and-check blindly.
- **Outcome soundness.** Seeded self-play outcomes are sound (real games to
  termination). Augmented positions have *no* outcome by design — do not invent
  one; the λ=1 path is the correct handling and must be tested, not assumed.
- **It may still lose.** Coverage is the most likely bottleneck given the
  diagnosis, but a 256-wide net on ~100k positions may still not beat a tuned
  material+PST. That remains an acceptable experiment outcome; the ladder
  diagnostic will at least tell us whether the *evaluation* got fixed even if the
  *match* does not flip.

## Plan

1. **Augmentation first** — it is cheaper and targets the measured failure most
   directly. Add the legal-position sampler and a score-only augmentation path to
   `gen.ts` (or a sibling `augment.ts` sharing the sampler). Generate ~20-40k
   material-diverse positions, mix with the existing 40k, retrain, and **re-run
   the material ladder**. This is a fast yes/no on "does teaching piece values
   fix the eval".
2. **If the ladder improves**, add seeded self-play, regenerate a fresh mixed set
   (~100k+), refit K, retrain.
3. **Re-run the equal-time match.** Report ladder + coverage histogram + match
   score together — the ladder explains the match, and the histogram explains the
   ladder.
4. Only if a net clearly wins does milestone 7 (int8 quantization) become worth
   doing.

## Notes for the implementer

- The sampler is the one genuinely new piece; everything else is wiring. Test it
  hard: every emitted position must load into `EvoChessGame` and have a legal
  move, or `searchRoot` will throw or mislabel.
- Keep the JSONL schema unchanged (`position.py`). Score-only records already
  serialize (score present, outcome/termination omitted).
- Dedup on `stateKey()` as today — synthesized positions can collide with each
  other and with self-play.
- Re-fit K after regenerating; the score distribution will shift once rook/queen
  positions are present, and K is fitted, never assumed.
