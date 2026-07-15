/**
 * Negamax with alpha-beta pruning over "compound turns" (a base move plus an
 * optional evolutionary promotion decision), plus iterative deepening, a
 * transposition table, move ordering (TT move / MVV-LVA / killers) and a
 * quiescence search.
 */
import type { Color, Square, PieceSymbol } from "chess.js";
import { EvoChessGame, ROOK_CHARGES, type ApplyMoveOptions } from "./game";

const PIECE_VALUES: Record<PieceSymbol, number> = {
  p: 1,
  n: 3,
  b: 3,
  r: 5,
  q: 9,
  k: 0,
};

// Mate scores are kept well clear of any reachable material score so that
// `isMateScore` can distinguish them. Scored as MATE - ply so that a mate
// found sooner outranks the same mate found later.
const MATE = 100_000;
const MATE_THRESHOLD = MATE - 1000;

// Bound on how deep quiescence may recurse past the nominal horizon. Captures
// are finite, but there are enough of them in a busy middlegame to be worth a
// hard stop.
const MAX_QUIESCE_PLY = 32;

// A rook is a wasting asset: once its last charge is spent it becomes a minor,
// so its value decays from a full rook toward a minor as charges drain rather
// than dropping off a cliff on the final move. Linear between the two, which
// keeps a 1-charge rook (3.4) clearly above a minor — it still has one rook
// move left to spend.
function rookValue(charges: number): number {
  const minor = PIECE_VALUES.n;
  return minor + (PIECE_VALUES.r - minor) * (charges / ROOK_CHARGES);
}

// -- piece-square tables ------------------------------------------------
// Centipawns from White's point of view, written rank 8 (top) down to rank 1
// (bottom) so the tables read like a board. Divided by 100 at lookup, since
// PIECE_VALUES are in pawn units. Deliberately mild: they exist to break ties
// between material-equal moves, not to overrule material.
//
// EvoChess-specific deviations from the usual chess tables:
//   - Pawns: advancement is worth more than in chess, because every pawn move
//     also feeds the "To Minor Piece Promotion" counter.
//   - King: there is no castling, so the usual "hide in the castled corner"
//     shape is replaced by a mild preference for staying off the open centre.
const PST: Record<PieceSymbol, number[]> = {
  p: [
      0,  0,  0,  0,  0,  0,  0,  0,
     60, 60, 60, 60, 60, 60, 60, 60,
     20, 20, 30, 40, 40, 30, 20, 20,
     10, 10, 20, 35, 35, 20, 10, 10,
      5,  5, 10, 25, 25, 10,  5,  5,
      5,  0,  0,  5,  5,  0,  0,  5,
      5, 10, 10,-10,-10, 10, 10,  5,
      0,  0,  0,  0,  0,  0,  0,  0,
  ],
  n: [
    -50,-40,-30,-30,-30,-30,-40,-50,
    -40,-20,  0,  0,  0,  0,-20,-40,
    -30,  0, 10, 15, 15, 10,  0,-30,
    -30,  5, 15, 20, 20, 15,  5,-30,
    -30,  0, 15, 20, 20, 15,  0,-30,
    -30,  5, 10, 15, 15, 10,  5,-30,
    -40,-20,  0,  5,  5,  0,-20,-40,
    -50,-40,-30,-30,-30,-30,-40,-50,
  ],
  b: [
    -20,-10,-10,-10,-10,-10,-10,-20,
    -10,  0,  0,  0,  0,  0,  0,-10,
    -10,  0,  5, 10, 10,  5,  0,-10,
    -10,  5,  5, 10, 10,  5,  5,-10,
    -10,  0, 10, 10, 10, 10,  0,-10,
    -10, 10, 10, 10, 10, 10, 10,-10,
    -10,  5,  0,  0,  0,  0,  5,-10,
    -20,-10,-10,-10,-10,-10,-10,-20,
  ],
  r: [
      0,  0,  0,  0,  0,  0,  0,  0,
      5, 10, 10, 10, 10, 10, 10,  5,
     -5,  0,  0,  0,  0,  0,  0, -5,
     -5,  0,  0,  0,  0,  0,  0, -5,
     -5,  0,  0,  0,  0,  0,  0, -5,
     -5,  0,  0,  0,  0,  0,  0, -5,
     -5,  0,  0,  0,  0,  0,  0, -5,
      0,  0,  0,  5,  5,  0,  0,  0,
  ],
  q: [
    -20,-10,-10, -5, -5,-10,-10,-20,
    -10,  0,  0,  0,  0,  0,  0,-10,
    -10,  0,  5,  5,  5,  5,  0,-10,
     -5,  0,  5,  5,  5,  5,  0, -5,
      0,  0,  5,  5,  5,  5,  0, -5,
    -10,  5,  5,  5,  5,  5,  0,-10,
    -10,  0,  5,  0,  0,  0,  0,-10,
    -20,-10,-10, -5, -5,-10,-10,-20,
  ],
  k: [
    -30,-40,-40,-50,-50,-40,-40,-30,
    -30,-40,-40,-50,-50,-40,-40,-30,
    -30,-40,-40,-50,-50,-40,-40,-30,
    -30,-40,-40,-50,-50,-40,-40,-30,
    -20,-30,-30,-40,-40,-30,-30,-20,
    -10,-20,-20,-20,-20,-20,-20,-10,
     10, 10,  0,  0,  0,  0, 10, 10,
     10, 15,  5,  0,  0,  5, 15, 10,
  ],
};

