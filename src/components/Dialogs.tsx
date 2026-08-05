import type { RefObject } from "react";
import type { ApplyMoveOptions } from "../evochess/game";
import type { ConfirmState, PromoModalState } from "../appTypes";
import type { UseShareModal } from "../hooks/useShareModal";
import { PromoModal } from "./PromoModal";
import { ShareModal } from "./ShareModal";
import { ConfirmModal } from "./ConfirmModal";

/**
 * Everything that opens over the board. One component so App's tree ends with
 * the page rather than with four conditionals.
 */
export function Dialogs({
  modal,
  finishModalMove,
  share,
  confirmAction,
  closeConfirm,
  totalPlies,
  confirmCancelBtnRef,
  onPlayHere,
  onLeaveLive,
  liveActive,
  onStartNewGame,
}: {
  modal: PromoModalState | null;
  finishModalMove: (options: ApplyMoveOptions) => void;
  share: UseShareModal;
  confirmAction: ConfirmState | null;
  closeConfirm: () => void;
  totalPlies: number;
  confirmCancelBtnRef: RefObject<HTMLButtonElement | null>;
  onPlayHere: (ply: number) => void;
  onLeaveLive: () => void;
  liveActive: boolean;
  onStartNewGame: () => void;
}) {
  return (
    <>
      {modal && <PromoModal modal={modal} finishModalMove={finishModalMove} />}
      {share.shareModal && (
        <ShareModal
          shareModal={share.shareModal}
          closeShareModal={share.closeShareModal}
          copyShareUrl={share.copyShareUrl}
          copyMoveLog={share.copyMoveLog}
          setShareWithHistory={share.setShareWithHistory}
          shareViaSheet={share.shareViaSheet}
          shareCopyBtnRef={share.shareCopyBtnRef}
          shareCloseBtnRef={share.shareCloseBtnRef}
        />
      )}
      {confirmAction && (
        <ConfirmModal
          confirmAction={confirmAction}
          totalPlies={totalPlies}
          close={closeConfirm}
          confirmCancelBtnRef={confirmCancelBtnRef}
          onPlayHere={onPlayHere}
          onLeaveLive={onLeaveLive}
          liveActive={liveActive}
          onStartNewGame={onStartNewGame}
        />
      )}
    </>
  );
}
