# Spec: NNUE evaluation on the bitboard backend (from-scratch)

**Status:** milestones 0–2 (Option A, Option B, wiring, validation, benchmark)
shipped. The eval swap now runs Option B in `evoSearch.ts`. Milestone 3
(accumulator hand-off) not yet started — see `nnue-accumulator-spec.md`.
**Goal:** let the bitboard search (`evoSearch.ts`) evaluate positions with the
trained NNUE net instead of PST-only (`evalEvo`), so self-play / data generation
and the `"bitboard"` engine backend get the net's strength at the bitboard
search's node rate.

**Scope boundary — read this first.** This is the *from-scratch* port: every node
that wants a net score builds the feature indices from its `EvoPos` and runs the
full `forwardActive`. It is deliberately the simple, obviously-correct step. The
**incremental accumulator** — maintaining the Layer-1 output across make/unmake so
each eval is O(Δfeatures) instead of a full rebuild — is a *separate, later*
optimization specified in [`nnue-accumulator-spec.md`](./nnue-accumulator-spec.md).
That document assumes the work here is already done and validated. Do this first;
it is the correctness anchor the accumulator's parity tests compare against.

The two specs share one artifact — the bitboard-native feature indexer (§3 here =
the accumulator spec's Phase 0 `nnueAccum.ts`). Build it once, here, so the
accumulator step inherits it already parity-tested.

---

## 1. What exists today, and the gap

- `nnue.ts` — the net: `forwardActive(weights, active: number[])` runs the
  `1569 → 256 → 32 → 1` net from a list of active feature indices and returns a
  **side-to-move pawn score**. `evaluatePosition(weights, NnuePosition)` and
  `evaluateNNUE(game: EvoChessGame)` are the two entry points. Weights live in
  module state (`setNnueWeights` / `hasNnueWeights`), loaded once by
  `ai.worker.ts`.
- `nnueFeatures.ts` — the extractor. `activeFeatures(pos)` + `denseActiveIndices(pos)`
  produce the active index list from an `NnuePosition` (a FEN string + evo record).
  This is the golden-tested twin of `training/nnue/features.py`.
- `evoSearch.ts` — the bitboard search. Evaluates only via `evalEvo(s: EvoPos)`
  (White-positive integer centipawns, with rook-charge decay). It never calls the
  net. `ai.ts` documents this: `"bitboard"` backend = "PST eval only".

**The gap:** `evaluateNNUE`/`evaluatePosition` take an `EvoChessGame` / `NnuePosition`
(FEN-based). The bitboard search holds an `EvoPos` (`evoBitboard.ts`): `bigint`
bitboards, number squares, number-keyed `charges`/`locked`. There is no path from
`EvoPos` to a net score. This spec builds that path.

---

## 2. Two build options, and the recommended order

### Option A — FEN adapter (correctness baseline, land first)

Write `nnuePositionFromEvoPos(s: EvoPos): NnuePosition`: serialize the `EvoPos`
board to a FEN and translate the evo state (number squares → `"e4"` names, color
ints → `"w"`/`"b"`), then call the existing `evaluatePosition(weights, …)`.

- **Pro:** reuses the golden-tested extractor verbatim — parity with the trainer
  and with the chessjs path is guaranteed by construction, no new index logic to
  get wrong. Unblocks NNUE on the bitboard backend in a few dozen lines.
- **Con:** a FEN build + `parseFen` + Map/Set walks **per eval**. Slow — this is
  most of the per-eval cost the accumulator spec §1 wants to reclaim. Fine as a
  baseline; not the endpoint.

There is likely already board→FEN logic on the bitboard side (`bitboard.ts` /
`fromEvoGame` goes the other way via `game.chess.fen()`); if not, the FEN placement
field is a straight walk of `pos.bb`. `squareName(sq)` (`bitboard.ts:28`) gives the
`"e4"` names for the evo `Map`/`Set` keys.

### Option B — bitboard-native indexer (the real port)

Write `nnueAccum.ts` (name shared with the accumulator spec): compute the active
index list **directly from `EvoPos`**, no FEN, no chess.js. This is a line-for-line
translation of `nnueFeatures.ts`'s indexing (§3). Then `forwardActive(weights,
indices)`.

- **Pro:** no per-eval string round-trip. This is the indexer the accumulator step
  needs anyway (its Phase 0), so building it here means it lands parity-tested once.
- **Con:** new index logic → new parity surface → must be tested against
  `nnueFeatures.ts` (§5). This is the whole risk of the port; §5 is not optional.

**Recommended order:** A → measure → B. Land A to prove the wiring (§4) and get a
correct NNUE-on-bitboard baseline number. Then land B as a drop-in eval replacement,
gated behind the same flag, and confirm it gives **bit-identical** active-index sets
to A (they must — both target the same golden vector). B is what ships; A can stay
as the reference oracle the parity test drives, or be deleted once B is trusted.

---

## 3. The bitboard-native indexer (Option B)

Mirror `nnueFeatures.ts` exactly. The three subtleties that make it non-trivial:

1. **Class index.** `PIECE_CLASSES` (`nnueFeatures.ts:48`) is
   `p n b n_locked b_locked r1..r5 q k` = 0..11. From `EvoPos`:
   - pawn (`P`) → 0; queen → 10; king → 11.
   - knight (`N`) → `evo.locked.has(sq) ? 3 : 1`; bishop (`B`) → `locked ? 4 : 2`.
   - rook (`R`) → `5 + clamp(charges, 1, ROOK_CHARGES) − 1`, where
     `charges = evo.charges.get(sq) ?? ROOK_CHARGES` (a rook absent from the map is
     full-charged — matches `pieceClass` in `nnueFeatures.ts:203`).
2. **Side-to-move–relative square.** `relativeSquare` mirrors the rank when Black is
   to move. In LERF (`a1=0 … h8=63`) that mirror is exactly `sq ^ 56`. Files are
   **not** mirrored. So `rel(sq) = pos.us === 0 ? sq : sq ^ 56`.
3. **The us/them bit.** `sparseIndex(isUs, cls, relSq) = ((isUs?0:1)*12 + cls)*64 + relSq`,
   where `isUs = (pieceColor === pos.us)`. Piece color is the `c` in `pos.bb[c*6+t]`.

Sparse indices — walk every piece:

```ts
for (let c = 0; c < 2; c++)
  for (let t = 0; t < 6; t++) {
    let bb = pos.bb[c * 6 + t];
    while (bb) { const sq = lsbIndex(bb); bb &= bb - 1n;
      indices.push(sparseIdx(c === pos.us, classIndexBB(t, sq, evo), rel(sq, pos.us)));
    }
  }
