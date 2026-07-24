/**
 * PROTOTYPE integrated search on the bitboard `Position` (see bitboard.ts).
 *
 * A standard negamax + alpha-beta + quiescence over the base-chess layer, using
 * in-place make/unmake. It deliberately omits the transposition table and
 * iterative deepening so the node tree is a pure function of (eval, move order):
 * that lets a chess.js reference searcher with the *same* eval and ordering
 * visit exactly the same nodes, which both proves this search correct and makes
 * nodes/sec a clean substrate comparison. The EvoChess evolution layer (rights,
 * charges, evolved en passant) is not modelled here — it is identical work on
 * either substrate, so leaving it out does not bias the comparison.
 *
 * Evaluation is integer centipawns, so summation order cannot introduce
 * floating-point tie-breaking differences between the two searchers.
 */
import {
  type Position,
  generateLegal,
  makeMoveInPlace,
  unmakeMove,
  inCheck,
  pieceAt,
  epSquare,
  lsbIndex,
  moveFrom,
  moveTo,
  movePromo,
} from "./bitboard";

// Piece values in pawn units (for MVV-LVA ordering) and centipawns (for eval).
// Indexed by type: P N B R Q K. Mirrors ai.ts PIECE_VALUES.
export const ORDER_VALUE = [1, 3, 3, 5, 9, 0];
const VALUE_CP = [100, 300, 300, 500, 900, 0];
const MATE = 100_000;

// Piece-square tables in centipawns, rank-8-first, indexed by type P N B R Q K.
// Copied verbatim from ai.ts's PST so the two evaluations are identical.
export const PST: number[][] = [
  [ // P
    0, 0, 0, 0, 0, 0, 0, 0,
    60, 60, 60, 60, 60, 60, 60, 60,
    20, 20, 30, 40, 40, 30, 20, 20,
    10, 10, 20, 35, 35, 20, 10, 10,
    5, 5, 10, 25, 25, 10, 5, 5,
    5, 0, 0, 5, 5, 0, 0, 5,
    5, 10, 10, -10, -10, 10, 10, 5,
    0, 0, 0, 0, 0, 0, 0, 0,
  ],
  [ // N
    -50, -40, -30, -30, -30, -30, -40, -50,
    -40, -20, 0, 0, 0, 0, -20, -40,
    -30, 0, 10, 15, 15, 10, 0, -30,
    -30, 5, 15, 20, 20, 15, 5, -30,
    -30, 0, 15, 20, 20, 15, 0, -30,
    -30, 5, 10, 15, 15, 10, 5, -30,
    -40, -20, 0, 5, 5, 0, -20, -40,
    -50, -40, -30, -30, -30, -30, -40, -50,
  ],
  [ // B
    -20, -10, -10, -10, -10, -10, -10, -20,
    -10, 0, 0, 0, 0, 0, 0, -10,
    -10, 0, 5, 10, 10, 5, 0, -10,
    -10, 5, 5, 10, 10, 5, 5, -10,
    -10, 0, 10, 10, 10, 10, 0, -10,
    -10, 10, 10, 10, 10, 10, 10, -10,
    -10, 5, 0, 0, 0, 0, 5, -10,
    -20, -10, -10, -10, -10, -10, -10, -20,
  ],
  [ // R
    0, 0, 0, 0, 0, 0, 0, 0,
    5, 10, 10, 10, 10, 10, 10, 5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    0, 0, 0, 5, 5, 0, 0, 0,
  ],
  [ // Q
    -20, -10, -10, -5, -5, -10, -10, -20,
    -10, 0, 0, 0, 0, 0, 0, -10,
    -10, 0, 5, 5, 5, 5, 0, -10,
    -5, 0, 5, 5, 5, 5, 0, -5,
    0, 0, 5, 5, 5, 5, 0, -5,
    -10, 5, 5, 5, 5, 5, 0, -10,
    -10, 0, 5, 0, 0, 0, 0, -10,
    -20, -10, -10, -5, -5, -10, -10, -20,
  ],
  [ // K
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -20, -30, -30, -40, -40, -30, -30, -20,
    -10, -20, -20, -20, -20, -20, -20, -10,
    10, 10, 0, 0, 0, 0, 10, 10,
    10, 15, 5, 0, 0, 5, 15, 10,
  ],
];

/** PST index for a square from the given colour's view (0 = white). */
export function pstIndex(sq: number, color: number): number {
  const file = sq & 7;
  const rank = sq >> 3;
  const row = color === 0 ? 7 - rank : rank;
  return row * 8 + file;
}

