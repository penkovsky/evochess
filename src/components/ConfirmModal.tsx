import { useState, type RefObject } from "react";
import type { Color } from "chess.js";
import { RESTART_TITLE, type ConfirmState, type NewGameChoice } from "../appTypes";

export function ConfirmModal({
  confirmAction,
  totalPlies,
  close,
  confirmCancelBtnRef,
  onPlayHere,
  onNewGame,
  onStartNewGame,
  onLeaveLive,
  liveActive,
}: {
  confirmAction: ConfirmState;
  totalPlies: number;
  /** A match on the board, whose seat this restart also gives up. */
  liveActive: boolean;
  close: () => void;
  confirmCancelBtnRef: RefObject<HTMLButtonElement | null>;
  onPlayHere: (ply: number) => void;
  /** New Game: `seat` is only read for "live". Choosing is the confirmation. */
  onNewGame: (choice: NewGameChoice, seat: Color) => void;
  /** A color or level switch, which restarts with the settings it carries. */
  onStartNewGame: () => void;
  onLeaveLive: () => void;
}) {
  // The creator's seat, and only the Live row shows it. Local to the dialog: it
  // decides one match and has nothing to say about the next game.
  const [seat, setSeat] = useState<Color>("w");
  // The discarded count is recomputed here rather than captured with the
  // ply, so it stays true if the AI adds a move while the dialog is open.
  const isPlayHere = confirmAction.kind === "play-here";
  // The seat is what is lost here, not the moves, so it counts no plies.
  const isLeave = confirmAction.kind === "leave-live";
  const isNewGame = confirmAction.kind === "restart" && confirmAction.what === "new-game";
  const discarded = isPlayHere ? totalPlies - confirmAction.ply : totalPlies;
  const title = isLeave
    ? "Leave this match?"
    : isPlayHere
    ? "Play from here?"
    : RESTART_TITLE[confirmAction.what];
  return (
    <div className="modal-backdrop" onClick={close}>
      <div
        className={`modal${isNewGame ? " modal-narrow" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <p>{title}</p>
          <button className="modal-close" aria-label="Close" onClick={close}>
            ×
          </button>
        </div>
        {isLeave ? (
          <p>You cannot take your seat back. The match carries on without you.</p>
        ) : (
          <>
            {discarded > 0 && (
              <p className="discard-warning">
                {/* The triangle belongs to the question, so it shares its
                    line; the count is the detail, on its own below. */}
                <span>
                  <span aria-hidden="true">⚠</span>{" "}
                  {isPlayHere ? "Discard the moves after this?" : "Discard the game?"}
                </span>
                <span className="discard-count">
                  ({discarded} move{discarded === 1 ? "" : "s"})
                </span>
              </p>
            )}
            {liveActive && <p>You give up your seat.</p>}
          </>
        )}
        {isNewGame ? (
          // Three options, no confirm button: picking one is the confirmation.
          <div className="new-game-options">
            <button className="mode-option" onClick={() => onNewGame("ai", seat)}>
              Computer
            </button>
            {/* The seat shares the row with the button it belongs to: two
                kings, one selected. Picking one does not start the game. */}
            <div className="new-game-live">
              <button className="mode-option" onClick={() => onNewGame("live", seat)}>
                Friend
              </button>
              <div className="seat-picker" role="group" aria-label="Your color in the match">
                {(
                  [
                    { label: "White", value: "w", glyph: "♔" },
                    { label: "Black", value: "b", glyph: "♚" },
                  ] as const
                ).map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    aria-label={opt.label}
                    aria-pressed={seat === opt.value}
                    className={seat === opt.value ? "active" : ""}
                    onClick={() => setSeat(opt.value)}
                  >
                    {opt.glyph}
                  </button>
                ))}
              </div>
            </div>
            <button className="mode-option" onClick={() => onNewGame("otb", seat)}>
              Over the board
            </button>
            <button ref={confirmCancelBtnRef} onClick={close}>
              Cancel
            </button>
          </div>
        ) : (
          <div className="modal-actions">
            <button ref={confirmCancelBtnRef} onClick={close}>
              Cancel
            </button>
            <button
              className="danger-btn"
              onClick={() => {
                if (confirmAction.kind === "play-here") onPlayHere(confirmAction.ply);
                else if (confirmAction.kind === "leave-live") onLeaveLive();
                else onStartNewGame();
              }}
            >
              {isLeave ? "Leave match" : isPlayHere ? "Discard and play" : "Switch and restart"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
