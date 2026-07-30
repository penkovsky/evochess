import type { RefObject } from "react";
import type { ShareModalState } from "../appTypes";

export function ShareModal({
  shareModal,
  closeShareModal,
  copyShareUrl,
  shareCopyBtnRef,
  shareCloseBtnRef,
}: {
  shareModal: ShareModalState;
  closeShareModal: () => void;
  copyShareUrl: (url: string) => void;
  shareCopyBtnRef: RefObject<HTMLButtonElement | null>;
  shareCloseBtnRef: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <div className="modal-backdrop" onClick={closeShareModal}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Share this position" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <p>Share this position</p>
          <button className="modal-close" aria-label="Close" onClick={closeShareModal}>
            ×
          </button>
        </div>
        {shareModal.problem ? (
          <p>
            {shareModal.problem === "too-long"
              ? "This position is too large to fit in a link."
              : "This position can't be put into a link."}
          </p>
        ) : (
          <>
            <input
              type="text"
              className="share-url"
              readOnly
              value={shareModal.url}
              onClick={(e) => {
                e.currentTarget.select();
                copyShareUrl(shareModal.url);
              }}
            />
            <div className="share-status" aria-live="polite">
              {shareModal.copiedAt != null
                ? "Copied!"
                : !shareModal.clipboardOk && "Press Ctrl-C to copy"}
            </div>
            <button ref={shareCopyBtnRef} onClick={() => copyShareUrl(shareModal.url)}>
              Copy
            </button>
          </>
        )}
        <button ref={shareCloseBtnRef} onClick={closeShareModal}>
          Close
        </button>
      </div>
    </div>
  );
}
