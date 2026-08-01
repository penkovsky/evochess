import type {
  CSSProperties,
  HTMLAttributes,
  RefObject,
  TouchEvent as ReactTouchEvent,
  MouseEvent as ReactMouseEvent,
} from "react";
import { Chessboard } from "react-chessboard";
import type { Color, Square } from "chess.js";
import type { EvoChessGame, Rights } from "../evochess/game";
import type { AiLevel } from "../evochess/ai";
import type { ConfirmState, Mode, MobileWidget } from "../appTypes";
import type { Scores } from "../evochess/scores";
import { EvoStrip } from "../EvoStrip";
import { ActionPicker } from "./ActionPicker";
import { ClockDisplay } from "./ClockDisplay";
import { MobileBar } from "./MobileBar";

export function BoardArea({
  boardWrapRef,
  mode,
  timerEnabled,
  clock,
  turn,
  gameOver,
  status,
  aiThinking,
  level,
  nnueReady,
  topColor,
  bottomColor,
  displayGame,
  rightsFor,
  onBoardTouchStart,
  onBoardTouchEnd,
  boardPosition,
  onPieceDrop,
  onSquareClick,
  squareStyles,
  boardOrientation,
  allowDragging,
  showScoreOverlay,
  scoreOverlayReady,
  levelLabel,
  currentRecord,
  onPlayAgain,
  browsing,
  browsePly,
  totalPlies,
  onRestart,
  onTakeback,
  onBrowseLive,
  browsePrevHoldable,
  browseNextHoldable,
  setConfirmAction,
  openTutorial,
  openWidget,
  onPuzzle,
  onPuzzleRetry,
  puzzleActive,
  puzzleMateIn,
  puzzleResult,
  onShare,
}: {
  boardWrapRef: RefObject<HTMLDivElement | null>;
  mode: Mode;
  timerEnabled: boolean;
  clock: Record<Color, number>;
  turn: Color;
  gameOver: boolean;
  status: string;
  aiThinking: boolean;
  level: AiLevel;
  nnueReady: boolean;
  topColor: Color;
  bottomColor: Color;
  displayGame: EvoChessGame;
  rightsFor: Record<Color, Rights>;
  onBoardTouchStart: (e: ReactTouchEvent) => void;
  onBoardTouchEnd: (e: ReactTouchEvent) => void;
  boardPosition: string;
  onPieceDrop: (args: { sourceSquare: string; targetSquare: string | null }) => boolean;
  onSquareClick: (args: { square: string }) => void;
  squareStyles: Record<string, CSSProperties>;
  boardOrientation: "white" | "black";
  allowDragging: boolean;
  showScoreOverlay: boolean;
  scoreOverlayReady: boolean;
  levelLabel: string;
  currentRecord: Scores[AiLevel];
  onPlayAgain: () => void;
  browsing: boolean;
  browsePly: number | null;
  totalPlies: number;
  onRestart: () => void;
  onTakeback: () => void;
  onBrowseLive: () => void;
  browsePrevHoldable: HTMLAttributes<HTMLButtonElement>;
  browseNextHoldable: HTMLAttributes<HTMLButtonElement>;
  setConfirmAction: (action: ConfirmState) => void;
  openTutorial: () => void;
  openWidget: (widget: MobileWidget) => void;
  /** Null when there is no puzzle to offer, which hides the bar's button. */
  onPuzzle: (() => void) | null;
  onPuzzleRetry: () => void;
  puzzleActive: boolean;
  puzzleMateIn: number;
  puzzleResult: null | "solved" | "failed";
  onShare: (e: ReactMouseEvent<HTMLButtonElement>, useShareSheet: boolean) => void;
}) {
  return (
    <div className="board-wrap" ref={boardWrapRef}>
      {mode === "human-human" && timerEnabled && <ClockDisplay clock={clock} turn={turn} gameOver={gameOver} />}
      <div className="board-status">{status}</div>
      <div
        className={`board-status-underline${
          aiThinking ? " thinking" : level === "easy" ? " easy" : nnueReady ? " nnue-ready" : ""
        }`}
      />
      <EvoStrip color={topColor} game={displayGame} rights={rightsFor[topColor]} active={displayGame.turn === topColor} />
      <div className="board-container" onTouchStart={onBoardTouchStart} onTouchEnd={onBoardTouchEnd}>
        <Chessboard
          options={{
            position: boardPosition,
            onPieceDrop,
            onSquareClick,
            squareRenderer: ({ square, children }) => {
              const charges = displayGame.rookCharges.get(square as Square);
              return (
                <div style={{ width: "100%", height: "100%", position: "relative", ...squareStyles[square] }}>
                  {children}
                  {charges !== undefined && (
                    <span className={`rook-charge-badge ${charges === 1 ? "low" : ""}`}>{charges}</span>
                  )}
                </div>
              );
            },
            boardOrientation,
            allowDragging,
          }}
        />
        {showScoreOverlay && (
          <div className={`score-overlay${scoreOverlayReady ? " revealed" : ""}`}>
            <div className="score-overlay-text">
              {levelLabel} <span className="score-win">{currentRecord.wins}</span>-{currentRecord.draws}-
              <span className="score-loss">{currentRecord.losses}</span>
            </div>
            <button className="play-again-btn" onClick={onPlayAgain}>
              Play again?
            </button>
          </div>
        )}
        {/* Over the board, like the score overlay, so the outcome costs no
            layout above or below it and cannot push the board under the fold.
            The two can never collide: a puzzle is always `fromShared`, and the
            score overlay is suppressed for those. */}
        {puzzleResult && (
          <div className="puzzle-overlay" role="status">
            <div className="puzzle-overlay-text">
              {puzzleResult === "solved"
                ? `Solved! Mate in ${puzzleMateIn}.`
                : `Not mate in ${puzzleMateIn}.`}
            </div>
            {puzzleResult === "failed" && (
              <button className="play-again-btn" onClick={onPuzzleRetry}>
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
        browsing={browsing}
        browsePly={browsePly}
        totalPlies={totalPlies}
        aiThinking={aiThinking}
        onRestart={onRestart}
        onTakeback={onTakeback}
        onBrowseLive={onBrowseLive}
        browsePrevHoldable={browsePrevHoldable}
        browseNextHoldable={browseNextHoldable}
        setConfirmAction={setConfirmAction}
        puzzleActive={puzzleActive}
      />
      <MobileBar
        openTutorial={openTutorial}
        openWidget={openWidget}
        onPuzzle={onPuzzle}
        onShare={onShare}
      />
    </div>
  );
}
