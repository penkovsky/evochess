/**
 * Legal-position sampler for NNUE data coverage (see
 * `nnue-data-coverage-spec.md`, mechanism 1 & 2). Builds a random but legal
 * `EvoChessGame` position that deliberately over-samples rooks and queens
 * relative to natural self-play, so downstream consumers (seeded self-play,
 * material augmentation) can teach the net piece values it never otherwise
 * sees.
 *
 * Construction is legal-by-design where possible (kings placed first and
 * checked for adjacency, pawns confined to ranks 3-6 — see `isPawnRank`)
 * with a final
 * validate-and-reject pass for the properties that are cheapest to check
 * after the fact (opponent not left in check, position not already
 * game-over, at least one legal move).
 */
import { SQUARES, type Color, type PieceSymbol, type Square } from "chess.js";
import { EvoChessGame } from "../src/evochess/game";

export interface PieceCounts {
  p: number;
  n: number;
  b: number;
  r: number;
  q: number;
}

// Weights (unnormalised) for how many of each piece type a side gets, index
// = count. Deliberately fatter in the rook/queen tail than natural self-play
// ever reaches — that skew is the whole point of this sampler. Starting
// knobs, not doctrine: retune against the coverage histogram once the
// generator is producing data.
// Pawns capped at 5 (not 8): a densely-packed, randomly-placed pawn chain
// creates far more simultaneous diagonal-capture options than any pawn
// structure that arises from actual play, and each one is a "noisy" move
// quiescence must explore — see MAX_NON_PAWN_PIECES below for the matching
// non-pawn-piece rationale, measured against real searchRoot calls.
export const MATERIAL_WEIGHTS: Record<keyof PieceCounts, number[]> = {
  p: [6, 10, 10, 8, 5, 3], // 0..5 pawns, weighted toward the low-mid range
  n: [40, 45, 15], // 0..2 knights
  b: [40, 45, 15], // 0..2 bishops
  r: [35, 40, 25], // 0..2 rooks, over-sampled
  q: [55, 35, 10], // 0..2 queens, over-sampled
};

const MAX_ATTEMPTS = 200;

function weightedIndex(weights: number[], rng: () => number): number {
  const total = weights.reduce((a, b) => a + b, 0);
  let x = rng() * total;
  for (let i = 0; i < weights.length; i++) {
    x -= weights[i];
    if (x < 0) return i;
  }
  return weights.length - 1;
}

