import type { HTMLAttributes } from "react";
import type { ConfirmState } from "../appTypes";
import { ChevronLeftIcon, ChevronRightIcon, PawnIcon, UndoIcon } from "../Icons";

export function ActionPicker({
  extraClass,
  browsing,
  browsePly,
  totalPlies,
  aiThinking,
  onRestart,
  onTakeback,
  onBrowseLive,
  browsePrevHoldable,
  browseNextHoldable,
  setConfirmAction,
  puzzleActive,
  liveActive,
}: {
  extraClass: string;
  browsing: boolean;
  browsePly: number | null;
  totalPlies: number;
  aiThinking: boolean;
  onRestart: () => void;
  onTakeback: () => void;
  onBrowseLive: () => void;
  /** Handlers for the previous-move chevron: hold jumps to the start. */
  browsePrevHoldable: HTMLAttributes<HTMLButtonElement>;
  /** Handlers for the next-move chevron: hold jumps to the live position. */
  browseNextHoldable: HTMLAttributes<HTMLButtonElement>;
  setConfirmAction: (action: ConfirmState) => void;
  /**
   * A puzzle owns the board, which takes away both of the actions that change
   * the game: takeback makes the failure state unreachable, and "play from
   * here" is a takeback wearing a different label.
   */
  puzzleActive: boolean;
  /** A live match: the line cannot be rewound, so the slot holds no button. */
  liveActive: boolean;
}) {
  return (
    <div className={`action-picker ${extraClass}`}>
      {/* Four slots, the same widths whichever state the row is in, so nothing
          moves under the thumb when browsing starts. The first two swap: the
          captioned button becomes the way out of browsing, and the takeback
          (unusable while browsing) gives its place to "play from here". */}
      {browsing ? (
        <button className="back-btn" onClick={onBrowseLive} title="Back to the live position">
          Back
        </button>
      ) : (
        <button className="new-game-btn" onClick={onRestart}>
          New Game
        </button>
      )}
      {/* The slot stays occupied while a puzzle or a live match is on the
          board, since neither can rewind its line. The row is four fixed
          widths so that nothing moves under the thumb, so the button is
          replaced rather than removed. */}
      {puzzleActive || liveActive ? (
        <span className="action-slot-empty" aria-hidden="true" />
      ) : browsing ? (
        <button
          className="play-here-btn icon-btn"
          onClick={() => setConfirmAction({ kind: "play-here", ply: browsePly! })}
          aria-label="Play from here"
          title="Play from here"
        >
          <PawnIcon />
        </button>
      ) : (
        <button
          className="takeback-btn icon-btn"
          onClick={onTakeback}
          aria-label="Takeback"
          title="Takeback"
          disabled={totalPlies === 0 || aiThinking}
        >
          <UndoIcon />
        </button>
      )}
      {/* The way into history browsing on a phone: always on screen, next to
          the board, no sheet to open first. Stepping back from the live
          position enters browsing (see `browsePrev`). Holding either one runs
          it to the end of the history in that direction. */}
      <button
        className="browse-step-btn icon-btn"
        aria-label="Previous move"
        title="Previous move (hold for the start)"
        disabled={totalPlies === 0 || browsePly === 0}
        {...browsePrevHoldable}
      >
        <ChevronLeftIcon />
      </button>
      <button
        className="browse-step-btn icon-btn"
        aria-label="Next move"
        title="Next move (hold for the live position)"
        disabled={!browsing}
        {...browseNextHoldable}
      >
        <ChevronRightIcon />
      </button>
    </div>
  );
}
