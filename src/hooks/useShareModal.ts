import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type RefObject } from "react";
import type { EvoChessGame } from "../evochess/game";
import { encodeShareLink, MAX_SHARE_PARAM_CHARS } from "../evochess/shareLink";
import type { ShareModalState, ShareProblem } from "../appTypes";

export interface UseShareModal {
  shareModal: ShareModalState | null;
  /** Opens the sheet or the dialog, depending on which button was pressed. */
  handleShare: (e: ReactMouseEvent<HTMLButtonElement>, useShareSheet: boolean) => Promise<void>;
  copyShareUrl: (url: string) => Promise<void>;
  closeShareModal: () => void;
  shareCopyBtnRef: RefObject<HTMLButtonElement | null>;
  shareCloseBtnRef: RefObject<HTMLButtonElement | null>;
}

/**
 * The share-a-position dialog: building the link, the clipboard, and the
 * dialog's own focus and Escape handling. Reads the live game through
 * `gameRef` at click time, so it never holds a stale position.
 */
export function useShareModal(gameRef: RefObject<EvoChessGame>): UseShareModal {
  const [shareModal, setShareModal] = useState<ShareModalState | null>(null);
  const shareLastFocusRef = useRef<HTMLElement | null>(null);
  const shareCopyBtnRef = useRef<HTMLButtonElement>(null);
  const shareCloseBtnRef = useRef<HTMLButtonElement>(null);

  // Never throws. `encodeShareLink` does, for a position the format cannot
  // represent, and the caller is an async click handler: an escaping throw
  // becomes an unhandled rejection, so the button would silently do nothing.
  function buildShareUrl(): { url: string; problem: ShareProblem } {
    let param: string;
    try {
      param = encodeShareLink(gameRef.current);
    } catch {
      return { url: "", problem: "unencodable" };
    }
    // The same comparison the decoder makes, so a link that would be refused
    // on arrival is never handed over.
    if (param.length > MAX_SHARE_PARAM_CHARS) return { url: "", problem: "too-long" };
    const url = new URL(window.location.href);
    url.search = "";
    url.searchParams.set("p", param);
    return { url: url.toString(), problem: null };
  }

  async function copyShareUrl(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setShareModal((m) => (m ? { ...m, clipboardOk: true, copiedAt: Date.now() } : m));
    } catch {
      setShareModal((m) => (m ? { ...m, clipboardOk: false } : m));
    }
  }

  // `useShareSheet` is per button, not per capability. Desktop browsers expose
  // `navigator.share` too, so gating on it alone would send a PC user to an OS
  // sheet and they would never see the URL field the panel button promises.
  // The mobile bar and the panel already exist on opposite sides of the
  // breakpoint, so the button that was pressed is the honest signal.
  async function handleShare(e: ReactMouseEvent<HTMLButtonElement>, useShareSheet: boolean) {
    shareLastFocusRef.current = e.currentTarget;
    const { url, problem } = buildShareUrl();
    if (problem) {
      setShareModal({ url, problem, clipboardOk: false, copiedAt: null });
      return;
    }
    if (useShareSheet && navigator.share) {
      try {
        // `title` and `url` only. Targets that take both `text` and `url`
        // tend to concatenate them rather than pick one, so passing the link
        // as `text` as well puts it in the message twice.
        await navigator.share({ title: "EvoChess position", url });
        return;
      } catch (err) {
        // A dismissed sheet is an answer, not a failure: don't follow it with
        // a fallback dialog. Anything else means the sheet never happened.
        if ((err as Error)?.name === "AbortError") return;
      }
    }
    setShareModal({ url, problem: null, clipboardOk: true, copiedAt: null });
    copyShareUrl(url);
  }

  function closeShareModal() {
    setShareModal(null);
    shareLastFocusRef.current?.focus();
  }

  // Escape and focus for the share dialog: focus lands on Copy when it opens,
  // and returns to whichever share button opened it when it closes. There is
  // no Copy button when there is no link, so Close takes the focus instead.
  // Otherwise it would stay outside the dialog it just opened.
  useEffect(() => {
    if (!shareModal) return;
    (shareCopyBtnRef.current ?? shareCloseBtnRef.current)?.focus();
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") closeShareModal();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shareModal !== null]);

  // The "Copied!" confirmation fades on its own; re-copying (Copy button or
  // clicking the input again) restarts the timer via a fresh copiedAt.
  useEffect(() => {
    if (shareModal?.copiedAt == null) return;
    const at = shareModal.copiedAt;
    const t = setTimeout(() => {
      setShareModal((m) => (m && m.copiedAt === at ? { ...m, copiedAt: null } : m));
    }, 1800);
    return () => clearTimeout(t);
  }, [shareModal?.copiedAt]);

  return { shareModal, handleShare, copyShareUrl, closeShareModal, shareCopyBtnRef, shareCloseBtnRef };
}
