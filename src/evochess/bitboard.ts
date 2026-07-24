/**
 * PROTOTYPE bitboard move generator for the base-chess layer of EvoChess.
 *
 * Purpose: measure how much faster a purpose-built generator is than
 * chess.js's `moves({verbose:true})`, which the profiling in the make/unmake
 * experiment fingered as the real per-node bottleneck of the search (it makes
 * and unmakes every pseudo-legal move on its 0x88 board to test for check, and
 * allocates a move object per move).
 *
 * Scope: standard chess movement/legality with NO castling (EvoChess has none)
 * plus en passant. It produces the exact set of legal (from, to, promotion)
 * base moves. The EvoChess evolution decisions (minor/rook promotion, rook
 * downgrade, evolved en passant) are a thin, cheap layer applied on top of the
 * base move set — deliberately out of scope here, exactly as they sit on top of
 * chess.js today.
 *
 * Representation: 64-bit bitboards as BigInt, LERF layout (a1=0 … h8=63). BigInt
 * is the honest, readable choice for a JS prototype; it does allocate per
 * operation, so it also marks the ceiling a lo/hi 32-bit-word or WASM/Rust
 * rewrite would push past. See the benchmark for the measured result.
 */

// ---- square helpers (LERF: a1=0, b1=1, … h1=7, a2=8, … h8=63) ----------
const fileOf = (sq: number): number => sq & 7;
const rankOf = (sq: number): number => sq >> 3;
export const bitAt = (sq: number): bigint => 1n << BigInt(sq);

export function squareName(sq: number): string {
  return String.fromCharCode(97 + fileOf(sq)) + (rankOf(sq) + 1);
}

// Piece indices within a side's 6 boards.
const P = 0, N = 1, B = 2, R = 3, Q = 4, K = 5;
// Promotion codes used in the packed move (0 = none).
const PROMO_NONE = 0;
const PROMO_LETTER = ["", "n", "b", "r", "q"];

// ---- precomputed attack tables -----------------------------------------
const knightAttacks: bigint[] = Array.from({ length: 64 }, () => 0n);
const kingAttacks: bigint[] = Array.from({ length: 64 }, () => 0n);
// pawnAttacks[color][sq]: squares a pawn of `color` on `sq` attacks (color 0 = white).
const pawnAttacks: bigint[][] = [Array.from({ length: 64 }, () => 0n), Array.from({ length: 64 }, () => 0n)];

// 8 ray directions; index increases for the first four ("positive").
const DIRS: Array<[number, number]> = [
  [0, 1], // 0 N  (+8)
  [1, 0], // 1 E  (+1)
  [1, 1], // 2 NE (+9)
  [-1, 1], // 3 NW (+7)
  [0, -1], // 4 S  (-8)
  [-1, 0], // 5 W  (-1)
  [1, -1], // 6 SE (-7)
  [-1, -1], // 7 SW (-9)
];
const POSITIVE = [true, true, true, true, false, false, false, false];
const rayMask: bigint[][] = DIRS.map(() => Array.from({ length: 64 }, () => 0n));

(function precompute() {
  const inBoard = (f: number, r: number) => f >= 0 && f < 8 && r >= 0 && r < 8;
  const knightD = [
    [1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2],
  ];
  const kingD = [
    [0, 1], [1, 1], [1, 0], [1, -1], [0, -1], [-1, -1], [-1, 0], [-1, 1],
  ];
  for (let sq = 0; sq < 64; sq++) {
    const f = fileOf(sq), r = rankOf(sq);
    for (const [df, dr] of knightD) {
      if (inBoard(f + df, r + dr)) knightAttacks[sq] |= bitAt((r + dr) * 8 + (f + df));
    }
    for (const [df, dr] of kingD) {
      if (inBoard(f + df, r + dr)) kingAttacks[sq] |= bitAt((r + dr) * 8 + (f + df));
    }
    // white pawn attacks up (dr +1), black down (dr -1)
    for (const df of [-1, 1]) {
      if (inBoard(f + df, r + 1)) pawnAttacks[0][sq] |= bitAt((r + 1) * 8 + (f + df));
      if (inBoard(f + df, r - 1)) pawnAttacks[1][sq] |= bitAt((r - 1) * 8 + (f + df));
    }
    for (let d = 0; d < 8; d++) {
      const [df, dr] = DIRS[d];
      let nf = f + df, nr = r + dr;
      while (inBoard(nf, nr)) {
        rayMask[d][sq] |= bitAt(nr * 8 + nf);
        nf += df;
        nr += dr;
      }
    }
  }
})();

