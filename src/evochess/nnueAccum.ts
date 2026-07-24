/**
 * The bitboard-native NNUE feature indexer. Originally Option B of the
 * NNUE-on-bitboard port (nnue-bitboard-port-spec.md §3): the active-feature-
 * index list computed **directly** from an `EvoPos`, with no FEN build and no
 * chess.js — a line-for-line translation of `nnueFeatures.ts`'s indexing
 * logic onto the bitboard's number-square, bigint-bitboard representation.
 *
 * Now also Phase 0 of the incremental accumulator (nnue-accumulator-spec.md
 * §4): `activeIndicesForPerspective` computes the index list for an
 * *explicit* perspective (0 = White, 1 = Black), independent of whose turn it
 * actually is — the accumulator maintains one such vector per colour
 * (`accW`/`accB`) and simply picks which to read off side to move.
 * `activeIndicesFromEvoPos` (the side-to-move vector the bitboard search
 * evaluates with today) is the special case `persp = pos.us`.
 *
 * Layout constants (`DENSE_OFFSETS`, `RIGHTS_BUCKETS`, `N_MINOR`, `M_ROOK`,
 * `NUM_CLASSES`, `NUM_SQUARES`) are imported from `nnueFeatures.ts`, never
 * re-derived — if `PIECE_CLASSES`/`DENSE_FIELDS` there ever change, this file
 * and its parity tests change with them.
 *
 * Also holds the accumulator itself (nnue-accumulator-spec.md §3, §5, §7):
 * `Acc` (the pre-activation Layer-1 output, one per perspective), `refresh`
 * (rebuild both from scratch), and `evalAcc` (Layers 2/3 from the
 * accumulator, sharing `forwardFromPreactivation` with `forwardActive` in
 * `nnue.ts` so the two paths can't drift there). The incremental
 * per-move-delta path (`nnue-accumulator-spec.md` §6) is a later milestone —
 * `refresh` is a full rebuild, not yet wired to make/unmake.
 */
import { ROOK_CHARGES } from "./game";
import { lsbIndex, pieceAt, type Position } from "./bitboard";
import type { EvoPos, EvoState, EvoTurn, EvoUndo } from "./evoBitboard";
import { DENSE_OFFSETS, N_MINOR, M_ROOK, NUM_CLASSES, NUM_SQUARES, RIGHTS_BUCKETS } from "./nnueFeatures";
import { forwardFromPreactivation, type NnueWeights } from "./nnue";

// Piece type codes, matching bitboard.ts: P=0 N=1 B=2 R=3 Q=4 K=5.
const P = 0, N = 1, B = 2, R = 3, Q = 4, K = 5;

/** 0 = White's perspective, 1 = Black's — independent of whose turn it is. */
export type Perspective = 0 | 1;

/**
 * The 0..11 PIECE_CLASSES index (nnueFeatures.ts) of a piece of type `t`,
 * given whether it's locked (downgraded-from-rook minor) and, for a rook, its
 * remaining charges. Mirrors `pieceClass` in `nnueFeatures.ts`. A rook absent
 * from `charges` defaults to full (matches game.ts — a rook can never sit on
 * the board with zero charges, spending the last one downgrades it the same
 * turn, but clamp anyway rather than emit an out-of-range index).
 */
function classFor(t: number, locked: boolean, charges: number | undefined): number {
  switch (t) {
    case P:
      return 0;
    case N:
      return locked ? 3 : 1;
    case B:
      return locked ? 4 : 2;
    case R:
      return 5 + Math.min(Math.max(charges ?? ROOK_CHARGES, 1), ROOK_CHARGES) - 1;
    case Q:
      return 10;
    case K:
      return 11;
    default:
      throw new Error(`unknown piece type: ${t}`);
  }
}

/** `classFor`, reading locked/charge state for `sq` off the live `evo`. */
function classIndexBB(t: number, sq: number, evo: EvoState): number {
  return classFor(t, evo.locked.has(sq), evo.charges.get(sq));
}

// Perspective-relative square: mirrors the rank (not the file) for Black's
// perspective. In LERF (a1=0 … h8=63) that mirror is exactly sq ^ 56.
const rel = (sq: number, persp: Perspective): number => (persp === 0 ? sq : sq ^ 56);

