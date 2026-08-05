import type { Color } from "chess.js";
import type { Square } from "chess.js";
import type { AiLevel } from "./evochess/ai";

export type Mode = "human-ai" | "human-human";

/** A puzzle is a mate to find, not a difficulty to pick, so it fixes its own
 *  level and locks the picker. Never written into `level`: that is the
 *  player's own setting, and a puzzle that set it would leave Zen behind. */
export const PUZZLE_LEVEL: AiLevel = "zen";

/**
 * Which widget the mobile bar is showing in the sheet, if any. The rules
 * summary is not one of them: the puzzle button took its place in the bar, so
 * on a phone the rules are reached from inside the settings sheet.
 */
export type MobileWidget = "log" | "settings";

export interface PromoModalState {
  from: Square;
  to: Square;
  kind: "forced" | "optional" | "downgrade";
  color: Color;
  canMinor: boolean;
  canRook: boolean;
}

/** Why there is no link to hand over. `null` is the ordinary case. */
export type ShareProblem = "too-long" | "unencodable" | null;

export interface ShareModalState {
  url: string;
  problem: ShareProblem;
  clipboardOk: boolean;
  copiedAt: number | null;
  /** Which section the "Copied!" confirmation belongs to. */
  copiedKind: "url" | "log" | null;
  /**
   * Whether to offer the OS share sheet as well as the URL field. True only
   * for the mobile bar's button, since a desktop browser exposing
   * `navigator.share` is not a reason to send a PC user to a sheet.
   */
  canShareSheet: boolean;
  /** The move log, snapshotted when the dialog opened. */
  moveLog: string[];
  /** Whether that log's first ply is Black's, as on a shared Black-to-move position. */
  blackFirst: boolean;
  /** Whether a history link is available at all, i.e. whether to offer the choice. */
  hasHistory: boolean;
  /** Whether the link currently carries the line as well as the position. */
  withHistory: boolean;
}

/** Why a restart is being proposed. Only the dialog's wording depends on it. */
export type RestartReason = "new-game" | "mode" | "color" | "level";

/**
 * The actions that discard moves, and so are asked about before they run.
 * `restart` carries the settings to start with, since a switch applies its own
 * new value while New Game reuses the current ones.
 */
export type ConfirmState =
  | { kind: "play-here"; ply: number }
  // The one confirmation that is not about discarded moves. The seat is what
  // is lost, and it cannot be reclaimed.
  | { kind: "leave-live" }
  | { kind: "restart"; what: RestartReason; mode: Mode; aiColor: Color; level: AiLevel };

export const RESTART_TITLE: Record<RestartReason, string> = {
  "new-game": "Start a new game?",
  mode: "Switch mode?",
  color: "Switch colors?",
  level: "Switch level?",
};