// ---- bit scans (via 32-bit halves; Math.clz32 is fast SMI work) ---------
const ctz32 = (x: number): number => 31 - Math.clz32(x & -x);
export function lsbIndex(bb: bigint): number {
  const lo = Number(bb & 0xffffffffn) >>> 0;
  if (lo !== 0) return ctz32(lo);
  return 32 + ctz32(Number((bb >> 32n) & 0xffffffffn) >>> 0);
}
function msbIndex(bb: bigint): number {
  const hi = Number((bb >> 32n) & 0xffffffffn) >>> 0;
  if (hi !== 0) return 63 - Math.clz32(hi);
  return 31 - Math.clz32(Number(bb & 0xffffffffn) >>> 0);
}

// ---- sliding attacks (classical ray obstruction) -----------------------
function rayAttack(dir: number, sq: number, occ: bigint): bigint {
  let att = rayMask[dir][sq];
  const blockers = att & occ;
  if (blockers !== 0n) {
    const b = POSITIVE[dir] ? lsbIndex(blockers) : msbIndex(blockers);
    att ^= rayMask[dir][b];
  }
  return att;
}
const bishopAttack = (sq: number, occ: bigint): bigint =>
  rayAttack(2, sq, occ) | rayAttack(3, sq, occ) | rayAttack(6, sq, occ) | rayAttack(7, sq, occ);
const rookAttack = (sq: number, occ: bigint): bigint =>
  rayAttack(0, sq, occ) | rayAttack(1, sq, occ) | rayAttack(4, sq, occ) | rayAttack(5, sq, occ);

// ---- position ----------------------------------------------------------
export interface Position {
  bb: bigint[]; // 12 boards: [white P,N,B,R,Q,K, black P,N,B,R,Q,K]
  occ: [bigint, bigint];
  all: bigint;
  us: 0 | 1; // 0 white, 1 black
  ep: number; // en-passant target square, or -1
}

const CHAR_TO_PIECE: Record<string, [number, number]> = {
  P: [0, P], N: [0, N], B: [0, B], R: [0, R], Q: [0, Q], K: [0, K],
  p: [1, P], n: [1, N], b: [1, B], r: [1, R], q: [1, Q], k: [1, K],
};

/** Build a Position from a FEN. Castling field is ignored (EvoChess has none). */
export function fromFen(fen: string): Position {
  const [board, side, , ep] = fen.trim().split(/\s+/);
  const bb = Array.from({ length: 12 }, () => 0n);
  const rows = board.split("/"); // rows[0] = rank 8
  for (let i = 0; i < 8; i++) {
    const rank = 7 - i;
    let file = 0;
    for (const ch of rows[i]) {
      if (ch >= "1" && ch <= "8") {
        file += ch.charCodeAt(0) - 48;
      } else {
        const [color, type] = CHAR_TO_PIECE[ch];
        bb[color * 6 + type] |= bitAt(rank * 8 + file);
        file++;
      }
    }
  }
  let occW = 0n, occB = 0n;
  for (let t = 0; t < 6; t++) { occW |= bb[t]; occB |= bb[6 + t]; }
  let epSq = -1;
  if (ep && ep !== "-") epSq = (ep.charCodeAt(1) - 49) * 8 + (ep.charCodeAt(0) - 97);
  return { bb, occ: [occW, occB], all: occW | occB, us: side === "w" ? 0 : 1, ep: epSq };
}

// packed move: from | to<<6 | promo<<12
const packMove = (from: number, to: number, promo: number): number => from | (to << 6) | (promo << 12);
export const moveFrom = (m: number): number => m & 63;
export const moveTo = (m: number): number => (m >> 6) & 63;
export const movePromo = (m: number): number => (m >> 12) & 7;
export function moveString(m: number): string {
  return squareName(moveFrom(m)) + squareName(moveTo(m)) + PROMO_LETTER[movePromo(m)];
}