const sparseIdx = (isUs: boolean, cls: number, relSq: number): number =>
  ((isUs ? 0 : 1) * NUM_CLASSES + cls) * NUM_SQUARES + relSq;

function oneHotIndex(field: string, value: number, width: number): number {
  return DENSE_OFFSETS.get(field)! + Math.min(Math.max(value, 0), width - 1);
}

/**
 * The active feature indices (sparse piece-square block + dense evolution
 * block) of `(pos, evo)` **from `persp`'s point of view**, regardless of
 * whose turn it actually is — the bitboard-native counterpart of running
 * `activeFeatures`/`denseActiveIndices` (nnueFeatures.ts) on a FEN whose
 * `turn` field is forced to `persp`'s colour (those functions derive
 * everything us/them and mirroring from that field alone, never from a
 * separate "real" side to move — that equivalence is what makes `accW`/`accB`
 * valid perspective accumulators; see nnue-accumulator-spec.md §2).
 */
export function activeIndicesForPerspective(pos: Position, evo: EvoState, persp: Perspective): number[] {
  const us = persp;
  const them = us ^ 1;
  const indices: number[] = [];

  for (let c = 0; c < 2; c++) {
    for (let t = 0; t < 6; t++) {
      let bb = pos.bb[c * 6 + t];
      while (bb !== 0n) {
        const sq = lsbIndex(bb);
        bb &= bb - 1n;
        indices.push(sparseIdx(c === us, classIndexBB(t, sq, evo), rel(sq, persp)));
      }
    }
  }

  indices.push(oneHotIndex("minor_rights_us", evo.minorRights[us], RIGHTS_BUCKETS));
  indices.push(oneHotIndex("minor_rights_them", evo.minorRights[them], RIGHTS_BUCKETS));
  indices.push(oneHotIndex("rook_rights_us", evo.rookRights[us], RIGHTS_BUCKETS));
  indices.push(oneHotIndex("rook_rights_them", evo.rookRights[them], RIGHTS_BUCKETS));
  indices.push(oneHotIndex("pawn_progress_us", evo.pawnProgress[us], N_MINOR));
  indices.push(oneHotIndex("pawn_progress_them", evo.pawnProgress[them], N_MINOR));
  indices.push(oneHotIndex("minor_progress_us", evo.minorProgress[us], M_ROOK));
  indices.push(oneHotIndex("minor_progress_them", evo.minorProgress[them], M_ROOK));
  if (evo.epEvolved !== null) indices.push(DENSE_OFFSETS.get("ep_evolved")!);

  return indices;
}

/**
 * The active feature indices from the **side-to-move**'s point of view — the
 * vector the bitboard search evaluates with. Equivalent to
 * `activeFeatures(...).concat(denseActiveIndices(...))` in `nnueFeatures.ts`
 * on the same position (spec §5.1 / accumulator-spec §9.1 pin this).
 */
export function activeIndicesFromEvoPos(s: EvoPos): number[] {
  return activeIndicesForPerspective(s.pos, s.evo, s.pos.us as Perspective);
}

// ---- incremental accumulator (nnue-accumulator-spec.md §3, §5, §7) --------

/**
 * One node's accumulator: the pre-activation (pre-clipped-ReLU) Layer-1
 * output, one per perspective. `Float32Array` per spec §3 — a memory/perf
 * choice, not a precision requirement; if refresh-parity ever fails to hit
 * epsilon, §10's fallback is widening these to `Float64Array`.
 */
export interface Acc {
  w: Float32Array; // White's perspective, length weights.hidden1
  b: Float32Array; // Black's perspective, length weights.hidden1
}

/** A fresh, zeroed accumulator sized for `weights`. */
export function createAcc(weights: NnueWeights): Acc {
  return { w: new Float32Array(weights.hidden1), b: new Float32Array(weights.hidden1) };
}

function addRows(row: Float32Array, l1w: Float64Array, hidden1: number, indices: number[]): void {
  for (const idx of indices) {
    const base = idx * hidden1;
    for (let o = 0; o < hidden1; o++) row[o] += l1w[base + o];
  }
}

