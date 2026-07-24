/**
 * The NNUE feature extractor: an EvoChess position -> the net's input vector.
 *
 * Everything is encoded **from the side-to-move's point of view** — ranks
 * mirrored, colours swapped — so the net learns one function rather than two,
 * and its output is a score from the side-to-move's perspective.
 *
 * This file is the twin of `training/nnue/features.py`. They must agree
 * exactly: feature-extraction skew between trainer and inference is the
 * number-one cause of silently worthless NNUE nets, and it fails *quietly* —
 * the net trains fine and plays badly. The golden-vector parity tests
 * (`__tests__/nnueFeatures.test.ts` here, `tests/test_parity.py` there) exist
 * solely to catch that, so treat any change here as a change to both files.
 *
 * Layout (1569 features):
 *
 *     [0,    1536)  sparse piece-square: 2 colours x 12 classes x 64 squares
 *     [1536, 1569)  dense evolution state
 *
 * Only ~32 of the sparse block are ever active — one per piece on the board —
 * which is what lets the first layer touch ~32 of its 1560 columns and makes
 * the net fast enough to skip incremental accumulator updates entirely.
 */
import type { Color } from "chess.js";
import { EvoChessGame, ROOK_CHARGES } from "./game";

// Mirror N_MINOR and M_ROOK in game.ts. Both are 3, so both progress counters
// live in 0..2 and one-hot to width 3.
export const N_MINOR = 3;
export const M_ROOK = 3;

/**
 * The 12 piece classes. EvoChess-specific, and where most of the design lives:
 *
 *   - `n`/`b`        a minor that may still become a rook
 *   - `n_locked`/`b_locked`
 *                    downgraded from a rook, permanently barred from returning.
 *                    Strictly worse than a normal minor, and the net must be
 *                    able to see the difference.
 *   - `r1`..`r5`     a rook bucketed by remaining charges. A 1-charge rook is
 *                    nearly a minor; a 5-charge rook is a real rook. Giving
 *                    each bucket its own class lets the net learn that curve
 *                    rather than inheriting rookValue()'s linear guess.
 *
 * The order is load-bearing: it fixes the column indices the golden vectors
 * pin down, and must match PIECE_CLASSES in features.py.
 */
export const PIECE_CLASSES = [
  "p",
  "n",
  "b",
  "n_locked",
  "b_locked",
  "r1",
  "r2",
  "r3",
  "r4",
  "r5",
  "q",
  "k",
] as const;
export type PieceClass = (typeof PIECE_CLASSES)[number];

const CLASS_INDEX = new Map<string, number>(PIECE_CLASSES.map((name, i) => [name, i]));

export const NUM_SQUARES = 64;
export const NUM_CLASSES = PIECE_CLASSES.length;
export const SPARSE_SIZE = 2 * NUM_CLASSES * NUM_SQUARES; // 1536

/**
 * Rights accumulate without bound, so they are bucketed 0,1,2,3,4+ to keep the
 * input finite. One-hot rather than a clipped scalar: the width is free at this
 * size, and "is this right worth banking or spending" is the exact non-linear
 * judgement the net exists to make.
 */
export const RIGHTS_BUCKETS = 5;

// Dense evolution-state block. Order and widths are load-bearing (see
// PIECE_CLASSES) and must match DENSE_FIELDS in features.py.
const DENSE_FIELDS: readonly (readonly [string, number])[] = [
  ["minor_rights_us", RIGHTS_BUCKETS],
  ["minor_rights_them", RIGHTS_BUCKETS],
  ["rook_rights_us", RIGHTS_BUCKETS],
  ["rook_rights_them", RIGHTS_BUCKETS],
  ["pawn_progress_us", N_MINOR],
  ["pawn_progress_them", N_MINOR],
  ["minor_progress_us", M_ROOK],
  ["minor_progress_them", M_ROOK],
  ["ep_evolved", 1],
];
export const DENSE_SIZE = DENSE_FIELDS.reduce((sum, [, width]) => sum + width, 0); // 33
export const DENSE_OFFSET = SPARSE_SIZE;
export const FEATURE_SIZE = SPARSE_SIZE + DENSE_SIZE; // 1569

// Start of each dense field within the full vector.
export const DENSE_OFFSETS = new Map<string, number>();
{
  let offset = DENSE_OFFSET;
  for (const [name, width] of DENSE_FIELDS) {
    DENSE_OFFSETS.set(name, offset);
    offset += width;
  }
}

