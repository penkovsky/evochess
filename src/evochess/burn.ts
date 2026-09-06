import type { Square } from "chess.js";
import type { EvoChessGame } from "./game";

/** A move that earned the burn. `id` restarts the animation. */
export interface Burn {
  from: Square;
  to: Square;
  id: number;
}

/**
 * An evolution or a rook downgrade, delivered with check. A pawn's last-rank
 * promotion is ordinary chess and does not count.
 */
export function isBurningMove(
  before: EvoChessGame,
  after: EvoChessGame,
  from: Square,
  to: Square,
): boolean {
  if (!after.chess.isCheck()) return false;
  const was = before.chess.get(from);
  const now = after.chess.get(to);
  if (!was || !now || was.type === now.type) return false;
  return !(was.type === "p" && (to[1] === "8" || to[1] === "1"));
}