/**
 * Rebuild both perspectives of `acc` from scratch for position `s` — full
 * refresh (spec §5), not the incremental per-move delta (§6, a later
 * milestone). Used at the search root and any time incremental state isn't
 * available.
 */
export function refresh(acc: Acc, s: EvoPos, weights: NnueWeights): void {
  const { hidden1, l1b, l1w } = weights;
  for (let o = 0; o < hidden1; o++) {
    acc.w[o] = l1b[o];
    acc.b[o] = l1b[o];
  }
  addRows(acc.w, l1w, hidden1, activeIndicesForPerspective(s.pos, s.evo, 0));
  addRows(acc.b, l1w, hidden1, activeIndicesForPerspective(s.pos, s.evo, 1));
}

/**
 * Evaluate from the accumulator: pick the side-to-move's perspective, then
 * run Layers 2/3 exactly as `forwardActive` does (shared via
 * `forwardFromPreactivation`, so the two paths cannot drift there). Returns
 * the side-to-move pawn score, same convention as `forwardActive`.
 */
export function evalAcc(acc: Acc, stm: Perspective, weights: NnueWeights): number {
  const preH1 = stm === 0 ? acc.w : acc.b;
  return forwardFromPreactivation(weights, preH1);
}

/**
 * A preallocated accumulator stack indexed by search ply (spec §3): `apply`
 * copies the parent into the child slot and adds/subtracts the moved
 * features; `undo` is a no-op — the next sibling's `apply` overwrites the
 * child slot again, and the parent slot was never touched. `size` must cover
 * nominal search depth plus quiescence's extra plies.
 */
export function createAccStack(weights: NnueWeights, size: number): Acc[] {
  return Array.from({ length: size }, () => createAcc(weights));
}

// One weight-row add/subtract, into a single perspective's accumulator row.
function addRow(row: Float32Array, l1w: Float64Array, hidden1: number, idx: number, sign: 1 | -1): void {
  const base = idx * hidden1;
  if (sign === 1) for (let o = 0; o < hidden1; o++) row[o] += l1w[base + o];
  else for (let o = 0; o < hidden1; o++) row[o] -= l1w[base + o];
}

// A sparse feature toggle for a piece of `color` at `sq` with class `cls`:
// applies to *both* perspectives' rows in `dst`, each with its own index
// (sparseIdx depends on persp via the us/them split and the rank mirror).
function toggleSparse(dst: Acc, l1w: Float64Array, hidden1: number, color: 0 | 1, cls: number, sq: number, sign: 1 | -1): void {
  addRow(dst.w, l1w, hidden1, sparseIdx(color === 0, cls, rel(sq, 0)), sign);
  addRow(dst.b, l1w, hidden1, sparseIdx(color === 1, cls, rel(sq, 1)), sign);
}

// A dense counter change for the mover's side (`us`): one toggle in the
// mover's own perspective's row (the "_us" field) and one in the opponent
// perspective's row (the "_them" field) — same before/after values, just a
// different field (and hence DENSE_OFFSETS index) per perspective.
function toggleDenseCounter(
  dst: Acc, l1w: Float64Array, hidden1: number, us: 0 | 1, fieldUs: string, fieldThem: string, before: number, after: number, width: number
): void {
  const oldUs = oneHotIndex(fieldUs, before, width), newUs = oneHotIndex(fieldUs, after, width);
  const oldThem = oneHotIndex(fieldThem, before, width), newThem = oneHotIndex(fieldThem, after, width);
  const usRow = us === 0 ? dst.w : dst.b;
  const themRow = us === 0 ? dst.b : dst.w;
  if (oldUs !== newUs) {
    addRow(usRow, l1w, hidden1, oldUs, -1);
    addRow(usRow, l1w, hidden1, newUs, 1);
  }
  if (oldThem !== newThem) {
    addRow(themRow, l1w, hidden1, oldThem, -1);
    addRow(themRow, l1w, hidden1, newThem, 1);
  }
}