/**
 * The minimal position view the extractor needs: the board (as a FEN), the
 * evolution state, and any pending evolved en passant. Deliberately decoupled
 * from `EvoChessGame` — the Python side extracts from a plain record too, and
 * a small struct is trivial to build from a golden fixture.
 */
export interface NnuePosition {
  fen: string;
  minorRights: Record<Color, number>;
  rookRights: Record<Color, number>;
  pawnMoveProgress: Record<Color, number>;
  minorMoveProgress: Record<Color, number>;
  /** Charges left on each rook, by square. A rook absent here is full-charged. */
  rookCharges: Map<string, number>;
  /** Squares holding a minor downgraded from a rook. */
  rookLocked: Set<string>;
  /** A pending evolved en passant, or null. Only its presence is encoded. */
  epEvolved: { skipped: string; victim: string; color: Color } | null;
}

/** Adapter: the live-game view the shipped engine passes to the net. */
export function positionFromGame(game: EvoChessGame): NnuePosition {
  return {
    fen: game.chess.fen(),
    minorRights: game.minorRights,
    rookRights: game.rookRights,
    pawnMoveProgress: game.pawnMoveProgress,
    minorMoveProgress: game.minorMoveProgress,
    rookCharges: game.rookCharges,
    rookLocked: game.rookLocked,
    epEvolved: game.epEvolved,
  };
}

export function opposite(color: Color): Color {
  return color === "w" ? "b" : "w";
}

interface ParsedFen {
  board: Map<string, { type: string; color: Color }>;
  turn: Color;
}

/**
 * Piece placement and side to move. Hand-rolled to mirror `parse_fen` in
 * features.py line for line, rather than routed through chess.js: the two
 * extractors must agree, and the cheapest way to be sure is to run the same
 * logic in both. The extractor needs nothing else from the FEN.
 */
export function parseFen(fen: string): ParsedFen {
  const parts = fen.trim().split(/\s+/);
  if (parts.length < 2) throw new Error(`not a FEN: ${fen}`);
  const [placement, turn] = parts;
  if (turn !== "w" && turn !== "b") throw new Error(`bad side to move in FEN: ${turn}`);

  const rows = placement.split("/");
  if (rows.length !== 8) throw new Error(`FEN has ${rows.length} ranks, want 8: ${fen}`);

  const board = new Map<string, { type: string; color: Color }>();
  for (let rowIndex = 0; rowIndex < 8; rowIndex++) {
    const rank = 8 - rowIndex; // FEN is written rank 8 first.
    let fileIndex = 0;
    for (const ch of rows[rowIndex]) {
      if (ch >= "1" && ch <= "8") {
        fileIndex += Number(ch);
      } else {
        if (fileIndex >= 8) throw new Error(`rank ${rank} overflows in FEN: ${fen}`);
        const square = `${"abcdefgh"[fileIndex]}${rank}`;
        const color: Color = ch === ch.toUpperCase() ? "w" : "b";
        board.set(square, { type: ch.toLowerCase(), color });
        fileIndex += 1;
      }
    }
    if (fileIndex !== 8) throw new Error(`rank ${rank} has ${fileIndex} files, want 8: ${fen}`);
  }
  return { board, turn };
}

/**
 * Square index 0..63 from the side-to-move's point of view. A1 is 0 and H8 is
 * 63 when White is to move; when Black is to move the rank is mirrored so the
 * side to move always looks up the board. Files are not mirrored.
 */
export function relativeSquare(square: string, stm: Color): number {
  const fileIndex = square.charCodeAt(0) - 97; // 'a' -> 0
  let rankIndex = square.charCodeAt(1) - 49; // '1' -> 0
  if (fileIndex < 0 || fileIndex > 7 || rankIndex < 0 || rankIndex > 7) {
    throw new Error(`not a square: ${square}`);
  }
  if (stm === "b") rankIndex = 7 - rankIndex;
  return rankIndex * 8 + fileIndex;
}