function shuffle<T>(items: T[], rng: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

function fileOf(sq: Square): number {
  return sq.charCodeAt(0) - 97;
}

function rankOf(sq: Square): number {
  return sq.charCodeAt(1) - 49; // 0-indexed, '1' -> 0
}

/**
 * Ranks 3-6, not the spec's full 2-7: a pawn placed on the rank just before
 * its own promotion (7 for White, 2 for Black) has its queening move counted
 * as "noisy" by quiescence, which explores every capture/promotion line to a
 * 32-ply cap. A handful of such pawns on an otherwise-random, densely packed
 * board (no natural position ever looks like this) blows the branching
 * factor up combinatorially — measured hangs of minutes-plus on a single
 * depth-1 `searchRoot` call. Excluding those two ranks removes the "noisy"
 * move entirely (a push from rank 3/6 is quiet, so quiescence never plays
 * it) without touching search, per the spec's non-goals.
 */
function isPawnRank(sq: Square): boolean {
  const r = rankOf(sq);
  return r >= 2 && r <= 5; // ranks 3-6
}

function kingsAdjacent(a: Square, b: Square): boolean {
  return Math.abs(fileOf(a) - fileOf(b)) <= 1 && Math.abs(rankOf(a) - rankOf(b)) <= 1;
}

/** Sample one side's material multiset from `MATERIAL_WEIGHTS`. */
export function sampleSideMaterial(rng: () => number): PieceCounts {
  return {
    p: weightedIndex(MATERIAL_WEIGHTS.p, rng),
    n: weightedIndex(MATERIAL_WEIGHTS.n, rng),
    b: weightedIndex(MATERIAL_WEIGHTS.b, rng),
    r: weightedIndex(MATERIAL_WEIGHTS.r, rng),
    q: weightedIndex(MATERIAL_WEIGHTS.q, rng),
  };
}

/** Nudge one side's counts by a single +/-1 piece edit, clamped to the weight table's range. */
function perturb(base: PieceCounts, rng: () => number): PieceCounts {
  const counts = { ...base };
  const types: (keyof PieceCounts)[] = ["p", "n", "b", "r", "q"];
  const type = types[Math.floor(rng() * types.length)];
  const delta = rng() < 0.5 ? -1 : 1;
  const max = MATERIAL_WEIGHTS[type].length - 1;
  counts[type] = clamp(counts[type] + delta, 0, max);
  return counts;
}

/**
 * Sample the opposing side's material given one side's, so imbalance spans a
 * controlled range instead of piling up at either extreme: often mirrored
 * (balanced), sometimes a single-piece edit, occasionally a fully independent
 * (and so potentially large) imbalance.
 */
export function sampleOpponentMaterial(base: PieceCounts, rng: () => number): PieceCounts {
  const r = rng();
  if (r < 0.5) return { ...base };
  if (r < 0.85) return perturb(base, rng);
  return sampleSideMaterial(rng);
}

// Independently drawing each of {n, b, r, q} up to 2 lets one side reach 8
// non-pawn pieces — the "8-queen monstrosity" the spec explicitly warns
// against, and measured to blow quiescence's search tree up combinatorially
// (a maximally loaded board gives every capture line dozens of replies).
// Reject and resample rather than tune the individual weights down, so the
// oversampling of any *one* piece type (the actual goal) is undisturbed.
const MAX_NON_PAWN_PIECES = 4;

function withinPieceBudget(counts: PieceCounts): boolean {
  return counts.n + counts.b + counts.r + counts.q <= MAX_NON_PAWN_PIECES;
}

function expandRequests(counts: PieceCounts, color: Color): { type: PieceSymbol; color: Color }[] {
  const out: { type: PieceSymbol; color: Color }[] = [];
  (["p", "n", "b", "r", "q"] as const).forEach((type) => {
    for (let i = 0; i < counts[type]; i++) out.push({ type, color });
  });
  return out;
}

function buildFen(
  pieces: Map<Square, { type: PieceSymbol; color: Color }>,
  turn: Color
): string {
  const grid: (string | null)[][] = Array.from({ length: 8 }, () => Array(8).fill(null));
  for (const [sq, piece] of pieces) {
    const file = fileOf(sq);
    const rank = rankOf(sq);
    const symbol = piece.color === "w" ? piece.type.toUpperCase() : piece.type;
    grid[7 - rank][file] = symbol;
  }
  const rows = grid.map((row) => {
    let out = "";
    let empty = 0;
    for (const cell of row) {
      if (cell === null) {
        empty += 1;
        continue;
      }
      if (empty > 0) {
        out += String(empty);
        empty = 0;
      }
      out += cell;
    }
    if (empty > 0) out += String(empty);
    return out;
  });
  return `${rows.join("/")} ${turn} - - 0 1`;
}

/** Random int in [lo, hi], inclusive. */
function randInt(lo: number, hi: number, rng: () => number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

function tryBuild(rng: () => number): EvoChessGame | null {
  const shuffled = shuffle(SQUARES as Square[], rng);

  const whiteKing = shuffled[0];
  const blackKing = shuffled.slice(1).find((sq) => !kingsAdjacent(sq, whiteKing));
  if (!blackKing) return null;

  const used = new Set<Square>([whiteKing, blackKing]);
  const white = sampleSideMaterial(rng);
  const black = sampleOpponentMaterial(white, rng);
  if (!withinPieceBudget(white) || !withinPieceBudget(black)) return null;

  const pieces = new Map<Square, { type: PieceSymbol; color: Color }>();
  pieces.set(whiteKing, { type: "k", color: "w" });
  pieces.set(blackKing, { type: "k", color: "b" });

  // Pawns first, confined to ranks 3-6 (see isPawnRank), so the remaining-square pool for
  // other piece types isn't accidentally starved of pawn-legal squares.
  const pawnEligible = shuffled.filter((sq) => !used.has(sq) && isPawnRank(sq));
  const totalPawns = white.p + black.p;
  if (totalPawns > pawnEligible.length) return null;
  const pawnRequests = [
    ...expandRequests({ p: white.p, n: 0, b: 0, r: 0, q: 0 }, "w"),
    ...expandRequests({ p: black.p, n: 0, b: 0, r: 0, q: 0 }, "b"),
  ];
  pawnRequests.forEach((req, i) => {
    const sq = pawnEligible[i];
    pieces.set(sq, req);
    used.add(sq);
  });

  // Everything else (knights/bishops/rooks/queens) on any remaining square.
  const otherEligible = shuffled.filter((sq) => !used.has(sq));
  const otherRequests = [
    ...expandRequests({ ...white, p: 0 }, "w"),
    ...expandRequests({ ...black, p: 0 }, "b"),
  ];
  if (otherRequests.length > otherEligible.length) return null;
  otherRequests.forEach((req, i) => {
    const sq = otherEligible[i];
    pieces.set(sq, req);
    used.add(sq);
  });

  const turn: Color = rng() < 0.5 ? "w" : "b";
  const fen = buildFen(pieces, turn);

  const game = new EvoChessGame();
  try {
    game.chess.load(fen);
  } catch {
    return null;
  }

  // -- evolution state: rook charges, locked minors, rights, progress --
  for (const [sq, piece] of pieces) {
    if (piece.type === "r") game.rookCharges.set(sq, randInt(1, 5, rng));
    if ((piece.type === "n" || piece.type === "b") && rng() < 0.15) game.rookLocked.add(sq);
  }
  game.minorRights = { w: randInt(0, 2, rng), b: randInt(0, 2, rng) };
  game.rookRights = { w: randInt(0, 2, rng), b: randInt(0, 2, rng) };
  game.pawnMoveProgress = { w: randInt(0, 2, rng), b: randInt(0, 2, rng) };
  game.minorMoveProgress = { w: randInt(0, 2, rng), b: randInt(0, 2, rng) };
  game.epEvolved = null;

  if (!isLegalSeed(game)) return null;
  return game;
}

/**
 * The properties that are cheaper to check after construction than to
 * guarantee structurally: the side not to move must not be in check (an
 * impossible position — they'd have had to answer it on the prior move), the
 * position must not already be over, and there must be at least one legal
 * `EvoChessGame` move so `searchRoot` never sees a dead position.
 */
function isLegalSeed(game: EvoChessGame): boolean {
  const stm = game.chess.turn();
  const opponent: Color = stm === "w" ? "b" : "w";
  const opponentKing = game.chess.findPiece({ type: "k", color: opponent })[0];
  if (!opponentKing) return false;
  if (game.chess.isAttacked(opponentKing, stm)) return false;
  if (game.isGameOver()) return false;
  if (game.legalMoves().length === 0) return false;
  return true;
}

/**
 * Sample a legal, material-rich `EvoChessGame` seed position: kings placed
 * non-adjacently, material drawn per `MATERIAL_WEIGHTS` (over-sampling rooks
 * and queens), pieces dropped on random empty squares (pawns on ranks 2-7
 * only), and evolution state (rook charges, locks, rights, progress) sampled
 * to plausible ranges. Retries internally on a rejected draw; throws if it
 * can't find a legal position within `maxAttempts` (should be exceedingly
 * rare — most rejections are the king-adjacency or opponent-in-check checks,
 * both cheap to redraw).
 */
export function sampleSeedPosition(rng: () => number, maxAttempts = MAX_ATTEMPTS): EvoChessGame {
  for (let i = 0; i < maxAttempts; i++) {
    const game = tryBuild(rng);
    if (game) return game;
  }
  throw new Error(`sampleSeedPosition: no legal position found in ${maxAttempts} attempts`);
}
