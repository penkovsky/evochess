/**
 * PROTOTYPE full EvoChess search on the bitboard substrate.
 *
 * Assembles the pieces: compound-turn generation + make/unmake (evoBitboard.ts)
 * driven by a negamax + alpha-beta + quiescence with an integer-centipawn
 * evaluation that includes the EvoChess rook-charge decay. No transposition
 * table / iterative deepening — those sit identically on either substrate, so
 * leaving them out keeps the node tree a pure function of (eval, move order) and
 * lets a reference EvoChessGame search visit the same nodes (see the benchmark).
 */
import { pieceAt, bitAt, inCheck, lsbIndex, insufficientMaterial } from "./bitboard";
import {
  type EvoPos,
  type EvoTurn,
  type EvoUndo,
  generateEvoTurns,
  applyEvoTurn,
  undoEvoTurn,
  turnKey,
} from "./evoBitboard";
import { PST, pstIndex } from "./bitboardSearch";
import { applyAccum, createAcc, createAccStack, evalAcc, refresh, type Acc, type Perspective } from "./nnueAccum";
import { hasNnueWeights, getNnueWeights, type NnueWeights } from "./nnue";

const MATE = 100_000;
const VALUE_CP = [100, 300, 300, 500, 900, 0]; // P N B R Q K
const P = 0, R = 3;
const fileOf = (sq: number): number => sq & 7;

// A rook's centipawn value decays linearly with remaining charges, matching
// ai.ts rookValue: 3 + 2*(charges/5) pawns → 300 + 40*charges centipawns.
const rookCp = (charges: number): number => 300 + 40 * charges;

// Whether the current search should evaluate with the net rather than PST.
// Captured once per search entry (searchEvoTT / searchEvoTTTimed) into this
// module-level boolean, per nnue-bitboard-port-spec.md §4: the PST path must
// stay exactly as fast when NNUE is off, so `evalPos` below costs one boolean
// load in that case, nothing more.
let USE_NNUE = false;

// The incremental accumulator stack (nnue-accumulator-spec.md §3, §8):
// preallocated once per loaded net and reused across searches. Sized well
// past any depth + quiescence extension this search realistically reaches;
// `evalPos`'s fallback below covers the (not expected) case where it isn't.
const ACC_STACK_SIZE = 256;
let accStack: Acc[] | null = null;
let accWeights: NnueWeights | null = null;

function ensureAccStack(weights: NnueWeights): Acc[] {
  if (accStack === null || accWeights !== weights) {
    accStack = createAccStack(weights, ACC_STACK_SIZE);
    accWeights = weights;
  }
  return accStack;
}

/** Static evaluation, White-positive, integer centipawns (with rook decay). */
export function evalEvo(s: EvoPos): number {
  const { pos, evo } = s;
  let score = 0;
  for (let c = 0; c < 2; c++) {
    const sign = c === 0 ? 1 : -1;
    for (let t = 0; t < 6; t++) {
      let bb = pos.bb[c * 6 + t];
      while (bb !== 0n) {
        const sq = lsbIndex(bb);
        bb &= bb - 1n;
        const v = t === R ? rookCp(evo.charges.get(sq) ?? 5) : VALUE_CP[t];
        score += sign * (v + PST[t][pstIndex(sq, c)]);
      }
    }
  }
  return score;
}

// Capture classification for a turn: whether it takes a piece, and the victim
// type (for MVV-LVA). Handles normal captures, standard ep, and evolved ep.
function captureInfo(s: EvoPos, t: EvoTurn): { isCapture: boolean; victim: number } {
  const { pos, evo } = s;
  const from = t.from, to = t.to;
  const attacker = pieceAt(pos, from);
  if (attacker === P) {
    const ep = evo.epEvolved;
    if (ep && to === ep.skipped && fileOf(from) !== fileOf(to) && pieceAt(pos, to) < 0) {
      return { isCapture: true, victim: pieceAt(pos, ep.victim) };
    }
    if (to === pos.ep && pos.ep >= 0 && fileOf(from) !== fileOf(to) && pieceAt(pos, to) < 0) {
      return { isCapture: true, victim: P };
    }
  }
  const vt = pieceAt(pos, to);
  if (vt >= 0 && (pos.occ[pos.us ^ 1] & bitAt(to)) !== 0n) return { isCapture: true, victim: vt };
  return { isCapture: false, victim: -1 };
}

