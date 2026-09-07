import type { Square } from "chess.js";
import type { EvoChessGame } from "./game";

/** The square that iced over. `id` restarts the animation. */
export interface Freeze {
  square: Square;
  id: number;
}

/**
 * A rook that spent its last charge and downgraded (rules.txt §4). A downgrade
 * that also gives check burns instead (`burn.ts`): fire wins over ice.
 */
export function isFreezingMove(
  before: EvoChessGame,
  after: EvoChessGame,
  from: Square,
  to: Square,
): boolean {
  if (after.chess.isCheck()) return false;
  const was = before.chess.get(from);
  const now = after.chess.get(to);
  if (!was || !now) return false;
  return was.type === "r" && (now.type === "n" || now.type === "b");
}
