import type { RefObject } from "react";
import type { ApplyMoveOptions } from "../evochess/game";
import type { Color } from "chess.js";
import type { ConfirmState, NewGameChoice, PromoModalState } from "../appTypes";
import type { UseShareModal } from "../hooks/useShareModal";
import { PromoModal } from "./PromoModal";
import { ShareModal } from "./ShareModal";
import { ConfirmModal } from "./ConfirmModal";
import { InviteModal } from "./InviteModal";

/**
 * Everything that opens over the board. One component so App's tree ends with
 * the page rather than with four conditionals.
 */
export function Dialogs({
  modal,
  finishModalMove,
  cancelModalMove,
  share,
  confirmAction,
  closeConfirm,
  totalPlies,
  confirmCancelBtnRef,
  onPlayHere,
  onLeaveLive,
  liveActive,
  onNewGame,
  onStartNewGame,
  invite,
  closeInvite,
}: {
  modal: PromoModalState | null;
  finishModalMove: (options: ApplyMoveOptions) => void;
  cancelModalMove: () => void;
  share: UseShareModal;
  confirmAction: ConfirmState | null;
  closeConfirm: () => void;
  totalPlies: number;
  confirmCancelBtnRef: RefObject<HTMLButtonElement | null>;
  onPlayHere: (ply: number) => void;
  onLeaveLive: () => void;
  liveActive: boolean;
  onNewGame: (choice: NewGameChoice, seat: Color) => void;
  onStartNewGame: () => void;
  /** The invite dialog's link and whether the second seat is taken, or null. */
  invite: { url: string; joined: boolean } | null;
  closeInvite: () => void;
}) {
  return (
    <>
      {modal && (
        <PromoModal modal={modal} finishModalMove={finishModalMove} cancelModalMove={cancelModalMove} />
      )}
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
          onNewGame={onNewGame}
          onStartNewGame={onStartNewGame}
        />
      )}
      {invite && <InviteModal url={invite.url} joined={invite.joined} close={closeInvite} />}
    </>
  );
}
