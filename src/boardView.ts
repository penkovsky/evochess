import type { Color } from "chess.js";
import type { EvoChessGame } from "./evochess/game";
import type { AiLevel } from "./evochess/ai";
import type { PuzzleState } from "./evochess/dailyPuzzle";
import { canMoveNow, drawOffered, type LiveOutcome, type LiveView } from "./liveMatch";
import type { Mode } from "./appTypes";

export interface BoardViewInput {
  /** The live position. */
  game: EvoChessGame;
  /** Positions strictly before the live one, one per ply already played. */
  history: EvoChessGame[];
  /** Which ply is on screen, or null for the live position. */
  browsePly: number | null;
  mode: Mode;
  aiColor: Color;
  level: AiLevel;
  autoFlip: boolean;
  aiThinking: boolean;
  timeUp: Color | null;
  live: LiveView | null;
  /** Three polls in a row failed. Says so, keeps the board, keeps trying. */
  liveConnectionLost: boolean;
  /** The puzzle on the board, if any. */
  puzzle: PuzzleState | null;
  puzzleResult: "solved" | "failed" | null;
  fromShared: boolean;
  /** Whether this level has a record to show. */
  hasScoreHistory: boolean;
  /** Whether the promotion prompt owns the screen. */
  promptOpen: boolean;
}

export interface BoardView {
  /** The position everything below the board tracks: the browsed ply, or live. */
  displayGame: EvoChessGame;
  browsing: boolean;
  totalPlies: number;
  status: string;
  gameOver: boolean;
  boardOrientation: "white" | "black";
  topColor: Color;
  bottomColor: Color;
  rightsFor: Record<Color, ReturnType<EvoChessGame["rightsFor"]>>;
  showScoreOverlay: boolean;
  levelLabel: string;
  /** Whether a tap may select a piece: not browsing, the human's turn, playable. */
  humanCanMove: boolean;
  /**
   * Whether a piece may be dragged. Not the same test as `humanCanMove`: drag
   * ignores the prompt (which covers the board anyway) and refuses a match seat
   * that is not ours or a clock that has run out, neither of which taps check.
   */
  allowDragging: boolean;
}

/**
 * Everything the board and the line above it show, derived from the state App
 * holds. Pure, so the branching here is testable without rendering anything.
 */