/** Is `sq` attacked by the side whose enemy boards are passed in? */
function attacked(
  sq: number, occ: bigint,
  eP: bigint, eN: bigint, eB: bigint, eR: bigint, eQ: bigint, eK: bigint,
  us: 0 | 1
): boolean {
  if ((knightAttacks[sq] & eN) !== 0n) return true;
  if ((kingAttacks[sq] & eK) !== 0n) return true;
  if ((pawnAttacks[us][sq] & eP) !== 0n) return true;
  const bq = eB | eQ;
  if (bq !== 0n && (bishopAttack(sq, occ) & bq) !== 0n) return true;
  const rq = eR | eQ;
  if (rq !== 0n && (rookAttack(sq, occ) & rq) !== 0n) return true;
  return false;
}

/**
 * Would the mover's own king be safe after (from → to)? Recomputes only the
 * occupancy and the captured enemy board; nothing is mutated.
 */
function kingSafe(pos: Position, from: number, to: number, isEp: boolean, moverIsKing: boolean): boolean {
  const us = pos.us, them = (us ^ 1) as 0 | 1;
  const fromB = bitAt(from), toB = bitAt(to);
  let occ = (pos.all & ~fromB) | toB;
  const base = them * 6;
  let eP = pos.bb[base + P], eN = pos.bb[base + N], eB = pos.bb[base + B];
  let eR = pos.bb[base + R], eQ = pos.bb[base + Q];
  const eK = pos.bb[base + K];

  const capSq = isEp ? (us === 0 ? to - 8 : to + 8) : to;
  const capB = bitAt(capSq);
  if (isEp) occ &= ~capB;
  if ((pos.occ[them] & capB) !== 0n) {
    eP &= ~capB; eN &= ~capB; eB &= ~capB; eR &= ~capB; eQ &= ~capB;
  }
  const ksq = moverIsKing ? to : lsbIndex(pos.bb[us * 6 + K]);
  return !attacked(ksq, occ, eP, eN, eB, eR, eQ, eK, us);
}

/** All legal base moves for the side to move, as packed ints. */
export function generateLegal(pos: Position): number[] {
  const moves: number[] = [];
  const us = pos.us;
  const base = us * 6;
  const usOcc = pos.occ[us];
  const notUs = ~usOcc;
  const enemyOcc = pos.occ[us ^ 1];
  const all = pos.all;

  // -- pawns --
  const fwd = us === 0 ? 8 : -8;
  const startRank = us === 0 ? 1 : 6;
  const promoRank = us === 0 ? 7 : 0;
  let pawns = pos.bb[base + P];
  while (pawns !== 0n) {
    const from = lsbIndex(pawns);
    pawns &= pawns - 1n;
    // pushes
    const one = from + fwd;
    if (one >= 0 && one < 64 && (all & bitAt(one)) === 0n) {
      if (rankOf(one) === promoRank) {
        if (kingSafe(pos, from, one, false, false)) {
          moves.push(packMove(from, one, Q), packMove(from, one, R), packMove(from, one, B), packMove(from, one, N));
        }
      } else {
        if (kingSafe(pos, from, one, false, false)) moves.push(packMove(from, one, PROMO_NONE));
        if (rankOf(from) === startRank) {
          const two = from + 2 * fwd;
          if ((all & bitAt(two)) === 0n && kingSafe(pos, from, two, false, false)) {
            moves.push(packMove(from, two, PROMO_NONE));
          }
        }
      }
    }
    // captures (incl. en passant)
    let caps = pawnAttacks[us][from] & (enemyOcc | (pos.ep >= 0 ? bitAt(pos.ep) : 0n));
    while (caps !== 0n) {
      const to = lsbIndex(caps);
      caps &= caps - 1n;
      const isEp = to === pos.ep;
      if (rankOf(to) === promoRank) {
        if (kingSafe(pos, from, to, false, false)) {
          moves.push(packMove(from, to, Q), packMove(from, to, R), packMove(from, to, B), packMove(from, to, N));
        }
      } else if (kingSafe(pos, from, to, isEp, false)) {
        moves.push(packMove(from, to, PROMO_NONE));
      }
    }
  }

  // -- knights --
  let knights = pos.bb[base + N];
  while (knights !== 0n) {
    const from = lsbIndex(knights);
    knights &= knights - 1n;
    let t = knightAttacks[from] & notUs;
    while (t !== 0n) {
      const to = lsbIndex(t);
      t &= t - 1n;
      if (kingSafe(pos, from, to, false, false)) moves.push(packMove(from, to, PROMO_NONE));
    }
  }

  // -- bishops / rooks / queens --
  const sliders: Array<[number, (sq: number, occ: bigint) => bigint]> = [
    [B, bishopAttack], [R, rookAttack],
    [Q, (sq, occ) => bishopAttack(sq, occ) | rookAttack(sq, occ)],
  ];
  for (const [type, attackFn] of sliders) {
    let pieces = pos.bb[base + type];
    while (pieces !== 0n) {
      const from = lsbIndex(pieces);
      pieces &= pieces - 1n;
      let t = attackFn(from, all) & notUs;
      while (t !== 0n) {
        const to = lsbIndex(t);
        t &= t - 1n;
        if (kingSafe(pos, from, to, false, false)) moves.push(packMove(from, to, PROMO_NONE));
      }
    }
  }

  // -- king --
  let king = pos.bb[base + K];
  while (king !== 0n) {
    const from = lsbIndex(king);
    king &= king - 1n;
    let t = kingAttacks[from] & notUs;
    while (t !== 0n) {
      const to = lsbIndex(t);
      t &= t - 1n;
      if (kingSafe(pos, from, to, false, true)) moves.push(packMove(from, to, PROMO_NONE));
    }
  }

  return moves;
}