/** Which of the 12 classes a piece on `square` belongs to. */
export function pieceClass(square: string, pieceType: string, position: NnuePosition): PieceClass {
  if (pieceType === "n" || pieceType === "b") {
    return (position.rookLocked.has(square) ? `${pieceType}_locked` : pieceType) as PieceClass;
  }
  if (pieceType === "r") {
    // A rook absent from rookCharges is freshly promoted and carries full
    // charges, matching game.ts. A rook can never sit on the board with zero
    // charges — spending the last one downgrades it the same turn — but clamp
    // anyway rather than emit an out-of-range index.
    const charges = position.rookCharges.get(square) ?? ROOK_CHARGES;
    return `r${Math.min(Math.max(charges, 1), ROOK_CHARGES)}` as PieceClass;
  }
  return pieceType as PieceClass;
}

/** Index of one active piece-square feature. */
export function sparseIndex(isUs: boolean, className: string, relativeSq: number): number {
  const classIndex = CLASS_INDEX.get(className);
  if (classIndex === undefined) throw new Error(`unknown piece class: ${className}`);
  return ((isUs ? 0 : 1) * NUM_CLASSES + classIndex) * NUM_SQUARES + relativeSq;
}

/** The ~32 active sparse indices — one per piece on the board. */
export function activeFeatures(position: NnuePosition): number[] {
  const { board, turn } = parseFen(position.fen);
  const indices: number[] = [];
  for (const [square, { type, color }] of board) {
    indices.push(
      sparseIndex(color === turn, pieceClass(square, type, position), relativeSquare(square, turn))
    );
  }
  return indices;
}

function oneHotIndex(field: string, value: number, width: number): number {
  return DENSE_OFFSETS.get(field)! + Math.min(Math.max(value, 0), width - 1);
}

/**
 * The ~8-9 active indices in the dense evolution-state block. This is the
 * part a material evaluation cannot express, and the whole reason for the
 * exercise — it must be included in every real evaluation, not just
 * `extract()`'s full-vector materialisation (see `evaluatePosition` in
 * `nnue.ts`, which was found to skip this entirely: two positions with
 * identical pieces but different banked rights scored bit-identical).
 */
export function denseActiveIndices(position: NnuePosition): number[] {
  const stm = parseFen(position.fen).turn;
  const them = opposite(stm);
  const indices: number[] = [
    oneHotIndex("minor_rights_us", position.minorRights[stm], RIGHTS_BUCKETS),
    oneHotIndex("minor_rights_them", position.minorRights[them], RIGHTS_BUCKETS),
    oneHotIndex("rook_rights_us", position.rookRights[stm], RIGHTS_BUCKETS),
    oneHotIndex("rook_rights_them", position.rookRights[them], RIGHTS_BUCKETS),
    oneHotIndex("pawn_progress_us", position.pawnMoveProgress[stm], N_MINOR),
    oneHotIndex("pawn_progress_them", position.pawnMoveProgress[them], N_MINOR),
    oneHotIndex("minor_progress_us", position.minorMoveProgress[stm], M_ROOK),
    oneHotIndex("minor_progress_them", position.minorMoveProgress[them], M_ROOK),
  ];

  // One flag suffices, with no need to say whose: the right is created by one
  // side's double move and the turn then flips, so a pending evolved en
  // passant is always the side to move's to take.
  if (position.epEvolved !== null) indices.push(DENSE_OFFSETS.get("ep_evolved")!);

  return indices;
}

/**
 * Write the evolution-state block into `vector` in place. This is the part a
 * material evaluation cannot express, and the whole reason for the exercise.
 */
export function denseFeatures(position: NnuePosition, vector: Float32Array): void {
  for (const index of denseActiveIndices(position)) vector[index] = 1;
}

/**
 * The full dense input vector. Mostly for tests and the parity check; the
 * shipped inference path reads `activeFeatures()` plus `denseActiveIndices()`
 * directly rather than materialising 1569 floats to touch ~40 of them.
 */
export function extract(position: NnuePosition): Float32Array {
  const vector = new Float32Array(FEATURE_SIZE);
  for (const index of activeFeatures(position)) vector[index] = 1;
  denseFeatures(position, vector);
  return vector;
}

/**
 * The sorted indices of the active (nonzero) features. Every feature is binary,
 * so this list *is* the vector — which is exactly what the golden-vector parity
 * check compares across the two languages.
 */
export function activeIndices(position: NnuePosition): number[] {
  const vector = extract(position);
  const indices: number[] = [];
  for (let i = 0; i < vector.length; i++) if (vector[i] !== 0) indices.push(i);
  return indices;
}
