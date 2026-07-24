/**
 * Option A of the NNUE-on-bitboard port (nnue-bitboard-port-spec.md §2): a FEN
 * adapter from the bitboard search's `EvoPos` to the net's `NnuePosition`, so
 * `evaluatePosition`/`evaluateNnuePosition` can score a bitboard position
 * without any new feature-indexing logic. Deliberately the slow, obviously-
 * correct baseline — it reuses the golden-tested extractor verbatim, so
 * parity with the trainer and the chessjs path is guaranteed by construction.
 * The bitboard-native indexer (Option B) that removes the FEN round-trip is a
 * later, separate step (spec §3).
 */
import type { Color } from "chess.js";
import type { EvoPos } from "./evoBitboard";
import { squareName, lsbIndex, type Position } from "./bitboard";
import type { NnuePosition } from "./nnueFeatures";

const PIECE_LETTERS = ["p", "n", "b", "r", "q", "k"]; // matches bitboard.ts P N B R Q K = 0..5

/** FEN piece-placement field for a bitboard `Position`'s board. */
function placementFromPos(pos: Position): string {
  const grid: (string | null)[] = Array.from({ length: 64 }, () => null);
  for (let c = 0; c < 2; c++) {
    for (let t = 0; t < 6; t++) {
      let bb = pos.bb[c * 6 + t];
      const letter = c === 0 ? PIECE_LETTERS[t].toUpperCase() : PIECE_LETTERS[t];
      while (bb !== 0n) {
        const sq = lsbIndex(bb);
        bb &= bb - 1n;
        grid[sq] = letter;
      }
    }
  }

  const rows: string[] = [];
  for (let rank = 7; rank >= 0; rank--) {
    let row = "";
    let empty = 0;
    for (let file = 0; file < 8; file++) {
      const piece = grid[rank * 8 + file];
      if (piece === null) {
        empty++;
        continue;
      }
      if (empty > 0) {
        row += empty;
        empty = 0;
      }
      row += piece;
    }
    if (empty > 0) row += empty;
    rows.push(row);
  }
  return rows.join("/");
}

/**
 * Build the `NnuePosition` the net's extractor expects from a bitboard
 * `EvoPos`: a FEN (placement + side to move only — `parseFen` reads nothing
 * else) plus the evo state translated from number-squares/color-ints to the
 * `"e4"`-name/`"w"`/`"b"` shapes `nnueFeatures.ts` uses.
 */
export function nnuePositionFromEvoPos(s: EvoPos): NnuePosition {
  const { pos, evo } = s;
  const turn: Color = pos.us === 0 ? "w" : "b";

  const rookCharges = new Map<string, number>();
  for (const [sq, charges] of evo.charges) rookCharges.set(squareName(sq), charges);

  const rookLocked = new Set<string>();
  for (const sq of evo.locked) rookLocked.add(squareName(sq));

  return {
    fen: `${placementFromPos(pos)} ${turn}`,
    minorRights: { w: evo.minorRights[0], b: evo.minorRights[1] },
    rookRights: { w: evo.rookRights[0], b: evo.rookRights[1] },
    pawnMoveProgress: { w: evo.pawnProgress[0], b: evo.pawnProgress[1] },
    minorMoveProgress: { w: evo.minorProgress[0], b: evo.minorProgress[1] },
    rookCharges,
    rookLocked,
    epEvolved: evo.epEvolved
      ? {
          skipped: squareName(evo.epEvolved.skipped),
          victim: squareName(evo.epEvolved.victim),
          color: evo.epEvolved.color === 0 ? "w" : "b",
        }
      : null,
  };
}
