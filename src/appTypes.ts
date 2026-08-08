import type { CSSProperties, HTMLAttributes } from "react";
import type { Color } from "chess.js";
import type { Square } from "chess.js";
import type { AiLevel } from "./evochess/ai";
import type { EvoChessGame, Rights } from "./evochess/game";
import type { Scores } from "./evochess/scores";

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
export type RestartReason = "new-game" | "color" | "level";

/**
 * What New Game starts. Mode used to be a picker in the panel, but changing it
 * always restarted the game, so it is a new game in disguise and lives here
 * (docs/live-match.md §Milestone 2).
 */
export type NewGameChoice = "ai" | "live" | "otb";

/** A match is vs-Human with a transport, so it needs no mode of its own. */
export const NEW_GAME_MODE: Record<NewGameChoice, Mode> = {
  ai: "human-ai",
  live: "human-human",
  otb: "human-human",
};

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
  // Not a confirmation at all: what New Game becomes while a match is live
  // (docs/live-match.md §Milestone 2c). It rides here so it gets the same
  // Escape handling and the same blocked flags every other dialog has.
  | { kind: "live-menu" }
  // Resign asks first. One misclick should not lose a game, and on a phone
  // these buttons sit close together under a thumb.
  | { kind: "resign" }
  | { kind: "restart"; what: RestartReason; mode: Mode; aiColor: Color; level: AiLevel };

export const RESTART_TITLE: Record<RestartReason, string> = {
  "new-game": "New game",
  color: "Switch colors?",
  level: "Switch level?",
};

/*
 * The board's props, in the clusters they already formed
 * (`docs/refactor-board-props.md`). Each one is built in `App` and handed down
 * whole, so a new field is one edit there and one in whichever component
 * reads it.
 */

/** The human-vs-human clock. Not shown in any other mode. */
export interface ClockProps {
  clock: Record<Color, number>;
  timerEnabled: boolean;
  turn: Color;
}

/** What is on the squares, and which way round. */
export interface BoardViewProps {
  displayGame: EvoChessGame;
  boardPosition: string;
  boardOrientation: "white" | "black";
  squareStyles: Record<string, CSSProperties>;
  topColor: Color;
  bottomColor: Color;
  rightsFor: Record<Color, Rights>;
}

/** History browsing: where in the line the board is, and how to move. */
export interface BrowseProps {
  browsing: boolean;
  browsePly: number | null;
  totalPlies: number;
  /** Handlers for the previous-move chevron: hold jumps to the start. */
  browsePrevHoldable: HTMLAttributes<HTMLButtonElement>;
  /** Handlers for the next-move chevron: hold jumps to the live position. */
  browseNextHoldable: HTMLAttributes<HTMLButtonElement>;
  onBrowseLive: () => void;
}

export interface PuzzleProps {
  /** Null when there is no puzzle to offer, which hides the bar's button. */
  onPuzzle: (() => void) | null;
  /** Today's puzzle not opened yet: the button is highlighted. */
  puzzleFresh: boolean;
  onPuzzleRetry: () => void;
  puzzleActive: boolean;
  puzzleMateIn: number;
  puzzleResult: null | "solved" | "failed";
}

export interface LiveProps {
  liveActive: boolean;
  /** The free seat on a live match this browser holds none of. Null offers nothing. */
  joinSeat: Color | null;
  joining: boolean;
  onJoin: () => void;
  /**
   * Reopens the invite dialog. Only while the match is waiting and the seat is
   * ours: the status line is the way back to a link that was closed too soon.
   */
  onShowInvite: (() => void) | null;
  /**
   * The rematch offer, once the game is over and the seat is ours. Null when
   * there is nothing to offer (docs/live-match.md §Milestone 2b).
   */
  rematch: { mine: boolean; theirs: boolean; onAsk: () => void } | null;
  /**
   * Opens the live menu, which is what New Game reads as while a match is being
   * played (docs/live-match.md §Milestone 2c). Null when there is no match, or
   * once it is over and New Game is itself again.
   */
  onMenu: (() => void) | null;
  /** The opponent's standing draw offer, for us to answer. Null when there is none. */
  drawOffer: { onAccept: () => void; onDecline: () => void } | null;
}

/** The end-of-game overlay: the running record, and the way out of it. */
export interface ScoreProps {
  showScoreOverlay: boolean;
  scoreOverlayReady: boolean;
  levelLabel: string;
  currentRecord: Scores[AiLevel];
  onPlayAgain: () => void;
  /** Offer to move up a level, after a win. Null when there is nothing to offer. */
  nudge: { label: string; onAccept: () => void } | null;
}
