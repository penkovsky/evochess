import type { RefObject } from "react";
import type { ShareModalState } from "../appTypes";

/**
 * Two things in one dialog, in two labelled sections: the position as a link,
 * and the move log as text. They are separate takeaways, so the divider is the
 * point rather than decoration.
 */
export function ShareModal({
  shareModal,
  closeShareModal,
  copyShareUrl,
  copyMoveLog,
  setShareWithHistory,
  shareViaSheet,
  shareCopyBtnRef,
  shareCloseBtnRef,
}: {
  shareModal: ShareModalState;
  closeShareModal: () => void;
  copyShareUrl: (url: string) => void;
  copyMoveLog: (moveLog: string[], blackFirst: boolean) => void;
  setShareWithHistory: (on: boolean) => void;
  shareViaSheet: (url: string) => void;
  shareCopyBtnRef: RefObject<HTMLButtonElement | null>;
  shareCloseBtnRef: RefObject<HTMLButtonElement | null>;
}) {
  const moves = shareModal.moveLog.length;
  const status = (kind: "url" | "log") =>
    shareModal.copiedAt != null && shareModal.copiedKind === kind
      ? "Copied!"
      : kind === "url" && !shareModal.clipboardOk
        ? "Press Ctrl-C to copy"
        : "";
  return (
    <div className="modal-backdrop" onClick={closeShareModal}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Share" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <p>Share</p>
          <button className="modal-close" aria-label="Close" onClick={closeShareModal}>
            ×
          </button>
        </div>

        <section className="share-section">
          <h3>Position</h3>
          {shareModal.hasHistory && (
            <label className="share-history">
              <input
                type="checkbox"
                checked={shareModal.withHistory}
                onChange={(e) => setShareWithHistory(e.target.checked)}
              />
              Full history
            </label>
          )}
          {shareModal.problem ? (
            <p className="share-note">
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
                {status("url")}
              </div>
              <button ref={shareCopyBtnRef} onClick={() => copyShareUrl(shareModal.url)}>
                Copy link
              </button>
              {/* Mobile only: the OS sheet is the way a link gets into a
                  messaging app on a phone. */}
              {shareModal.canShareSheet && (
                <button onClick={() => shareViaSheet(shareModal.url)}>Share link…</button>
              )}
            </>
          )}
        </section>

        <section className="share-section">
          <h3>Move log</h3>
          <p className="share-note">
            {moves === 0 ? "No moves yet." : `${moves} ${moves === 1 ? "move" : "moves"} as text.`}
          </p>
          <div className="share-status" aria-live="polite">
            {status("log")}
          </div>
          <button disabled={moves === 0} onClick={() => copyMoveLog(shareModal.moveLog, shareModal.blackFirst)}>
            Copy move log
          </button>
        </section>

        <button ref={shareCloseBtnRef} onClick={closeShareModal}>
          Close
        </button>
      </div>
    </div>
  );
}
