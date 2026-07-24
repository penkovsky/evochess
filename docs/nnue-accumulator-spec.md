# Spec: NNUE incremental accumulator on the bitboard substrate

**Status:** all four milestones shipped. A benchmark (throwaway script per §11,
not committed — 12 positions sampled through the middlegame of a seeded random
walk, depth 3, two structurally identical no-TT negamax+quiescence searches
differing only in which eval each node calls) **corrects** the §1 estimate:
isolated incremental-eval cost (one child reached by one move, parent
accumulator already refreshed) landed close to predicted — from-scratch
~0.027–0.029 ms vs accumulator ~0.020–0.021 ms, ~1.35–1.37× faster, a bit under
the ~1.5–2× eval-only ceiling (plausible given `applyAccum`'s own overhead:
several small toggle calls plus a 512-float parent→child copy the idealized
"handful of 256-wide adds" description doesn't fully price in). But the
whole-search win came in at only ~1.05–1.08× (from-scratch 1550–1640 ms vs
accumulator 1440–1590 ms across the 12 positions, both visiting the identical
45,235 nodes — a correctness check as a side effect, confirming the two evals
agree closely enough to preserve pruning decisions), well under the ~1.4–1.7×
whole-search estimate. Why: `quiesce` calls eval on ~54% of all visited nodes
(every quiesce call evaluates its stand-pat, whether or not it then recurses
further) — not a small minority, so Amdahl's law alone doesn't explain the gap.
The real reason is that eval's absolute cost (tens of microseconds) is already
comparable to the rest of a node's cost (move generation, MVV-LVA ordering with
its array map+sort, make/unmake) even before the accumulator speeds it up — so
a ~26% per-eval saving, applied to ~54% of nodes, works out to only a ~7–8%
reduction in total search time. move-gen/ordering/make-unmake cost per node
turns out to already be the same order of magnitude as eval, not a small
fraction Amdahl's law shrinks away.
**Goal:** make the NNUE evaluation cheap enough per node that the bitboard search
(`evoSearch.ts`) can run NNUE self-play / data generation at a useful fraction of
the PST path's ~20×, by maintaining the net's first-layer output incrementally
across make/unmake instead of recomputing it from scratch every node.

This is a design document. It is deliberately explicit about the one feature
of this net that makes the standard NNUE trick non-obvious here (side-to-move
–relative features), because getting that wrong produces a net that evaluates
subtly wrong and fails quietly — the same failure mode the parity tests exist to
catch.

---

## 1. Where the time goes today, and what this reclaims

Per-eval cost of `forwardActive` (`nnue.ts:135`) on the `1569 → 256 → 32 → 1` net:

| part | cost | incremental? |
|---|---|---|
| feature build: `positionFromGame` + `parseFen` + `activeFeatures` + `denseActiveIndices` (rebuilt from the chess.js board / FEN string every eval) | a FEN parse + Map/Set walks + array allocs | **yes** → O(pieces moved) |
| **Layer 1**: accumulate ~40 active weight rows into a 256-wide vector (`nnue.ts:140`) | ~40 × 256 ≈ **10k adds** | **yes** → O(Δfeatures) × 256 |
| **Layer 2**: dense 256 × 32 (`nnue.ts:148`) | ~**8k madds** | **no** — reads all 256 h1 |
| **Layer 3**: 32 × 1 (`nnue.ts:158`) | 32 madds | no |

The incremental accumulator removes the feature build and shrinks Layer 1 from
~10k adds to a handful of 256-wide row add/subtracts. **Layers 2 and 3 do not
move** — they depend on all 256 activated hidden units, so they are recomputed
every eval. That fixed ~8k-madd floor is why the realistic ceiling for this step
is **~1.5–2× faster eval**, and (Amdahl over the search) **~1.4–1.7× on the whole
NNUE search**. Pushing past that floor is a separate lever (SIMD / quantization /
Rust), out of scope here.

We build this so it can be measured against that estimate, not assumed.

---

## 2. The core problem: features are side-to-move–relative

`nnueFeatures.ts` encodes a position **from the side-to-move's point of view**
(`activeFeatures`, `relativeSquare`, the `isUs` bit in `sparseIndex`). Two
consequences, both of which flip **every single ply**:

1. **Square mirroring.** `relativeSquare(sq, stm)` mirrors the rank when Black is
   to move (`rankIndex = 7 - rankIndex`). In LERF this is exactly `sq ^ 56`.
