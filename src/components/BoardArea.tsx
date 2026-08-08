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
      {/* While a match is waiting, the line is the way back to the link: the
          dialog closes to the board and this is the only copy of the URL. */}
      {live.onShowInvite ? (
        <button type="button" className="board-status board-status-invite" onClick={live.onShowInvite}>
          {status} <span className="board-status-invite-hint">Show link</span>
        </button>
      ) : (
        <div className="board-status">{status}</div>
      )}
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
            {score.nudge && <div className="score-nudge-text">You won. Ready for {score.nudge.label}?</div>}
            <div className="score-overlay-actions">
              {score.nudge && (
                <button className="play-again-btn nudge-btn" onClick={score.nudge.onAccept}>
                  Play {score.nudge.label}
                </button>
              )}
              <button className="play-again-btn" onClick={score.onPlayAgain}>
                Play again?
              </button>
            </div>
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
        {/* The opponent's draw offer, in the same slot and for the same reason
            as the join button: the position is what the offer is being judged
            on, so it is not dimmed and nothing above or below the board moves
            to make room (docs/live-match.md §Milestone 2c). */}
        {live.drawOffer && (
          <div className="live-join-overlay live-rematch-overlay">
            <div className="live-rematch-text">Your opponent offers a draw</div>
            <div className="live-offer-actions">
              <button className="play-again-btn accept-btn" onClick={live.drawOffer.onAccept}>
                Accept
              </button>
              <button className="play-again-btn decline-btn" onClick={live.drawOffer.onDecline}>
                Decline
              </button>
            </div>
          </div>
        )}
        {/* The rematch, in the same slot: the game is over, so the board below
            is only a record of it. One press both asks and accepts
            (docs/live-match.md §Milestone 2b). */}
        {live.rematch && (
          <div className="live-join-overlay live-rematch-overlay">
            {live.rematch.theirs && <div className="live-rematch-text">Your opponent wants a rematch</div>}
            {live.rematch.mine && !live.rematch.theirs ? (
              <div className="live-rematch-text">Waiting for your opponent...</div>
            ) : (
              <button
                className={`play-again-btn${live.rematch.theirs ? " accept-btn" : ""}`}
                onClick={live.rematch.onAsk}
              >
                {live.rematch.theirs ? "Accept" : "Rematch"}
              </button>
            )}
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
        onLiveMenu={live.onMenu}
      />
      <MobileBar
        openTutorial={openTutorial}
        openWidget={openWidget}
        onPuzzle={puzzle.onPuzzle}
        puzzleFresh={puzzle.puzzleFresh}
        onShare={onShare}
      />
    </div>
  );
}
