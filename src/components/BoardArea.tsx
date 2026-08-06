import type {
  RefObject,
  TouchEvent as ReactTouchEvent,
  MouseEvent as ReactMouseEvent,
} from "react";
import { Chessboard } from "react-chessboard";
import type { Square } from "chess.js";
import type {
  BoardViewProps,
  BrowseProps,
  ClockProps,
  ConfirmState,
  LiveProps,
  Mode,
  MobileWidget,
  PuzzleProps,
  ScoreProps,
} from "../appTypes";
import { EvoStrip } from "../EvoStrip";
import { ActionPicker } from "./ActionPicker";
import { ClockDisplay } from "./ClockDisplay";
import { MobileBar } from "./MobileBar";

export function BoardArea({
  boardWrapRef,
  mode,
  clock,
  board,
  browse,
  puzzle,
  live,
  score,
  gameOver,
  status,
  aiThinking,
  nnueReady,
  onBoardTouchStart,
  onBoardTouchEnd,
  onPieceDrop,
  onSquareClick,
  allowDragging,
  onRestart,
  onTakeback,
  setConfirmAction,
  openTutorial,
  openWidget,
  onShare,
}: {
  boardWrapRef: RefObject<HTMLDivElement | null>;
  mode: Mode;
  clock: ClockProps;
  board: BoardViewProps;
  browse: BrowseProps;
  puzzle: PuzzleProps;
  live: LiveProps;
  score: ScoreProps;
  gameOver: boolean;
  status: string;
  aiThinking: boolean;
  nnueReady: boolean;
  onBoardTouchStart: (e: ReactTouchEvent) => void;
  onBoardTouchEnd: (e: ReactTouchEvent) => void;
  onPieceDrop: (args: { sourceSquare: string; targetSquare: string | null }) => boolean;
  onSquareClick: (args: { square: string }) => void;
  allowDragging: boolean;
  onRestart: () => void;
  onTakeback: () => void;
  setConfirmAction: (action: ConfirmState) => void;
  openTutorial: () => void;
  openWidget: (widget: MobileWidget) => void;
  onShare: (e: ReactMouseEvent<HTMLButtonElement>, useShareSheet: boolean) => void;
}) {
  const { displayGame, topColor, bottomColor, squareStyles, rightsFor } = board;
  return (
    <div className="board-wrap" ref={boardWrapRef}>
      {mode === "human-human" && clock.timerEnabled && (
        <ClockDisplay clock={clock.clock} turn={clock.turn} gameOver={gameOver} />
      )}
      <div className="board-status">{status}</div>
      <div
        className={`board-status-underline${aiThinking ? " thinking" : nnueReady ? " nnue-ready" : ""}`}
      />
      <EvoStrip color={topColor} game={displayGame} rights={rightsFor[topColor]} active={displayGame.turn === topColor} />
      <div className="board-container" onTouchStart={onBoardTouchStart} onTouchEnd={onBoardTouchEnd}>
        <Chessboard
          options={{
            position: board.boardPosition,
            onPieceDrop,
            onSquareClick,
            squareRenderer: ({ square, children }) => {
              const charges = displayGame.rookCharges.get(square as Square);
              const locked = displayGame.rookLocked.has(square as Square);
              return (
                <div style={{ width: "100%", height: "100%", position: "relative", ...squareStyles[square] }}>
                  {children}
                  {charges !== undefined && (
                    <span className={`rook-charge-badge ${charges === 1 ? "low" : ""}`}>{charges}</span>
                  )}
                  {/* A minor that came from a spent rook can never become one
                      again, so it gets the badge slot the rook it used to be
                      had. The two never collide: a locked square holds a minor,
                      and only a rook carries charges. */}
                  {locked && <span className="rook-locked-dot" title="Downgraded rook - cannot become a rook again" />}
                </div>
              );
            },
            boardOrientation: board.boardOrientation,
            allowDragging,
          }}
        />
        {score.showScoreOverlay && (
          <div className={`score-overlay${score.scoreOverlayReady ? " revealed" : ""}`}>
            <div className="score-overlay-text">
              {score.levelLabel} <span className="score-win">{score.currentRecord.wins}</span>-
              {score.currentRecord.draws}-
              <span className="score-loss">{score.currentRecord.losses}</span>
            </div>
            <button className="play-again-btn" onClick={score.onPlayAgain}>
              Play again?
            </button>
          </div>
        )}
        {/* The seat offer sits over the board, where "Play again?" does. It
            does not dim: the position is what the offer is being judged on.
            Never fired on load, since taking a seat is a deliberate act
            (docs/live-match.md). */}
        {live.joinSeat && (
          <div className="live-join-overlay">
            <button className="play-again-btn" onClick={live.onJoin} disabled={live.joining}>
              {live.joining ? "Joining…" : `Play as ${live.joinSeat === "w" ? "White" : "Black"}`}
            </button>
          </div>
        )}
        {/* Over the board, like the score overlay, so the outcome costs no
            layout above or below it and cannot push the board under the fold.
            The two can never collide: a puzzle is always `fromShared`, and the
            score overlay is suppressed for those. */}
        {puzzle.puzzleResult && (
          <div className="puzzle-overlay" role="status">
            <div className="puzzle-overlay-text">
              {puzzle.puzzleResult === "solved"
                ? `Solved! Mate in ${puzzle.puzzleMateIn}.`
                : `Not mate in ${puzzle.puzzleMateIn}.`}
            </div>
            {puzzle.puzzleResult === "failed" && (
              <button className="play-again-btn" onClick={puzzle.onPuzzleRetry}>
                Try again
              </button>
            )}
          </div>
        )}
      </div>
      <EvoStrip
        color={bottomColor}
        game={displayGame}
        rights={rightsFor[bottomColor]}
        active={displayGame.turn === bottomColor}
      />
      <ActionPicker
        extraClass="action-picker-below-board"
        browse={browse}
        aiThinking={aiThinking}
        onRestart={onRestart}
        onTakeback={onTakeback}
        setConfirmAction={setConfirmAction}
        puzzleActive={puzzle.puzzleActive}
        liveActive={live.liveActive}
      />
      <MobileBar
        openTutorial={openTutorial}
        openWidget={openWidget}
        onPuzzle={puzzle.onPuzzle}
        onShare={onShare}
      />
    </div>
  );
}