export function deriveBoardView(input: BoardViewInput): BoardView {
  const { game, history, browsePly, mode, aiColor, level, live, timeUp, puzzleResult } = input;
  const totalPlies = history.length;
  const browsing = browsePly !== null;
  // `history` holds positions strictly before the live one, so an out-of-range
  // index falls back to it.
  const displayGame = browsing && browsePly! < totalPlies ? history[browsePly!] : game;
  const turnLabel = displayGame.turn === "w" ? "White" : "Black";
  // A resignation and an agreed draw end the game as surely as a mate does,
  // and neither is on the board (docs/live-match.md §Milestone 2c).
  const gameOver = game.isGameOver() || !!timeUp || !!live?.outcome;
  // A puzzle owns the board until it resolves, at which point the banner over
  // the board carries the news and this line says what it says for any other
  // game.
  const activePuzzle = puzzleResult ? null : input.puzzle;

  const status = browsing
    ? // With no bar under the board, this line is the only readout of where in
      // the game you are, so ply 0 says what it is rather than "Move 0 of N".
      browsePly === 0
      ? "Start position"
      : `Move ${browsePly} of ${totalPlies}`
    : activePuzzle
    ? // The solver's colour, not whoever is to move: this line is the label of
      // the puzzle and it has to hold still. Taken from the live turn it would
      // flip to "Black to play, mate in 2" for the length of every engine reply.
      `${aiColor === "w" ? "Black" : "White"} to play, mate in ${activePuzzle.mateIn}`
    : liveStatus(input, turnLabel);

  const boardOrientation: "white" | "black" = live?.seat
    ? live.seat.seat === "b"
      ? "black"
      : "white"
    : mode === "human-human"
    ? input.autoFlip && game.turn === "b"
      ? "black"
      : "white"
    : aiColor === "w"
    ? "black"
    : "white";
  const bottomColor: Color = boardOrientation === "white" ? "w" : "b";

  // Suppressed for a game played from a shared position: that result was never
  // recorded, so the score would be the running total of unrelated games, and
  // "play again" would start from the opening rather than from the position.
  // Suppressed while browsing too: the overlay and the fireworks belong to the
  // end of the live game, not to whichever ply is on screen.
  const showScoreOverlay =
    mode === "human-ai" && gameOver && input.hasScoreHistory && !input.fromShared && !browsing;

  const allowDragging =
    !browsing &&
    !(mode === "human-ai" && game.turn === aiColor) &&
    // No seat token means every move is refused. That is the observer case.
    canMoveNow(live, game.moveLog.length) &&
    !gameOver &&
    !puzzleResult;

  return {
    displayGame,
    browsing,
    totalPlies,
    status,
    gameOver,
    boardOrientation,
    topColor: bottomColor === "w" ? "b" : "w",
    bottomColor,
    rightsFor: { w: displayGame.rightsFor("w"), b: displayGame.rightsFor("b") },
    showScoreOverlay,
    levelLabel: level.charAt(0).toUpperCase() + level.slice(1),
    humanCanMove:
      !browsing &&
      !(mode === "human-ai" && game.turn === aiColor) &&
      // The board's own game-over, not `isGameOver`: a flag and an agreed
      // ending are both endings, and clicking a piece after one selected it
      // and offered moves that `attemptMove` then refused.
      !gameOver &&
      !puzzleResult &&
      !input.promptOpen,
    allowDragging,
  };
}

/** The live position's own line, plus the one a live match adds to it. */
function liveStatus(input: BoardViewInput, turnLabel: string): string {
  const { game, live, timeUp, aiThinking } = input;
  let status = `${turnLabel} to move.`;
  if (game.chess.isCheck()) status += " Check!";
  if (game.isGameOver()) status = game.resultString();
  else if (timeUp) {
    const winner = timeUp === "w" ? "Black" : "White";
    status = `${timeUp === "w" ? "White" : "Black"} ran out of time. ${winner} wins!`;
  } else if (aiThinking) status += " (AI thinking...)";
  if (!live) return status;
  // The line a live match adds: what the board is waiting for.
  if (!canMoveNow(live, game.moveLog.length) && !game.isGameOver()) {
    if (!live.joined) status = live.seat ? "Waiting for opponent" : status;
    else status = live.seat ? "Waiting for your opponent's move." : `Watching. ${turnLabel} to move.`;
  }
  // An offer of ours is the only thing on screen that says so; the opponent's
  // is also on the board, above the position it is being judged on.
  const offer = drawOffered(live);
  if (offer === "mine") status = "Draw offered. Waiting for your opponent.";
  else if (offer === "theirs") status = "Your opponent offers a draw.";
  // Both outrank it, and out of sync outranks the lot: it is terminal, so
  // saying whose turn it is would be saying the match still works.
  if (input.liveConnectionLost) status = "Connection lost. Still trying...";
  // An ending the players agreed on outranks the connection: there is nothing
  // left to read, so a failing poll is no longer news.
  if (live.outcome) status = endingText(live.outcome, live.seat?.seat ?? null);
  if (live.outOfSync) status = "This match is out of sync. Start a new game to carry on.";
  return status;
}

/** A resignation or an agreed draw, said from our own side of the board. */
function endingText(outcome: LiveOutcome, seat: Color | null): string {
  if (outcome === "d") return "Draw agreed.";
  if (!seat) return `${outcome === "w" ? "White" : "Black"} wins by resignation.`;
  return outcome === seat ? "Your opponent resigned. You win!" : "You resigned.";
}