```

Dense indices — mirror `denseActiveIndices` (`nnueFeatures.ts:245`) with
`us = pos.us`, `them = pos.us ^ 1`, reading the `[white, black]`-indexed evo arrays
(`evo.minorRights[us]`, `evo.pawnProgress[us]`, …). The one-hot bucket clamp is
`min(max(value,0), width-1)` with `RIGHTS_BUCKETS = 5`, progress widths `N_MINOR =
M_ROOK = 3`. Push the single `ep_evolved` flag iff `evo.epEvolved !== null`.

**Do not re-derive the layout constants.** Import `DENSE_OFFSETS`, `RIGHTS_BUCKETS`,
`N_MINOR`, `M_ROOK`, `NUM_CLASSES`, `NUM_SQUARES`, and the class ordering from
`nnueFeatures.ts` (export what isn't exported yet) so the two files cannot drift.
If `features.py` / `PIECE_CLASSES` / `DENSE_FIELDS` ever change, this file and its
parity test change with them — the same contract the golden vectors already enforce.

---

## 4. Wiring into the search

The eval swap lives in `evoSearch.ts`. Today `quiesce` computes
`standPat = sign * evalEvo(s)`, where `sign = s.pos.us === 0 ? 1 : -1` converts
White-positive centipawns to **side-to-move-positive** centipawns. `forwardActive`
already returns a **side-to-move pawn score**, so it slots in at exactly that
side-to-move-positive point — no `sign` multiply, just unit scaling:

```ts
// side-to-move-relative centipawns, matching evalEvo's post-sign convention
function evalPos(s: EvoPos): number {
  if (USE_NNUE) return Math.round(100 * nnueEvalFromEvoPos(s)); // pawns → centipawns
  return (s.pos.us === 0 ? 1 : -1) * evalEvo(s);
}
```

Then `quiesce`'s stand-pat becomes `const standPat = evalPos(s);` (drop the `sign *
evalEvo` there). Everything downstream — negamax negation, alpha/beta, mate scores
(`MATE = 100_000`, comfortably above any net score) — already works in
side-to-move-relative centipawns, so nothing else moves.

Gating:

- **`USE_NNUE`** = `hasNnueWeights()` **and** an explicit mode flag, captured once at
  search entry (`searchEvoTT` / `searchEvoTTTimed`) into a module-level boolean the
  eval reads. The PST path must stay exactly as fast when NNUE is off — no per-node
  branch cost beyond one boolean load, no feature work.
- The engine flag stays as documented in `ai.ts` (`engineConfig.backend`): with
  weights loaded, `"bitboard"` now runs NNUE; with none, PST. (Note `chooseMove`'s
  current fallback in `ai.ts:645` sends the NNUE path to the `"chessjs"` backend —
  once this ships, that policy can point NNUE at `"bitboard"` instead; that's a
  follow-up policy change, not part of this port.)
- Weights: `evoSearch.ts` must reach the loaded net. Cleanest is to have
  `nnueEvalFromEvoPos` call a small accessor in `nnue.ts` that reads the same
  module-state `loadedWeights` (add `evaluateActive(active: number[])` or expose a
  getter), so there is one source of truth for "which net is loaded" and the worker's
  existing `setNnueWeights` load path (`ai.worker.ts:48`) feeds both backends.

**Determinism note.** The bitboard search sorts moves by an integer ordering key with
a tie-break; swapping eval from integer centipawns to `round(100·pawns)` changes
which quiet moves compare equal and thus the node tree and sometimes the chosen move.
That is expected and fine — it is a *different evaluator*, not a bug. The property to
preserve is that the eval is a deterministic function of the position (it is).

---

## 5. Correctness validation (the whole point)

Feature-extraction skew is the number-one cause of silently worthless NNUE — it
trains fine and plays badly. Three tests, cheapest first, all runnable with a
`seededNet` (`nnue.ts:58`) so no shipped weights are needed:

1. **Index parity (Option B only, do first).** For a corpus of random `EvoPos`
   (both colours to move), assert the multiset of indices from the bitboard-native
   indexer equals `activeFeatures(nnuePositionFromEvoPos(s)).concat(denseActiveIndices(…))`
   — i.e. Option B ≡ Option A ≡ the golden extractor. This pins B with **no net
   involved**. Must exercise **both `pos.us === 0` and `=== 1`** — the `sq ^ 56`
   mirror and the us/them swap both flip with side to move, and a bug there is
   invisible when you only test White to move.
2. **Eval parity.** For random positions, assert the bitboard NNUE eval equals
   `evaluatePosition(seededNet, nnuePositionFromEvoPos(s))` within tight epsilon
   (`1e-4` pawns; nonzero only because Option B may sum indices in a different order).
   Option A should be **bit-exact**.
3. **Cross-backend parity.** On a shared position set, the bitboard NNUE **search's**
   root score should agree with `searchRoot` on the chessjs+NNUE backend within
   epsilon (modulo the move-ordering tie-break caveat of §4). This is the honest
   end-to-end check that sign, scale, and side-to-move convention are all right —
   the exact integration risk called out in the accumulator spec §12.

**Corpus.** There is no random-`EvoPos` generator in the repo. Use two sources:

1. **`training/parity/fixtures.json`** (primary) — the 28 curated positions the
   cross-language golden gate uses, deliberately covering every evo edge case
   (all `r1..r5` buckets, locked minors, rook-full-by-default, minor rights 0–7,
   both progress counters, evolved en passant, corner pieces). Build an `EvoPos`
   from each in a test helper (`fromFen` for the board + translate the evo fields,
   name-square → number-square). This pins `nnueAccum.ts` to the same positions
   already gated across languages, and hits the rare classes a random walk misses.
2. **A seeded inline random-turn walker** (supplement) — `generateEvoTurns` → seeded
   pick → `applyEvoTurn`, for volume and colour balance: the fixtures are 25
   white-to-move vs only 3 black-to-move, and the `sq ^ 56` mirror + us/them swap are
   exactly what flip with side to move, so black-to-move coverage matters. Low-risk
   because index parity has an independent oracle (Option A / the golden extractor):
   a buggy walker yields a weird-but-legal position, never a false pass.

---

## 6. Performance expectations

This step does **not** make eval cheap — it makes it *possible* on the bitboard
backend. Each eval is a full feature build + full `forwardActive` (Layer 1 ~10k
adds, Layers 2+3 ~8k madds; see accumulator spec §1). Expect the NNUE-on-bitboard
search to be **much slower per node** than PST `evalEvo` (which is a bitboard popcount
loop) — the win is *strength per node*, not nodes/s.

- Option A adds a FEN round-trip on top of that; Option B removes it (its main
  reason to exist beyond seeding the accumulator).
- The per-node eval cost is what the accumulator spec reclaims (~1.4–1.7× on the
  whole NNUE search, projected). **Do not attempt the accumulator until this
  from-scratch path is landed and parity-green** — it is the oracle those tests need.

Benchmark to record (write to scratch, run detached; mirror existing bench tests):
nodes/s and ms/node for PST vs NNUE-A vs NNUE-B on a fixed position set at fixed
depth. This becomes the baseline the accumulator's end-to-end benchmark is measured
against.

---

## 7. Milestones

0. ✅ **Shipped.** `nnuePositionFromEvoPos` (Option A, `nnueEvoAdapter.ts`) + wiring
   (§4: `evalPos`/`USE_NNUE` in `evoSearch.ts`, `evaluateNnuePosition` accessor in
   `nnue.ts`, `useNnue` param on `searchEvoTT`/`searchEvoTTTimed`) + eval parity
   (§5.2) and cross-backend parity (§5.3) tests, both green
   (`__tests__/nnueEvoAdapter.test.ts`, run against the 28-fixture corpus plus a
   seeded random walk). Ships a correct, slow NNUE-on-bitboard; unblocks NNUE
   self-play on the bitboard backend. The `ai.ts` policy change that actually
   routes NNUE play at the `"bitboard"` backend (§4's note on `chooseMove`'s
   fallback) is still open — this milestone only proves the eval path works.
1. ✅ **Shipped.** `nnueAccum.ts` native indexer (Option B) + index-parity test vs
   Option A / golden extractor, both colours (§5.1, `__tests__/nnueAccum.test.ts`),
   plus an eval-parity check of `forwardActive` on B's indices vs A (§5.2). The
   eval swapped to B behind the same gate (`evoSearch.ts`'s `nnueEvalFromEvoPos`
   now calls `activeIndicesFromEvoPos` + `evaluateActive`, not the FEN adapter).
   Option A (`nnueEvoAdapter.ts`) stays in the tree as the parity oracle these
   tests drive, per the spec's own suggestion — not deleted.
2. ✅ **Shipped.** Benchmark (§6): PST vs A vs B (throwaway script, not
   committed — 12 positions sampled through the middlegame of a seeded random
   walk, a full-size seeded net matching shipped dimensions (256×32)).
   Per-eval cost, tight loop with no search (isolates the eval itself from
   move-ordering/pruning effects): PST (`evalEvo`) ~0.0031 ms/eval (1×); NNUE
   Option B (native indexer) ~0.0240 ms (7.6×); NNUE Option A (FEN adapter)
   ~0.0492 ms (15.7×, i.e. 2.05× vs Option B — matches the spec's expectation
   exactly, since Option A's FEN build + `parseFen` + Map/Set walk roughly
   doubles Option B's already-real net cost, the FEN round-trip B already
   removed). Full search, depth 3, over the same 12 positions, real
   `searchEvoTT` (Option A isn't wired into the search, so its number is the
   per-eval ratio applied to NNUE-B's measured wall time, not an independent
   measurement): PST 37,278 nodes / ~743 ms (~0.0199 ms/node); NNUE-B 67,667
   nodes / ~1,800 ms (~0.0264 ms/node); NNUE-A ~67,667 nodes / ~3,690 ms
   (estimated). NNUE-B search is ~2.4× slower than PST at equal depth — the
   baseline milestone 3's accumulator is measured against. Two effects stack:
   the node count itself grows ~1.82× (37,278 → 67,667) because a different
   eval reorders pruning (expected per the determinism note in §4 of this
   spec, not a bug), on top of the per-node eval cost increase.
3. **Hand off** to [`nnue-accumulator-spec.md`](./nnue-accumulator-spec.md): the
   incremental accumulator reuses `nnueAccum.ts` from milestone 1 and this path as
   its parity oracle.

Milestones 0–1 carry all the parity risk. Land and validate them before any
accumulator work.
