import type { RefObject } from "react";
import { RESTART_TITLE, type ConfirmState } from "../appTypes";

export function ConfirmModal({
  confirmAction,
  totalPlies,
  close,
  confirmCancelBtnRef,
  onPlayHere,
  onStartNewGame,
}: {
  confirmAction: ConfirmState;
  totalPlies: number;
  close: () => void;
  confirmCancelBtnRef: RefObject<HTMLButtonElement | null>;
  onPlayHere: (ply: number) => void;
  onStartNewGame: () => void;
}) {
  // The discarded count is recomputed here rather than captured with the
  // ply, so it stays true if the AI adds a move while the dialog is open.
  const isPlayHere = confirmAction.kind === "play-here";
  const discarded = isPlayHere ? totalPlies - confirmAction.ply : totalPlies;
  const title = isPlayHere ? "Play from here?" : RESTART_TITLE[confirmAction.what];
  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <p>{title}</p>
          <button className="modal-close" aria-label="Close" onClick={close}>
            ×
          </button>
        </div>
        <p>
          This discards the {discarded} move{discarded === 1 ? "" : "s"}{" "}
          {isPlayHere ? "played after this position" : "of the game in progress"}. It cannot be undone.
        </p>
        <div className="modal-actions">
          <button ref={confirmCancelBtnRef} onClick={close}>
            Cancel
          </button>
          <button
            className="danger-btn"
            onClick={() => {
              if (confirmAction.kind === "play-here") onPlayHere(confirmAction.ply);
              else onStartNewGame();
            }}
          >
            {isPlayHere
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