2. **The us/them bit.** `sparseIndex(isUs, …)` puts a piece in the first or second
   half of the sparse block depending on whether its colour equals the side to
   move. The dense block is the same: `minor_rights_us` vs `_them`, etc.

So a naïve single accumulator would have **every active feature index change on
every move** — recomputing it entirely — defeating the point.

### The fix: two perspective accumulators (standard NNUE)

Maintain **two** accumulators, one per colour's perspective, each **independent of
whose turn it is**:

- `accW` — the feature vector as if **White** were to move: a piece is `us` iff it
  is White; squares use White-relative indexing (`sq`, no mirror); dense `us`
  fields read White's counters.
- `accB` — symmetric for Black: `us` iff Black; squares mirrored (`sq ^ 56`);
  dense `us` fields read Black's counters.

Reading rule: at a node whose side to move is `stm`, the net input is
`stm === white ? accW : accB`. This is **bit-for-bit the vector**
`activeFeatures() ++ denseActiveIndices()` produces today — `accW` when White is
to move literally *is* the current STM vector — so **no retraining and no change
to `features.py` / the golden vectors is needed.** We are only changing *how* the
same vector is computed.

Each accumulator changes only when a piece actually moves / a counter actually
changes — never merely because the turn flipped. The turn flip just selects which
accumulator to read.

---

## 3. Data structures

The accumulator holds the **pre-activation** Layer-1 output (biases + summed rows),
*before* the clipped ReLU — that is the linear, incrementally-updatable quantity.
Clipped ReLU, Layer 2, and Layer 3 are applied at read time.

```ts
// One node's accumulator: both perspectives, pre-activation (length hidden1=256).
interface Acc {
  w: Float32Array; // hidden1
  b: Float32Array; // hidden1
}
```

**Do not mutate accumulators in place across make/unmake.** Use an **accumulator
stack** indexed by search ply:

```ts
// Preallocated once; MAX_PLY covers nominal depth + quiescence (MAX_QUIESCE_PLY).
const stack: Acc[] = Array.from({ length: MAX_PLY + 1 }, () => ({
  w: new Float32Array(HIDDEN1), b: new Float32Array(HIDDEN1),
}));
```

- **apply** at ply `p` → `p+1`: copy `stack[p]` into `stack[p+1]` (two 256-float
  `.set()` copies), then add/subtract the moved features' rows into `stack[p+1]`.
- **read** at ply `p`: pick `stack[p].w` or `.b` by side to move.
- **undo**: nothing — just search at ply `p` again; `stack[p]` was never touched.

This sidesteps two problems at once: (a) no undo bookkeeping for the accumulator,
and (b) no float **drift** — `stack[p]` is only ever *written by its parent's
apply*, never restored by subtracting, so `x + d` is never later "undone" to a
non-`x` value. Each node's accumulator is `parent + Δ` (adds only from the copy),
which is stable and deterministic for a given path. (It still differs from a
from-scratch full sum by float summation order — see §10 — which is inherent to
any incremental scheme and acceptable.)

Copy cost: 512 float writes/node. Cheaper than the FEN parse + 10k-add rebuild it
replaces, but **must be benchmarked** (§11) — if the copy dominates, a finny-style
"dirty" scheme is the fallback (§12).

---

## 4. Bitboard-native feature indexing (Phase 0)

`activeFeatures` / `denseActiveIndices` operate on a parsed FEN and string squares.
The accumulator must derive the same indices from an `EvoPos` (number squares,
bitboard piece types, number-keyed `charges`/`locked`). Add a small module
(`nnueAccum.ts`) that mirrors `nnueFeatures.ts` **exactly** — this is the parity
surface, so it must be a line-for-line translation, tested against it (§9).

```ts
// class index within PIECE_CLASSES (p n b n_locked b_locked r1..r5 q k = 0..11)
function classIndexBB(type: number, sq: number, evo: EvoState): number {
  switch (type) {
    case P: return 0;
    case N: return evo.locked.has(sq) ? 3 : 1;
    case B: return evo.locked.has(sq) ? 4 : 2;
    case R: { const c = evo.charges.get(sq) ?? ROOK_CHARGES;
              return 5 + (Math.min(Math.max(c, 1), ROOK_CHARGES) - 1); } // r1..r5 → 5..9
    case Q: return 10;
    case K: return 11;
  }
}

const rel = (sq: number, persp: 0 | 1): number => (persp === 0 ? sq : sq ^ 56); // white:0

// sparse feature index for a piece, in a given perspective
function sparseIdx(persp: 0 | 1, pieceColor: 0 | 1, cls: number, sq: number): number {
  const isUs = pieceColor === persp ? 0 : 1;
  return (isUs * NUM_CLASSES + cls) * NUM_SQUARES + rel(sq, persp); // NUM_CLASSES=12, NUM_SQUARES=64
}
```

