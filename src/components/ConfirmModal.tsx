import type { RefObject } from "react";
import { RESTART_TITLE, type ConfirmState } from "../appTypes";

export function ConfirmModal({
  confirmAction,
  totalPlies,
  close,
  confirmCancelBtnRef,
  onPlayHere,
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
  onStartNewGame: () => void;
  onLeaveLive: () => void;
}) {
  // The discarded count is recomputed here rather than captured with the
  // ply, so it stays true if the AI adds a move while the dialog is open.
  const isPlayHere = confirmAction.kind === "play-here";
  // The seat is what is lost here, not the moves, so it counts no plies.
  const isLeave = confirmAction.kind === "leave-live";
  const discarded = isPlayHere ? totalPlies - confirmAction.ply : totalPlies;
  const title = isLeave
    ? "Leave this match?"
    : isPlayHere
    ? "Play from here?"
    : RESTART_TITLE[confirmAction.what];
  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
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
              <p>
                This discards the {discarded} move{discarded === 1 ? "" : "s"}{" "}
                {isPlayHere ? "played after this position" : "of the game in progress"}. It cannot be undone.
              </p>
            )}
            {liveActive && <p>You give up your seat in the match. It cannot be taken back.</p>}
          </>
        )}
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
            {isLeave
              ? "Leave match"
              : isPlayHere
              ? "Discard and play"
              : confirmAction.what === "new-game"
              ? "Discard and start"
              : "Switch and restart"}
          </button>
        </div>
      </div>
    </div>
  );
}