// PST index for a square, from the given colour's point of view. Tables are
// written from White's side, so Black's lookup mirrors the rank.
function pstIndex(square: Square, color: Color): number {
  const file = square.charCodeAt(0) - 97; // 'a' -> 0
  const rank = square.charCodeAt(1) - 49; // '1' -> 0
  const row = color === "w" ? 7 - rank : rank;
  return row * 8 + file;
}

/**
 * Material-only score, White-positive, in pawn units. Kept separate from the
 * full static evaluation so that the rook-charge decay can be reasoned about
 * (and tested) without positional terms mixed in.
 */
export function material(game: EvoChessGame): number {
  let score = 0;
  for (const row of game.chess.board()) {
    for (const cell of row) {
      if (!cell) continue;
      const value =
        cell.type === "r"
          ? rookValue(game.rookCharges.get(cell.square) ?? ROOK_CHARGES)
          : PIECE_VALUES[cell.type];
      score += cell.color === "w" ? value : -value;
    }
  }
  return score;
}

/**
 * Full static evaluation, White-positive, in pawn units: material plus
 * piece-square tables. Only ever applied to quiet-ish positions (the search
 * resolves captures via quiescence first), and never to a finished game —
 * terminal scoring is the search's job, so that mate distance is preserved.
 */
export function evaluate(game: EvoChessGame): number {
  let score = material(game);
  for (const row of game.chess.board()) {
    for (const cell of row) {
      if (!cell) continue;
      const pst = PST[cell.type][pstIndex(cell.square, cell.color)] / 100;
      score += cell.color === "w" ? pst : -pst;
    }
  }
  return score;
}

interface CandidateTurn {
  from: Square;
  to: Square;
  options: ApplyMoveOptions;
}

// Search-internal view of a candidate: the turn plus the metadata needed to
// order it and to decide whether quiescence should look at it.
interface ScoredCandidate extends CandidateTurn {
  /** Captures and last-rank promotions: the moves quiescence resolves. */
  noisy: boolean;
  order: number;
}

function candidateKey(c: CandidateTurn): string {
  const o = c.options;
  return `${c.from}${c.to}|${o.forcedPromo ?? ""}${o.minorPromo ?? ""}${o.rookPromo ? "R" : ""}${o.downgradeTo ?? ""}`;
}

/**
 * Key for the transposition table. The chess FEN alone is not a sound key:
 * two positions with identical boards but different accumulated rights,
 * counters, rook charges or downgrade locks are genuinely different EvoChess
 * positions and evaluate differently.
 *
 * Like any FEN-keyed engine this cannot see repetition history, so a score
 * cached here may miss a threefold that the path to it would have forced.
 */
function stateKey(game: EvoChessGame): string {
  const charges = [...game.rookCharges].sort(([a], [b]) => (a < b ? -1 : 1));
  const locked = [...game.rookLocked].sort();
  return (
    game.chess.fen() +
    `|${game.minorRights.w},${game.minorRights.b},${game.rookRights.w},${game.rookRights.b}` +
    `|${game.pawnMoveProgress.w},${game.pawnMoveProgress.b},${game.minorMoveProgress.w},${game.minorMoveProgress.b}` +
    `|${charges.map(([s, c]) => s + c).join("")}` +
    `|${locked.join("")}` +
    // A pending en-passant capture of an evolved pawn is invisible to fen()
    // (chess.js has no idea it exists), so without this two positions that
    // differ only by that capture being available would share an entry.
    `|${game.epEvolved ? game.epEvolved.skipped + game.epEvolved.victim : ""}`
  );
}

type Bound = "exact" | "lower" | "upper";

interface TTEntry {
  depth: number;
  score: number;
  bound: Bound;
  best: CandidateTurn | null;
}