/** Static evaluation, White-positive, integer centipawns. */
export function evalBB(pos: Position): number {
  let score = 0;
  for (let c = 0; c < 2; c++) {
    const sign = c === 0 ? 1 : -1;
    for (let t = 0; t < 6; t++) {
      let bb = pos.bb[c * 6 + t];
      const base = VALUE_CP[t];
      while (bb !== 0n) {
        const sq = lsbIndex(bb);
        bb &= bb - 1n;
        score += sign * (base + PST[t][pstIndex(sq, c)]);
      }
    }
  }
  return score;
}

/** MVV-LVA / promotion ordering key (higher = search earlier). */
export function orderKey(pos: Position, m: number): number {
  const from = moveFrom(m), to = moveTo(m), promo = movePromo(m);
  const attacker = pieceAt(pos, from);
  const isEp = attacker === 0 && to === epSquare(pos);
  const victimSq = isEp ? (pos.us === 0 ? to - 8 : to + 8) : to;
  const victim = pieceAt(pos, victimSq);
  let key = 0;
  if (victim >= 0) key += 1e6 + ORDER_VALUE[victim] * 10 - ORDER_VALUE[attacker];
  if (promo !== 0) key += promo === 4 ? 2e6 : 1e3;
  return key;
}

/** A capture, en-passant, or promotion — the moves quiescence resolves. */
export function isNoisy(pos: Position, m: number): boolean {
  const from = moveFrom(m), to = moveTo(m);
  if (movePromo(m) !== 0) return true;
  const attacker = pieceAt(pos, from);
  const isEp = attacker === 0 && to === epSquare(pos);
  const victimSq = isEp ? (pos.us === 0 ? to - 8 : to + 8) : to;
  return isEp || pieceAt(pos, victimSq) >= 0;
}

// Sort by key desc, packed-move int asc — a total order, so both searchers
// (which generate identical move sets) produce identical node trees.
function ordered(pos: Position, moves: number[]): number[] {
  return moves
    .map((m) => [orderKey(pos, m), m] as [number, number])
    .sort((a, b) => b[0] - a[0] || a[1] - b[1])
    .map((x) => x[1]);
}

let NODES = 0;

function quiesce(pos: Position, alpha: number, beta: number, ply: number): number {
  NODES++;
  const moves = generateLegal(pos);
  if (moves.length === 0) return inCheck(pos) ? -(MATE - ply) : 0;

  const sign = pos.us === 0 ? 1 : -1;
  const standPat = sign * evalBB(pos);
  if (standPat >= beta) return beta;
  if (standPat > alpha) alpha = standPat;

  for (const m of ordered(pos, moves.filter((mv) => isNoisy(pos, mv)))) {
    const u = makeMoveInPlace(pos, m);
    const s = -quiesce(pos, -beta, -alpha, ply + 1);
    unmakeMove(pos, u);
    if (s >= beta) return beta;
    if (s > alpha) alpha = s;
  }
  return alpha;
}

function negamax(pos: Position, depth: number, alpha: number, beta: number, ply: number): number {
  NODES++;
  const moves = generateLegal(pos);
  if (moves.length === 0) return inCheck(pos) ? -(MATE - ply) : 0;
  if (depth === 0) return quiesce(pos, alpha, beta, ply);

  let best = -Infinity;
  for (const m of ordered(pos, moves)) {
    const u = makeMoveInPlace(pos, m);
    const s = -negamax(pos, depth - 1, -beta, -alpha, ply + 1);
    unmakeMove(pos, u);
    if (s > best) best = s;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;
  }
  return best;
}

export interface SearchResult {
  score: number; // side-to-move-relative centipawns
  move: number; // packed best move, or -1
  nodes: number;
}

/** Fixed-depth negamax root. No TT / iterative deepening (see module note). */
export function searchBB(pos: Position, depth: number): SearchResult {
  NODES = 1;
  const moves = ordered(pos, generateLegal(pos));
  let best = -Infinity, bestMove = -1, alpha = -Infinity;
  for (const m of moves) {
    const u = makeMoveInPlace(pos, m);
    const s = -negamax(pos, depth - 1, -Infinity, -alpha, 1);
    unmakeMove(pos, u);
    if (s > best) { best = s; bestMove = m; }
    if (best > alpha) alpha = best;
  }
  return { score: best, move: bestMove, nodes: NODES };
}