// MVV-LVA + promotion ordering key (higher = search earlier).
function turnOrderKey(s: EvoPos, t: EvoTurn): number {
  const { isCapture, victim } = captureInfo(s, t);
  const attacker = pieceAt(s.pos, t.from);
  let key = 0;
  if (isCapture) key += 1e6 + (victim >= 0 ? victim : 0) * 10 - attacker;
  if (t.forced) key += t.forced === "q" ? 2e6 : 1e3;
  else if (t.minor || t.rook) key += 5e5;
  return key;
}

// Ordering with a deterministic tie-break by canonical turn key.
function orderTurns(s: EvoPos, turns: EvoTurn[]): EvoTurn[] {
  const scored = turns.map((t) => ({ t, key: turnOrderKey(s, t), tie: turnKey(t) }));
  scored.sort((a, b) => b.key - a.key || (a.tie < b.tie ? -1 : 1));
  return scored.map((x) => x.t);
}

// Root ordering with a *seeded* tie-break: equal-ordering-key turns are shuffled
// per seed, so among moves the search ends up valuing equally a different one is
// examined (and thus chosen) first each seed — the bitboard engine's equivalent
// of ai.ts's move jitter, giving varied games without changing strength.
function orderRoot(s: EvoPos, turns: EvoTurn[], hint: EvoTurn | null, rng: () => number): EvoTurn[] {
  const scored = turns.map((t) => ({ t, key: turnOrderKey(s, t), tie: rng() }));
  scored.sort((a, b) => b.key - a.key || a.tie - b.tie);
  const arr = scored.map((x) => x.t);
  if (hint) {
    const idx = arr.findIndex((t) => sameTurn(t, hint));
    if (idx > 0) { const [el] = arr.splice(idx, 1); arr.unshift(el); }
  }
  return arr;
}

// Small float PRNG (mulberry32), matching ai.ts, for the seeded root tie-break.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const isNoisy = (s: EvoPos, t: EvoTurn): boolean => !!t.forced || captureInfo(s, t).isCapture;

// Whether either side still has a minor that could one day become a rook (a
// knight/bishop not permanently locked by a prior downgrade). Mirrors game.ts
// `hasPromotableMinor`: a lone such minor is not yet a draw in EvoChess.
const hasPromotableMinor = (s: EvoPos): boolean => {
  const { pos, evo } = s;
  for (let c = 0; c < 2; c++) {
    let bb = pos.bb[c * 6 + 1] | pos.bb[c * 6 + 2]; // knights | bishops
    while (bb !== 0n) {
      const sq = lsbIndex(bb);
      bb &= bb - 1n;
      if (!evo.locked.has(sq)) return true;
    }
  }
  return false;
};

// A non-mating terminal draw the search must recognise in-tree, matching the
// reference engine's copy-from-FEN searcher (which sees the fifty-move clock and
// the board, but not repetition history — that stays a game-driver concern).
// Insufficient material only draws once no minor can still promote to a rook,
// matching game.ts `isGameOver`.
const isDraw = (s: EvoPos): boolean =>
  s.evo.half >= 100 || (insufficientMaterial(s.pos) && !hasPromotableMinor(s));

let NODES = 0;

// Side-to-move-relative centipawns: PST when NNUE is off (White-positive
// evalEvo flipped by `sign`), the net's pawn score (via the incremental
// accumulator, nnue-accumulator-spec.md §7) scaled to centipawns when it's
// on — `evalAcc` is already side-to-move-relative, so no sign flip there
// (matching `forwardActive`'s convention, nnue-bitboard-port-spec.md §4).
function evalPos(s: EvoPos, ply: number): number {
  if (USE_NNUE) {
    const stack = accStack!, weights = accWeights!;
    if (ply < stack.length) {
      return Math.round(100 * evalAcc(stack[ply], s.pos.us as Perspective, weights));
    }
    // Defensive fallback for quiescence going deeper than ACC_STACK_SIZE
    // (not expected in practice — a full refresh rather than an out-of-bounds read).
    const acc = createAcc(weights);
    refresh(acc, s, weights);
    return Math.round(100 * evalAcc(acc, s.pos.us as Perspective, weights));
  }
  return (s.pos.us === 0 ? 1 : -1) * evalEvo(s);
}

// Update the accumulator stack for a child just reached at ply `p + 1`, iff
// NNUE is on and within the preallocated stack (see the fallback above).
function accumApply(p: number, s: EvoPos, t: EvoTurn, u: EvoUndo): void {
  if (USE_NNUE && p + 1 < accStack!.length) applyAccum(accStack!, p, s, t, u, accWeights!);
}

