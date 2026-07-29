/**
 * Negamax with alpha-beta pruning over "compound turns" (a base move plus an
 * optional evolutionary promotion decision), plus iterative deepening, a
 * transposition table, move ordering (TT move / MVV-LVA / killers) and a
 * quiescence search.
 */
import type { Color, Square, PieceSymbol } from "chess.js";
import { EvoChessGame, ROOK_CHARGES, N_MINOR, M_ROOK, type ApplyMoveOptions } from "./game";
import { evaluateNNUE, hasNnueWeights } from "./nnue";
import { squareName } from "./bitboard";
import { fromEvoGame, type EvoTurn } from "./evoBitboard";
import { searchEvoTT, searchEvoTTTimed, armSearchDeadline, disarmSearchDeadline } from "./evoSearch";

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
 * Full static evaluation, White-positive, in pawn units. Uses the learned net
 * when weights are loaded, else material plus piece-square tables. Only ever
 * applied to quiet-ish positions (the search resolves captures via quiescence
 * first), and never to a finished game — terminal scoring is the search's job,
 * so that mate distance is preserved.
 */
export function evaluate(game: EvoChessGame): number {
  if (hasNnueWeights()) {
    // The net is side-to-move-relative; evaluate() is White-positive.
    const score = evaluateNNUE(game);
    return game.chess.turn() === "w" ? score : -score;
  }
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

export interface CandidateTurn {
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
export function stateKey(game: EvoChessGame): string {
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
  nodes: number;
  /** Wall-clock deadline (Date.now()-based); undefined means no budget. */
  deadline?: number;
}

/** Thrown to unwind a search that blew past `ctx.deadline` mid-iteration. */
class SearchAborted extends Error {}

// Checking Date.now() on every node would itself be a meaningful cost at NNUE
// node rates, so only sample it periodically.
const DEADLINE_CHECK_INTERVAL = 1024;

function checkDeadline(ctx: SearchContext): void {
  if (ctx.deadline === undefined) return;
  if ((ctx.nodes & (DEADLINE_CHECK_INTERVAL - 1)) !== 0) return;
  if (Date.now() >= ctx.deadline) throw new SearchAborted();
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

    // Rights are read *after* this move's own counter tick: a right earned by
    // this very move may be spent on it (see the `a4=B` example in rules.txt,
    // and the matching ordering in applyMove()).
    const minorRightsAfter =
      game.minorRights[color] + (game.pawnMoveProgress[color] + 1 >= N_MINOR ? 1 : 0);
    const rookRightsAfter =
      game.rookRights[color] + (game.minorMoveProgress[color] + 1 >= M_ROOK ? 1 : 0);

    if (isPawnMove && minorRightsAfter > 0) {
      for (const minor of ["n", "b"] as const) {
        // Spending a right adds ~2 pawns of material on the spot: order it
        // above quiet moves but below real captures.
        push(from, to, { minorPromo: minor }, isCapture, captureBonus + 5e5);
      }
    }

    if (isMinorMove && rookRightsAfter > 0 && !game.rookLocked.has(from)) {
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
  ctx.nodes++;
  checkDeadline(ctx);
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
  ctx.nodes++;
  checkDeadline(ctx);
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
  return searchRoot(game, depth, seed).move;
}

export interface RootSearch {
  move: CandidateTurn | null;
  /**
   * Score of the root position from the **side-to-move's** point of view, in
   * pawn units (positive = good for the side to move). This is the negamax
   * convention; White-positive callers must negate for Black.
   */
  score: number;
  /** Positions visited (search + quiescence), for reporting search speed. */
  nodes: number;
  /** Wall-clock time spent searching, in milliseconds. */
  timeMs: number;
  /** Static evaluation method the search used. */
  method: "nnue" | "pst";
}

/**
 * Like `chooseMove`, but also returns the root search score — the label the
 * NNUE data generator needs. Iteratively deepens and reports the move and
 * score from the deepest completed pass.
 */
/**
 * Selects which search backend `searchRoot` (hence `chooseMove`) uses:
 *   - "bitboard": the make/unmake bitboard search (`searchEvoTT`); the default.
 *   - "chessjs": the negamax over `EvoChessGame` in this file; the reference
 *     implementation the bitboard path's parity tests are written against.
 * Both support both evaluations: each picks up the net whenever weights are
 * loaded (bitboard through the incremental accumulator, `evoSearch.ts`'s
 * `USE_NNUE`) and falls back to PST otherwise. Their scores agree at equal
 * depth — see the cross-backend parity test in `nnueEvoAdapter.test.ts` —
 * though bitboard computes in integer centipawns and chessjs in float pawn
 * units, so the two are not bit-identical.
 * A flag rather than a parameter so a single toggle A/B-tests the whole engine
 * (self-play, data generation) without threading it through every call site.
 */
export type EngineBackend = "chessjs" | "bitboard";
// Default "bitboard": it is 8-17× faster at equal depth and, since the
// accumulator landed, evaluates identically with either PST or the net, so
// there is no longer a reason for any caller to pay chessjs's cost by
// default. "chessjs" remains the reference implementation — every backend
// parity test is defined against it, and `--backend chessjs` opts back in.
export const engineConfig: { backend: EngineBackend } = { backend: "bitboard" };

/** Map a bitboard `EvoTurn` back to the `CandidateTurn` the game layer expects. */
function evoTurnToCandidate(t: EvoTurn): CandidateTurn {
  const options: ApplyMoveOptions = {};
  if (t.forced) options.forcedPromo = t.forced;
  if (t.minor) options.minorPromo = t.minor;
  if (t.rook) options.rookPromo = true;
  if (t.down) options.downgradeTo = t.down;
  return { from: squareName(t.from) as Square, to: squareName(t.to) as Square, options };
}

/**
 * `useNnue` defaults to "use the net if one is loaded", matching what the
 * chessjs backend's `evaluate()` does implicitly. Pass `false` to force PST
 * even with weights loaded — `searchLevel` does this to keep Easy on the
 * weaker evaluation. Note it currently gates the **bitboard** backend only
 * (`searchEvoTT`'s own opt-in); the chessjs path always follows the loaded
 * weights, so force-PST callers must also be on the bitboard backend.
 */
export function searchRoot(
  game: EvoChessGame,
  depth: number,
  seed: number,
  useNnue = hasNnueWeights(),
  keepTT = false
): RootSearch {
  const start = performance.now();
  if (engineConfig.backend === "bitboard") {
    // Bitboard backend: integer-centipawn eval (PST or, with `useNnue`, the
    // accumulator), own Zobrist TT + iterative deepening. `seed` drives a root
    // tie-break so equal-value moves vary per game. Score is centipawns,
    // side-to-move-relative → convert to pawn units. `keepTT` (ponder-spec.md
    // §4.1) is the bitboard TT's own opt-in; the chessjs path below builds a
    // fresh `Map` per search regardless, so it has nothing to keep.
    const r = searchEvoTT(fromEvoGame(game), depth, seed, useNnue, keepTT);
    return {
      move: r.turn ? evoTurnToCandidate(r.turn) : null,
      score: r.score / 100,
      nodes: r.nodes,
      timeMs: performance.now() - start,
      // `beginNnueSearch` ands this with `hasNnueWeights()`, which the default
      // argument already reflects — so this matches what actually evaluated.
      method: useNnue ? "nnue" : "pst",
    };
  }

  const ctx: SearchContext = { tt: new Map(), killers: [], rng: mulberry32(seed), nodes: 0 };
  let best: CandidateTurn | null = null;
  let score = 0;

  for (let d = 1; d <= depth; d++) {
    const [s, candidate] = negamax(game, d, -Infinity, Infinity, 0, ctx);
    if (candidate) {
      best = candidate;
      score = s;
    }
  }
  return {
    move: best,
    score,
    nodes: ctx.nodes,
    timeMs: performance.now() - start,
    method: hasNnueWeights() ? "nnue" : "pst",
  };
}

/**
 * Iterative-deepening search under a wall-clock budget rather than a fixed
 * depth. Deepens until `timeMs` elapses, returning the best move and score from
 * the deepest pass that *completed* — so a slower evaluation (the net) simply
 * reaches a shallower depth in the same time, which is exactly what an
 * equal-time strength match is meant to expose. A depth may overshoot the
 * budget by up to its own duration; both engines overshoot alike, so the
 * comparison stays fair.
 *
 * `startDepth` resumes the deepening ladder instead of restarting it at 1, and
 * is only meaningful alongside `keepTT` — `searchEvoTTTimed` documents the
 * contract this forwards. The reference backend honours it too, but has no
 * persistent table to resume against, so there it only skips (already cheap)
 * shallow iterations at the cost of a cold deep one.
 */
export function searchRootTimed(
  game: EvoChessGame,
  timeMs: number,
  seed: number,
  maxDepth = 64,
  useNnue = hasNnueWeights(),
  keepTT = false,
  startDepth = 1
): RootSearch & { depth: number } {
  const start = performance.now();
  if (engineConfig.backend === "bitboard") {
    const r = searchEvoTTTimed(fromEvoGame(game), timeMs, maxDepth, seed, useNnue, keepTT, startDepth);
    return {
      move: r.turn ? evoTurnToCandidate(r.turn) : null,
      score: r.score / 100,
      depth: r.depth,
      nodes: r.nodes,
      timeMs: performance.now() - start,
      method: useNnue ? "nnue" : "pst",
    };
  }

  const deadline = Date.now() + timeMs;
  const ctx: SearchContext = { tt: new Map(), killers: [], rng: mulberry32(seed), nodes: 0, deadline };
  let best: CandidateTurn | null = null;
  let score = 0;
  let depth = 0;

  for (let d = startDepth < 1 ? 1 : startDepth; d <= maxDepth; d++) {
    let s: number, candidate: CandidateTurn | null;
    try {
      [s, candidate] = negamax(game, d, -Infinity, Infinity, 0, ctx);
    } catch (e) {
      // Blew the budget mid-iteration: keep the previous (fully-searched)
      // depth's result rather than reporting a partial, unreliable one.
      if (e instanceof SearchAborted) break;
      throw e;
    }
    if (candidate) {
      best = candidate;
      score = s;
      depth = d;
    }
    // A mate is found; deeper search cannot improve on it.
    if (Math.abs(s) >= MATE_THRESHOLD) break;
    if (Date.now() >= deadline) break;
  }
  return {
    move: best,
    score,
    depth,
    nodes: ctx.nodes,
    timeMs: performance.now() - start,
    method: hasNnueWeights() ? "nnue" : "pst",
  };
}

/**
 * UI difficulty level. Easy is fixed-depth PST; Zen and Fun are both
 * time-budgeted NNUE with the identical search policy — the only difference
 * between them is that Fun ponders on the human's time and Zen doesn't
 * (that gating lives in App.tsx's `maybeStartPonder`, keyed on `level === "fun"`).
 */
export type AiLevel = "easy" | "zen" | "fun";

// Difficulty → search policy, the single source of truth for what each level
// does. Every level runs on the bitboard backend, which supports both
// evaluations. Easy is fixed-depth and passes `useNnue: false` so it stays on
// PST even though the worker has weights loaded — that weaker evaluation is
// the difficulty. Zen and Fun are time-budgeted and take the net when one is
// loaded, falling back to PST when none is (e.g. weights are still fetching
// in the worker).
const LEVEL_DEPTH: Record<"easy", number> = { easy: 4 };

// Zen/Fun time management. Two numbers, because one is not enough:
//
// `TIMED_TIME_MS` is the *budget* — after this much has elapsed, no new
// deepening iteration is started. On its own it bounds nothing, since the
// iteration that blows it is the one already running: measured in the browser
// at Fun, a nominally 800ms search took 4552ms (depth 6, NNUE, 469k nodes).
// The move does arrive, so nothing breaks; it just feels broken.
//
// `TIMED_HARD_MS` is the *ceiling* — the wall-clock limit on a move, enforced
// inside the search by the in-search abort (evoSearch.ts `armSearchDeadline`),
// which unwinds mid-iteration and discards the unfinished pass. It is armed
// `ABORT_SLACK_MS` early because the abort polls its deadline every 2048
// nodes and so overshoots by up to one poll interval plus the unwind
// (measured ~25-45ms, bench/bench10_slice_ms.ts; given room here for slower
// devices). What has to hold is the total, not the arming point.
//
// The budget is 400, not the original 800: measured over 8 corpus positions ×
// PST/NNUE (bench/bench11_move_latency.ts), stopping at 280/400/560/800ms
// reaches *identical* depth, because an iteration started after ~400ms cannot
// finish before the ceiling and is discarded when the ceiling fires. Carrying
// the budget to 800 therefore bought no depth and cost ~300ms of thrown-away
// work on every move — mean latency 1005ms against 694ms at 400.
// The ceiling is 1200, not 1100: measured over the same 8-position corpus
// (bench/bench11_move_latency.ts), 1100->1200 buys an extra ply on 1-2 of 8
// positions (an iteration starting just before the 400ms budget needs ~100ms
// more to finish); 1200->1300 buys nothing further, just 100ms of idle
// latency. 1200 is the ceiling that actually earns its cost.
const TIMED_TIME_MS = 400;
const TIMED_HARD_MS = 1_200;
const ABORT_SLACK_MS = 80;

// Exposed so the latency regression test asserts against the real constants
// rather than a copy that can drift out of step with them.
export const __timingForTest = { TIMED_TIME_MS, TIMED_HARD_MS, ABORT_SLACK_MS };

// Includes `depth`: the fixed depth for Easy, or the deepest completed
// iteration for Zen/Fun's timed search — reported in the search-speed console log.
//
// `opts.keepTT` (ponder-spec.md §4.1/§5.4) threads down to the bitboard TT to
// suppress its generation bump, so a search can continue from a warm cache
// left by a prior ponder. `opts.timeMs` overrides the timed levels'
// `TIMED_TIME_MS` budget — this is what lets a 40ms ponder slice run through
// the same function as the real 800ms search (ponder-spec.md §5.2). Either
// way the in-search abort (§4.2) is armed, since a budget alone bounds
// nothing: at the slice deadline for a ponder, at `TIMED_HARD_MS` for a real
// search.
// `opts.startDepth` resumes the deepening ladder rather than restarting it at
// 1 — what lets a chain of short ponder slices accumulate depth instead of
// re-walking d=1..n every slice; only meaningful with `keepTT`, whose warm
// table is what makes the skipped iterations already-paid-for (see
// `searchEvoTTTimed`). All three
// default away so every existing caller is unaffected. Deliberately excludes
// `useNnue`: that stays derived from `hasNnueWeights()` inside
// `searchRoot`/`searchRootTimed` so no caller — ponder included — can make it
// diverge from the real search's evaluation.
export function searchLevel(
  game: EvoChessGame,
  level: AiLevel,
  seed: number,
  opts: { timeMs?: number; keepTT?: boolean; startDepth?: number } = {}
): RootSearch & { depth: number } {
  engineConfig.backend = "bitboard";
  const keepTT = opts.keepTT ?? false;
  if (level === "zen" || level === "fun") {
    // `useNnue` defaults to hasNnueWeights(), so these levels get the net when
    // the worker has finished fetching it and PST until then.
    // A ponder slice's budget *is* its ceiling — it has no move to return, so
    // an unfinished iteration costs it nothing to discard. A real search
    // budgets `TIMED_TIME_MS` and is capped at `TIMED_HARD_MS`, the gap being
    // what lets an iteration already in flight finish and count.
    const timeMs = opts.timeMs ?? TIMED_TIME_MS;
    const ceiling = opts.timeMs !== undefined ? timeMs : TIMED_HARD_MS - ABORT_SLACK_MS;
    armSearchDeadline(Date.now() + ceiling);
    try {
      return searchRootTimed(game, timeMs, seed, undefined, undefined, keepTT, opts.startDepth);
    } finally {
      disarmSearchDeadline();
    }
  }
  const depth = LEVEL_DEPTH[level];
  return { ...searchRoot(game, depth, seed, false, keepTT), depth };
}

/**
 * Every legal compound turn (base move plus any evolutionary-promotion choice)
 * for the side to move, unordered. Reuses the search's own candidate generator
 * so the data generator's random moves cover exactly the same move space the
 * engine searches — including evolved en passant and mandatory downgrades.
 */
export function legalTurns(game: EvoChessGame): CandidateTurn[] {
  const ctx: SearchContext = { tt: new Map(), killers: [], rng: () => 0, nodes: 0 };
  return candidateTurns(game, ctx, 0, null).map(({ from, to, options }) => ({ from, to, options }));
}