Dense indices per perspective mirror `denseActiveIndices`, with `us = persp`,
`them = persp ^ 1`, and the single `ep_evolved` flag active (in both perspectives)
iff `evo.epEvolved !== null`. Reuse the exact `DENSE_OFFSETS` / bucket-clamp logic;
export those constants from `nnueFeatures.ts` rather than re-deriving them, so the
two files cannot drift.

---

## 5. Full refresh

`refresh(acc, s: EvoPos, weights)`: rebuild both perspectives from scratch. Used at
the search root, and any time incremental state is unavailable (initialisation, and
optionally a periodic drift reset — §10).

```
for persp in {w, b}:
  acc[persp] = Float32Array(weights.l1b)            // copy biases
  for each piece (color, type, sq) on the board:
    idx = sparseIdx(persp, color, classIndexBB(type, sq, evo), sq)
    addRow(acc[persp], weights.l1w, idx)            // acc[persp][o] += l1w[idx*256 + o]
  for each active dense index d in perspective persp:
    addRow(acc[persp], weights.l1w, d)
```

`refresh` at the root must produce a vector that, when read for the root's STM,
equals `forwardActive`'s pre-ReLU h1 within float epsilon (§9 golden test).

---

## 6. Incremental deltas per move (Phase 2)

For each `applyEvoTurn`, enumerate the features that toggle and apply
`addRow`/`subRow` to `stack[p+1]` (already a copy of `stack[p]`), **in both
perspectives**. All the information needed is what `applyEvoTurn` already computes;
the `EvoUndo` record (`evoBitboard.ts:197`) already captures the touched squares,
types, charges, and counters.

**Sparse toggles** (a feature = one `(perspective, index)` row):

| event | sub (remove) | add (place) |
|---|---|---|
| mover leaves `from` | class@`from` before the move, at `from` | — |
| mover lands `to` | — | class@`to` after the move (post-promotion / post-charge-decrement), at `to` |
| normal capture on `to` | victim class@`to` before, at `to` | — |
| standard ep capture | captured pawn at `capSq` (`to ± 8`) | — |
| evolved ep capture | victim class@`victim` before, at `victim` | — |
| forced last-rank promo | pawn at `from` | promoted class at `to` |
| minor / rook evolution | (mover already removed at `from`) | evolved class at `to` (instead of the un-evolved class) |
| rook charge decrement | — | the moved rook's class bucket at `to` reflects the **new** charge count |
| mandatory downgrade | — | `n_locked`/`b_locked` at `to` |

Note the "leaves `from`" sub always uses the **pre-move** class at `from`, and the
"lands `to`" add always uses the **final** class at `to` (after promotion / charge
change / downgrade). A capture's victim sub uses the victim's pre-move class.
Because `sparseIdx` mirrors square + swaps us/them per perspective, each toggle is
computed twice (once per perspective) from the same `(color, type, sq, evo-before/after)`.

Key correctness point already established in the make/unmake work: **no piece other
than the mover, the victim, and (for evolved-ep) the victim on its own square ever
changes class or square** on a single turn. Rook charge buckets change only for the
moved rook; locking affects only the moved piece. So sparse deltas are confined to
`from`, `to`, and the ep `capSq`/`victim` — never a board scan.

**Dense toggles** (each changed counter flips one one-hot bucket → one sub + one add,
in both perspectives with us/them swapped):

- pawn move: `pawn_progress[us]` bucket changes; on wraparound `minor_rights[us]`
  bucket changes too.
- minor move: `minor_progress[us]`; on wraparound `rook_rights[us]`.
- spending a right (`minor`/`rook` evolution): `minor_rights[us]` / `rook_rights[us]`
  bucket −1.
- `ep_evolved` flag: toggles as `evo.epEvolved` goes null↔set.

