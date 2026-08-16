/**
 * What a finished game is reported as, and whether it is reported at all.
 *
 * Pure, and split out of `App.tsx` for that reason: the effects that ship these
 * events need a browser and a whole app around them, and the rules below are
 * the part with the edge cases. `telemetry.ts` owns the sending, and knows
 * nothing about how the outcome was decided.
 */

import type { Color } from "chess.js";
import type { GameMeta } from "./telemetry";

/** How a live match ended: a winner's colour, or "d" for a draw. */
export type LiveOutcome = Color | "d";

export type ReportedOutcome = "win" | "loss" | "draw" | "timeout";

/**
 * Whose result "win" and "loss" are stated from.
 *
 * In a match the human is whoever holds the seat, not White. Over the board
 * there is no away side, so White stands in.
 */
export function humanSeat({
  liveSeat,
  mode,
  aiColor,
}: {
  /** The seat held in a live match, or null when this is not one. */
  liveSeat: Color | null;
  mode: "human-ai" | "human-human";
  aiColor: Color;
}): Color {
  if (liveSeat) return liveSeat;
  return mode === "human-ai" ? (aiColor === "w" ? "b" : "w") : "w";
}

/**
 * Whether the game has ended by any means.
 *
 * The clock and a live resignation both end it without the board showing it
 * (docs/live-match.md §Milestone 2c). Left out, either would go unreported and
 * then be logged as abandoned on the way out of the tab.
 */
export function gameFinished({
  isGameOver,
  timeUp,
  liveOutcome,
}: {
  isGameOver: boolean;
  /** The side that ran out of time, or null. */
  timeUp: Color | null;
  liveOutcome: LiveOutcome | null;
}): boolean {
  return isGameOver || timeUp !== null || liveOutcome !== null;
}

/**
 * The outcome to report, from the human's side.
 *
 * The order is the rule: the clock beats an agreed result, which beats the
 * board. A match that ended in resignation has a result the position does not
 * show, so reading the board first would call it a draw.
 *
 * A timeout is reported as "timeout" whichever side ran out, so it is one
 * bucket rather than a win and a loss. Only the clock runs in human-vs-human,
 * where there is no human side to state a result from.
 */
export function finishedOutcome({
  timeUp,
  liveOutcome,
  isCheckmate,
  turn,
  humanColor,
}: {
  /** The side that ran out of time, or null. */
  timeUp: Color | null;
  liveOutcome: LiveOutcome | null;
  isCheckmate: boolean;
  /** Side to move now. On a mate, the side that has been mated. */
  turn: Color;
  humanColor: Color;
}): ReportedOutcome {
  if (timeUp) return "timeout";
  if (liveOutcome) {
    if (liveOutcome === "d") return "draw";
    return liveOutcome === humanColor ? "win" : "loss";
  }
  // Over, and not mate: stalemate, repetition, the fifty-move rule.
  if (!isCheckmate) return "draw";
  return turn === humanColor ? "loss" : "win";
}

/**
 * Whether leaving the tab should report an abandon.
 *
 * `logged` is the game already having been reported as finished. `started` is
 * the player having played at all. `abandonedAtPly` is the bfcache guard:
 * `pagehide` fires again after a restore, so a game reopened and left alone
 * would otherwise be reported once per visit.
 */
export function shouldReportAbandon(
  meta: Pick<GameMeta, "started" | "logged" | "abandonedAtPly">,
  plies: number
): boolean {
  if (!meta.started || meta.logged) return false;
  return meta.abandonedAtPly !== plies;
}
