/**
 * PROTOTYPE EvoChess evolution layer on top of the bitboard `Position`.
 *
 * Mirrors the two pieces of the reference engine that the bitboard search would
 * need: `candidateTurns` (ai.ts) — expanding each base move into compound
 * EvoChess turns — and `applyMove` (game.ts) — advancing board + evolutionary
 * state. The evolutionary state (rights, move-progress counters, per-square rook
 * charges, downgrade locks, evolved en passant) rides alongside the bitboard
 * `Position` exactly as it rides alongside chess.js today.
 *
 * Validated against the reference `EvoChessGame` for legal-turn-set equality and
 * post-move state equality over random games (see evoBitboard.bench.test.ts).
 */
import {
  type Position,
  type Undo,
  fromFen,
  generateLegal,
  makeMoveInPlace,
  unmakeMove,
  inCheck,
  pieceAt,
  squareName,
  bitAt,
} from "./bitboard";
import type { EvoChessGame } from "./game";

const N_MINOR = 3;
const M_ROOK = 3;
const ROOK_CHARGES = 5;

// piece type codes (match bitboard.ts): P=0 N=1 B=2 R=3 Q=4 K=5
const P = 0, N = 1, B = 2, R = 3;
const LETTER_TO_CODE: Record<string, number> = { n: N, b: B, r: R, q: 4 };

export interface EvoState {
  minorRights: [number, number]; // [white, black]
  rookRights: [number, number];
  pawnProgress: [number, number];
  minorProgress: [number, number];
  charges: Map<number, number>; // square -> rook charges
  locked: Set<number>; // squares barred from rook promotion
  epEvolved: { skipped: number; victim: number; color: number } | null;
  half: number; // halfmove clock (plies since last pawn move or capture)
}

export interface EvoPos {
  pos: Position;
  evo: EvoState;
}

/** A compound EvoChess turn: a base move plus at most one evolution decision. */
export interface EvoTurn {
  from: number;
  to: number;
  forced?: "q" | "r" | "b" | "n"; // pawn reaching the last rank
  minor?: "n" | "b"; // evolve the pawn that just moved
  rook?: boolean; // evolve the minor that just moved
  down?: "n" | "b"; // mandatory downgrade when a rook spends its last charge
}

const fileOf = (sq: number): number => sq & 7;
const rankOf = (sq: number): number => sq >> 3;
const nameToSq = (n: string): number => (n.charCodeAt(1) - 49) * 8 + (n.charCodeAt(0) - 97);

/** Canonical key matching ai.ts `candidateKey`, for set comparison. */
export function turnKey(t: EvoTurn): string {
  return `${squareName(t.from)}${squareName(t.to)}|${t.forced ?? ""}${t.minor ?? ""}${t.rook ? "R" : ""}${t.down ?? ""}`;
}

/** Build an EvoPos from a reference game (board via FEN, evo state copied). */
export function fromEvoGame(game: EvoChessGame): EvoPos {
  const fen = game.chess.fen();
  const pos = fromFen(fen);
  const half = parseInt(fen.split(/\s+/)[4] ?? "0", 10) || 0;
  const charges = new Map<number, number>();
  for (const [sq, c] of game.rookCharges) charges.set(nameToSq(sq), c);
  const locked = new Set<number>();
  for (const sq of game.rookLocked) locked.add(nameToSq(sq));
  const ep = game.epEvolved;
  return {
    pos,
    evo: {
      minorRights: [game.minorRights.w, game.minorRights.b],
      rookRights: [game.rookRights.w, game.rookRights.b],
      pawnProgress: [game.pawnMoveProgress.w, game.pawnMoveProgress.b],
      minorProgress: [game.minorMoveProgress.w, game.minorMoveProgress.b],
      charges,
      locked,
      epEvolved: ep ? { skipped: nameToSq(ep.skipped), victim: nameToSq(ep.victim), color: ep.color === "w" ? 0 : 1 } : null,
      half,
    },
  };
}

export function cloneEvoPos(s: EvoPos): EvoPos {
  return {
    pos: { bb: s.pos.bb.slice(), occ: [s.pos.occ[0], s.pos.occ[1]], all: s.pos.all, us: s.pos.us, ep: s.pos.ep },
    evo: {
      minorRights: [...s.evo.minorRights],
      rookRights: [...s.evo.rookRights],
      pawnProgress: [...s.evo.pawnProgress],
      minorProgress: [...s.evo.minorProgress],
      charges: new Map(s.evo.charges),
      locked: new Set(s.evo.locked),
      epEvolved: s.evo.epEvolved ? { ...s.evo.epEvolved } : null,
      half: s.evo.half,
    },
  };
}