For perspective `w`, `us = white`; for `b`, `us = black` — so a change to White's
counter is a `_us` toggle in `accW` and a `_them` toggle in `accB`. Buckets are
clamped (`RIGHTS_BUCKETS = 5`, progress widths `3`); a change within the clamp
ceiling (e.g. rights 4→5) is a no-op toggle (same bucket) and must be skipped.

Because we use the **stack** (§3), `undoEvoTurn` needs to do **nothing** to the
accumulator. If a future variant mutates in place instead, the toggle list must be
recorded and inverted in undo — but the stack approach is strongly preferred.

---

## 7. Evaluation from the accumulator

Replace the Layer-1 accumulation in the eval, keep the rest:

```ts
function evalAcc(acc: Acc, stm: 0 | 1, w: NnueWeights): number {
  const pre = stm === 0 ? acc.w : acc.b;   // pre-activation h1, side-to-move perspective
  const h1 = new Float64Array(HIDDEN1);
  for (let o = 0; o < HIDDEN1; o++) { const x = pre[o]; h1[o] = x < 0 ? 0 : x > 1 ? 1 : x; }
  // Layers 2 + 3: identical to forwardActive (nnue.ts:146-159)
  …
  return out; // side-to-move pawn score
}
```

This returns the **side-to-move pawn score**, exactly like `forwardActive`. The
bitboard search's eval convention is side-to-move centipawns (`evalEvo`), so scale
by 100 and keep the sign handling consistent with the existing NNUE path
(`evaluateNNUE` → `evaluate` negates for White-positive callers; the bitboard search
already works in side-to-move units, so no negation is needed there — verify against
`evalEvo`'s sign at integration).

---

## 8. Wiring into the search

- Gate on `hasNnueWeights()` **and** a mode flag: the PST path (`evalEvo`) must pay
  nothing (no accumulator copies) when NNUE is off. Simplest: a boolean captured at
  search entry; if false, never touch the stack.
- `searchEvoTT` / `searchEvoTTTimed` build the root accumulator via `refresh`, then
  thread the stack ply index through `negamaxTT` / `quiesce` alongside the existing
  `ply` parameter (they already carry `ply`; the stack is indexed by it).
- `applyEvoTurn` gains an optional accumulator-update side-effect. Cleanest: keep
  `applyEvoTurn` pure and add a parallel `applyAccum(stack, p, s, t, undo, weights)`
  the search calls right after `applyEvoTurn`, reading the same `t`/`EvoUndo`. This
  keeps the PST path and the make/unmake unit tests untouched.
- Quiescence uses the same stack (its plies extend past nominal depth up to
  `MAX_QUIESCE_PLY`); size the stack accordingly.
- The engine flag stays as-is: `engineConfig.backend = "bitboard"` with weights
  loaded now runs the NNUE accumulator path; with no weights it runs PST.

---

## 9. Correctness validation (do this first, and keep it)

Parity is the whole ballgame for NNUE. Three layers of test, cheapest first:

1. **Index parity (Phase 0).** For a corpus of random `EvoPos`, assert the multiset
   of `{ sparseIdx + dense }` indices for the STM perspective equals
   `activeFeatures(positionFromGame(...)) ++ denseActiveIndices(...)`. This pins the
   bitboard-native indexer to the golden-tested extractor with no net involved.
2. **Refresh parity (Phase 1).** For random positions, assert `evalAcc(refresh(s))`
   equals `evaluateNNUE`/`forwardActive` within a tight epsilon (e.g. `1e-4` pawns).
   Do it for **both** STM colours (exercises `accW` and `accB`).
3. **Incremental parity (Phase 2).** The important one. Walk random games with the
   accumulator stack; at **every** node assert `evalAcc(stack[p])` equals a
   from-scratch `refresh` of the same position within epsilon. Then do recursive
   make→apply→(descend)→undo and assert the parent read is unchanged (trivially true
   with the stack, but the test guards against a regression to in-place mutation).

Wire a seeded net (`seededNet`, `nnue.ts:58`) so these run without shipped weights.

---

## 10. Float determinism (call it out, don't fight it)

`forwardActive` sums Layer 1 in active-feature order into a `Float64Array`. The
accumulator sums in a **different order** (biases, then per-move deltas along the
game/search path), and in `Float32Array`. Float addition is not associative, so:

- The accumulator eval will differ from a from-scratch eval by ~float epsilon.
  This can, very rarely, flip a move choice between two near-equal candidates.
- Consequence for training data: the accumulator path **defines its own labels**.
  That is fine — labels must be *self-consistent and deterministic given the
  position*, which the stack guarantees, not bit-identical to the old path.
- Validation therefore compares **within epsilon** (§9), never bit-exact.

Two knobs if drift ever matters: (a) keep the accumulator in `Float64Array` to match
`forwardActive`'s precision (costs 2× copy bandwidth); (b) since the stack derives
each node from a *root* `refresh` and only adds ≤ maxPly deltas, drift is bounded and
small — no periodic reset is needed. Prefer (a) only if the epsilon test fails at
`1e-4`.

(The durable fix used by production engines is **int16 quantization**, which makes
add/subtract exact and reversible. That is a larger change — retrain with quantized
weights — and belongs to the SIMD/Rust follow-up, not this step.)

---

## 11. Expected performance and how to measure

Predicted (from §1): eval ~1.5–2× faster; whole NNUE search ~1.4–1.7×. **Measure,
don't assume** — the fixed Layer-2/3 floor and the per-node stack-copy could each
eat the win. Benchmark protocol (mirror the existing bench tests, write results to
scratch, run detached):

- **Eval microbench:** N positions, `evaluateNNUE` (from-scratch) vs `evalAcc` on a
  freshly-refreshed accumulator — isolates the Layer-1 + feature-build saving from
  the search.
- **Search end-to-end:** `searchEvoTT` at fixed depth with NNUE, accumulator on vs a
  from-scratch-NNUE control (call `forwardActive` per node), same positions — the
  honest number, including stack-copy overhead and Amdahl.
- Report nodes/s and ms/node for both; confirm the eval-fraction assumption behind
  the estimate by also timing eval-only vs move-gen-only per node.

If the measured search win is < ~1.3×, the stack-copy is likely the culprit → §12.

---

## 12. Risks, fallbacks, open questions

- **Stack-copy dominates.** Fallback: "dirty piece" / finny-tables scheme — don't
  copy; record the ≤ few toggled rows per ply and apply/reverse them in place, with
  the `EvoUndo` carrying the toggle list. More bookkeeping, no per-node 512-float
  copy. Only pursue if §11 shows copy is the bottleneck.
- **Perspective/dense parity bugs.** The us/them-per-perspective dense logic is the
  most error-prone part; §9.1 index parity for **both** colours is the guard. Do not
  skip the Black-to-move cases.
- **Sign/scale at integration.** `evalEvo` (PST) and NNUE differ in unit (cp vs
  pawns) and the White-positive vs STM convention differs across `evaluate` /
  `evaluateNNUE` / the bitboard search. Nail this down with a test that compares the
  bitboard NNUE search's root score against `searchRoot` (chess.js + NNUE) on the
  same positions — they should agree within epsilon (modulo the tie-break/label
  caveat of §10).
- **Trainer parity is *not* at risk** as long as §4 stays a literal translation and
  reuses `nnueFeatures.ts`'s exported constants. If `features.py` / `PIECE_CLASSES`
  / `DENSE_FIELDS` ever change, this file and the index-parity test change with them
  — same contract the existing golden vectors already enforce.
- **Only helps the NNUE path.** The PST path is untouched and must stay zero-cost
  when NNUE is off (§8).

---

## 13. Milestones (each independently testable / committable)

0. ✅ **Shipped.** `nnueAccum.ts` gained `activeIndicesForPerspective(pos, evo, persp)`
   (§4) — the same indexing logic as the port spec's Option B, generalized to an
   explicit perspective rather than tied to `pos.us`. `activeIndicesFromEvoPos`
   (the port spec's export, still what `evoSearch.ts` evaluates with) is now a
   thin wrapper `activeIndicesForPerspective(pos, evo, pos.us)`. Index-parity
   test (§9.1, `__tests__/nnueAccumPerspective.test.ts`) validates **both**
   perspectives against the golden extractor by forcing the FEN's `turn` field
   to each colour in turn — the oracle for "perspective P" is literally "the
   golden extractor with `turn = P`", per §2's `accW`/`accB` equivalence claim
   — over the 28-fixture corpus plus a random walk, both colours to move, plus
   a sanity guard that the two perspectives' index sets actually differ (not a
   vacuously-passing symmetric test).
1. ✅ **Shipped.** `Acc` + `refresh` + `evalAcc` (`nnueAccum.ts`) + refresh-parity
   test vs `forwardActive` (§9.2, `__tests__/nnueAccumRefresh.test.ts`), both
   colours to move. `forwardActive` (`nnue.ts`) was split to share its Layers
   2/3 tail (`forwardFromPreactivation`) with `evalAcc`, so the two paths can't
   drift there — only Layer 1 (from-scratch sum vs accumulator) differs, and
   that's exactly what the epsilon in §10 accounts for. `1e-4` pawns was
   sufficient in practice; the `Float64Array` fallback wasn't needed.
2. ✅ **Shipped.** Incremental deltas (`applyAccum`) + accumulator stack
   (`createAccStack`) in `nnueAccum.ts`, validated by the incremental-parity
   test (§9.3, `__tests__/nnueAccumIncremental.test.ts`): a long straight-line
   random walk and a recursive make→apply→descend→undo→sibling walk, both
   colours to move, every node checked against a from-scratch `refresh`.
   `applyAccum` is deliberately called strictly *after* `applyEvoTurn` (per
   §8's suggested signature) — every "before" value it needs turns out to be
   already sitting in the `EvoUndo` record (mover/victim pre-move type and
   lock/charge state at `from`/`to`, all four counters' pre-move values), and
   every "after" value is read straight off the now-mutated `EvoPos`, which
   sidesteps needing to special-case promotion/evolution/charge-decrement/
   downgrade separately — reading the post-move board already reflects
   whichever one happened. Only the evolved-en-passant victim's lock state
   isn't in `EvoUndo`; it doesn't need to be; that victim is always the minor
   a pawn evolved into on the immediately preceding ply, so it can never yet
   be a rook-downgrade-locked piece. Verified the parity test isn't vacuous by
   deliberately dropping one dense-counter toggle and confirming it fails
   (~0.005–0.017 pawn error, `expect(...).toBeCloseTo(..., 4)` catches it),
   then restoring it. Not yet wired into the live search — that's milestone 3.
3. ✅ **Shipped.** `searchEvoTT`/`searchEvoTTTimed` wired to the accumulator
   behind their existing `useNnue`-flag-and-`hasNnueWeights()` gate
   (`evoSearch.ts`): a root `refresh` at search entry, `applyAccum` called
   right after every `applyEvoTurn` across `rootSearch`/`negamaxTT`/`quiesce`
   (ply already threaded through all three, so the accumulator stack slots in
   at the existing `ply` parameter with no new plumbing), and `evalPos`
   reading `evalAcc(stack[ply], ...)` instead of a from-scratch rebuild. The
   integration sign/scale test (§12) is the existing cross-backend parity
   test in `nnueEvoAdapter.test.ts` (§5.3 of the port spec) — it now exercises
   the accumulator live rather than the from-scratch Option B path, since
   that's what `evoSearch.ts` calls now. Hardened that test with a
   comparison-count guard after discovering (by deliberately breaking the
   root refresh) that `seededNet`'s small random weights make broken and
   correct scores land close enough to zero that the tolerance alone didn't
   reliably distinguish them — added a second, surgical test
   (`nnueAccumSearchIntegration.test.ts`) using a larger weight scale and a
   hand-picked position where no move is ever "noisy" (so `quiesce` provably
   returns the stand-pat untouched), checked against an independently
   from-scratch-computed expectation; confirmed both tests catch the same
   injected bug before restoring the fix.
4. ✅ **Shipped.** Benchmark (eval microbench + search end-to-end, throwaway
   script per §11, not committed) **corrects** the ~1.4–1.7× estimate. Isolated
   incremental-eval cost landed close to the §1 prediction (~1.36× vs ~1.5–2×).
   The whole-search win came in much lower, ~1.05–1.08×: eval is called on ~54%
   of visited nodes (not a small minority), but its absolute cost is already
   comparable to the rest of a node's cost (move-gen, MVV-LVA ordering,
   make/unmake) even before the accumulator speeds it up, so a ~26% per-eval
   saving barely moves the whole-search number. Confirmed via node counts:
   from-scratch and accumulator searches visited the *identical* node count at
   equal depth, cross-checking that the two evals agree closely enough to
   preserve pruning decisions.

Milestones 0–1 carry all the parity risk and none of the search plumbing; land and
validate them before touching make/unmake.