function quiesce(s: EvoPos, alpha: number, beta: number, ply: number): number {
  NODES++;
  const turns = generateEvoTurns(s);
  if (turns.length === 0) return inCheck(s.pos) ? -(MATE - ply) : 0;
  if (isDraw(s)) return 0;

  const standPat = evalPos(s, ply);
  if (standPat >= beta) return beta;
  if (standPat > alpha) alpha = standPat;

  for (const t of orderTurns(s, turns.filter((tt) => isNoisy(s, tt)))) {
    const u = applyEvoTurn(s, t);
    accumApply(ply, s, t, u);
    const score = -quiesce(s, -beta, -alpha, ply + 1);
    undoEvoTurn(s, u);
    if (score >= beta) return beta;
    if (score > alpha) alpha = score;
  }
  return alpha;
}

function negamax(s: EvoPos, depth: number, alpha: number, beta: number, ply: number): number {
  NODES++;
  const turns = generateEvoTurns(s);
  if (turns.length === 0) return inCheck(s.pos) ? -(MATE - ply) : 0;
  if (isDraw(s)) return 0;
  if (depth === 0) return quiesce(s, alpha, beta, ply);

  let best = -Infinity;
  for (const t of orderTurns(s, turns)) {
    const u = applyEvoTurn(s, t);
    const score = -negamax(s, depth - 1, -beta, -alpha, ply + 1);
    undoEvoTurn(s, u);
    if (score > best) best = score;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;
  }
  return best;
}

export interface EvoSearchResult {
  score: number; // side-to-move-relative centipawns
  turn: EvoTurn | null;
  nodes: number;
}

/** Fixed-depth negamax root over compound EvoChess turns. */
export function searchEvo(s: EvoPos, depth: number): EvoSearchResult {
  NODES = 1;
  USE_NNUE = false; // PST-only entry point; must not inherit a prior TT-search's flag
  let best = -Infinity, bestTurn: EvoTurn | null = null, alpha = -Infinity;
  for (const t of orderTurns(s, generateEvoTurns(s))) {
    const u = applyEvoTurn(s, t);
    const score = -negamax(s, depth - 1, -Infinity, -alpha, 1);
    undoEvoTurn(s, u);
    if (score > best) { best = score; bestTurn = t; }
    if (best > alpha) alpha = best;
  }
  return { score: best, turn: bestTurn, nodes: NODES };
}

// ---------------------------------------------------------------------------
// Zobrist transposition table + iterative deepening
//
// The plain `searchEvo` above visits an identical node tree to a reference
// EvoChessGame search (that is how it was validated). This variant adds a
// Zobrist-keyed TT and iterative deepening on top. It returns the *same* root
// score as `searchEvo` at equal depth — the TT stores exact bounds and, to keep
// that guarantee airtight, never caches mate-range scores (those rare subtrees
// are simply re-searched), so no cross-ply mate-distance skew can leak in. The
// win is node reduction: transposed subtrees and the previous iteration's best
// move (as the first move tried) both come for free.
// ---------------------------------------------------------------------------

const MASK64 = (1n << 64n) - 1n;

/** SplitMix64 → 64-bit BigInts, for deterministic Zobrist tables. */
function makeRng(seed: bigint): () => bigint {
  let state = seed & MASK64;
  return () => {
    state = (state + 0x9e3779b97f4a7c15n) & MASK64;
    let z = state;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK64;
    return (z ^ (z >> 31n)) & MASK64;
  };
}

const rnd = makeRng(0x1234_5678_9abc_def0n);
const rndOdd = (): bigint => rnd() | 1n; // odd → invertible mod 2^64 (no value collisions)
const table64 = (n: number, f: () => bigint): bigint[] => Array.from({ length: n }, f);

const Z_PIECE = table64(12, () => 0n).map(() => table64(64, rnd)); // [c*6+t][sq]
const Z_SIDE = rnd();
const Z_EP = table64(64, rnd); // standard en-passant target square
const Z_EEP_SKIP = table64(64, rnd); // evolved-ep: skipped square
const Z_EEP_VIC = table64(64, rnd); // evolved-ep: victim square
const Z_EEP_COLOR = rnd();
const Z_COUNT = table64(8, rndOdd); // [minorR/rookR/pawnProg/minorProg × w,b], folded by value
const Z_CHARGE = table64(64, rndOdd); // per-square rook charges, folded by value
const Z_LOCK = table64(64, rnd); // per-square downgrade lock
const Z_HALF = rndOdd(); // fifty-move clock, folded by value (a fifty-move draw depends on it)