/** Apply a legal move, returning a new Position (used by perft; allocates). */
export function makeMove(pos: Position, m: number): Position {
  const from = moveFrom(m), to = moveTo(m), promo = movePromo(m);
  const us = pos.us, them = (us ^ 1) as 0 | 1;
  const bb = pos.bb.slice();
  const fromB = bitAt(from), toB = bitAt(to);

  // moving piece type
  let type = -1;
  for (let t = 0; t < 6; t++) if ((bb[us * 6 + t] & fromB) !== 0n) { type = t; break; }
  bb[us * 6 + type] &= ~fromB;

  const isEp = type === P && to === pos.ep;
  const capSq = isEp ? (us === 0 ? to - 8 : to + 8) : to;
  const capB = bitAt(capSq);
  for (let t = 0; t < 6; t++) if ((bb[them * 6 + t] & capB) !== 0n) { bb[them * 6 + t] &= ~capB; break; }

  bb[us * 6 + (promo === PROMO_NONE ? type : promo)] |= toB;

  let ep = -1;
  if (type === P && Math.abs(to - from) === 16) ep = from + (us === 0 ? 8 : -8);

  let occW = 0n, occB = 0n;
  for (let t = 0; t < 6; t++) { occW |= bb[t]; occB |= bb[6 + t]; }
  return { bb, occ: [occW, occB], all: occW | occB, us: them, ep };
}

/** Node count of the legal move tree to `depth` — the standard correctness probe. */
export function perft(pos: Position, depth: number): number {
  if (depth === 0) return 1;
  const moves = generateLegal(pos);
  if (depth === 1) return moves.length;
  let nodes = 0;
  for (const m of moves) nodes += perft(makeMove(pos, m), depth - 1);
  return nodes;
}

// ---- in-place make/unmake (for search) ---------------------------------

/** Undo record for `makeMoveInPlace`. */
export interface Undo {
  from: number;
  to: number;
  moverType: number;
  placedType: number;
  capType: number; // -1 if not a capture
  capSq: number;
  prevEp: number;
}

/**
 * Apply a legal move by mutating `pos`, returning an `Undo` for `unmakeMove`.
 * Occupancy is maintained incrementally, so a make/unmake pair is a handful of
 * BigInt ops — no board rebuild, no allocation beyond the small Undo record.
 */
