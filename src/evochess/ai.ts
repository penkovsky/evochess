/**
 * Depth-limited minimax with alpha-beta pruning over "compound turns" (a
 * base move plus an optional evolutionary promotion decision). Port of
 * evochess/ai.py.
 */
import type { Color, Square, PieceSymbol } from "chess.js";
import { EvoChessGame, type ApplyMoveOptions } from "./game";

const PIECE_VALUES: Record<PieceSymbol, number> = {
  p: 1,
  n: 3,
  b: 3,
  r: 5,
  q: 9,
  k: 0,
};

export function evaluate(game: EvoChessGame): number {
  let score = 0;
  const board = game.chess.board();
  for (const row of board) {
    for (const cell of row) {
      if (!cell) continue;
      const value = PIECE_VALUES[cell.type];
      score += cell.color === "w" ? value : -value;
    }
  }
  if (game.chess.isCheckmate()) {
    // side to move is checkmated
    score += game.chess.turn() === "w" ? -1000 : 1000;
  }
  return score;
}

interface CandidateTurn {
  from: Square;
  to: Square;
  options: ApplyMoveOptions;
}

function candidateTurns(game: EvoChessGame): CandidateTurn[] {
  const color: Color = game.chess.turn();
  const candidates: CandidateTurn[] = [];
  const moves = game.chess.moves({ verbose: true });

  for (const move of moves) {
    const from = move.from as Square;
    const to = move.to as Square;
    const piece = game.chess.get(from);
    const isPawnMove = piece?.type === "p";
    const isMinorMove = piece?.type === "n" || piece?.type === "b";
    const reachesLastRank = isPawnMove && (to[1] === "8" || to[1] === "1");

    if (reachesLastRank) {
      for (const forced of ["q", "r", "b", "n"] as const) {
        candidates.push({ from, to, options: { forcedPromo: forced } });
      }
      continue;
    }

    candidates.push({ from, to, options: {} });

    if (isPawnMove && game.minorRights[color] > 0) {
      for (const minor of ["n", "b"] as const) {
        candidates.push({ from, to, options: { minorPromo: minor } });
      }
    }

    if (isMinorMove && game.rookRights[color] > 0) {
      candidates.push({ from, to, options: { rookPromo: true } });
    }
  }

  return candidates;
}

function shuffle<T>(arr: T[], rng: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Simple deterministic PRNG (mulberry32) so search results are reproducible
// given a seed, mirroring the Python implementation's random.Random(seed).
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function search(
  game: EvoChessGame,
  depth: number,
  alpha: number,
  beta: number,
  rng: () => number
): [number, CandidateTurn | null] {
  if (depth === 0 || game.isGameOver()) {
    return [evaluate(game), null];
  }

  const maximizing = game.chess.turn() === "w";
  const candidates = shuffle(candidateTurns(game), rng);
  let bestCandidate: CandidateTurn | null = null;

  if (maximizing) {
    let bestScore = -Infinity;
    for (const candidate of candidates) {
      const child = game.copy();
      child.applyMove(candidate.from, candidate.to, candidate.options);
      const [score] = search(child, depth - 1, alpha, beta, rng);
      if (score > bestScore) {
        bestScore = score;
        bestCandidate = candidate;
      }
      alpha = Math.max(alpha, bestScore);
      if (alpha >= beta) break;
    }
    return [bestScore, bestCandidate];
  } else {
    let bestScore = Infinity;
    for (const candidate of candidates) {
      const child = game.copy();
      child.applyMove(candidate.from, candidate.to, candidate.options);
      const [score] = search(child, depth - 1, alpha, beta, rng);
      if (score < bestScore) {
        bestScore = score;
        bestCandidate = candidate;
      }
      beta = Math.min(beta, bestScore);
      if (alpha >= beta) break;
    }
    return [bestScore, bestCandidate];
  }
}

export function chooseMove(game: EvoChessGame, depth: number, seed: number): CandidateTurn | null {
  const rng = mulberry32(seed);
  const [, candidate] = search(game, depth, -Infinity, Infinity, rng);
  return candidate;
}