// Squares of the (at most two) pawns that could capture en passant onto `ep`.
function epCapturerSquares(ep: number, us: number): number[] {
  const cands = us === 0 ? [ep - 7, ep - 9] : [ep + 7, ep + 9];
  return cands.filter((f) => f >= 0 && f < 64 && Math.abs(fileOf(f) - fileOf(ep)) === 1);
}

/**
 * Legality of the evolved en-passant capture (from → skipped, taking the evolved
 * piece on `victim`) without mutating `s`: simulate on a scratch board and test
 * the capturer's king.
 */
function evolvedEpLegal(s: EvoPos, from: number, victim: number, skipped: number): boolean {
  const scratch = cloneEvoPos(s).pos;
  const us = scratch.us, them = us ^ 1;
  const fromB = bitAt(from), skipB = bitAt(skipped), vicB = bitAt(victim);
  scratch.bb[us * 6 + P] ^= fromB; // lift capturer pawn
  scratch.bb[us * 6 + P] |= skipB; // land on skipped
  const vType = pieceAt(scratch, victim);
  if (vType >= 0) scratch.bb[them * 6 + vType] ^= vicB; // remove victim
  scratch.occ[us] = (scratch.occ[us] & ~fromB) | skipB;
  scratch.occ[them] &= ~vicB;
  scratch.all = scratch.occ[0] | scratch.occ[1];
  // scratch's side to move is still the capturer, so inCheck tests its king.
  return !inCheck(scratch);
}

/** All legal compound EvoChess turns for the side to move. */
export function generateEvoTurns(s: EvoPos): EvoTurn[] {
  const { pos, evo } = s;
  const us = pos.us;
  const turns: EvoTurn[] = [];

  const expand = (from: number, to: number) => {
    const moverType = pieceAt(pos, from);
    const isPawn = moverType === P;
    const isMinor = moverType === N || moverType === B;
    const isRook = moverType === R;
    const reachesLastRank = isPawn && (rankOf(to) === 7 || rankOf(to) === 0);

    if (reachesLastRank) {
      for (const forced of ["q", "r", "b", "n"] as const) turns.push({ from, to, forced });
      return;
    }
    if (isRook) {
      const remaining = (evo.charges.get(from) ?? ROOK_CHARGES) - 1;
      if (remaining <= 0) {
        for (const d of ["n", "b"] as const) turns.push({ from, to, down: d });
        return;
      }
    }
    turns.push({ from, to });
    if (isPawn && evo.minorRights[us] > 0) {
      for (const m of ["n", "b"] as const) turns.push({ from, to, minor: m });
    }
    if (isMinor && evo.rookRights[us] > 0 && !evo.locked.has(from)) {
      turns.push({ from, to, rook: true });
    }
  };

  for (const m of generateLegal(pos)) expand(m & 63, (m >> 6) & 63);

  // evolved en passant: chess.js / the base generator cannot see it.
  const ep = evo.epEvolved;
  if (ep && us === (ep.color ^ 1) && pieceAt(pos, ep.victim) >= 0) {
    for (const from of epCapturerSquares(ep.skipped, us)) {
      if (fileOf(from) === fileOf(ep.skipped)) continue; // must be a diagonal capture
      if (rankOf(from) !== rankOf(ep.victim)) continue; // capturer stands beside the victim
      if (pieceAt(pos, from) !== P || (pos.occ[us] & bitAt(from)) === 0n) continue;
      if (!evolvedEpLegal(s, from, ep.victim, ep.skipped)) continue;
      turns.push({ from, to: ep.skipped });
      if (evo.minorRights[us] > 0) for (const m of ["n", "b"] as const) turns.push({ from, to: ep.skipped, minor: m });
    }
  }

  return turns;
}

/** Swap the piece standing on `sq` (owned by `color`) from one type to another. */
function replacePiece(pos: Position, sq: number, color: number, fromType: number, toType: number): void {
  const b = bitAt(sq);
  pos.bb[color * 6 + fromType] ^= b;
  pos.bb[color * 6 + toType] |= b;
}