const mix = (z: bigint, v: number): bigint => (v === 0 ? 0n : (z * BigInt(v)) & MASK64);

/** Full Zobrist key of an EvoPos (board + side + both ep flavours + evo state). */
function hashEvo(s: EvoPos): bigint {
  const { pos, evo } = s;
  let h = 0n;
  for (let idx = 0; idx < 12; idx++) {
    let bb = pos.bb[idx];
    const tbl = Z_PIECE[idx];
    while (bb !== 0n) {
      const sq = lsbIndex(bb);
      bb &= bb - 1n;
      h ^= tbl[sq];
    }
  }
  if (pos.us === 1) h ^= Z_SIDE;
  if (pos.ep >= 0) h ^= Z_EP[pos.ep];
  const ep = evo.epEvolved;
  if (ep) h ^= Z_EEP_SKIP[ep.skipped] ^ Z_EEP_VIC[ep.victim] ^ (ep.color ? Z_EEP_COLOR : 0n);
  h ^= mix(Z_COUNT[0], evo.minorRights[0]) ^ mix(Z_COUNT[1], evo.minorRights[1]);
  h ^= mix(Z_COUNT[2], evo.rookRights[0]) ^ mix(Z_COUNT[3], evo.rookRights[1]);
  h ^= mix(Z_COUNT[4], evo.pawnProgress[0]) ^ mix(Z_COUNT[5], evo.pawnProgress[1]);
  h ^= mix(Z_COUNT[6], evo.minorProgress[0]) ^ mix(Z_COUNT[7], evo.minorProgress[1]);
  for (const [sq, c] of evo.charges) h ^= mix(Z_CHARGE[sq], c);
  for (const sq of evo.locked) h ^= Z_LOCK[sq];
  h ^= mix(Z_HALF, evo.half);
  return h & MASK64;
}

// Transposition table: fixed-size, always-replace, generation-stamped so a new
// search invalidates old entries without clearing megabytes of memory.
const TT_BITS = 20;
const TT_SIZE = 1 << TT_BITS;
const TT_IDX = BigInt(TT_SIZE - 1);
const ttKey = new BigUint64Array(TT_SIZE);
const ttScore = new Int32Array(TT_SIZE);
const ttDepth = new Int8Array(TT_SIZE);
const ttFlag = new Int8Array(TT_SIZE);
const ttGen = new Int32Array(TT_SIZE);
const ttMoveArr: (EvoTurn | null)[] = table64(TT_SIZE, () => 0n).map(() => null);
let GEN = 0;

const EXACT = 1, LOWER = 2, UPPER = 3;
const MATE_THRESHOLD = MATE - 1000;

const sameTurn = (a: EvoTurn, b: EvoTurn): boolean =>
  a.from === b.from && a.to === b.to && a.forced === b.forced &&
  a.minor === b.minor && a.rook === b.rook && a.down === b.down;

/** Order turns, but search a hint move (TT / previous iteration) first. */
function orderTurnsHint(s: EvoPos, turns: EvoTurn[], hint: EvoTurn | null): EvoTurn[] {
  const arr = orderTurns(s, turns);
  if (hint) {
    const idx = arr.findIndex((t) => sameTurn(t, hint));
    if (idx > 0) { const [el] = arr.splice(idx, 1); arr.unshift(el); }
  }
  return arr;
}