export function makeMoveInPlace(pos: Position, m: number): Undo {
  const from = moveFrom(m), to = moveTo(m), promo = movePromo(m);
  const us = pos.us, them = (us ^ 1) as 0 | 1;
  const usBase = us * 6, themBase = them * 6;
  const fromB = bitAt(from), toB = bitAt(to);

  let moverType = -1;
  for (let t = 0; t < 6; t++) if ((pos.bb[usBase + t] & fromB) !== 0n) { moverType = t; break; }
  pos.bb[usBase + moverType] ^= fromB;

  const isEp = moverType === P && to === pos.ep;
  const capSq = isEp ? (us === 0 ? to - 8 : to + 8) : to;
  const capB = bitAt(capSq);
  let capType = -1;
  if ((pos.occ[them] & capB) !== 0n) {
    for (let t = 0; t < 6; t++) if ((pos.bb[themBase + t] & capB) !== 0n) { capType = t; break; }
    pos.bb[themBase + capType] ^= capB;
    pos.occ[them] ^= capB;
  }

  const placedType = promo === PROMO_NONE ? moverType : promo;
  pos.bb[usBase + placedType] |= toB;
  pos.occ[us] = (pos.occ[us] & ~fromB) | toB;
  pos.all = pos.occ[0] | pos.occ[1];

  const prevEp = pos.ep;
  pos.ep = moverType === P && (to - from === 16 || from - to === 16) ? from + (us === 0 ? 8 : -8) : -1;
  pos.us = them;
  return { from, to, moverType, placedType, capType, capSq, prevEp };
}

/** Reverse a `makeMoveInPlace`. */
export function unmakeMove(pos: Position, u: Undo): void {
  pos.us = (pos.us ^ 1) as 0 | 1; // back to the mover
  const us = pos.us, them = (us ^ 1) as 0 | 1;
  const usBase = us * 6, themBase = them * 6;
  const fromB = bitAt(u.from), toB = bitAt(u.to);

  pos.bb[usBase + u.placedType] ^= toB; // lift the placed (possibly promoted) piece
  pos.bb[usBase + u.moverType] |= fromB; // restore the mover on its origin
  pos.occ[us] = (pos.occ[us] & ~toB) | fromB;
  if (u.capType >= 0) {
    const capB = bitAt(u.capSq);
    pos.bb[themBase + u.capType] |= capB;
    pos.occ[them] |= capB;
  }
  pos.all = pos.occ[0] | pos.occ[1];
  pos.ep = u.prevEp;
}

/** Is the side to move currently in check? */
export function inCheck(pos: Position): boolean {
  const us = pos.us, tb = (us ^ 1) * 6;
  const ksq = lsbIndex(pos.bb[us * 6 + K]);
  return attacked(
    ksq, pos.all,
    pos.bb[tb + P], pos.bb[tb + N], pos.bb[tb + B], pos.bb[tb + R], pos.bb[tb + Q], pos.bb[tb + K],
    us
  );
}

/** Piece type (0..5, colour-agnostic) on `sq`, or -1 if empty. */
export function pieceAt(pos: Position, sq: number): number {
  const b = bitAt(sq);
  for (let i = 0; i < 12; i++) if ((pos.bb[i] & b) !== 0n) return i % 6;
  return -1;
}

/** En-passant target square of `pos` (-1 if none) — exposed for move ordering. */
export const epSquare = (pos: Position): number => pos.ep;

/**
 * Draw by insufficient mating material, replicating chess.js's rule exactly (so
 * the bitboard engine terminates games where the reference does): K vs K, K vs
 * K+minor, and any number of bishops on a single square colour. A pawn, rook, or
 * queen anywhere means mate is still possible.
 */
export function insufficientMaterial(pos: Position): boolean {
  let numPieces = 0, nB = 0, nN = 0, bishopColorSum = 0, majorOrPawn = false;
  for (let i = 0; i < 12; i++) {
    const t = i % 6;
    let bb = pos.bb[i];
    while (bb !== 0n) {
      const sq = lsbIndex(bb);
      bb &= bb - 1n;
      numPieces++;
      if (t === P || t === R || t === Q) majorOrPawn = true;
      else if (t === N) nN++;
      else if (t === B) { nB++; bishopColorSum += (fileOf(sq) + rankOf(sq)) & 1; }
    }
  }
  if (majorOrPawn) return false;
  if (numPieces === 2) return true; // K vs K
  if (numPieces === 3 && (nB === 1 || nN === 1)) return true; // K vs K+minor
  if (numPieces === nB + 2) return bishopColorSum === 0 || bishopColorSum === nB; // bishops, one colour
  return false;
}
