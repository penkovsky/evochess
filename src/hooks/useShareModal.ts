import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type RefObject } from "react";
import type { EvoChessGame } from "../evochess/game";
import { encodeShareLink, encodeShareLinkWithHistory, MAX_SHARE_PARAM_CHARS } from "../evochess/shareLink";
import { deserializeGame } from "../evochess/serialize";
import { formatMoveLog } from "../evochess/moveLogText";
import type { ShareModalState, ShareProblem } from "../appTypes";
import { track, type GameMeta } from "../telemetry";

/** The checkbox's last position, kept for the session only. */
let lastWithHistory = true;

export interface UseShareModal {
  shareModal: ShareModalState | null;
  /** Opens the dialog. `useShareSheet` decides whether it offers the OS sheet. */
  handleShare: (e: ReactMouseEvent<HTMLButtonElement>, useShareSheet: boolean) => Promise<void>;
  copyShareUrl: (url: string) => Promise<void>;
  copyMoveLog: (moveLog: string[], blackFirst: boolean) => Promise<void>;
  setShareWithHistory: (on: boolean) => void;
  shareViaSheet: (url: string) => Promise<void>;
  closeShareModal: () => void;
  shareCopyBtnRef: RefObject<HTMLButtonElement | null>;
  shareCloseBtnRef: RefObject<HTMLButtonElement | null>;
}

/**
 * The share-a-position dialog: building the link, the clipboard, and the
 * dialog's own focus and Escape handling. Reads the live game through
 * `gameRef` at click time, so it never holds a stale position.
 *
 * `browsePlyRef` is the history-browsing cursor, or null when the player is
 * live. A ref rather than the value, for the same reason `gameRef` is one: the
 * AI can move while the dialog is open, and because `useHistoryBrowse` is
 * blocked by this hook's own `shareModal` and so cannot be called before it.
 */
export function useShareModal(
  gameRef: RefObject<EvoChessGame>,
  browsePlyRef: RefObject<number | null>,
  gameMetaRef: RefObject<GameMeta>
): UseShareModal {
  const [shareModal, setShareModal] = useState<ShareModalState | null>(null);
  const shareLastFocusRef = useRef<HTMLElement | null>(null);
  const shareCopyBtnRef = useRef<HTMLButtonElement>(null);
  const shareCloseBtnRef = useRef<HTMLButtonElement>(null);

  // A link carrying the whole line, or null when this game cannot produce one:
  // no known base (a legacy save, or a game continued from a position-only
  // link), no moves yet, or a line too long to fit. Every one of those falls
  // back to the position-only link silently, which is what the app did before
  // history links existed.
  function buildHistoryParam(): string | null {
    const game = gameRef.current;
    if (!game.base || game.moveTokens.length === 0) return null;
    // Sharing while browsing sends the whole line with the cursor pointing back
    // into it, not a line cut at the cursor: the recipient can scroll forward.
    const cursor = Math.min(Math.max(browsePlyRef.current ?? game.moveTokens.length, 0), game.moveTokens.length);
    try {
      return encodeShareLinkWithHistory(deserializeGame(game.base), game.moveTokens, cursor);
    } catch {
      return null;
    }
  }

  // Never throws. `encodeShareLink` does, for a position the format cannot
  // represent, and the caller is an async click handler: an escaping throw
  // becomes an unhandled rejection, so the button would silently do nothing.
  function buildShareUrl(withHistory: boolean): { url: string; problem: ShareProblem } {
    let param: string | null = withHistory ? buildHistoryParam() : null;
    try {
      param ??= encodeShareLink(gameRef.current);
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

  // `kind` only picks which section shows the confirmation; the clipboard call
  // is the same either way.
  // `auto` marks the copies the dialog makes for you, so analysis can separate
  // them from a pressed button. Only a successful write is reported.
  async function copyText(text: string, kind: "url" | "log", auto = false) {
    try {
      await navigator.clipboard.writeText(text);
      setShareModal((m) => (m ? { ...m, clipboardOk: true, copiedAt: Date.now(), copiedKind: kind } : m));
      track("share_copy", { kind, auto }, gameMetaRef.current.uid);
    } catch {
      setShareModal((m) => (m ? { ...m, clipboardOk: false, copiedAt: null, copiedKind: null } : m));
    }
  }

  async function copyShareUrl(url: string) {
    await copyText(url, "url");
  }

  async function copyMoveLog(moveLog: string[], blackFirst: boolean) {
    await copyText(formatMoveLog(moveLog, blackFirst), "log");
  }

  // Never rejects: a dismissed sheet is an answer, not a failure, and the
  // dialog stays open behind it either way.
  async function shareViaSheet(url: string) {
    try {
      await navigator.share?.({ title: "Evochess position", url });
      track("share_copy", { kind: "sheet", auto: false }, gameMetaRef.current.uid);
    } catch {
      /* dismissed, or the sheet never happened */
    }
  }

  // Both buttons open the same dialog, because the move log lives in it too
  // and a phone handed straight to the OS sheet would never reach it.
  // `useShareSheet` is per button, not per capability: desktop browsers expose
  // `navigator.share` too, so gating on it alone would put an OS-sheet button
  // in front of a PC user. The mobile bar and the panel already exist on
  // opposite sides of the breakpoint, so the button pressed is the honest
  // signal.
  async function handleShare(e: ReactMouseEvent<HTMLButtonElement>, useShareSheet: boolean) {
    shareLastFocusRef.current = e.currentTarget;
    const moveLog = [...gameRef.current.moveLog];
    const blackFirst = gameRef.current.logStartsWithBlack;
    const hasHistory = buildHistoryParam() !== null;
    const withHistory = hasHistory && lastWithHistory;
    const { url, problem } = buildShareUrl(withHistory);
    const canShareSheet = useShareSheet && !!navigator.share;
    const base = { canShareSheet, moveLog, blackFirst, hasHistory, withHistory, copiedAt: null, copiedKind: null };
    // The top of the share funnel. `problem` rides along: a link the format
    // could not build is an intent that the app refused, not a lost user.
    track(
      "share_open",
      { surface: useShareSheet ? "mobile" : "panel", problem, with_history: withHistory, browsing: browsePlyRef.current !== null },
      gameMetaRef.current.uid
    );
    if (problem) {
      setShareModal({ ...base, url, problem, clipboardOk: false });
      return;
    }
    setShareModal({ ...base, url, problem: null, clipboardOk: true });
    copyText(url, "url", true);
  }

  // Toggling rebuilds the link and re-copies it, so the clipboard never holds
  // the version the checkbox no longer shows.
  function setShareWithHistory(on: boolean) {
    lastWithHistory = on;
    const { url, problem } = buildShareUrl(on);
    setShareModal((m) => (m ? { ...m, url, problem, withHistory: on, clipboardOk: !problem } : m));
    if (!problem) copyText(url, "url", true);
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
      setShareModal((m) => (m && m.copiedAt === at ? { ...m, copiedAt: null, copiedKind: null } : m));
    }, 1800);
    return () => clearTimeout(t);
  }, [shareModal?.copiedAt]);

  return {
    shareModal,
    handleShare,
    copyShareUrl,
    copyMoveLog,
    setShareWithHistory,
    shareViaSheet,
    closeShareModal,
    shareCopyBtnRef,
    shareCloseBtnRef,
  };
}