/**
 * Undo record for `applyEvoTurn`. Compact and allocation-light: the base-move
 * `Undo`, the single evolution piece-swap on `to`, the mover's four counters as
 * scalars (only the mover's entries ever change), and the charges/locked state
 * at exactly the two square-keys (`from`, `to`) that a turn can touch.
 */
export interface EvoUndo {
  us: number;
  evolvedEp: boolean;
  base: Undo | null;
  from: number;
  to: number;
  prevPosEp: number;
  epVictim: number;
  epVictimType: number;
  swapTo: number; // square of an evolution piece-swap, or -1
  swapFrom: number; // type placed by the swap (to revert from)
  swapBack: number; // type before the swap (to revert to)
  minorRights: number;
  rookRights: number;
  pawnProgress: number;
  minorProgress: number;
  chFrom: number | undefined;
  chTo: number | undefined;
  lkFrom: boolean;
  lkTo: boolean;
  epEvolved: { skipped: number; victim: number; color: number } | null;
  prevHalf: number;
}

/** Apply a compound turn in place, returning an `EvoUndo` for `undoEvoTurn`. */
export function applyEvoTurn(s: EvoPos, t: EvoTurn): EvoUndo {
  const { pos, evo } = s;
  const us = pos.us;
  const from = t.from, to = t.to;

  const u: EvoUndo = {
    us, evolvedEp: false, base: null, from, to,
    prevPosEp: pos.ep, epVictim: -1, epVictimType: -1,
    swapTo: -1, swapFrom: -1, swapBack: -1,
    minorRights: evo.minorRights[us], rookRights: evo.rookRights[us],
    pawnProgress: evo.pawnProgress[us], minorProgress: evo.minorProgress[us],
    chFrom: evo.charges.get(from), chTo: evo.charges.get(to),
    lkFrom: evo.locked.has(from), lkTo: evo.locked.has(to),
    epEvolved: evo.epEvolved,
    prevHalf: evo.half,
  };

  const moverType = pieceAt(pos, from);
  const isPawn = moverType === P;
  const isMinor = moverType === N || moverType === B;
  const isRook = moverType === R;
  const reachesLastRank = isPawn && (rankOf(to) === 7 || rankOf(to) === 0);

  // evolved en passant is a base move the bitboard generator can't make.
  const prevEp = evo.epEvolved;
  const isEvolvedEp =
    isPawn && !reachesLastRank && prevEp !== null && to === prevEp.skipped &&
    fileOf(from) !== fileOf(to) && pieceAt(pos, to) < 0 && (pos.occ[us] & bitAt(from)) !== 0n;

  evo.epEvolved = null; // an evolved-ep right lasts exactly one ply

  if (isEvolvedEp) {
    u.evolvedEp = true;
    const them = us ^ 1;
    const victim = prevEp!.victim;
    const vType = pieceAt(pos, victim);
    u.epVictim = victim;
    u.epVictimType = vType;
    const fromB = bitAt(from), toB = bitAt(to), vicB = bitAt(victim);
    pos.bb[us * 6 + P] ^= fromB;
    pos.bb[us * 6 + P] |= toB;
    if (vType >= 0) pos.bb[them * 6 + vType] ^= vicB;
    pos.occ[us] = (pos.occ[us] & ~fromB) | toB;
    pos.occ[them] &= ~vicB;
    pos.all = pos.occ[0] | pos.occ[1];
    pos.ep = -1;
    pos.us = them as 0 | 1;
    evo.half = 0; // an evolved-ep capture is both a pawn move and a capture
    // pawn move → minor-promotion counter
    if (++evo.pawnProgress[us] >= N_MINOR) { evo.pawnProgress[us] -= N_MINOR; evo.minorRights[us]++; }
    if (t.minor) {
      replacePiece(pos, to, us, P, LETTER_TO_CODE[t.minor]);
      evo.minorRights[us]--;
      u.swapTo = to; u.swapFrom = LETTER_TO_CODE[t.minor]; u.swapBack = P;
    }
    return u;
  }

  // -- base move on the bitboard (handles standard ep, captures, forced promo) --
  const promoCode = reachesLastRank ? LETTER_TO_CODE[t.forced!] : 0;
  u.base = makeMoveInPlace(pos, from | (to << 6) | (promoCode << 12));

  // Fifty-move clock: reset on a pawn move or any capture, else advance.
  evo.half = isPawn || u.base.capType >= 0 ? 0 : evo.half + 1;

  // rook-charge / lock bookkeeping (square-keyed; follows the piece, drops on capture)
  evo.charges.delete(to);
  evo.locked.delete(to);
  if (evo.charges.has(from)) { evo.charges.set(to, evo.charges.get(from)!); evo.charges.delete(from); }
  if (evo.locked.has(from)) { evo.locked.delete(from); evo.locked.add(to); }

  // evolutionary counters
  if (isPawn && ++evo.pawnProgress[us] >= N_MINOR) { evo.pawnProgress[us] -= N_MINOR; evo.minorRights[us]++; }
  if (isMinor && ++evo.minorProgress[us] >= M_ROOK) { evo.minorProgress[us] -= M_ROOK; evo.rookRights[us]++; }

  // rook charge spend + mandatory downgrade
  if (isRook) {
    const remaining = (evo.charges.get(to) ?? ROOK_CHARGES) - 1;
    if (remaining > 0) {
      evo.charges.set(to, remaining);
    } else {
      replacePiece(pos, to, us, R, LETTER_TO_CODE[t.down!]);
      evo.charges.delete(to);
      evo.locked.add(to);
      u.swapTo = to; u.swapFrom = LETTER_TO_CODE[t.down!]; u.swapBack = R;
    }
  }

  // optional evolutionary promotion
  if (!reachesLastRank) {
    if (t.minor) {
      replacePiece(pos, to, us, P, LETTER_TO_CODE[t.minor]);
      u.swapTo = to; u.swapFrom = LETTER_TO_CODE[t.minor]; u.swapBack = P;
      // an evolving double pawn push re-expresses its en passant as evolved-ep
      if (isPawn && Math.abs(to - from) === 16 && pos.ep >= 0) {
        evo.epEvolved = { skipped: pos.ep, victim: to, color: us };
        pos.ep = -1;
      }
      evo.minorRights[us]--;
    } else if (t.rook) {
      const cur = pieceAt(pos, to); // the minor that just moved
      replacePiece(pos, to, us, cur, R);
      u.swapTo = to; u.swapFrom = R; u.swapBack = cur;
      evo.rookRights[us]--;
      evo.charges.set(to, ROOK_CHARGES);
    }
  }

  // forced last-rank promotion to a rook grants full charges
  if (reachesLastRank && t.forced === "r") evo.charges.set(to, ROOK_CHARGES);
  return u;
}

