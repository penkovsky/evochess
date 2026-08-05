import type { Square } from "chess.js";
import { ROOK_CHARGES, type ApplyMoveOptions, type EvoChessGame } from "./game";
import type { PromoModalState } from "../appTypes";

/**
 * What a tap or drag from one square to another should do. Three outcomes, so
 * the caller never has to re-derive which one it is: refuse it, apply it, or
 * ask the player a question first.
 */
export type MoveIntent =
  /** Not a move: an empty square, or one the engine refuses. */
  | { kind: "reject" }
  /** Legal and unambiguous. */
  | { kind: "apply"; from: Square; to: Square; options: ApplyMoveOptions }
  /** There is a choice to make before it can be applied. */
  | { kind: "prompt"; modal: PromoModalState };

/**
 * The promotion, evolution and rook-charge rules that decide between those
 * three. Pure: it reads the position and previews the move on a scratch copy,
 * and changes nothing.
 *
 * The preview is what keeps the prompt from lagging a move behind. A pawn move
 * can earn the very right it would spend, and a minor's rook right may be spent
 * only on the piece that just moved, so both are read from the position the
 * move leads to rather than the one it leaves.
 */
export function planMove(game: EvoChessGame, from: Square, to: Square): MoveIntent {
  const piece = game.chess.get(from);
  if (!piece) return { kind: "reject" };

  const isPawn = piece.type === "p";
  const isRook = piece.type === "r";
  const reachesLastRank = isPawn && (to[1] === "8" || to[1] === "1");

  if (reachesLastRank) {
    return { kind: "prompt", modal: { from, to, kind: "forced", color: game.turn, canMinor: false, canRook: false } };
  }

  if (isRook) {
    const remaining = (game.rookCharges.get(from) ?? ROOK_CHARGES) - 1;
    // A dummy downgrade choice is only there to get past the mandatory-
    // downgrade check. It is never applied to the real game.
    const scratch = game.copy();
    try {
      scratch.applyMove(from, to, remaining <= 0 ? { downgradeTo: "n" } : {});
    } catch {
      return { kind: "reject" };
    }
    if (remaining <= 0) {
      return {
        kind: "prompt",
        modal: { from, to, kind: "downgrade", color: game.turn, canMinor: false, canRook: false },
      };
    }
    return { kind: "apply", from, to, options: {} };
  }

  const scratch = game.copy();
  try {
    scratch.applyMove(from, to);
  } catch {
    return { kind: "reject" };
  }

  const color = game.turn;
  const isMinor = piece.type === "n" || piece.type === "b";
  const canMinor = isPawn && scratch.minorRights[color] > 0;
  // The rook right may be spent only on the minor piece that just moved, which
  // now sits on `to`.
  const canRook = isMinor && scratch.canRookPromote(color, to);

  if (!canMinor && !canRook) return { kind: "apply", from, to, options: {} };
  return { kind: "prompt", modal: { from, to, kind: "optional", color, canMinor, canRook } };
}