// Mate scores are relative to the root when stored (MATE - ply), so they must
// be re-based to the storing node's ply going in and to the probing node's ply
// coming out. Otherwise a mate cached at one ply reads as a different distance
// when hit via a transposition at another.
function scoreToTT(score: number, ply: number): number {
  if (score >= MATE_THRESHOLD) return score + ply;
  if (score <= -MATE_THRESHOLD) return score - ply;
  return score;
}

function scoreFromTT(score: number, ply: number): number {
  if (score >= MATE_THRESHOLD) return score - ply;
  if (score <= -MATE_THRESHOLD) return score + ply;
  return score;
}

interface SearchContext {
  tt: Map<string, TTEntry>;
  killers: (CandidateTurn | null)[][];
  rng: () => number;
}

function candidateTurns(
  game: EvoChessGame,
  ctx: SearchContext,
  ply: number,
  ttMove: CandidateTurn | null
): ScoredCandidate[] {
  const color: Color = game.chess.turn();
  const candidates: ScoredCandidate[] = [];
  const ttKey = ttMove ? candidateKey(ttMove) : null;
  const killerKeys = (ctx.killers[ply] ?? []).filter(Boolean).map((k) => candidateKey(k!));

  const push = (from: Square, to: Square, options: ApplyMoveOptions, noisy: boolean, base: number) => {
    const c: ScoredCandidate = { from, to, options, noisy, order: base };
    const key = candidateKey(c);
    if (ttKey !== null && key === ttKey) {
      c.order = 1e9;
    } else if (!noisy) {
      const killerIdx = killerKeys.indexOf(key);
      if (killerIdx >= 0) c.order = 9e5 - killerIdx;
      // Jitter only among quiet, non-killer moves, and only by <1, so it
      // breaks ties between equal-looking moves (keeping games varied per
      // seed, as the old full shuffle did) without reordering real ones.
      else c.order = base + ctx.rng();
    }
    candidates.push(c);
  };

  // legalMoves(), not chess.moves(): the en passant capture of an evolved
  // pawn exists only in the EvoChess layer.
  for (const move of game.legalMoves()) {
    const from = move.from;
    const to = move.to;
    const piece = game.chess.get(from);
    const isPawnMove = piece?.type === "p";
    const isMinorMove = piece?.type === "n" || piece?.type === "b";
    const isRookMove = piece?.type === "r";
    const reachesLastRank = isPawnMove && (to[1] === "8" || to[1] === "1");

    // MVV-LVA: most valuable victim first, cheapest attacker as the tiebreak.
    // A captured rook is priced by its charge-decayed value, matching how
    // `material` scores it.
    const isCapture = move.isCapture;
    let captureBonus = 0;
    if (isCapture) {
      const victimType = move.captured;
      const victimValue =
        victimType === "r"
          ? rookValue(game.rookCharges.get(to) ?? ROOK_CHARGES)
          : victimType
            ? PIECE_VALUES[victimType]
            : 0;
      const attackerValue = piece ? PIECE_VALUES[piece.type] : 0;
      captureBonus = 1e6 + victimValue * 10 - attackerValue;
    }

    if (reachesLastRank) {
      for (const forced of ["q", "r", "b", "n"] as const) {
        // Queening is nearly always right; underpromotions are kept for
        // completeness but ordered last.
        const promoBonus = forced === "q" ? 2e6 : 1e3;
        push(from, to, { forcedPromo: forced }, true, captureBonus + promoBonus);
      }
      continue;
    }

    if (isRookMove) {
      const remaining = (game.rookCharges.get(from) ?? ROOK_CHARGES) - 1;
      if (remaining <= 0) {
        // Last charge: the downgrade is mandatory and part of this same turn.
        for (const minor of ["n", "b"] as const) {
          push(from, to, { downgradeTo: minor }, isCapture, captureBonus);
        }
        continue;
      }
    }

    push(from, to, {}, isCapture, captureBonus);

    if (isPawnMove && game.minorRights[color] > 0) {
      for (const minor of ["n", "b"] as const) {
        // Spending a right adds ~2 pawns of material on the spot: order it
        // above quiet moves but below real captures.
        push(from, to, { minorPromo: minor }, isCapture, captureBonus + 5e5);
      }
    }

    if (isMinorMove && game.rookRights[color] > 0 && !game.rookLocked.has(from)) {
      push(from, to, { rookPromo: true }, isCapture, captureBonus + 5e5);
    }
  }

  candidates.sort((a, b) => b.order - a.order);
  return candidates;
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

/** Terminal score from the side-to-move's point of view, or null if the game is live. */
function terminalScore(game: EvoChessGame, ply: number): number | null {
  if (!game.isGameOver()) return null;
  // Side to move is mated. Every other terminal state (stalemate, insufficient
  // material, fifty-move, repetition) is a draw and scores 0 regardless of
  // material — the old evaluation returned material here, which told the
  // engine that stalemating itself while up a rook was as good as winning.
  if (game.chess.isCheckmate()) return -(MATE - ply);
  return 0;
}

/**
 * Resolve captures past the nominal horizon so the static evaluation is only
 * ever applied to a quiet position. Without this the search happily grabs a
 * defended piece on the last ply and calls itself a piece up.
 */
function quiesce(game: EvoChessGame, alpha: number, beta: number, ply: number, ctx: SearchContext): number {
  const terminal = terminalScore(game, ply);
  if (terminal !== null) return terminal;

  const sign = game.chess.turn() === "w" ? 1 : -1;
  const standPat = sign * evaluate(game);
  if (ply >= MAX_QUIESCE_PLY) return standPat;
  if (standPat >= beta) return beta;
  if (standPat > alpha) alpha = standPat;

  for (const candidate of candidateTurns(game, ctx, ply, null)) {
    if (!candidate.noisy) continue;
    const child = game.copy();
    child.applyMove(candidate.from, candidate.to, candidate.options);
    const score = -quiesce(child, -beta, -alpha, ply + 1, ctx);
    if (score >= beta) return beta;
    if (score > alpha) alpha = score;
  }
  return alpha;
}

function negamax(
  game: EvoChessGame,
  depth: number,
  alpha: number,
  beta: number,
  ply: number,
  ctx: SearchContext
): [number, CandidateTurn | null] {
  const terminal = terminalScore(game, ply);
  if (terminal !== null) return [terminal, null];
  if (depth === 0) return [quiesce(game, alpha, beta, ply, ctx), null];

  const alphaOrig = alpha;
  const betaOrig = beta;
  const key = stateKey(game);
  const entry = ctx.tt.get(key);
  let ttMove: CandidateTurn | null = null;

  if (entry) {
    ttMove = entry.best;
    if (entry.depth >= depth) {
      const score = scoreFromTT(entry.score, ply);
      if (entry.bound === "exact") return [score, entry.best];
      if (entry.bound === "lower" && score > alpha) alpha = score;
      else if (entry.bound === "upper" && score < beta) beta = score;
      if (alpha >= beta) return [score, entry.best];
    }
  }

  let bestScore = -Infinity;
  let bestCandidate: CandidateTurn | null = null;

  for (const candidate of candidateTurns(game, ctx, ply, ttMove)) {
    const child = game.copy();
    child.applyMove(candidate.from, candidate.to, candidate.options);
    const [childScore] = negamax(child, depth - 1, -beta, -alpha, ply + 1, ctx);
    const score = -childScore;

    if (score > bestScore) {
      bestScore = score;
      bestCandidate = { from: candidate.from, to: candidate.to, options: candidate.options };
    }
    if (score > alpha) alpha = score;
    if (alpha >= beta) {
      // Quiet moves that cause a cutoff are worth trying early in sibling
      // nodes at the same ply; captures are already ordered by MVV-LVA.
      if (!candidate.noisy) {
        const slot = (ctx.killers[ply] ??= [null, null]);
        if (slot[0] === null || candidateKey(slot[0]) !== candidateKey(candidate)) {
          slot[1] = slot[0];
          slot[0] = { from: candidate.from, to: candidate.to, options: candidate.options };
        }
      }
      break;
    }
  }

  ctx.tt.set(key, {
    depth,
    score: scoreToTT(bestScore, ply),
    bound: bestScore <= alphaOrig ? "upper" : bestScore >= betaOrig ? "lower" : "exact",
    best: bestCandidate,
  });

  return [bestScore, bestCandidate];
}

/**
 * Best turn for the side to move, searched to `depth` plies (plus quiescence).
 * `seed` makes play reproducible while keeping equal-valued moves varied.
 *
 * Iteratively deepens: each pass seeds the transposition table and the root
 * move ordering for the next, which more than pays back the cost of
 * re-searching the shallow plies.
 */
export function chooseMove(game: EvoChessGame, depth: number, seed: number): CandidateTurn | null {
  const ctx: SearchContext = { tt: new Map(), killers: [], rng: mulberry32(seed) };
  let best: CandidateTurn | null = null;

  for (let d = 1; d <= depth; d++) {
    const [, candidate] = negamax(game, d, -Infinity, Infinity, 0, ctx);
    if (candidate) best = candidate;
  }
  return best;
}