/** Reverse an `applyEvoTurn`, restoring the exact prior EvoPos. */
export function undoEvoTurn(s: EvoPos, u: EvoUndo): void {
  const { pos, evo } = s;
  const us = u.us;

  // Reverse the evolution piece-swap first, so the board matches what the base
  // unmake (or the evolved-ep reversal) expects to find on `to`.
  if (u.swapTo >= 0) replacePiece(pos, u.swapTo, us, u.swapFrom, u.swapBack);

  if (u.evolvedEp) {
    const them = us ^ 1;
    const fromB = bitAt(u.from), toB = bitAt(u.to), vicB = bitAt(u.epVictim);
    pos.bb[us * 6 + P] ^= toB;
    pos.bb[us * 6 + P] |= fromB;
    if (u.epVictimType >= 0) pos.bb[them * 6 + u.epVictimType] |= vicB;
    pos.occ[us] = (pos.occ[us] & ~toB) | fromB;
    pos.occ[them] |= vicB;
    pos.all = pos.occ[0] | pos.occ[1];
    pos.us = us as 0 | 1;
    pos.ep = u.prevPosEp;
  } else {
    unmakeMove(pos, u.base!);
  }

  // Restore evolutionary state. Only the mover's counters change, and only the
  // `from`/`to` square-keys of charges/locked, so restoring those suffices.
  evo.minorRights[us] = u.minorRights;
  evo.rookRights[us] = u.rookRights;
  evo.pawnProgress[us] = u.pawnProgress;
  evo.minorProgress[us] = u.minorProgress;
  if (u.chFrom === undefined) evo.charges.delete(u.from); else evo.charges.set(u.from, u.chFrom);
  if (u.chTo === undefined) evo.charges.delete(u.to); else evo.charges.set(u.to, u.chTo);
  if (u.lkFrom) evo.locked.add(u.from); else evo.locked.delete(u.from);
  if (u.lkTo) evo.locked.add(u.to); else evo.locked.delete(u.to);
  evo.epEvolved = u.epEvolved;
  evo.half = u.prevHalf;
}