/**
 * Incremental accumulator update for one applied turn (spec §6): copies
 * `stack[p]` into `stack[p + 1]` and applies only the features that actually
 * toggled, in both perspectives. Call this **after** `applyEvoTurn(s, t)` has
 * already mutated `s` and produced `u` — every "before" value this needs is
 * either already in `u` (the mover's/victim's pre-move type and
 * lock/charge state at `from`/`to`, the four counters' pre-move values) or
 * read directly off the now-mutated `s` for "after" values (the moved
 * piece's final class at `to`, after any promotion/evolution/charge-decrement
 * /downgrade — reading the post-move board directly sidesteps needing to
 * enumerate those cases separately, since they've already been applied to
 * `s` by the time this runs).
 *
 * One case `u` doesn't carry a lock flag for: an evolved-en-passant victim.
 * That's fine — the victim is always the minor a pawn evolved into on the
 * immediately preceding ply, so it can never yet be a rook-downgrade-locked
 * minor (locking only happens via rook downgrade, which needs three prior
 * minor moves); its class is simply unlocked N/B.
 */
export function applyAccum(stack: Acc[], p: number, s: EvoPos, t: EvoTurn, u: EvoUndo, weights: NnueWeights): void {
  const { hidden1, l1w } = weights;
  const dst = stack[p + 1];
  dst.w.set(stack[p].w);
  dst.b.set(stack[p].b);

  const us = u.us as 0 | 1;
  const them = (us ^ 1) as 0 | 1;

  // Mover leaves `from`: pre-move type/lock/charge all come from `u` (never
  // from the post-move board/evo, which no longer reflect `from`'s old state).
  const moverTypeBefore = u.base ? u.base.moverType : P; // evolved-ep mover is always a pawn
  const moverClsBefore = classFor(moverTypeBefore, u.lkFrom, u.chFrom);
  toggleSparse(dst, l1w, hidden1, us, moverClsBefore, t.from, -1);

  // Mover lands at its final square: read directly off the post-move board —
  // this already reflects any promotion/evolution/charge change/downgrade.
  const landSq = t.to; // also correct for evolved ep: the mover lands on t.to (= ep.skipped)
  const finalType = pieceAt(s.pos, landSq);
  const finalCls = classIndexBB(finalType, landSq, s.evo);
  toggleSparse(dst, l1w, hidden1, us, finalCls, landSq, 1);

  // Capture removal, if any.
  if (u.evolvedEp) {
    const victimCls = classFor(u.epVictimType, false, undefined); // always an unlocked minor
    toggleSparse(dst, l1w, hidden1, them, victimCls, u.epVictim, -1);
  } else if (u.base && u.base.capType >= 0) {
    const capSq = u.base.capSq;
    const victimCls =
      capSq === t.to
        ? classFor(u.base.capType, u.lkTo, u.chTo) // normal capture: pre-move state at `to`
        : 0; // standard en passant: victim is always a pawn, at capSq !== to
    toggleSparse(dst, l1w, hidden1, them, victimCls, capSq, -1);
  }

  // Dense counters: only the mover's side ever changes (evoBitboard.ts).
  toggleDenseCounter(dst, l1w, hidden1, us, "minor_rights_us", "minor_rights_them", u.minorRights, s.evo.minorRights[us], RIGHTS_BUCKETS);
  toggleDenseCounter(dst, l1w, hidden1, us, "rook_rights_us", "rook_rights_them", u.rookRights, s.evo.rookRights[us], RIGHTS_BUCKETS);
  toggleDenseCounter(dst, l1w, hidden1, us, "pawn_progress_us", "pawn_progress_them", u.pawnProgress, s.evo.pawnProgress[us], N_MINOR);
  toggleDenseCounter(dst, l1w, hidden1, us, "minor_progress_us", "minor_progress_them", u.minorProgress, s.evo.minorProgress[us], M_ROOK);

  // ep_evolved: a single flag, active in both perspectives, independent of
  // colour — toggled directly rather than through toggleDenseCounter.
  const epBefore = u.epEvolved !== null;
  const epAfter = s.evo.epEvolved !== null;
  if (epBefore !== epAfter) {
    const idx = DENSE_OFFSETS.get("ep_evolved")!;
    const sign = epAfter ? 1 : -1;
    addRow(dst.w, l1w, hidden1, idx, sign);
    addRow(dst.b, l1w, hidden1, idx, sign);
  }
}