function negamaxTT(s: EvoPos, depth: number, alpha: number, beta: number, ply: number): number {
  NODES++;
  if (depth === 0) return quiesce(s, alpha, beta, ply);

  const h = hashEvo(s);
  const i = Number(h & TT_IDX);
  let ttMove: EvoTurn | null = null;
  if (ttGen[i] === GEN && ttKey[i] === h) {
    ttMove = ttMoveArr[i];
    if (ttDepth[i] >= depth) {
      const eScore = ttScore[i], eFlag = ttFlag[i];
      if (eFlag === EXACT) return eScore;
      if (eFlag === LOWER) { if (eScore > alpha) alpha = eScore; }
      else if (eScore < beta) beta = eScore;
      if (alpha >= beta) return eScore;
    }
  }

  const turns = generateEvoTurns(s);
  if (turns.length === 0) return inCheck(s.pos) ? -(MATE - ply) : 0;
  if (isDraw(s)) return 0;

  const alphaOrig = alpha;
  let best = -Infinity, bestTurn: EvoTurn | null = null;
  for (const t of orderTurnsHint(s, turns, ttMove)) {
    const u = applyEvoTurn(s, t);
    accumApply(ply, s, t, u);
    const score = -negamaxTT(s, depth - 1, -beta, -alpha, ply + 1);
    undoEvoTurn(s, u);
    if (score > best) { best = score; bestTurn = t; }
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;
  }

  // Cache exact bounds, but never mate scores: their value is ply-dependent, so
  // caching them across transpositions at different plies could skew the result.
  if (best < MATE_THRESHOLD && best > -MATE_THRESHOLD) {
    ttKey[i] = h;
    ttScore[i] = best;
    ttDepth[i] = depth;
    ttFlag[i] = best <= alphaOrig ? UPPER : best >= beta ? LOWER : EXACT;
    ttMoveArr[i] = bestTurn;
    ttGen[i] = GEN;
  }
  return best;
}

/** One full-window root pass at a fixed depth; seeds ordering with `hint`.
 * With `rng`, equal-value moves are chosen at random (per seed) for variety. */
function rootSearch(s: EvoPos, depth: number, hint: EvoTurn | null, rng?: () => number): EvoSearchResult {
  const turns = generateEvoTurns(s);
  const ordered = rng ? orderRoot(s, turns, hint, rng) : orderTurnsHint(s, turns, hint);
  let best = -Infinity, bestTurn: EvoTurn | null = null, alpha = -Infinity;
  for (const t of ordered) {
    const u = applyEvoTurn(s, t);
    accumApply(0, s, t, u); // root is implicitly ply 0
    const score = -negamaxTT(s, depth - 1, -Infinity, -alpha, 1);
    undoEvoTurn(s, u);
    if (score > best) { best = score; bestTurn = t; }
    if (best > alpha) alpha = best;
  }
  return { score: best, turn: bestTurn, nodes: NODES };
}

// Set USE_NNUE for this search entry and, if on, (re)build the root
// accumulator via a full refresh — every node below reads/writes off it.
function beginNnueSearch(s: EvoPos, useNnue: boolean): void {
  USE_NNUE = useNnue && hasNnueWeights();
  if (USE_NNUE) {
    const weights = getNnueWeights()!;
    const stack = ensureAccStack(weights);
    refresh(stack[0], s, weights);
  }
}

/**
 * Iterative-deepening negamax with a Zobrist transposition table. Returns the
 * same root score as `searchEvo(s, maxDepth)` but visits far fewer nodes.
 */
export function searchEvoTT(
  s: EvoPos,
  maxDepth: number,
  seed?: number,
  useNnue = false
): EvoSearchResult {
  GEN++;
  NODES = 1;
  beginNnueSearch(s, useNnue);
  const rng = seed === undefined ? undefined : mulberry32(seed);
  let result: EvoSearchResult = { score: 0, turn: null, nodes: 0 };
  for (let d = 1; d <= maxDepth; d++) {
    result = rootSearch(s, d, result.turn, rng);
  }
  return { score: result.score, turn: result.turn, nodes: NODES };
}

export interface EvoSearchTimedResult extends EvoSearchResult {
  depth: number; // deepest iteration that completed
}

/**
 * Like `searchEvoTT`, but bounded by a wall-clock budget instead of a fixed
 * depth: deepens until `timeMs` elapses (checked between iterations, so each
 * reported depth completed fully), or a mate is found. Mirrors `ai.ts`
 * `searchRootTimed` so the two backends can be A/B'd at equal time.
 */
export function searchEvoTTTimed(
  s: EvoPos,
  timeMs: number,
  maxDepth = 64,
  seed?: number,
  useNnue = false
): EvoSearchTimedResult {
  GEN++;
  NODES = 1;
  beginNnueSearch(s, useNnue);
  const rng = seed === undefined ? undefined : mulberry32(seed);
  const deadline = Date.now() + timeMs;
  let best: EvoTurn | null = null, score = 0, depth = 0;
  for (let d = 1; d <= maxDepth; d++) {
    const r = rootSearch(s, d, best, rng);
    best = r.turn; score = r.score; depth = d;
    if (score >= MATE_THRESHOLD || score <= -MATE_THRESHOLD) break; // mate found
    if (Date.now() >= deadline) break;
  }
  return { score, turn: best, nodes: NODES, depth };
}
